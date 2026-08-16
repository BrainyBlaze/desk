// The durable per-session identity grammar (spec §10): what the manifest
// parser accepts, what `desk add` mints, and how duplicates are refused.

import { describe, expect, it } from 'vitest';
import { checkGlobalUniqueness, isValidSessionId, mintSessionId, SESSION_ID_GRAMMAR } from '../src/shared/sessionId.js';

describe('sessionId grammar', () => {
  it('accepts valid ids and rejects invalid ones', () => {
    expect(isValidSessionId('web-1')).toBe(true);
    expect(isValidSessionId('abc')).toBe(true); // 3-char minimum
    expect(isValidSessionId('a'.repeat(64))).toBe(true);
    expect(isValidSessionId('ab')).toBe(false); // too short
    expect(isValidSessionId('a'.repeat(65))).toBe(false); // too long
    expect(isValidSessionId('1web')).toBe(false); // must start with a letter
    expect(isValidSessionId('Web-1')).toBe(false); // no uppercase
    expect(isValidSessionId('web_1')).toBe(false); // no underscore
    expect(isValidSessionId('-web')).toBe(false);
    expect(isValidSessionId(true)).toBe(false); // regex coercion must not admit non-strings
    expect(isValidSessionId(null)).toBe(false);
  });

  it('publishes the grammar it enforces, so refusals can quote it', () => {
    expect(SESSION_ID_GRAMMAR).toBe('^[a-z][a-z0-9-]{2,63}$');
    expect(new RegExp(SESSION_ID_GRAMMAR).test('web-1')).toBe(true);
  });

  it('mints valid ids from arbitrary names, deduping collisions', () => {
    expect(mintSessionId('My Cool Session!', new Set())).toBe('my-cool-session');
    expect(isValidSessionId(mintSessionId('42', new Set()))).toBe(true); // leading digit fixed
    const taken = new Set(['agent', 'agent-2']);
    const minted = mintSessionId('agent', taken);
    expect(minted).toBe('agent-3');
    expect(isValidSessionId(minted)).toBe(true);
  });

  it('checkGlobalUniqueness finds the first duplicate (refuse before anything is written)', () => {
    expect(checkGlobalUniqueness(['a-1', 'a-2', 'a-3'])).toEqual({ ok: true });
    expect(checkGlobalUniqueness(['a-1', 'a-2', 'a-1'])).toEqual({ ok: false, duplicate: 'a-1' });
  });
});
