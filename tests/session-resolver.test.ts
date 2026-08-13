// desk#57: addressing a session by its EXACT name must not be defeated by a
// neighbour whose id merely contains that name. Live symptom: `desk capture
// claude-1` refused with "multiple sessions match claude-1: claude-1, claude,
// claude, claude, claude" because `claude-10`, `claude-11`, … contain the
// literal string `claude-1`, while the daemon answered for `claude-1` fine.

import { describe, expect, it } from 'vitest';
import { findSession } from '../src/core/runner.js';
import type { SessionSpec } from '../src/core/manifest.js';

const spec = (name: string, sessionId: string, resume?: string): SessionSpec =>
  ({
    name,
    sessionId,
    cwd: '/tmp',
    groupId: 'main',
    agent: 'claude',
    ...(resume === undefined ? {} : { resume })
  }) as SessionSpec;

const fleet: SessionSpec[] = [
  spec('claude-1', 'claude-1'),
  spec('claude', 'claude-10'),
  spec('claude', 'claude-11'),
  spec('claude', 'claude-12'),
  spec('codex', 'codex-2', '019ec5e5-78dc-7eb3-99d9-2a98122d6ad7')
];

describe('findSession precedence (desk#57)', () => {
  it('resolves the exact name even when longer ids contain it', () => {
    expect(findSession(fleet, 'claude-1').sessionId).toBe('claude-1');
  });

  it('resolves an exact sessionId that is also a prefix of others', () => {
    expect(findSession(fleet, 'claude-10').sessionId).toBe('claude-10');
  });

  it('still resolves by resume id', () => {
    expect(findSession(fleet, '019ec5e5-78dc-7eb3-99d9-2a98122d6ad7').sessionId).toBe('codex-2');
  });

  it('keeps the substring convenience when nothing matches exactly', () => {
    expect(findSession(fleet, 'dex-2').sessionId).toBe('codex-2');
  });

  it('reports genuine ambiguity — two sessions truly carrying the identifier', () => {
    const duplicated = [spec('dup', 'dup-a'), spec('dup', 'dup-b')];
    expect(() => findSession(duplicated, 'dup')).toThrowError(/multiple sessions match dup/);
  });

  it('distinguishes an ambiguous PREFIX from an ambiguous identity', () => {
    // 'claude-1' is exact here, so use a query that is only ever a substring.
    expect(() => findSession(fleet, 'claude-1x')).toThrowError(/no session matches/);
    expect(() => findSession(fleet, 'laude-1')).toThrowError(/not an exact session name or id/);
  });

  it('still refuses an unknown target', () => {
    expect(() => findSession(fleet, 'nope')).toThrowError(/no session matches nope/);
  });
});
