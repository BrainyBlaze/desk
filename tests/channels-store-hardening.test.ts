// RED-first tests for the storage-hardening slice (boot sweep + destroy serialization + save cap):
//   boot sweep — boot-time orphan-temp sweep (ensureChannelsHome clears leftover .desk-tmp-* entries)
//   destroy serialization — destroyChannel serializes via withHomeLockSync + drains concurrent channel-lock holders
//   save cap — saveChannelFile cap policy (high cap + clearer error; lock provides the real serialization)

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendMessage,
  createChannel,
  destroyChannel,
  ensureChannelsHome,
  saveChannelFile
} from '../src/server/channelsStore.js';

describe('boot sweep: boot-time orphan-temp sweep', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-fu1-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('ensureChannelsHome removes leftover .desk-tmp-* directories from a prior crash', () => {
    // Simulate a crashed createChannel: hidden temp dir left behind.
    const orphanChannelTemp = join(home, '.stress.desk-tmp-99999-1700000000000-deadbeef');
    mkdirSync(join(orphanChannelTemp, '_members'), { recursive: true });
    writeFileSync(join(orphanChannelTemp, 'root.md'), 'partial');

    // Simulate a crashed saveChannelFile: hidden temp file in _files.
    const channelDir = join(home, 'live');
    mkdirSync(join(channelDir, '_files'), { recursive: true });
    const orphanFileTemp = join(channelDir, '_files', '.upload.png.desk-tmp-99999-1700000000000-cafebabe');
    writeFileSync(orphanFileTemp, Buffer.from('partial'));

    ensureChannelsHome(home);
    // After the sweep, the orphans should be gone (channels root).
    const rootEntries = readdirSync(home);
    expect(rootEntries.filter((e) => e.includes('desk-tmp'))).toEqual([]);
    // And the _files dir should be clean too (per-channel sweep on demand).
    // The per-channel sweep is invoked separately (sweepChannelOrphanTemps);
    // ensureChannelsHome handles only the top-level dir to stay cheap.
  });

  it('ensureChannelsHome is idempotent (no orphans = no-op, normal channels untouched)', () => {
    createChannel(home, 'ops', 'goal');
    ensureChannelsHome(home);
    expect(existsSync(join(home, 'ops', 'root.md'))).toBe(true);
  });
});

describe('destroy serialization: destroyChannel serializes via home lock', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-fu2-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('destroyChannel removes a channel that exists', () => {
    createChannel(home, 'doomed', 'goal');
    expect(existsSync(join(home, 'doomed', 'root.md'))).toBe(true);
    destroyChannel(home, 'doomed');
    expect(existsSync(join(home, 'doomed'))).toBe(false);
  });

  it('destroyChannel is a no-op (no throw) when the channel does not exist', () => {
    expect(() => destroyChannel(home, 'never-existed')).not.toThrow();
    expect(existsSync(join(home, 'never-existed'))).toBe(false);
  });

  // Race: a concurrent createChannel must not collide with destroyChannel.
  // Both acquire the home lock; serialized cleanly; one wins, the other throws
  // or no-ops deterministically (never partial state on disk).
  it('does not leave partial state when destroyChannel races createChannel for the same name', async () => {
    // Run N concurrent destroy+create cycles for the same name; after all settle,
    // the channel dir is either fully present (root.md + _members) or fully absent.
    const name = 'contended';
    const N = 20;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i += 1) {
      tasks.push(
        Promise.resolve().then(() => {
          if (i % 2 === 0) {
            try {
              createChannel(home, name, 'goal');
            } catch {
              // 'channel already exists' is a valid race outcome
            }
          } else {
            destroyChannel(home, name);
          }
        })
      );
    }
    await Promise.all(tasks);
    // Final state is consistent: either present-with-root.md OR absent.
    const dirExists = existsSync(join(home, name));
    const rootExists = existsSync(join(home, name, 'root.md'));
    expect(dirExists === rootExists).toBe(true);
  });
});

describe('save cap: saveChannelFile cap policy', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-fu3-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('saveChannelFile keeps allocating unique suffixes for many same-base uploads (channel lock serializes)', () => {
    createChannel(home, 'ops', 'goal');
    // 50 same-name uploads should all succeed with distinct names; the cap is a
    // safety valve only, not a real limit under normal lock-serialized load.
    const saved: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      saved.push(saveChannelFile(home, 'ops', 'report.json', Buffer.from(`{"i":${i}}`)));
    }
    expect(new Set(saved).size).toBe(50);
    expect(saved[0]).toBe('report.json');
    expect(saved[1]).toBe('report-1.json');
    expect(saved[2]).toBe('report-2.json');
  });
});
