// Product-side §10 manifest glue (cutover Phase 2, Step 1): flatten → mint →
// apply, with round-trip alignment between the minted map and the applied ids.

import { describe, expect, it } from 'vitest';
import type { DeskManifest } from '../src/core/types.js';
import { applyMigratedSessionIds, buildManifestMigration, deskManifestToEntries } from '../src/core/sessionIdentity.js';
import { isValidSessionId, validateManifestMigration } from '../src/shared/migration/index.js';

const manifest = (): DeskManifest => ({
  groups: [
    {
      id: 'g1',
      sessions: [
        { name: 'Claude', tmuxSession: 'tmux-claude' },
        { name: 'Server', tmuxSession: 'tmux-server' }
      ]
    }
  ],
  projects: [
    {
      id: 'p1',
      cwd: '/p',
      groups: [
        {
          id: 'pg1',
          sessions: [
            { name: 'Claude', tmuxSession: 'tmux-claude-2' }, // name collision across the manifest
            { name: 'Fresh Session' } // never started — no tmuxSession
          ]
        }
      ]
    }
  ]
});

describe('sessionIdentity — manifest glue (§10)', () => {
  it('flattens groups then projects, in order, capturing name + tmuxSession', () => {
    expect(deskManifestToEntries(manifest())).toEqual([
      { name: 'Claude', tmuxSession: 'tmux-claude' },
      { name: 'Server', tmuxSession: 'tmux-server' },
      { name: 'Claude', tmuxSession: 'tmux-claude-2' },
      { name: 'Fresh Session' }
    ]);
  });

  it('mints valid, deduped sessionIds and a validated tmux map', () => {
    const m = buildManifestMigration(manifest());
    expect(m.entries.map((e) => e.sessionId)).toEqual(['claude', 'server', 'claude-2', 'fresh-session']);
    for (const e of m.entries) expect(isValidSessionId(e.sessionId)).toBe(true);
    expect(validateManifestMigration(deskManifestToEntries(manifest()), m).ok).toBe(true);
    expect(m.tmuxToSessionId.get('tmux-claude-2')).toBe('claude-2');
    expect(m.tmuxToSessionId.size).toBe(3);
  });

  it('applies sessionIds back in the same order, aligned with the map, without mutating the input', () => {
    const original = manifest();
    const m = buildManifestMigration(original);
    const applied = applyMigratedSessionIds(original, m);

    // Round-trip: every session with a tmuxSession gets the sessionId the map assigned it.
    const appliedSessions = [
      ...applied.groups.flatMap((g) => g.sessions),
      ...(applied.projects ?? []).flatMap((p) => p.groups.flatMap((g) => g.sessions))
    ];
    for (const s of appliedSessions) {
      if (s.tmuxSession !== undefined) {
        expect(s.sessionId).toBe(m.tmuxToSessionId.get(s.tmuxSession));
      } else {
        expect(isValidSessionId(s.sessionId ?? '')).toBe(true); // never-started session still gets an id
      }
    }
    expect(appliedSessions.map((s) => s.sessionId)).toEqual(['claude', 'server', 'claude-2', 'fresh-session']);

    // Non-mutating: the original manifest is untouched.
    expect(original.groups[0].sessions[0].sessionId).toBeUndefined();
  });

  it('fails closed on a migration whose cardinality does not match the manifest', () => {
    const original = manifest(); // 4 sessions
    const full = buildManifestMigration(original);
    const short = { ...full, entries: full.entries.slice(0, 2) };
    const extra = { ...full, entries: [...full.entries, { name: 'X', sessionId: 'x-extra' }] };
    // A short OR extra migration must throw, never silently write undefined ids.
    expect(() => applyMigratedSessionIds(original, short)).toThrow(/refusing to partially apply/);
    expect(() => applyMigratedSessionIds(original, extra)).toThrow(/refusing to partially apply/);
  });
});
