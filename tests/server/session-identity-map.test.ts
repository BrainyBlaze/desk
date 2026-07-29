// GET /api/session-identity-map (cutover step 4) — the read-only feed for the
// pre-React localStorage migration. Committed mappings come from the
// migration's session-id-map.json; sessionIds come from the CURRENT strict
// manifest so post-cutover additions are preserved. Missing marker = 409
// not-migrated; a missing/malformed map AFTER the gate fails closed (500).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionIdentityMap } from '../../src/server/routes/systemRoutes.js';

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setUp(): { manifestPath: string; migrationRoot: string } {
  dir = mkdtempSync(join(tmpdir(), 'desk-idmap-'));
  const manifestPath = join(dir, 'desk.yml');
  writeFileSync(
    manifestPath,
    ['groups:', '  - id: g', '    label: G', '    sessions:', '      - name: shell', '        cwd: /tmp', '        command: bash', '        sessionId: shell'].join(
      '\n'
    ) + '\n'
  );
  const migrationRoot = join(dir, '_migration', 'session-id-v1');
  mkdirSync(migrationRoot, { recursive: true });
  return { manifestPath, migrationRoot };
}

describe('readSessionIdentityMap', () => {
  it('409s before the migration marker exists (not migrated, not an error)', () => {
    const { manifestPath } = setUp();
    const result = readSessionIdentityMap(manifestPath);
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringContaining('not committed'), code: 'not-migrated' });
  });

  it('serves committed mappings plus the CURRENT manifest sessionIds', () => {
    const { manifestPath, migrationRoot } = setUp();
    writeFileSync(join(migrationRoot, 'migration.done'), '{"version":1}\n');
    writeFileSync(
      join(migrationRoot, 'session-id-map.json'),
      JSON.stringify({ version: 1, entries: [['agentdesk-g-shell-abc', 'shell']] }) + '\n'
    );
    const result = readSessionIdentityMap(manifestPath);
    expect(result).toEqual({
      ok: true,
      payload: { version: 1, mappings: [['agentdesk-g-shell-abc', 'shell']], sessionIds: ['shell'] }
    });
  });

  it('fails closed on a MISSING map after the gate (corruption, never a silent empty map)', () => {
    const { manifestPath, migrationRoot } = setUp();
    writeFileSync(join(migrationRoot, 'migration.done'), '{"version":1}\n');
    const result = readSessionIdentityMap(manifestPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.code).toBe('identity-map-corrupt');
    }
  });

  it('fails closed on malformed shapes (wrong version, non-pair entries)', () => {
    const { manifestPath, migrationRoot } = setUp();
    writeFileSync(join(migrationRoot, 'migration.done'), '{"version":1}\n');
    for (const bad of [
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 1, entries: [['only-one']] }),
      JSON.stringify({ version: 1, entries: 'nope' }),
      '{not json'
    ]) {
      writeFileSync(join(migrationRoot, 'session-id-map.json'), bad);
      const result = readSessionIdentityMap(manifestPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(500);
        expect(result.code).toBe('identity-map-corrupt');
      }
    }
  });
});
