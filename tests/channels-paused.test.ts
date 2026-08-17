import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listPausedSessions,
  pauseSession
} from '../src/server/channels/delivery/paused.js';
import { PreCutoverStoreError } from '../src/shared/supportFloor.js';

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

  it('refuses the version-1 store Desk v0.3.1 wrote by name, citing the support floor rather than a migration', () => {
    home = mkdtempSync(join(tmpdir(), 'desk-channels-paused-'));
    const path = join(home, '_engine', 'paused.json');
    mkdirSync(join(home, '_engine'), { recursive: true });
    // Byte shape of a real v0.3.1 paused store (values shortened): version 1,
    // items keyed by the retired per-session identity.
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      items: [
        {
          tmuxSession: 'agentdesk-desk-multiplexor-glm-7f9f4607',
          pausedAt: '2026-07-07T19:22:18.833Z',
          reason: 'native channel delivery failed (adapter-unavailable)'
        }
      ]
    }, null, 2)}\n`);

    let caught: unknown;
    try {
      listPausedSessions(home as string);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PreCutoverStoreError);
    const message = (caught as Error).message;
    expect(message).toContain(path);
    expect(message).toContain('version 1');
    expect(message).toContain('Desk v0.3.1 or older');
    expect(message).toContain('boot Desk v0.3.2 once');
    expect(message).toContain('does not migrate');
    // A pause attempted against the old store must not rewrite it either.
    expect(() => pauseSession(home as string, 'alpha', 'operator hold', new Date('2026-08-14T12:00:00.000Z'))).toThrow(PreCutoverStoreError);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });

  it('a version that is neither 1 nor current is corruption, not a pre-cutover store — no floor is named', () => {
    home = mkdtempSync(join(tmpdir(), 'desk-channels-paused-'));
    const path = join(home, '_engine', 'paused.json');
    mkdirSync(join(home, '_engine'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 7, items: [] })}\n`);

    let caught: unknown;
    try {
      listPausedSessions(home as string);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(PreCutoverStoreError);
    expect((caught as Error).message).toContain(`invalid Channels paused store at ${path}`);
    expect((caught as Error).message).not.toContain('v0.3.2');
  });
});
