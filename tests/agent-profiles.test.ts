import { describe, expect, it } from 'vitest';
import { buildSessionSpecs, parseDeskManifest, parseLegacyDeskManifest } from '../src/core/manifest.js';
import { applyMigratedSessionIds, deskManifestToEntries } from '../src/core/sessionIdentity.js';
import { migrateManifestSessions } from '../src/shared/migration/index.js';
import { rewriteNativeLaunchCommand } from '../src/server/agentHostLaunch.js';
import { readDeskSessionBody } from '../src/server/routes/sessionsRoutes.js';
import { shouldRespawnAfterEdit } from '../src/server/editRespawn.js';
import { mintProfileId } from '../src/server/routes/profileRoutes.js';
import {
  PROFILE_ENV_VAR,
  SCRUBBED_PROVIDER_ENV,
  isValidProfileId,
  profileEnvPrefix,
  profileLaunchEnv,
  profileRoot,
  profileScrubPrefix,
  scrubProviderEnv
} from '../src/shared/agentProfiles.js';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeskManifest, SessionSpec } from '../src/core/types.js';

const HOME = '/home/tester';
// Injection witness: the quoting test passes only if nothing ever creates it.
const MARKER = join(tmpdir(), `desk-profile-injection-witness-${process.pid}`);
rmSync(MARKER, { force: true });

function manifest(overrides: Partial<DeskManifest> = {}): DeskManifest {
  return {
    profiles: [
      { id: 'work', provider: 'claude', label: 'Work account' },
      { id: 'personal', provider: 'codex', label: 'Personal' }
    ],
    groups: [
      {
        id: 'main',
        sessions: [
          { name: 'ambient-claude', sessionId: 'ambient-claude', agent: 'claude', cwd: '~/p', uiMode: 'terminal' },
          {
            name: 'work-claude',
            sessionId: 'work-claude',
            agent: 'claude',
            cwd: '~/p',
            uiMode: 'terminal',
            profileId: 'work'
          }
        ]
      }
    ],
    ...overrides
  } as DeskManifest;
}

function specFor(name: string, m: DeskManifest = manifest()): SessionSpec {
  const spec = buildSessionSpecs(m, { homeDir: HOME }).find((candidate) => candidate.name === name);
  if (!spec) {
    throw new Error(`no spec for ${name}`);
  }
  return spec;
}

describe('profile identity and paths', () => {
  it('accepts the sessionId-class grammar and rejects everything else', () => {
    expect(isValidProfileId('work')).toBe(true);
    expect(isValidProfileId('work-2')).toBe(true);
    expect(isValidProfileId('Work')).toBe(false); // uppercase
    expect(isValidProfileId('2work')).toBe(false); // must start with a letter
    expect(isValidProfileId('ab')).toBe(false); // too short
    expect(isValidProfileId('../escape')).toBe(false); // never a traversal
    expect(isValidProfileId(undefined)).toBe(false);
  });

  it('maps each provider to its own credential-dir variable and directory', () => {
    expect(profileLaunchEnv('claude', 'work', HOME)).toEqual({
      CLAUDE_CONFIG_DIR: `${HOME}/.config/desk/profiles/work`
    });
    expect(profileLaunchEnv('codex', 'personal', HOME)).toEqual({
      CODEX_HOME: `${HOME}/.config/desk/profiles/personal`
    });
    expect(profileRoot('work', HOME)).toBe(`${HOME}/.config/desk/profiles/work`);
    expect(PROFILE_ENV_VAR.claude).toBe('CLAUDE_CONFIG_DIR');
    expect(PROFILE_ENV_VAR.codex).toBe('CODEX_HOME');
  });

  it('scrubs every inherited provider credential from a spawn environment', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME };
    for (const key of SCRUBBED_PROVIDER_ENV) {
      parent[key] = 'inherited-secret';
    }
    const scrubbed = scrubProviderEnv(parent);
    for (const key of SCRUBBED_PROVIDER_ENV) {
      expect(scrubbed[key], key).toBeUndefined();
    }
    expect(scrubbed.PATH).toBe('/usr/bin'); // unrelated values survive
  });
});

