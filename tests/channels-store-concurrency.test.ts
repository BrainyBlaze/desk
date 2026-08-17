// Regression tests for cross-process lost-append races and PID-reuse hazards.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendMessage } from '../src/server/channels/store/fileStore.js';
import { formatChannelPreamble, parseConversation } from '../src/server/channels/protocol/format.js';
import { ChannelsEngine } from '../src/server/channels/delivery/engine.js';
import { canonicalAgentStateBatch } from './helpers/canonicalAgentState.js';

const STORE_SOURCE = pathToFileURL(resolve(process.cwd(), 'src/server/channels/store/fileStore.ts')).href;
const TEST_PID_SCOPE = {
  bootId: '11111111-1111-4111-8111-111111111111',
  pidNamespaceDev: 4n,
  pidNamespaceIno: 1_001n
};

function enginePidRecord(pid: number, starttime: bigint): string {
  return (
    `desk-engine-lock-v1\npid=${pid}\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n` +
    `linux_boot_id=${TEST_PID_SCOPE.bootId}\n` +
    `linux_pidns_dev=${TEST_PID_SCOPE.pidNamespaceDev}\n` +
    `linux_pidns_ino=${TEST_PID_SCOPE.pidNamespaceIno}\n` +
    `starttime=${starttime}\n`
  );
}

const WORKER_SOURCE = `
import { appendMessage } from '${STORE_SOURCE}';
const home = process.argv[2];
const channel = process.argv[3];
const id = process.argv[4];
const parent = process.argv[5];
const body = 'reply-' + id + ' ' + 'X'.repeat(6000);  // 6KB body to widen the write window
appendMessage(home, channel, { author: 'agent-' + id, body, threadParentId: parent })
  .then(() => process.exit(0))
  .catch((e) => { console.error('worker', id, e.message); process.exit(2); });
`;

describe('cross-process thread-reply lost-append race (probabilistic, repeated)', () => {
  let home: string;
  let workerFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-chan-s2-'));
    workerFile = join(home, 'worker.mjs');
    writeFileSync(workerFile, WORKER_SOURCE);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // The append race is probabilistic per run (~20% loss rate under 8-worker contention
  // on the test runner — measured 1 lost reply in 5 runs of the standalone reproducer).
  // To converge reliably RED today (and reliably GREEN after the cross-process lock fix), we run K
  // independent iterations and assert ALL succeed. P(all pass today) ≈ 0.8^K;
  // K=30 → ~99.9% reliable RED, ~12s runtime.
  it('does not lose replies across 30 iterations of 8-way concurrent thread appends', async () => {
    const K = 30;
    const N = 8;
    let totalReplies = 0;
    let totalExpected = 0;

    for (let iter = 0; iter < K; iter += 1) {
      const channel = `stress-${iter}`;
      const chanDir = join(home, channel);
      mkdirSync(join(chanDir, '_members'), { recursive: true });
      mkdirSync(join(chanDir, '_files'), { recursive: true });
      writeFileSync(join(chanDir, 'root.md'), formatChannelPreamble(channel, 'repro'));

      const seed = await appendMessage(home, channel, { author: 'seed', body: 'parent' });
      const parentId = seed.message.id;

      const exits = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          new Promise<number>((resolve) => {
            const child = spawn(process.execPath, ['--import', 'tsx', workerFile, home, channel, `${iter}-${i}`, parentId], {
              stdio: 'pipe'
            });
            child.on('exit', resolve);
          })
        )
      );
      expect(exits).toEqual(Array.from({ length: N }, () => 0));
      const succeeded = exits.filter((code) => code === 0).length;
      totalExpected += succeeded;

      const threadPath = join(chanDir, `thread-${parentId}.md`);
      if (existsSync(threadPath)) {
        totalReplies += parseConversation(readFileSync(threadPath, 'utf8')).messages.length;
      }
    }

    // RED today: totalReplies < totalExpected (some iterations lose 1-of-8).
    // GREEN after the per-channel lock fix wraps every appendMessage / RMW path.
    expect(totalReplies).toBe(totalExpected);
  }, 120_000);
});

