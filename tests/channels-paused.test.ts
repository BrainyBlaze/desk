import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listPausedSessions,
  pauseSession
} from '../src/server/channelsPaused.js';

describe('Channels paused store', () => {
  let home: string | undefined;

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('fails closed on corrupt JSON and preserves the evidence during mutation', () => {
    home = mkdtempSync(join(tmpdir(), 'desk-channels-paused-'));
    const path = join(home, '_engine', 'paused.json');
    mkdirSync(join(home, '_engine'), { recursive: true });
    const corrupt = Buffer.from('{"version":2,"items":[', 'utf8');
    writeFileSync(path, corrupt);

    expect(() => listPausedSessions(home as string)).toThrow(`invalid Channels paused store at ${path}`);
    expect(() => pauseSession(home as string, 'alpha', 'operator hold', new Date('2026-08-14T12:00:00.000Z'))).toThrow(
      `invalid Channels paused store at ${path}`
    );
    expect(readFileSync(path)).toEqual(corrupt);
  });

  it('rejects structurally invalid paused records instead of dropping them', () => {
    home = mkdtempSync(join(tmpdir(), 'desk-channels-paused-'));
    const path = join(home, '_engine', 'paused.json');
    mkdirSync(join(home, '_engine'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      version: 2,
      items: [{ sessionId: '../escape', pausedAt: '2026-08-14T12:00:00.000Z' }]
    })}\n`);

    expect(() => listPausedSessions(home as string)).toThrow(`invalid Channels paused store at ${path}`);
  });
});