describe('manifest validation fails closed', () => {
  const bad = (m: unknown): (() => unknown) => () => parseDeskManifest(JSON.stringify(m));

  it('rejects a session referencing an unknown profile', () => {
    expect(
      bad({
        profiles: [{ id: 'work', provider: 'claude', label: 'W' }],
        groups: [{ id: 'g', sessions: [{ name: 'sess', sessionId: 'sess', agent: 'claude', cwd: '~/p', profileId: 'ghost' }] }]
      })
    ).toThrow(/unknown profile "ghost"/);
  });

  it('rejects a profile whose provider does not match the session agent', () => {
    expect(
      bad({
        profiles: [{ id: 'work', provider: 'codex', label: 'W' }],
        groups: [{ id: 'g', sessions: [{ name: 'sess', sessionId: 'sess', agent: 'claude', cwd: '~/p', profileId: 'work' }] }]
      })
    ).toThrow(/but profile work is for codex/);
  });

  it('rejects a profile on a custom-command session', () => {
    expect(
      bad({
        profiles: [{ id: 'work', provider: 'claude', label: 'W' }],
        groups: [{ id: 'g', sessions: [{ name: 'sess', sessionId: 'sess', command: 'htop', cwd: '~/p', profileId: 'work' }] }]
      })
    ).toThrow(/custom command and cannot use a profile/);
  });

  it('rejects invalid ids, unsupported providers, empty labels, and duplicates', () => {
    expect(bad({ profiles: [{ id: 'Bad Id', provider: 'claude', label: 'x' }], groups: [] })).toThrow(/invalid id/);
    expect(bad({ profiles: [{ id: 'work', provider: 'opencode', label: 'x' }], groups: [] })).toThrow(/unsupported provider/);
    expect(bad({ profiles: [{ id: 'work', provider: 'claude', label: '  ' }], groups: [] })).toThrow(/empty label/);
    expect(
      bad({
        profiles: [
          { id: 'work', provider: 'claude', label: 'a' },
          { id: 'work', provider: 'codex', label: 'b' }
        ],
        groups: []
      })
    ).toThrow(/duplicate profile id/);
  });

  it('accepts a manifest with no profiles at all (additive schema)', () => {
    const parsed = parseDeskManifest(
      JSON.stringify({ groups: [{ id: 'g', sessions: [{ name: 'sess', sessionId: 'sess', agent: 'claude', cwd: '~/p' }] }] })
    );
    expect(parsed.profiles).toBeUndefined();
  });
});

describe('terminal launch injection', () => {
  it('leaves an ambient session byte-identical to a profile-free manifest', () => {
    const withProfiles = specFor('ambient-claude');
    const withoutProfiles = specFor(
      'ambient-claude',
      manifest({ profiles: undefined, groups: manifest().groups })
    );
    expect(withProfiles.command).toBe(withoutProfiles.command);
    expect(withProfiles.command).not.toContain('CLAUDE_CONFIG_DIR');
    expect(withProfiles.command).not.toContain('unset ');
    expect(withProfiles.profileId).toBeUndefined();
  });

  it('scrubs inherited credentials and points a profiled session at its own directory', () => {
    const spec = specFor('work-claude');
    expect(spec.profileId).toBe('work');
    expect(spec.command).toContain(`unset ${SCRUBBED_PROVIDER_ENV.join(' ')};`);
    expect(spec.command).toContain(`CLAUDE_CONFIG_DIR='${HOME}/.config/desk/profiles/work'`);
    // the scrub precedes the assignment, so nothing inherited can outrank it
    expect(spec.command.indexOf('unset ')).toBeLessThan(spec.command.indexOf('CLAUDE_CONFIG_DIR'));
  });

  it('survives a home path that tries to break out of the quoting', () => {
    // The prefix is a shell string, so the credential directory reaches `sh`
    // as source text. Prove the audited quoter holds by running the real
    // prefix through a real shell with a home path built to escape it.
    const hostile = "/home/e'; touch " + MARKER + "; echo '";
    const prefix = `${profileScrubPrefix()} ${profileEnvPrefix('claude', 'work', hostile)}`;
    const printed = execFileSync('sh', ['-c', `${prefix} printenv CLAUDE_CONFIG_DIR`], { encoding: 'utf8' });
    expect(printed.trim()).toBe(`${hostile}/.config/desk/profiles/work`);
    expect(existsSync(MARKER)).toBe(false);
  });

  it('scrubs an ambient key out of the child even when a profile is selected', () => {
    const prefix = `${profileScrubPrefix()} ${profileEnvPrefix('codex', 'work', HOME)}`;
    const printed = execFileSync('sh', ['-c', `${prefix} printenv ANTHROPIC_API_KEY || echo ABSENT`], {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: 'inherited-key' }
    });
    expect(printed.trim()).toBe('ABSENT');
  });

  it('carries a codex profile through its own variable', () => {
    const m = manifest({
      groups: [
        {
          id: 'main',
          sessions: [
            { name: 'work-codex', sessionId: 'work-codex', agent: 'codex', cwd: '~/p', uiMode: 'terminal', profileId: 'personal' }
          ]
        }
      ]
    });
    expect(specFor('work-codex', m).command).toContain(`CODEX_HOME='${HOME}/.config/desk/profiles/personal'`);
  });

  it('uses exact Claude resume without falling back to another conversation in a profile', () => {
    const m = manifest({
      groups: [
        {
          id: 'main',
          sessions: [
            {
              name: 'work-resume',
              sessionId: 'work-resume',
              agent: 'claude',
              cwd: '~/p',
              uiMode: 'terminal',
              profileId: 'work',
              resume: '11111111-2222-4333-8444-555555555555'
            }
          ]
        }
      ]
    });

    const command = specFor('work-resume', m).command;
    expect(command).toContain("--resume '11111111-2222-4333-8444-555555555555'");
    expect(command).not.toContain('--continue');
  });
});