// The engine.pid PID/start-time ownership record is GONE: Channels ownership
// is a heartbeat lease at the runtime boundary (proper-lockfile: a dead owner
// simply stops refreshing mtime and the lock is reclaimable after staleness),
// so PID reuse is no longer an input to any ownership decision. The successor
// contract — second live runtime refused, killed owner reclaimable, obsolete
// engine.pid artifact fail-closed — is pinned in
// tests/channels-runtime-ownership.test.ts.

describe('durability restore: engine classifies per-item extensions on restart', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-durability-restore-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const seqFile = (seq: number, ext: string): string => `${String(seq).padStart(10, '0')}.${ext}`;
  const sample = (seq: number, messageId = `msg-${seq}`) => ({
    seq,
    channel: 'ops',
    messageId,
    author: 'human',
    prompt: `prompt ${seq}`,
    queuedAt: '2026-06-18T00:00:00.000Z',
    kind: 'message' as const,
    file: 'root.md',
    member: 'alpha'
  });

  const writeQueueFile = (sessionId: string, seq: number, ext: string, body = sample(seq)): void => {
    const dir = join(home, '_engine', 'queue', sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, seqFile(seq, ext)), JSON.stringify({ ...body, seq }));
  };

  it('re-enqueues .json AND .delivering items (.delivering = at-least-once re-send)', async () => {
    const tmux = 'tmux-a';
    writeQueueFile(tmux, 1, 'json');
    writeQueueFile(tmux, 2, 'delivering');
    writeQueueFile(tmux, 3, 'delivered'); // must be skipped
    writeQueueFile(tmux, 4, 'stuck-paste'); // must be preserved, not enqueued
    writeQueueFile(tmux, 5, 'stuck-submit'); // ditto

    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 1_000_000,
      readAgentStates: async () => canonicalAgentStateBatch([tmux]),
      sendText: async () => true,
      sessionRunning: () => false,
      capturePane: async () => null
    });

    try {
      const states = await engine.lifecycleStates();
      const state = states.find((s) => s.sessionId === tmux);
      expect(state?.queueDepth).toBe(2); // seqs 1 + 2 enqueued; 3/4/5 NOT
    } finally {
      engine.dispose();
    }
  });

  it('preserves .stuck-* files on disk after restore (ops console surfaces them)', () => {
    const tmux = 'tmux-b';
    writeQueueFile(tmux, 7, 'stuck-paste');
    writeQueueFile(tmux, 8, 'stuck-submit');

    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 1_000_000,
      sendText: async () => true,
      sessionRunning: () => false,
      capturePane: async () => null
    });

    try {
      const stuckPaste = join(home, '_engine', 'queue', tmux, seqFile(7, 'stuck-paste'));
      const stuckSubmit = join(home, '_engine', 'queue', tmux, seqFile(8, 'stuck-submit'));
      expect(existsSync(stuckPaste)).toBe(true);
      expect(existsSync(stuckSubmit)).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it('consumes .delivering on restore (rewritten as .json with the new seq via persistQueue)', () => {
    const tmux = 'tmux-c';
    writeQueueFile(tmux, 99, 'delivering');

    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 1_000_000,
      sendText: async () => true,
      sessionRunning: () => false,
      capturePane: async () => null
    });

    try {
      // The old .delivering file is gone; the item now lives at .json with a
      // fresh seq assigned by the new runtime's monotonic counter.
      const dir = join(home, '_engine', 'queue', tmux);
      const files = existsSync(dir) ? readdirSync(dir) : [];
      const deliveringLeft = files.filter((f: string) => f.endsWith('.delivering')).length;
      const jsonCount = files.filter((f: string) => f.endsWith('.json')).length;
      expect(deliveringLeft).toBe(0);
      expect(jsonCount).toBe(1);
    } finally {
      engine.dispose();
    }
  });
});
