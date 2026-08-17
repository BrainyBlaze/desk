import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readManifestFile } from '../src/core/config.js';
import { buildSessionSpecs } from '../src/core/manifest.js';
import { createTerminalDaemon, type TerminalDaemon } from '../src/server/runtime/terminalDaemon.js';
import { profileRoot } from '../src/shared/agentProfiles.js';
import { moorCommandFor } from '../src/shared/moorCommand.js';

type Provider = 'claude' | 'codex';
type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

class FakeUpgradeServer {
  private listeners: UpgradeListener[] = [];
  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }
  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((current) => current !== listener);
  }
}

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const LATER_ID = '33333333-3333-4333-8333-333333333333';
const FAKE_MOOR = fileURLToPath(
  new URL('./helpers/fake-moor-holder.ts', import.meta.url)
);

interface LaunchRecord {
  argv: string[];
  cwd: string;
  pid: number;
  launchProof?: string;
  codexHome?: string;
  claudeConfigDir?: string;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`provider process ${pid} survived holder retirement`);
}

function waitForRecords(path: string, count: number): Promise<LaunchRecord[]> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = (): void => {
      try {
        const records = readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LaunchRecord);
        if (records.length >= count) return resolve(records);
      } catch {
        // The provider shim may not have created the file yet.
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${count} provider launches`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function writeProviderEvidence(
  root: string,
  cwd: string,
  provider: Provider,
  providerSessionId = NEW_ID
): void {
  const providerRoot = profileRoot('work', root);
  if (provider === 'codex') {
    const path = join(
      providerRoot,
      'sessions',
      '2026',
      '08',
      '14',
      `rollout-2026-08-14T00-00-00-${providerSessionId}.jsonl`
    );
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`
    );
    return;
  }
  const path = join(
    providerRoot,
    'projects',
    cwd.replace(/[^A-Za-z0-9._-]/g, '-'),
    `${providerSessionId}.jsonl`
  );
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'queue-operation', sessionId: providerSessionId })}\n${JSON.stringify(
      { type: 'user', sessionId: providerSessionId, cwd }
    )}\n`
  );
}

describe('provider continuity at the real terminal child boundary', () => {
  const roots: string[] = [];
  const daemons: TerminalDaemon[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const daemon of daemons.splice(0)) {
      await daemon.retire('alpha').catch(() => undefined);
      daemon.dispose();
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'claude'] as const)(
    'relaunches %s with the explicitly rebound provider ID and unchanged Desk context',
    async (provider) => {
      const root = mkdtempSync(join(tmpdir(), `desk-provider-terminal-${provider}-`));
      roots.push(root);
      const cwd = join(root, 'workspace');
      const bin = join(root, 'bin');
      const argvLog = join(root, 'provider-launches.ndjson');
      const manifestPath = join(root, 'desk.yml');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const providerShim = join(bin, provider);
      writeFileSync(
        providerShim,
        `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.ARGV_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, launchProof: process.env.DESK_PROVIDER_LAUNCH_PROOF, codexHome: process.env.CODEX_HOME, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }) + '\\n');\nsetInterval(() => {}, 1_000);\n`
      );
      chmodSync(providerShim, 0o755);

      const moorWrapper = join(bin, 'node');
      writeFileSync(
        moorWrapper,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(FAKE_MOOR)} "$@"\n`
      );
      chmodSync(moorWrapper, 0o755);
      writeFileSync(
        manifestPath,
        `profiles:\n  - id: work\n    provider: ${provider}\n    label: Work\ngroups:\n  - id: main\n    sessions:\n      - name: alpha\n        cwd: ${cwd}\n        agent: ${provider}\n        profileId: work\n        resume: ${OLD_ID}\n        bypassPermissions: false\n        uiMode: terminal\n        sessionId: alpha\n`
      );

      vi.stubEnv('ARGV_LOG', argvLog);
      vi.stubEnv('FAKE_MOOR_EVENT_TS_SECONDS', '1');
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      vi.stubEnv('TMPDIR', root);
      const daemon = createTerminalDaemon({
        homeRoot: root,
        moorBinPath: moorWrapper,
        moorSocketRoot: root,
        httpServer: new FakeUpgradeServer(),
        manifestPath,
        homeDir: root
      });
      daemons.push(daemon);

      const firstSpec = buildSessionSpecs(readManifestFile(manifestPath), {
        homeDir: root
      })[0]!;
      const firstProvision = await daemon.provision('alpha', {
          command: moorCommandFor(firstSpec),
          geometry: { rows: 24, cols: 80 },
          subject: {
            kind: 'agent',
            provider,
            mode: 'terminal',
            producer: provider === 'codex' ? 'codex-hooks' : 'claude-hooks'
          },
          providerSessionId: OLD_ID
        });
      expect(firstProvision).toMatchObject({ ok: true, generation: 2 });
      const first = (await waitForRecords(argvLog, 1))[0]!;
      expect(first.launchProof).toMatch(/^[A-Za-z0-9_-]{43}$/);

      writeProviderEvidence(root, cwd, provider);
      expect(
        await daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider,
          providerSessionId: NEW_ID,
          generation: 2,
          launchProof: 'A'.repeat(43),
          hook: 'SessionStart'
        })
      ).toMatchObject({
        ok: false,
        reason: 'provider-session-proof-invalid'
      });
      expect(
        await daemon.rebindProviderSession({
          deskSessionId: 'alpha',
          targetProviderSessionId: NEW_ID
        })
      ).toMatchObject({
        ok: false,
        reason: 'provider-session-transition-missing'
      });
      expect(readManifestFile(manifestPath).groups[0]?.sessions[0]?.resume).toBe(
        OLD_ID
      );

      expect(
        await daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider,
          providerSessionId: NEW_ID,
          generation: 2,
          launchProof: first.launchProof!,
          hook: 'SessionStart'
        })
      ).toMatchObject({
        ok: false,
        reason: 'provider-session-rebind-required'
      });
      expect(
        await daemon.rebindProviderSession({
          deskSessionId: 'alpha',
          targetProviderSessionId: NEW_ID
        })
      ).toMatchObject({ ok: true, kind: 'rebound' });

      expect(await daemon.retire('alpha')).toMatchObject({ ok: true });
      await waitForProcessExit(first.pid);
      const reboundSpec = buildSessionSpecs(readManifestFile(manifestPath), {
        homeDir: root
      })[0]!;
      expect(reboundSpec.resume).toBe(NEW_ID);
      const secondProvision = await daemon.provision('alpha', {
          command: moorCommandFor(reboundSpec),
          geometry: { rows: 24, cols: 80 },
          subject: {
            kind: 'agent',
            provider,
            mode: 'terminal',
            producer: provider === 'codex' ? 'codex-hooks' : 'claude-hooks'
          },
          providerSessionId: NEW_ID
        });
      expect(secondProvision).toMatchObject({ ok: true, generation: 3 });
      const second = (await waitForRecords(argvLog, 2))[1]!;

      const resumeFlag = provider === 'codex' ? 'resume' : '--resume';
      expect(second.argv.filter((value) => value === resumeFlag)).toHaveLength(1);
      expect(second.argv[second.argv.indexOf(resumeFlag) + 1]).toBe(NEW_ID);
      expect(second.argv).not.toContain(OLD_ID);
      expect(second.cwd).toBe(cwd);
      expect(
        provider === 'codex' ? second.codexHome : second.claudeConfigDir
      ).toBe(profileRoot('work', root));
      expect(second.launchProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.launchProof).not.toBe(first.launchProof);

      writeProviderEvidence(root, cwd, provider, LATER_ID);
      expect(
        await daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider,
          providerSessionId: LATER_ID,
          generation: 3,
          launchProof: second.launchProof!,
          hook: 'SessionStart'
        })
      ).toMatchObject({
        ok: false,
        reason: 'provider-session-rebind-required'
      });
      expect(await daemon.retire('alpha')).toMatchObject({ ok: true });
      await waitForProcessExit(second.pid);
      expect(
        await daemon.provision('alpha', {
          command: moorCommandFor(reboundSpec),
          geometry: { rows: 24, cols: 80 },
          subject: {
            kind: 'agent',
            provider,
            mode: 'terminal',
            producer: provider === 'codex' ? 'codex-hooks' : 'claude-hooks'
          },
          providerSessionId: NEW_ID
        })
      ).toMatchObject({
        ok: false,
        detail: 'provider-session-rebind-required'
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await waitForRecords(argvLog, 2))).toHaveLength(2);
    },
    30_000
  );
});