describe('native launch injection', () => {
  const nativeSpec = (profileId?: string): SessionSpec =>
    ({
      groupId: 'g',
      groupLabel: 'G',
      name: 'chat',
      cwd: '/work',
      agent: 'claude',
      sessionId: 'chat',
      command: "cd '/work' && exec desk agent-host",
      uiMode: 'native',
      ...(profileId ? { profileId } : {})
    }) as SessionSpec;

  const ctx = { serverUrl: 'http://127.0.0.1:5190', token: 'tok' };

  it('leaves an ambient native launch untouched by profile plumbing', () => {
    const command = rewriteNativeLaunchCommand(nativeSpec(), ctx).command;
    expect(command).not.toContain('CLAUDE_CONFIG_DIR');
    expect(command).not.toContain('unset ');
  });

  it('scrubs and injects for a profiled native launch, before the Desk env', () => {
    const command = rewriteNativeLaunchCommand(nativeSpec('work'), ctx).command;
    expect(command).toContain('unset ');
    expect(command).toContain('CLAUDE_CONFIG_DIR=');
    expect(command.indexOf('unset ')).toBeLessThan(command.indexOf('DESK_SESSION_ID='));
  });
});

describe('API body parsing and respawn', () => {
  it('preserves a valid profileId and rejects a malformed one', () => {
    expect(readDeskSessionBody({ name: 's', cwd: '/x', agent: 'claude', profileId: 'work' }).profileId).toBe('work');
    expect(readDeskSessionBody({ name: 's', cwd: '/x', agent: 'claude' }).profileId).toBeUndefined();
    expect(() => readDeskSessionBody({ name: 's', cwd: '/x', agent: 'claude', profileId: '../escape' })).toThrow(
      /not a valid profile id/
    );
  });

  it('refuses a profile on a custom-command body at the API edge', () => {
    expect(() => readDeskSessionBody({ name: 's', cwd: '/x', command: 'htop', profileId: 'work' })).toThrow(
      /not supported for custom-command/
    );
  });

  it('treats a profile change as launch-relevant so the old account cannot keep answering', () => {
    const base = { sessionId: 'chat', uiMode: 'terminal', command: 'c', model: undefined } as unknown as SessionSpec;
    const withWork = { ...base, profileId: 'work' } as SessionSpec;
    const withPersonal = { ...base, profileId: 'personal' } as SessionSpec;

    expect(shouldRespawnAfterEdit(withWork, withPersonal, () => true)).toBe(true); // A -> B
    expect(shouldRespawnAfterEdit(base, withWork, () => true)).toBe(true); // ambient -> A
    expect(shouldRespawnAfterEdit(withWork, base, () => true)).toBe(true); // A -> ambient
    expect(shouldRespawnAfterEdit(withWork, { ...withWork }, () => true)).toBe(false); // unchanged
    expect(shouldRespawnAfterEdit(withWork, withPersonal, () => false)).toBe(false); // not running
  });
});

describe('profile id minting', () => {
  it('derives a valid id from a label and dedupes collisions', () => {
    expect(mintProfileId('Work account', new Set())).toBe('work-account');
    expect(mintProfileId('Work account', new Set(['work-account']))).toBe('work-account-2');
    expect(mintProfileId('!!', new Set())).toMatch(/^[a-z][a-z0-9-]{2,63}$/);
    expect(isValidProfileId(mintProfileId('123', new Set()))).toBe(true);
  });
});

describe('profiles survive the identity migration (regression: silent data loss)', () => {
  it('carries top-level profiles through applyMigratedSessionIds byte-for-byte', () => {
    const legacy = parseLegacyDeskManifest(
      [
        'profiles:',
        '  - id: work',
        '    provider: claude',
        '    label: Work account',
        '  - id: personal',
        '    provider: codex',
        '    label: Personal',
        'groups:',
        '  - id: main',
        '    sessions:',
        '      - name: chat',
        '        agent: claude',
        '        cwd: ~/p'
      ].join('\n')
    );
    expect(legacy.profiles).toHaveLength(2);

    const migration = migrateManifestSessions(deskManifestToEntries(legacy));
    const migrated = applyMigratedSessionIds(legacy, migration);

    // the whole point: the migration REPLACES the manifest, so an omitted
    // top-level key is silent data loss on the very next write
    expect(migrated.profiles).toEqual(legacy.profiles);
    expect(migrated.groups[0].sessions[0].sessionId).toBeTruthy();
  });

  it('keeps a profile-free manifest profile-free (no empty key invented)', () => {
    const legacy = parseLegacyDeskManifest(
      ['groups:', '  - id: main', '    sessions:', '      - name: chat', '        agent: claude', '        cwd: ~/p'].join('\n')
    );
    const migrated = applyMigratedSessionIds(legacy, migrateManifestSessions(deskManifestToEntries(legacy)));
    expect('profiles' in migrated).toBe(false);
  });
})
