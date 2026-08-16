import { afterEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  constants,
  type BigIntStats,
  type Dir,
  type Dirent,
  type OpenDirOptions,
  type PathLike,
  type StatOptions,
  type Stats
} from 'node:fs';
import {
  type FileHandle,
  link,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PROVIDER_EVIDENCE_MAX_DIRECTORY_ENTRIES,
  PROVIDER_EVIDENCE_MAX_LINE_BYTES,
  PROVIDER_EVIDENCE_MAX_PREFIX_BYTES,
  PROVIDER_EVIDENCE_MAX_RECORDS,
  verifyProviderSessionEvidence
} from '../src/server/providerSessionEvidence.js';
import { profileRoot } from '../src/shared/agentProfiles.js';

const fsPromisesMocks = vi.hoisted(() => ({
  open: vi.fn<typeof import('node:fs/promises').open>(),
  lstat: vi.fn<
    (path: PathLike, options?: StatOptions) => Promise<Stats | BigIntStats>
  >(),
  opendir: vi.fn<(path: PathLike, options?: OpenDirOptions) => Promise<Dir>>()
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsPromisesMocks.open.mockImplementation(actual.open);
  fsPromisesMocks.lstat.mockImplementation((candidatePath, options) =>
    actual.lstat(candidatePath, options)
  );
  fsPromisesMocks.opendir.mockImplementation((directoryPath, options) =>
    actual.opendir(directoryPath, options)
  );
  return {
    ...actual,
    open: fsPromisesMocks.open,
    lstat: fsPromisesMocks.lstat,
    opendir: fsPromisesMocks.opendir
  };
});

const temporaryHomes: string[] = [];

const INVALID_EVIDENCE_REQUEST = {
  ok: false,
  code: 'evidence-invalid-request',
  error: 'provider session evidence request is invalid'
} as const;

function injectedFsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected filesystem failure: ${code}`), { code });
}

interface DirectoryMembershipRaceState {
  descriptorOpened: boolean;
  childHidden: boolean;
  childRestoredAtEof: boolean;
}

async function installRestoredDirectoryMembershipRace(
  directoryPath: string,
  childPath: string,
  displacedChildPath: string
): Promise<DirectoryMembershipRaceState> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises'
  );
  const canonicalDirectoryPath = await actual.realpath(directoryPath);
  const childName = path.basename(childPath);
  const state: DirectoryMembershipRaceState = {
    descriptorOpened: false,
    childHidden: false,
    childRestoredAtEof: false
  };

  fsPromisesMocks.opendir.mockImplementation(async (openedPath, options) => {
    const directory = await actual.opendir(openedPath, options);
    let canonicalOpenedPath: string;
    try {
      canonicalOpenedPath = await actual.realpath(String(openedPath));
    } catch {
      return directory;
    }
    if (state.descriptorOpened || canonicalOpenedPath !== canonicalDirectoryPath) {
      return directory;
    }
    state.descriptorOpened = true;

    let entries: Dirent[] | undefined;
    let nextEntry = 0;
    return {
      read: async () => {
        if (entries === undefined) {
          entries = [];
          await rename(childPath, displacedChildPath);
          state.childHidden = true;
          try {
            for (;;) {
              const entry = await directory.read();
              if (entry === null) break;
              if (entry.name !== childName) entries.push(entry);
            }
          } finally {
            await rename(displacedChildPath, childPath);
            const epochMarker = new Date(Date.now() + 86_400_000);
            await utimes(directoryPath, epochMarker, epochMarker);
            state.childRestoredAtEof = true;
          }
        }
        return entries[nextEntry++] ?? null;
      },
      close: () => directory.close()
    } as unknown as Dir;
  });

  return state;
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsPromisesMocks.open.mockReset();
  fsPromisesMocks.open.mockImplementation(actual.open);
  fsPromisesMocks.lstat.mockReset();
  fsPromisesMocks.lstat.mockImplementation((candidatePath, options) =>
    actual.lstat(candidatePath, options)
  );
  fsPromisesMocks.opendir.mockReset();
  fsPromisesMocks.opendir.mockImplementation((directoryPath, options) =>
    actual.opendir(directoryPath, options)
  );
  await Promise.all(temporaryHomes.splice(0).map((homeDir) => rm(homeDir, { recursive: true, force: true })));
});

describe('verifyProviderSessionEvidence', () => {
  test('exports the exact hard resource bounds', () => {
    expect(PROVIDER_EVIDENCE_MAX_DIRECTORY_ENTRIES).toBe(65_536);
    expect(PROVIDER_EVIDENCE_MAX_PREFIX_BYTES).toBe(256 * 1_024);
    expect(PROVIDER_EVIDENCE_MAX_RECORDS).toBe(64);
    expect(PROVIDER_EVIDENCE_MAX_LINE_BYTES).toBe(64 * 1_024);
  });

  test('rejects a non-UUID provider session id before filesystem lookup', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId: '../not-a-runtime-uuid',
        selected: { cwd: '/workspace/example' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-invalid-request',
      error: 'provider session evidence request is invalid'
    });
  });

  test('rejects a runtime provider outside the Claude and Codex evidence adapters', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'bash' as never,
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: { cwd: '/workspace/example' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-invalid-request',
      error: 'provider session evidence request is invalid'
    });
  });

  test('rejects an invalid selected profile id before resolving its root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: { profileId: '../escape', cwd: '/workspace/example' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-invalid-request',
      error: 'provider session evidence request is invalid'
    });
  });

  test.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['a number', () => 42],
    ['a string', () => 'request'],
    ['a boolean', () => true],
    ['an array', () => []],
    [
      'a proxy',
      () =>
        new Proxy(
          {
            provider: 'claude',
            providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
            selected: { cwd: '/workspace/example' },
            homeDir: '/tmp',
            notBeforeMs: 0
          },
          {}
        )
    ],
    [
      'a throwing top-level getter',
      () =>
        Object.defineProperty({}, 'provider', {
          enumerable: true,
          get: () => {
            throw new Error('provider getter must not escape');
          }
        })
    ]
  ] as const)('returns typed invalid-request without throwing for %s options', async (_label, makeOptions) => {
    await expect(
      verifyProviderSessionEvidence(makeOptions() as never)
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['an array', () => []],
    ['a proxy', () => new Proxy({ cwd: '/workspace/example' }, {})],
    [
      'a throwing profile getter',
      () =>
        Object.defineProperty({}, 'profileId', {
          enumerable: true,
          get: () => {
            throw new Error('profile getter must not escape');
          }
        })
    ],
    [
      'a throwing cwd getter',
      () =>
        Object.defineProperty({}, 'cwd', {
          enumerable: true,
          get: () => {
            throw new Error('cwd getter must not escape');
          }
        })
    ]
  ] as const)('returns typed invalid-request without throwing for selected=%s', async (_label, makeSelected) => {
    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: makeSelected(),
        homeDir: '/tmp',
        notBeforeMs: 0
      } as never)
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test('rejects an own undefined profile id instead of treating it as absent', async () => {
    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: { cwd: '/workspace/example', profileId: undefined },
        homeDir: '/tmp',
        notBeforeMs: 0
      } as never)
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test.each([
    ['empty', ''],
    ['relative', 'workspace/example'],
    ['NUL-containing', '/workspace/example\u0000escape']
  ] as const)('rejects a %s selected cwd at the request boundary', async (_label, cwd) => {
    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: { cwd },
        homeDir: '/tmp',
        notBeforeMs: 0
      })
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test('rejects a numeric cwd even when matching Codex JSON would otherwise accept it', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '133e4567-e89b-42d3-a456-426614174000';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd: 42 }
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd: 42 },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      } as never)
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test.each([
    ['empty', ''],
    ['relative', 'tmp/desk-home'],
    ['NUL-containing', '/tmp/desk-home\u0000escape'],
    ['numeric', 42]
  ] as const)('rejects a %s homeDir without throwing', async (_label, homeDir) => {
    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: { cwd: '/workspace/example' },
        homeDir,
        notBeforeMs: 0
      } as never)
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test.each([
    ['an object provider session id', { toString: () => '123e4567-e89b-42d3-a456-426614174000' }],
    ['an unsafe freshness boundary', Number.MAX_SAFE_INTEGER + 1]
  ] as const)('rejects %s at the runtime request boundary', async (label, value) => {
    const input =
      label === 'an object provider session id'
        ? {
            provider: 'claude',
            providerSessionId: value,
            selected: { cwd: '/workspace/example' },
            homeDir: '/tmp',
            notBeforeMs: 0
          }
        : {
            provider: 'claude',
            providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
            selected: { cwd: '/workspace/example' },
            homeDir: '/tmp',
            notBeforeMs: value
          };
    await expect(
      verifyProviderSessionEvidence(input as never)
    ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
  });

  test.each(['selected', 'homeDir', 'notBeforeMs'] as const)(
    'contains a throwing %s getter as typed invalid-request',
    async (property) => {
      const input: Record<string, unknown> = {
        provider: 'claude',
        providerSessionId: '123e4567-e89b-42d3-a456-426614174000',
        selected: { cwd: '/workspace/example' },
        homeDir: '/tmp',
        notBeforeMs: 0
      };
      Object.defineProperty(input, property, {
        enumerable: true,
        get: () => {
          throw new Error(`${property} getter must not escape`);
        }
      });

      await expect(
        verifyProviderSessionEvidence(input as never)
      ).resolves.toEqual(INVALID_EVIDENCE_REQUEST);
    }
  );

  test('accepts exact Codex session metadata from the ambient profile', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const cwd = '/workspace/example';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    const result = await verifyProviderSessionEvidence({
      provider: 'codex',
      providerSessionId,
      selected: { cwd },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    });

    expect(result).toEqual({
      ok: true,
      provider: 'codex',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });

  test('accepts Claude only after a record proves both the exact id and cwd', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '234e5678-e89b-42d3-a456-426614174001';
    const cwd = '/workspace/example';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-example',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      [
        JSON.stringify({ type: 'queue-operation', sessionId: providerSessionId }),
        JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })
      ].join('\n') + '\n',
      'utf8'
    );

    const result = await verifyProviderSessionEvidence({
      provider: 'claude',
      providerSessionId,
      selected: { cwd },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    });

    expect(result).toEqual({
      ok: true,
      provider: 'claude',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });

  test('accepts Codex evidence only from the selected profile root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '345e6789-e89b-42d3-a456-426614174002';
    const cwd = '/workspace/selected';
    const evidencePath = path.join(
      profileRoot('work', homeDir),
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    const result = await verifyProviderSessionEvidence({
      provider: 'codex',
      providerSessionId,
      selected: { profileId: 'work', cwd },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    });

    expect(result).toEqual({
      ok: true,
      provider: 'codex',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });

  test('accepts Claude evidence from the selected profile root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '456e789a-e89b-42d3-a456-426614174003';
    const cwd = '/workspace/claude-selected';
    const evidencePath = path.join(
      profileRoot('work', homeDir),
      'projects',
      '-workspace-claude-selected',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    const result = await verifyProviderSessionEvidence({
      provider: 'claude',
      providerSessionId,
      selected: { profileId: 'work', cwd },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    });

    expect(result).toEqual({
      ok: true,
      provider: 'claude',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });

  test('rejects evidence whose file mtime predates launch-proof issuance', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '467e89ab-e89b-42d3-a456-426614174004';
    const cwd = '/workspace/stale';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-stale',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    const notBeforeMs = Date.now();
    const staleTime = new Date(notBeforeMs - 10_000);
    await utimes(evidencePath, staleTime, staleTime);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-stale',
      error: 'provider session evidence predates this launch'
    });
  });

  test('enforces the launch-proof mtime fence for Codex evidence too', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '478e9abc-e89b-42d3-a456-426614174005';
    const cwd = '/workspace/codex-stale';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );
    const notBeforeMs = Date.now();
    const staleTime = new Date(notBeforeMs - 10_000);
    await utimes(evidencePath, staleTime, staleTime);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-stale',
      error: 'provider session evidence predates this launch'
    });
  });

  test('returns a typed mismatch for a Codex file with the wrong embedded id', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '567e89ab-e89b-42d3-a456-426614174004';
    const cwd = '/workspace/example';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: '678e9abc-e89b-42d3-a456-426614174005', cwd }
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-mismatch',
      error: 'provider session evidence did not match the requested identity'
    });
  });

  test('returns a typed mismatch when Claude has only an id-only queue record', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '789eabcd-e89b-42d3-a456-426614174006';
    const cwd = '/workspace/example';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-example',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'queue-operation', sessionId: providerSessionId })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-mismatch',
      error: 'provider session evidence did not match the requested identity'
    });
  });

  test('returns typed not-found instead of falling back to ambient for a selected profile', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '89abcdef-e89b-42d3-a456-426614174007';
    const cwd = '/workspace/example';
    const ambientPath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(ambientPath), { recursive: true });
    await writeFile(
      ambientPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { profileId: 'work', cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('rejects an absent Claude leaf beneath a symlinked provider root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '4a6e789a-e89b-42d3-a456-426614174003';
    const cwd = '/workspace/absent-root-symlink';
    const outsideRoot = path.join(homeDir, 'outside-claude-root');
    await mkdir(path.join(outsideRoot, 'projects', '-workspace-absent-root-symlink'), {
      recursive: true
    });
    await symlink(
      outsideRoot,
      path.join(homeDir, '.claude'),
      'dir'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects an absent Claude leaf beneath a symlinked exact project component', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '4b6e789a-e89b-42d3-a456-426614174003';
    const cwd = '/workspace/absent-project-symlink';
    const projectsRoot = path.join(homeDir, '.claude', 'projects');
    const outsideProject = path.join(homeDir, 'outside-claude-project');
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(outsideProject, { recursive: true });
    await symlink(
      outsideProject,
      path.join(projectsRoot, '-workspace-absent-project-symlink'),
      'dir'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('returns not-found for an absent Claude leaf beneath a safe exact project', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '4c6e789a-e89b-42d3-a456-426614174003';
    const cwd = '/workspace/safe-absent-leaf';
    await mkdir(
      path.join(homeDir, '.claude', 'projects', '-workspace-safe-absent-leaf'),
      { recursive: true }
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test.each(['provider root', 'projects directory'] as const)(
    'rejects a Claude exact child removed from the open %s',
    async (level) => {
      const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
      temporaryHomes.push(homeDir);
      const providerSessionId = '4c7e789a-e89b-42d3-a456-426614174003';
      const cwd = '/workspace/removed-exact-child';
      const providerRoot = path.join(homeDir, '.claude');
      const projectsRoot = path.join(providerRoot, 'projects');
      const projectPath = path.join(projectsRoot, '-workspace-removed-exact-child');
      const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
      await mkdir(projectPath, { recursive: true });
      await writeFile(
        evidencePath,
        `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
        'utf8'
      );
      const parentPath = level === 'provider root' ? providerRoot : projectsRoot;
      const childPath = level === 'provider root' ? projectsRoot : projectPath;
      const displacedChildPath = path.join(
        homeDir,
        level === 'provider root'
          ? 'displaced-claude-projects'
          : 'displaced-claude-project'
      );
      let childHidden = false;

      let result;
      try {
        result = await verifyProviderSessionEvidence(
          {
            provider: 'claude',
            providerSessionId,
            selected: { cwd },
            homeDir,
            notBeforeMs: Date.now() - 1_000
          },
          {
            afterDirectoryOpen: async (directoryPath) => {
              if (childHidden || directoryPath !== parentPath) return;
              await rename(childPath, displacedChildPath);
              const epochMarker = new Date(Date.now() + 86_400_000);
              await utimes(parentPath, epochMarker, epochMarker);
              childHidden = true;
            }
          }
        );
      } finally {
        if (childHidden) await rename(displacedChildPath, childPath);
      }

      expect(childHidden).toBe(true);
      expect(result).toEqual({
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      });
    }
  );

  test('rejects a Claude transcript removed after its project descriptor opens', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '4c8e789a-e89b-42d3-a456-426614174003';
    const cwd = '/workspace/removed-transcript-after-open';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-removed-transcript-after-open'
    );
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    const displacedEvidencePath = path.join(homeDir, 'displaced-claude-transcript.jsonl');
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    let transcriptHidden = false;

    let result;
    try {
      result = await verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryOpen: async (directoryPath) => {
            if (transcriptHidden || directoryPath !== projectPath) return;
            await rename(evidencePath, displacedEvidencePath);
            const epochMarker = new Date(Date.now() + 86_400_000);
            await utimes(projectPath, epochMarker, epochMarker);
            transcriptHidden = true;
          }
        }
      );
    } finally {
      if (transcriptHidden) await rename(displacedEvidencePath, evidencePath);
    }

    expect(transcriptHidden).toBe(true);
    expect(result).toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('returns not-found for a genuinely absent Claude provider root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '4d6e789a-e89b-42d3-a456-426614174003',
        selected: { cwd: '/workspace/absent-provider-root' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('returns not-found for a genuinely absent Claude project component', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    await mkdir(path.join(homeDir, '.claude', 'projects'), { recursive: true });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '4e6e789a-e89b-42d3-a456-426614174003',
        selected: { cwd: '/workspace/absent-project-component' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('rejects a special Claude project component even when the leaf is absent', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const projectsRoot = path.join(homeDir, '.claude', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    await writeFile(
      path.join(projectsRoot, '-workspace-special-project-component'),
      'not a directory',
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId: '4f6e789a-e89b-42d3-a456-426614174003',
        selected: { cwd: '/workspace/special-project-component' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects an absent Claude leaf after its project directory identity changes', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '506e789a-e89b-42d3-a456-426614174003';
    const cwd = '/workspace/absent-leaf-project-race';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-absent-leaf-project-race'
    );
    const displacedProject = path.join(homeDir, 'displaced-absent-leaf-project');
    await mkdir(projectPath, { recursive: true });
    let moved = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryOpen: async (directoryPath) => {
            if (moved || directoryPath !== projectPath) return;
            await rename(projectPath, displacedProject);
            await symlink(
              displacedProject,
              projectPath,
              'dir'
            );
            moved = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(moved).toBe(true);
  });

  test('returns a typed mismatch when Claude proves the id under the wrong cwd', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '9abcdef0-e89b-42d3-a456-426614174008';
    const cwd = '/workspace/example';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-example',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'user',
        sessionId: providerSessionId,
        cwd: '/workspace/other'
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-mismatch',
      error: 'provider session evidence did not match the requested identity'
    });
  });

  test('rejects malformed complete JSONL before otherwise eligible Claude metadata', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'abcdef01-e89b-42d3-a456-426614174009';
    const cwd = '/workspace/malformed';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-malformed',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `{"type":"broken"\n${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-malformed',
      error: 'provider session evidence contains malformed JSON'
    });
  });

  test.each([
    ['a leading', '\n'],
    ['an interior', `${JSON.stringify({ type: 'noise' })}\n\n`]
  ] as const)(
    'rejects %s zero-byte complete JSONL record before eligible Claude metadata',
    async (_position, prefix) => {
      const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
      temporaryHomes.push(homeDir);
      const providerSessionId = 'abdef012-e89b-42d3-a456-426614174010';
      const cwd = '/workspace/empty-jsonl-record';
      const evidencePath = path.join(
        homeDir,
        '.claude',
        'projects',
        '-workspace-empty-jsonl-record',
        `${providerSessionId}.jsonl`
      );
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(
        evidencePath,
        `${prefix}${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
        'utf8'
      );

      await expect(
        verifyProviderSessionEvidence({
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        })
      ).resolves.toEqual({
        ok: false,
        code: 'evidence-malformed',
        error: 'provider session evidence contains malformed JSON'
      });
    }
  );

  test('rejects malformed complete JSONL before otherwise eligible Codex metadata', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'bcdef012-e89b-42d3-a456-426614174010';
    const cwd = '/workspace/codex-malformed';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `{"type":"broken"\n${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-malformed',
      error: 'provider session evidence contains malformed JSON'
    });
  });

  test('rejects invalid UTF-8 bytes instead of replacement-decoding eligible JSONL', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'ccdef012-e89b-42d3-a456-426614174010';
    const cwd = '/workspace/invalid-utf8';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-invalid-utf8',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      Buffer.concat([
        Buffer.from('{"noise":"', 'utf8'),
        Buffer.from([0x80]),
        Buffer.from(
          `","type":"user","sessionId":"${providerSessionId}","cwd":"${cwd}"}\n`,
          'utf8'
        )
      ])
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-malformed',
      error: 'provider session evidence contains malformed JSON'
    });
  });

  test('rejects a complete JSONL record larger than 64 KiB', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'cdef0123-e89b-42d3-a456-426614174011';
    const cwd = '/workspace/oversized';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-oversized',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const oversized = JSON.stringify({ payload: 'x'.repeat(PROVIDER_EVIDENCE_MAX_LINE_BYTES) });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(PROVIDER_EVIDENCE_MAX_LINE_BYTES);
    await writeFile(
      evidencePath,
      `${oversized}\n${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-line-too-long',
      error: 'provider session evidence contains an oversized JSONL record'
    });
  });

  test('rejects a line proven oversized before its newline falls beyond the prefix', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'cef01234-e89b-42d3-a456-426614174012';
    const cwd = '/workspace/oversized-prefix-line';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-oversized-prefix-line',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ payload: 'x'.repeat(PROVIDER_EVIDENCE_MAX_PREFIX_BYTES * 2) })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-line-too-long',
      error: 'provider session evidence contains an oversized JSONL record'
    });
  });

  test('does not inspect an eligible record after the 64-record bound', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'def01234-e89b-42d3-a456-426614174012';
    const cwd = '/workspace/record-bound';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-record-bound',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const records = Array.from({ length: PROVIDER_EVIDENCE_MAX_RECORDS }, (_, index) =>
      JSON.stringify({ type: 'queue-operation', index })
    );
    records.push(JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd }));
    await writeFile(evidencePath, `${records.join('\n')}\n`, 'utf8');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-scan-bound-exhausted',
      error: 'provider session evidence scan bound was exhausted'
    });
  });

  test('does not inspect an empty 65th complete record', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'df012345-e89b-42d3-a456-426614174012';
    const cwd = '/workspace/empty-record-bound';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-empty-record-bound',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const records = Array.from({ length: PROVIDER_EVIDENCE_MAX_RECORDS }, (_, index) =>
      JSON.stringify({ type: 'queue-operation', index })
    );
    await writeFile(
      evidencePath,
      `${records.join('\n')}\n\n${JSON.stringify({
        type: 'user',
        sessionId: providerSessionId,
        cwd
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-scan-bound-exhausted',
      error: 'provider session evidence scan bound was exhausted'
    });
  });

  test('does not inspect eligible metadata beyond the 256 KiB prefix', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'ef012345-e89b-42d3-a456-426614174013';
    const cwd = '/workspace/prefix-bound';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-prefix-bound',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const paddingRecord = JSON.stringify({
      padding: 'x'.repeat(PROVIDER_EVIDENCE_MAX_LINE_BYTES - 32)
    });
    expect(Buffer.byteLength(paddingRecord)).toBeLessThanOrEqual(PROVIDER_EVIDENCE_MAX_LINE_BYTES);
    expect(Buffer.byteLength(`${paddingRecord}\n`.repeat(5))).toBeGreaterThan(
      PROVIDER_EVIDENCE_MAX_PREFIX_BYTES
    );
    await writeFile(
      evidencePath,
      `${paddingRecord}\n`.repeat(5) +
        `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-scan-bound-exhausted',
      error: 'provider session evidence scan bound was exhausted'
    });
  });

  test('applies the bounded prefix reader to Codex transcripts too', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'f0123456-e89b-42d3-a456-426614174014';
    const cwd = '/workspace/codex-prefix-bound';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const paddingRecord = JSON.stringify({
      padding: 'x'.repeat(PROVIDER_EVIDENCE_MAX_LINE_BYTES - 32)
    });
    await writeFile(
      evidencePath,
      `${paddingRecord}\n`.repeat(5) +
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd }
        })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-scan-bound-exhausted',
      error: 'provider session evidence scan bound was exhausted'
    });
  });

  test('accepts an eligible complete record in the prefix of a larger transcript', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '01234567-e89b-42d3-a456-426614174015';
    const cwd = '/workspace/large-valid';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-large-valid',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    await writeFile(
      evidencePath,
      eligible + 'x'.repeat(PROVIDER_EVIDENCE_MAX_PREFIX_BYTES * 2),
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: true,
      provider: 'claude',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });

  test('continues positional reads after deterministic short chunks', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '02234567-e89b-42d3-a456-426614174015';
    const cwd = '/workspace/short-reads';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-short-reads',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    let readCalls = 0;

    const result = await verifyProviderSessionEvidence(
      {
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      },
      {
        readChunk: async (
          handle: FileHandle,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number
        ) => {
          readCalls += 1;
          return handle.read(buffer, offset, Math.min(length, 7), position);
        }
      }
    );

    expect(result).toEqual({
      ok: true,
      provider: 'claude',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
    expect(readCalls).toBeGreaterThan(1);
  });

  test('stops slicing JSONL after an eligible record in a newline-heavy prefix', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '03234567-e89b-42d3-a456-426614174015';
    const cwd = '/workspace/lazy-jsonl';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-lazy-jsonl',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    await writeFile(
      evidencePath,
      eligible + '\n'.repeat(PROVIDER_EVIDENCE_MAX_PREFIX_BYTES),
      'utf8'
    );

    const originalSubarray = Buffer.prototype.subarray;
    let subarrayCalls = 0;
    const subarraySpy = vi
      .spyOn(Buffer.prototype, 'subarray')
      .mockImplementation(function (this: Buffer, start?: number, end?: number) {
        subarrayCalls += 1;
        return originalSubarray.call(this, start, end);
      });
    let result: Awaited<ReturnType<typeof verifyProviderSessionEvidence>> | undefined;
    try {
      result = await verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      });
    } finally {
      subarraySpy.mockRestore();
    }

    expect(result).toEqual({
      ok: true,
      provider: 'claude',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
    expect(subarrayCalls).toBeLessThanOrEqual(3);
  });

  test.each(['EACCES', 'EIO', 'ENOTDIR', 'EMFILE'] as const)(
    'classifies an initial candidate lstat %s failure as typed unsafe evidence',
    async (code) => {
      const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
      temporaryHomes.push(homeDir);
      const providerSessionId = '04234567-e89b-42d3-a456-426614174015';
      const cwd = '/workspace/initial-lstat-failure';
      const evidencePath = path.join(
        homeDir,
        '.claude',
        'projects',
        '-workspace-initial-lstat-failure',
        `${providerSessionId}.jsonl`
      );
      await mkdir(path.dirname(evidencePath), { recursive: true });
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      );
      fsPromisesMocks.lstat.mockImplementation(async (candidatePath, options) => {
        if (path.basename(String(candidatePath)) === path.basename(evidencePath)) {
          throw injectedFsError(code);
        }
        return actual.lstat(candidatePath, options);
      });

      await expect(
        verifyProviderSessionEvidence({
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        })
      ).resolves.toEqual({
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      });
      expect(
        fsPromisesMocks.lstat.mock.calls.some(
          ([candidatePath]) => path.basename(String(candidatePath)) === path.basename(evidencePath)
        )
      ).toBe(true);
    }
  );

  test.each([
    [
      'ENOENT',
      {
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      }
    ],
    [
      'EACCES',
      {
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      }
    ],
    [
      'EIO',
      {
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      }
    ]
  ] as const)('classifies an opendir %s failure without collapsing I/O to absence', async (code, expected) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    await mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true });
    fsPromisesMocks.opendir.mockRejectedValueOnce(injectedFsError(code));

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId: '10234567-e89b-42d3-a456-426614174016',
        selected: { cwd: '/workspace/opendir-failure' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual(expected);
  });

  test('resolves a typed unsafe result and closes after an injected directory read failure', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    await mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true });
    let closeCalls = 0;
    const directory = {
      read: async () => {
        throw injectedFsError('EIO');
      },
      close: async () => {
        closeCalls += 1;
      }
    } as unknown as Dir;
    fsPromisesMocks.opendir.mockResolvedValueOnce(directory);

    const result = await verifyProviderSessionEvidence({
      provider: 'codex',
      providerSessionId: '10334567-e89b-42d3-a456-426614174016',
      selected: { cwd: '/workspace/read-failure' },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    }).catch((error: unknown) => error);

    expect(closeCalls).toBe(1);
    expect(result).toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('resolves a typed unsafe result after an injected directory close failure', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    await mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true });
    let closeCalls = 0;
    const directory = {
      read: async () => null,
      close: async () => {
        closeCalls += 1;
        throw injectedFsError('EIO');
      }
    } as unknown as Dir;
    fsPromisesMocks.opendir.mockResolvedValueOnce(directory);

    const result = await verifyProviderSessionEvidence({
      provider: 'codex',
      providerSessionId: '10434567-e89b-42d3-a456-426614174016',
      selected: { cwd: '/workspace/close-failure' },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    }).catch((error: unknown) => error);

    expect(closeCalls).toBe(1);
    expect(result).toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('fails closed when the total Codex directory-entry budget is exhausted', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '11234567-e89b-42d3-a456-426614174016';
    const cwd = '/workspace/directory-bound';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        { limits: { maxDirectoryEntries: 3 } }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-scan-bound-exhausted',
      error: 'provider session evidence scan bound was exhausted'
    });
  });

  test('accepts an eligible Codex candidate at the exact directory-entry budget', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '12234567-e89b-42d3-a456-426614174016';
    const cwd = '/workspace/exact-directory-bound';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        { limits: { maxDirectoryEntries: 4 } }
      )
    ).resolves.toEqual({
      ok: true,
      provider: 'codex',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });

  test('opens only the newest numeric Codex candidate for the exact UUID', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '21234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/newest-only';
    const root = path.join(homeDir, '.codex', 'sessions');
    const olderPath = path.join(
      root,
      '2025',
      '12',
      '31',
      `rollout-2025-12-31T23-59-59-${providerSessionId}.jsonl`
    );
    const newestPath = path.join(
      root,
      '2026',
      '01',
      '01',
      `rollout-2026-01-01T00-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(olderPath), { recursive: true });
    await mkdir(path.dirname(newestPath), { recursive: true });
    await writeFile(
      olderPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );
    await writeFile(
      newestPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd: '/workspace/wrong' }
      })}\n`,
      'utf8'
    );
    const openedPaths: string[] = [];

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        { beforeOpen: (candidatePath) => openedPaths.push(candidatePath) }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-mismatch',
      error: 'provider session evidence did not match the requested identity'
    });
    expect(openedPaths).toEqual([newestPath]);
  });

  test('rejects an older Codex candidate when an exact record appears in an already-scanned newer day', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '22234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/newer-day-epoch';
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const newerDayPath = path.join(sessionsRoot, '2026', '08', '13');
    const olderYearPath = path.join(sessionsRoot, '2025');
    const olderDayPath = path.join(olderYearPath, '08', '13');
    const newerPath = path.join(
      newerDayPath,
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const olderPath = path.join(
      olderDayPath,
      `rollout-2025-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(newerDayPath, { recursive: true });
    await mkdir(olderDayPath, { recursive: true });
    let insertedAfterNewerDayClosed = false;
    const openedPaths: string[] = [];

    const result = await verifyProviderSessionEvidence(
      {
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      },
      {
        beforeOpen: (candidatePath) => openedPaths.push(candidatePath),
        beforeDirectoryOpen: async (directoryPath) => {
          if (insertedAfterNewerDayClosed || directoryPath !== olderYearPath) return;
          await writeFile(
            newerPath,
            `${JSON.stringify({
              type: 'session_meta',
              payload: { id: providerSessionId, cwd: '/workspace/wrong' }
            })}\n`,
            'utf8'
          );
          await writeFile(
            olderPath,
            `${JSON.stringify({
              type: 'session_meta',
              payload: { id: providerSessionId, cwd }
            })}\n`,
            'utf8'
          );
          insertedAfterNewerDayClosed = true;
        }
      }
    );

    expect(insertedAfterNewerDayClosed).toBe(true);
    expect(openedPaths).toEqual([olderPath]);
    expect(result).toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test.each([
    ['year', ['2026']],
    ['month', ['2026', '08']],
    ['day', ['2026', '08', '13']]
  ] as const)('rejects a numeric Codex %s entry that is a regular file', async (_level, parts) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const malformedPath = path.join(sessionsRoot, ...parts);
    await mkdir(path.dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, 'not a directory', 'utf8');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId: '28234567-e89b-42d3-a456-426614174017',
        selected: { cwd: '/workspace/numeric-regular-entry' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('does not bypass a newer numeric regular entry to accept older valid evidence', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '29234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/newer-malformed-year';
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const evidencePath = path.join(
      sessionsRoot,
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );
    await writeFile(path.join(sessionsRoot, '2027'), 'not a directory', 'utf8');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test.each([
    ['year', [], '2027'],
    ['month', ['2026'], '09'],
    ['day', ['2026', '08'], '14']
  ] as const)(
    'does not accept older Codex evidence when a malformed newer numeric %s is hidden for one directory epoch',
    async (level, parentParts, malformedName) => {
      const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
      temporaryHomes.push(homeDir);
      const providerSessionId = '29a34567-e89b-42d3-a456-426614174017';
      const cwd = `/workspace/hidden-newer-${level}`;
      const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
      const evidencePath = path.join(
        sessionsRoot,
        '2026',
        '08',
        '13',
        `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
      );
      const parentPath = path.join(sessionsRoot, ...parentParts);
      const malformedPath = path.join(parentPath, malformedName);
      const displacedMalformedPath = path.join(
        homeDir,
        `displaced-newer-${level}`
      );
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(
        evidencePath,
        `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
        'utf8'
      );
      await writeFile(malformedPath, 'not a directory', 'utf8');
      const race = await installRestoredDirectoryMembershipRace(
        parentPath,
        malformedPath,
        displacedMalformedPath
      );

      const result = await verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      });

      expect(race).toEqual({
        descriptorOpened: true,
        childHidden: true,
        childRestoredAtEof: true
      });
      expect(result).toEqual({
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      });
    }
  );

  test('does not accept an older exact Codex candidate hidden behind a restored malformed newer candidate', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '29b34567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/hidden-newer-exact-candidate';
    const dayPath = path.join(homeDir, '.codex', 'sessions', '2026', '08', '13');
    const olderPath = path.join(
      dayPath,
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const newerPath = path.join(
      dayPath,
      `rollout-2026-08-13T11-00-00-${providerSessionId}.jsonl`
    );
    const displacedNewerPath = path.join(homeDir, 'displaced-newer-exact.jsonl');
    await mkdir(dayPath, { recursive: true });
    await writeFile(
      olderPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );
    await writeFile(newerPath, 'not-json\n', 'utf8');
    const race = await installRestoredDirectoryMembershipRace(
      dayPath,
      newerPath,
      displacedNewerPath
    );

    const result = await verifyProviderSessionEvidence({
      provider: 'codex',
      providerSessionId,
      selected: { cwd },
      homeDir,
      notBeforeMs: Date.now() - 1_000
    });

    expect(race).toEqual({
      descriptorOpened: true,
      childHidden: true,
      childRestoredAtEof: true
    });
    expect(result).toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test(
    'rejects a numeric Codex hierarchy entry that is a FIFO',
    async () => {
      const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
      temporaryHomes.push(homeDir);
      const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
      await mkdir(sessionsRoot, { recursive: true });
      const fifo = spawnSync('mkfifo', [path.join(sessionsRoot, '2026')], {
        encoding: 'utf8'
      });
      if (fifo.status !== 0) throw new Error(`mkfifo failed: ${fifo.stderr}`);

      await expect(
        verifyProviderSessionEvidence({
          provider: 'codex',
          providerSessionId: '2a234567-e89b-42d3-a456-426614174017',
          selected: { cwd: '/workspace/numeric-fifo-entry' },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        })
      ).resolves.toEqual({
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      });
    }
  );

  test('fails closed when a numeric Codex entry has an unknown Dirent type', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2b234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/unknown-dirent-type';
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const evidencePath = path.join(
      sessionsRoot,
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
    const canonicalSessionsRoot = await actual.realpath(sessionsRoot);
    fsPromisesMocks.opendir.mockImplementation(async (directoryPath, options) => {
      const directory = await actual.opendir(directoryPath, options);
      if ((await actual.realpath(String(directoryPath))) !== canonicalSessionsRoot) {
        return directory;
      }
      return {
        read: async () => {
          const entry = await directory.read();
          if (entry?.name !== '2026') return entry;
          return {
            name: entry.name,
            parentPath: entry.parentPath,
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isDirectory: () => false,
            isFIFO: () => false,
            isFile: () => false,
            isSocket: () => false,
            isSymbolicLink: () => false
          } as Dirent;
        },
        close: () => directory.close()
      } as unknown as Dir;
    });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('ignores an irrelevant nonnumeric regular Codex hierarchy entry', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(path.join(sessionsRoot, 'latest'), 'not numeric', 'utf8');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId: '2c234567-e89b-42d3-a456-426614174017',
        selected: { cwd: '/workspace/irrelevant-nonnumeric-entry' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('rejects a Codex sessions-root symlink without traversing its target', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '29234567-e89b-42d3-a456-426614174017';
    const providerRoot = path.join(homeDir, '.codex');
    const outsideSessions = path.join(homeDir, 'outside-sessions');
    await mkdir(providerRoot, { recursive: true });
    await mkdir(path.join(outsideSessions, '2026'), { recursive: true });
    await symlink(
      outsideSessions,
      path.join(providerRoot, 'sessions'),
      'dir'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd: '/workspace/sessions-root-symlink' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a numeric Codex hierarchy symlink without traversing its target', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2a234567-e89b-42d3-a456-426614174017';
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const outsideYear = path.join(homeDir, 'outside-year');
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(path.join(outsideYear, '08'), { recursive: true });
    await symlink(
      outsideYear,
      path.join(sessionsRoot, '2026'),
      'dir'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd: '/workspace/year-symlink' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a Codex component replaced after its parent entry is read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2b234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/component-replacement';
    const yearPath = path.join(homeDir, '.codex', 'sessions', '2026');
    const displacedYear = path.join(homeDir, 'displaced-year');
    const evidencePath = path.join(
      yearPath,
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    let replaced = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          beforeDirectoryOpen: async (directoryPath) => {
            if (replaced || directoryPath !== yearPath) return;
            await rename(yearPath, displacedYear);
            await symlink(
              displacedYear,
              yearPath,
              'dir'
            );
            replaced = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(replaced).toBe(true);
  });

  test('rejects a Codex component moved after descriptor open but before directory read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2c234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/post-directory-open-move';
    const yearPath = path.join(homeDir, '.codex', 'sessions', '2026');
    const displacedYear = path.join(homeDir, 'post-open-displaced-year');
    const evidencePath = path.join(
      yearPath,
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    let moved = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryOpen: async (directoryPath) => {
            if (moved || directoryPath !== yearPath) return;
            await rename(yearPath, displacedYear);
            await symlink(
              displacedYear,
              yearPath,
              'dir'
            );
            moved = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(moved).toBe(true);
  });

  test('rejects a Codex component moved after a bound directory read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2d234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/post-directory-read-move';
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const displacedSessions = path.join(homeDir, 'post-read-displaced-sessions');
    const evidencePath = path.join(
      sessionsRoot,
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    let moved = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryRead: async (directoryPath, entry) => {
            if (moved || directoryPath !== sessionsRoot || entry?.name !== '2026') return;
            await rename(sessionsRoot, displacedSessions);
            await symlink(
              displacedSessions,
              sessionsRoot,
              'dir'
            );
            moved = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(moved).toBe(true);
  });

  test('rejects a Codex sessions directory moved after an empty bound read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2e134567-e89b-42d3-a456-426614174017';
    const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
    const displacedSessions = path.join(homeDir, 'post-empty-read-displaced-sessions');
    await mkdir(sessionsRoot, { recursive: true });
    let moved = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd: '/workspace/post-empty-directory-read-move' },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryRead: async (directoryPath, entry) => {
            if (moved || directoryPath !== sessionsRoot || entry !== null) return;
            await rename(sessionsRoot, displacedSessions);
            await symlink(
              displacedSessions,
              sessionsRoot,
              'dir'
            );
            moved = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(moved).toBe(true);
  });

  test('rejects a Codex candidate removed after its exact name is observed', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2e034567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/observed-candidate-removed';
    const dayPath = path.join(homeDir, '.codex', 'sessions', '2026', '08', '13');
    const evidencePath = path.join(
      dayPath,
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const removedPath = path.join(homeDir, 'removed-observed-candidate.jsonl');
    await mkdir(dayPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    let removed = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryRead: async (directoryPath, entry) => {
            if (removed || directoryPath !== dayPath || entry?.name !== path.basename(evidencePath)) {
              return;
            }
            await rename(evidencePath, removedPath);
            removed = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(removed).toBe(true);
  });

  test('rejects a Codex candidate replaced by a symlink after its name is observed', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2e134567-e89b-42d3-a456-426614174018';
    const cwd = '/workspace/observed-candidate-symlink';
    const dayPath = path.join(homeDir, '.codex', 'sessions', '2026', '08', '13');
    const evidencePath = path.join(
      dayPath,
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const displacedPath = path.join(homeDir, 'displaced-observed-candidate.jsonl');
    await mkdir(dayPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    let replaced = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryRead: async (directoryPath, entry) => {
            if (
              replaced ||
              directoryPath !== dayPath ||
              entry?.name !== path.basename(evidencePath)
            ) {
              return;
            }
            await rename(evidencePath, displacedPath);
            await symlink(displacedPath, evidencePath, 'file');
            replaced = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(replaced).toBe(true);
  });

  test('rejects a Codex candidate replaced by a non-regular entry after observation', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2e234567-e89b-42d3-a456-426614174018';
    const cwd = '/workspace/observed-candidate-nonregular';
    const dayPath = path.join(homeDir, '.codex', 'sessions', '2026', '08', '13');
    const evidencePath = path.join(
      dayPath,
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const displacedPath = path.join(homeDir, 'displaced-nonregular-candidate.jsonl');
    await mkdir(dayPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    let replaced = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterDirectoryRead: async (directoryPath, entry) => {
            if (
              replaced ||
              directoryPath !== dayPath ||
              entry?.name !== path.basename(evidencePath)
            ) {
              return;
            }
            await rename(evidencePath, displacedPath);
            await mkdir(evidencePath);
            replaced = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(replaced).toBe(true);
  });

  test('returns not-found for a genuinely empty safe Codex traversal', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    await mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId: '2e334567-e89b-42d3-a456-426614174018',
        selected: { cwd: '/workspace/empty-safe-codex-traversal' },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('fails closed when the bound directory descriptor alias is unavailable', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '2e234567-e89b-42d3-a456-426614174017';
    const cwd = '/workspace/missing-directory-alias';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          directoryDescriptorPath: () => path.join(homeDir, 'missing-fd-alias')
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a non-regular evidence candidate with a typed unsafe-file error', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '31234567-e89b-42d3-a456-426614174018';
    const cwd = '/workspace/nonregular';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-nonregular',
      `${providerSessionId}.jsonl`
    );
    await mkdir(evidencePath, { recursive: true });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a candidate whose canonical path escapes through an intermediate symlink', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '41234567-e89b-42d3-a456-426614174019';
    const cwd = '/workspace/escape';
    const providerRoot = path.join(homeDir, '.claude');
    const projectsRoot = path.join(providerRoot, 'projects');
    const outsideProject = path.join(homeDir, 'outside-project');
    const linkedProject = path.join(projectsRoot, '-workspace-escape');
    const evidencePath = path.join(outsideProject, `${providerSessionId}.jsonl`);
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(outsideProject, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    await symlink(outsideProject, linkedProject, 'dir');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects an intermediate symlink even when its target remains inside the provider root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '42234567-e89b-42d3-a456-426614174020';
    const cwd = '/workspace/contained-symlink';
    const providerRoot = path.join(homeDir, '.claude');
    const projectsRoot = path.join(providerRoot, 'projects');
    const realProject = path.join(providerRoot, 'real-contained-project');
    const linkedProject = path.join(projectsRoot, '-workspace-contained-symlink');
    const evidencePath = path.join(realProject, `${providerSessionId}.jsonl`);
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(realProject, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    await symlink(realProject, linkedProject, 'dir');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects an intermediate directory moved outside the provider root before open', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '43234567-e89b-42d3-a456-426614174020';
    const cwd = '/workspace/intermediate-path-swap';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-intermediate-path-swap'
    );
    const movedProjectPath = path.join(homeDir, 'moved-project');
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          beforeOpen: async () => {
            await rename(projectPath, movedProjectPath);
            await symlink(
              movedProjectPath,
              projectPath,
              'dir'
            );
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects an intermediate directory identity swap that preserves the leaf inode', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '44234567-e89b-42d3-a456-426614174020';
    const cwd = '/workspace/intermediate-identity-swap';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-intermediate-identity-swap'
    );
    const movedProjectPath = path.join(homeDir, 'identity-moved-project');
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          beforeOpen: async () => {
            await rename(projectPath, movedProjectPath);
            await mkdir(projectPath);
            await link(
              path.join(movedProjectPath, `${providerSessionId}.jsonl`),
              evidencePath
            );
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('does not alias distinct intermediate directory identities above 2^53', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '45234567-e89b-42d3-a456-426614174020';
    const cwd = '/workspace/bigint-directory-identity';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-bigint-directory-identity'
    );
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    const exactInodes = [9_007_199_254_740_995n, 9_007_199_254_740_996n] as const;
    expect(exactInodes[0]).not.toBe(exactInodes[1]);
    expect(Number(exactInodes[0])).toBe(Number(exactInodes[1]));
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
    let projectIdentityReads = 0;
    const observedIdentityTypes: string[] = [];
    fsPromisesMocks.lstat.mockImplementation(async (candidatePath, options) => {
      const metadata = await actual.lstat(candidatePath, options);
      if (candidatePath !== projectPath) return metadata;
      const exactInode = exactInodes[Math.min(projectIdentityReads, 1)]!;
      projectIdentityReads += 1;
      observedIdentityTypes.push(typeof metadata.ino);
      return Object.assign(metadata, {
        ino: typeof metadata.ino === 'bigint' ? exactInode : Number(exactInode)
      });
    });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(projectIdentityReads).toBe(2);
    expect(observedIdentityTypes).toEqual(['bigint', 'bigint']);
  });

  test('does not alias a distinct opened descriptor identity above 2^53', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '46234567-e89b-42d3-a456-426614174020';
    const cwd = '/workspace/bigint-descriptor-identity';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-bigint-descriptor-identity',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    const pathInode = 9_007_199_254_740_995n;
    const descriptorInode = 9_007_199_254_740_996n;
    expect(pathInode).not.toBe(descriptorInode);
    expect(Number(pathInode)).toBe(Number(descriptorInode));
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
    const observedPathIdentityTypes: string[] = [];
    const observedDescriptorIdentityTypes: string[] = [];
    fsPromisesMocks.lstat.mockImplementation(async (candidatePath, options) => {
      const metadata = await actual.lstat(candidatePath, options);
      if (path.basename(String(candidatePath)) !== path.basename(evidencePath)) return metadata;
      observedPathIdentityTypes.push(typeof metadata.ino);
      return Object.assign(metadata, {
        ino: typeof metadata.ino === 'bigint' ? pathInode : Number(pathInode)
      });
    });
    fsPromisesMocks.open.mockImplementation(async (candidatePath, flags, mode) => {
      if (path.basename(String(candidatePath)) !== path.basename(evidencePath)) {
        return actual.open(candidatePath, flags, mode);
      }
      const handle = await actual.open(candidatePath, flags, mode);
      const originalStat = handle.stat.bind(handle);
      const stat = async (options?: StatOptions) => {
        const metadata = await originalStat(options);
        observedDescriptorIdentityTypes.push(typeof metadata.ino);
        return Object.assign(metadata, {
          ino:
            typeof metadata.ino === 'bigint' ? descriptorInode : Number(descriptorInode)
        });
      };
      return Object.assign(handle, { stat });
    });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(observedPathIdentityTypes.every((type) => type === 'bigint')).toBe(true);
    expect(observedDescriptorIdentityTypes).toEqual(['bigint']);
  });

  test('rejects a candidate swapped after validation but before descriptor open', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '51234567-e89b-42d3-a456-426614174020';
    const cwd = '/workspace/path-swap';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-path-swap',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    await writeFile(evidencePath, eligible, 'utf8');
    let swapped = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          beforeOpen: async () => {
            await rename(evidencePath, `${evidencePath}.validated`);
            await writeFile(evidencePath, eligible, 'utf8');
            swapped = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(swapped).toBe(true);
  });

  test.runIf(typeof constants.O_NONBLOCK === 'number')(
    'opens a final-race FIFO nonblocking and returns a typed unsafe result without an unblocker',
    async () => {
      const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
      temporaryHomes.push(homeDir);
      const providerSessionId = '51734567-e89b-42d3-a456-426614174020';
      const cwd = '/workspace/final-open-fifo-swap';
      const evidencePath = path.join(
        homeDir,
        '.claude',
        'projects',
        '-workspace-final-open-fifo-swap',
        `${providerSessionId}.jsonl`
      );
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(
        evidencePath,
        `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
        'utf8'
      );

      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      );
      let openedFlags: string | number | undefined;
      let actualOpenCompleted = false;
      let emergencyWriterNeeded = false;
      fsPromisesMocks.open.mockImplementation(async (candidatePath, flags, mode) => {
        if (typeof candidatePath !== 'string') {
          throw new Error('expected a string evidence path');
        }
        if (path.basename(candidatePath) !== path.basename(evidencePath)) {
          return actual.open(candidatePath, flags, mode);
        }
        openedFlags = flags;
        await rename(evidencePath, `${evidencePath}.validated`);
        const fifo = spawnSync('mkfifo', [evidencePath], { encoding: 'utf8' });
        if (fifo.status !== 0) {
          throw new Error(`mkfifo failed: ${fifo.stderr}`);
        }

        let emergencyWriter: Promise<void> | undefined;
        const emergencyTimer = setTimeout(() => {
          emergencyWriterNeeded = true;
          emergencyWriter = actual
            .open(evidencePath, constants.O_WRONLY | constants.O_NONBLOCK)
            .then(async (handle) => handle.close());
        }, 250);
        const handle = await actual.open(candidatePath, flags, mode);
        actualOpenCompleted = true;
        clearTimeout(emergencyTimer);
        await emergencyWriter;
        return handle;
      });

      let hangTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        verifyProviderSessionEvidence({
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        }),
        new Promise<never>((_resolve, reject) => {
          hangTimer = setTimeout(
            () => reject(new Error('provider evidence FIFO open did not settle')),
            2_000
          );
        })
      ]).finally(() => {
        if (hangTimer !== undefined) clearTimeout(hangTimer);
      });

      expect(result).toEqual({
        ok: false,
        code: 'evidence-unsafe-file',
        error: 'provider session evidence file is unsafe'
      });
      expect(actualOpenCompleted).toBe(true);
      expect(typeof openedFlags).toBe('number');
      expect((openedFlags as number) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(emergencyWriterNeeded).toBe(false);
    }
  );

  test('rejects a candidate path swapped after its descriptor is opened', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '52234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-open-swap';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-post-open-swap',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    await writeFile(evidencePath, eligible, 'utf8');
    let swapped = false;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterOpen: async () => {
            await rename(evidencePath, `${evidencePath}.opened`);
            await writeFile(evidencePath, eligible, 'utf8');
            swapped = true;
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(swapped).toBe(true);
  });

  test('rejects an intermediate directory moved outside the provider root after open', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '53234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-open-intermediate-path-swap';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-post-open-intermediate-path-swap'
    );
    const movedProjectPath = path.join(homeDir, 'post-open-moved-project');
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterOpen: async () => {
            await rename(projectPath, movedProjectPath);
            await symlink(
              movedProjectPath,
              projectPath,
              'dir'
            );
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects an intermediate directory moved outside the provider root after read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '54234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-intermediate-path-swap';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-post-read-intermediate-path-swap'
    );
    const movedProjectPath = path.join(homeDir, 'post-read-moved-project');
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterRead: async () => {
            await rename(projectPath, movedProjectPath);
            await symlink(
              movedProjectPath,
              projectPath,
              'dir'
            );
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a same-length Claude leaf rewrite after its bytes are read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '55234567-e89b-42d3-a456-426614174021';
    const replacementSessionId = '56234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-same-length-rewrite';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-post-read-same-length-rewrite',
      `${providerSessionId}.jsonl`
    );
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    const replacement = `${JSON.stringify({
      type: 'user',
      sessionId: replacementSessionId,
      cwd
    })}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(eligible));
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, eligible, 'utf8');
    const before = await stat(evidencePath, { bigint: true });
    let rewrittenDev: bigint | undefined;
    let rewrittenIno: bigint | undefined;
    let rewrittenCtimeNs: bigint | undefined;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterRead: async () => {
            for (let attempt = 0; attempt < 10; attempt += 1) {
              await writeFile(evidencePath, replacement, 'utf8');
              const after = await stat(evidencePath, { bigint: true });
              rewrittenDev = after.dev;
              rewrittenIno = after.ino;
              rewrittenCtimeNs = after.ctimeNs;
              if (rewrittenCtimeNs !== before.ctimeNs) break;
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(rewrittenDev).toBe(before.dev);
    expect(rewrittenIno).toBe(before.ino);
    expect(rewrittenCtimeNs).not.toBe(before.ctimeNs);
  });

  test('rejects a same-length Claude rewrite even when its mtime is restored', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '57234567-e89b-42d3-a456-426614174021';
    const replacementSessionId = '58234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-mtime-rollback';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-post-read-mtime-rollback',
      `${providerSessionId}.jsonl`
    );
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    const replacement = `${JSON.stringify({
      type: 'user',
      sessionId: replacementSessionId,
      cwd
    })}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(eligible));
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, eligible, 'utf8');
    const stableTime = new Date(Math.floor((Date.now() - 2_000) / 1_000) * 1_000);
    await utimes(evidencePath, stableTime, stableTime);
    const before = await stat(evidencePath, { bigint: true });
    let restoredDev: bigint | undefined;
    let restoredIno: bigint | undefined;
    let restoredMtimeNs: bigint | undefined;
    let restoredCtimeNs: bigint | undefined;

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: stableTime.getTime() - 1_000
        },
        {
          afterRead: async () => {
            for (let attempt = 0; attempt < 10; attempt += 1) {
              await writeFile(evidencePath, replacement, 'utf8');
              await utimes(evidencePath, stableTime, stableTime);
              const after = await stat(evidencePath, { bigint: true });
              restoredDev = after.dev;
              restoredIno = after.ino;
              restoredMtimeNs = after.mtimeNs;
              restoredCtimeNs = after.ctimeNs;
              if (after.ctimeNs !== before.ctimeNs) break;
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
          }
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(restoredDev).toBe(before.dev);
    expect(restoredIno).toBe(before.ino);
    expect(restoredMtimeNs).toBe(before.mtimeNs);
    expect(restoredCtimeNs).not.toBe(before.ctimeNs);
  });

  test('returns stale when the opened Claude leaf becomes stale after read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '59234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-stale';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-post-read-stale',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    const notBeforeMs = Date.now() - 1_000;
    const staleTime = new Date(notBeforeMs - 10_000);

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'claude',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs
        },
        {
          afterRead: () => utimes(evidencePath, staleTime, staleTime)
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-stale',
      error: 'provider session evidence predates this launch'
    });
  });

  test('returns stale when the opened Codex leaf becomes stale after read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '5a134567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-codex-stale';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    const notBeforeMs = Date.now() - 1_000;
    const staleTime = new Date(notBeforeMs - 10_000);

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs
        },
        {
          afterRead: () => utimes(evidencePath, staleTime, staleTime)
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-stale',
      error: 'provider session evidence predates this launch'
    });
  });

  test('rejects a Codex leaf appended after its bytes are read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '5a234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-codex-append';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const eligible = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: providerSessionId, cwd }
    })}\n`;
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, eligible, 'utf8');

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterRead: () => writeFile(evidencePath, `${eligible}{"later":true}\n`, 'utf8')
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a Codex leaf truncated after its bytes are read', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '5b234567-e89b-42d3-a456-426614174021';
    const cwd = '/workspace/post-read-codex-truncate';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const eligible = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: providerSessionId, cwd }
    })}\n`;
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, eligible, 'utf8');

    await expect(
      verifyProviderSessionEvidence(
        {
          provider: 'codex',
          providerSessionId,
          selected: { cwd },
          homeDir,
          notBeforeMs: Date.now() - 1_000
        },
        {
          afterRead: () => writeFile(evidencePath, eligible.slice(0, -1), 'utf8')
        }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('rejects a non-finite daemon freshness boundary', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId: '61234567-e89b-42d3-a456-426614174021',
        selected: { cwd: '/workspace/example' },
        homeDir,
        notBeforeMs: Number.NaN
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-invalid-request',
      error: 'provider session evidence request is invalid'
    });
  });

  test('rejects an exact candidate that is itself a symlink', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '71234567-e89b-42d3-a456-426614174022';
    const cwd = '/workspace/leaf-symlink';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-leaf-symlink',
      `${providerSessionId}.jsonl`
    );
    const outsidePath = path.join(homeDir, 'outside-leaf.jsonl');
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      outsidePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    await symlink(outsidePath, evidencePath, 'file');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
  });

  test('does not accept Claude evidence from a different cwd-derived project directory', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '81234567-e89b-42d3-a456-426614174023';
    const cwd = '/workspace/expected-project';
    const wrongProjectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-other-project',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(wrongProjectPath), { recursive: true });
    await writeFile(
      wrongProjectPath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('does not accept Claude-shaped records as Codex session metadata', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '91234567-e89b-42d3-a456-426614174024';
    const cwd = '/workspace/wrong-provider-shape';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-mismatch',
      error: 'provider session evidence did not match the requested identity'
    });
  });

  test('ignores non-numeric Codex year, month, and day directories', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'a1234567-e89b-42d3-a456-426614174025';
    const cwd = '/workspace/numeric-only';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      'latest',
      'month',
      'day',
      `rollout-latest-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('rejects a Claude transcript whose embedded session id differs from its filename', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'b1234567-e89b-42d3-a456-426614174026';
    const cwd = '/workspace/claude-id-mismatch';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-claude-id-mismatch',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'user',
        sessionId: 'c1234567-e89b-42d3-a456-426614174027',
        cwd
      })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-mismatch',
      error: 'provider session evidence did not match the requested identity'
    });
  });

  test('applies the complete-line size bound to Codex JSONL too', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'd1234567-e89b-42d3-a456-426614174028';
    const cwd = '/workspace/codex-line-bound';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const oversized = JSON.stringify({ payload: 'x'.repeat(PROVIDER_EVIDENCE_MAX_LINE_BYTES) });
    await writeFile(evidencePath, `${oversized}\n`, 'utf8');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-line-too-long',
      error: 'provider session evidence contains an oversized JSONL record'
    });
  });

  test('rejects stale evidence copied into a selected profile root', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'e1234567-e89b-42d3-a456-426614174029';
    const cwd = '/workspace/profile-stale';
    const evidencePath = path.join(
      profileRoot('work', homeDir),
      'projects',
      '-workspace-profile-stale',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );
    const notBeforeMs = Date.now();
    const staleTime = new Date(notBeforeMs - 10_000);
    await utimes(evidencePath, staleTime, staleTime);

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { profileId: 'work', cwd },
        homeDir,
        notBeforeMs
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-stale',
      error: 'provider session evidence predates this launch'
    });
  });

  test('ignores a UUID-suffixed Codex file that is not an exact dated rollout candidate', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'f1234567-e89b-42d3-a456-426614174030';
    const cwd = '/workspace/exact-candidate';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-forged-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-not-found',
      error: 'provider session evidence was not found'
    });
  });

  test('never parses a trailing partial JSONL record at the prefix boundary', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '01234567-e89b-42d3-a456-426614174031';
    const cwd = '/workspace/trailing-partial';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-trailing-partial',
      `${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const completePadding = `${JSON.stringify({ padding: 'x'.repeat(60_000) })}\n`;
    const prefix = completePadding.repeat(4);
    const partialEligible = JSON.stringify({
      type: 'user',
      sessionId: providerSessionId,
      cwd,
      padding: 'x'.repeat(30_000)
    });
    expect(Buffer.byteLength(prefix)).toBeLessThan(PROVIDER_EVIDENCE_MAX_PREFIX_BYTES);
    expect(Buffer.byteLength(prefix + partialEligible)).toBeGreaterThan(
      PROVIDER_EVIDENCE_MAX_PREFIX_BYTES
    );
    await writeFile(evidencePath, `${prefix}${partialEligible}\n`, 'utf8');

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-scan-bound-exhausted',
      error: 'provider session evidence scan bound was exhausted'
    });
  });

  test('rejects a Claude leaf restored during the final project descriptor close', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '62234567-e89b-42d3-a456-426614174032';
    const cwd = '/workspace/final-project-close-race';
    const projectPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-final-project-close-race'
    );
    const evidencePath = path.join(projectPath, `${providerSessionId}.jsonl`);
    const displacedEvidencePath = path.join(homeDir, 'final-close-displaced-evidence.jsonl');
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`,
      'utf8'
    );

    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
    const beforeProject = await stat(projectPath, { bigint: true });
    let mutatedDuringClose = false;
    fsPromisesMocks.open.mockImplementation(async (candidatePath, flags, mode) => {
      const handle = await actual.open(candidatePath, flags, mode);
      let canonicalOpenedPath: string;
      try {
        canonicalOpenedPath = await actual.realpath(String(candidatePath));
      } catch {
        return handle;
      }
      if (canonicalOpenedPath !== projectPath) return handle;

      const originalClose = handle.close.bind(handle);
      return Object.assign(handle, {
        close: async () => {
          if (!mutatedDuringClose) {
            await rename(evidencePath, displacedEvidencePath);
            await rename(displacedEvidencePath, evidencePath);
            const epochMarker = new Date(Date.now() + 86_400_000);
            await utimes(projectPath, epochMarker, epochMarker);
            mutatedDuringClose = true;
          }
          await originalClose();
        }
      });
    });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    const afterProject = await stat(projectPath, { bigint: true });
    expect(mutatedDuringClose).toBe(true);
    expect(afterProject.dev).toBe(beforeProject.dev);
    expect(afterProject.ino).toBe(beforeProject.ino);
    expect(afterProject.mtimeNs).not.toBe(beforeProject.mtimeNs);
  });

  test('rejects a same-inode same-length Claude rewrite during the final evidence close', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '63234567-e89b-42d3-a456-426614174032';
    const replacementSessionId = '64234567-e89b-42d3-a456-426614174032';
    const cwd = '/workspace/final-evidence-close-race';
    const evidencePath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-workspace-final-evidence-close-race',
      `${providerSessionId}.jsonl`
    );
    const eligible = `${JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd })}\n`;
    const replacement = `${JSON.stringify({
      type: 'user',
      sessionId: replacementSessionId,
      cwd
    })}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(eligible));
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, eligible, 'utf8');

    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
    const beforeEvidence = await stat(evidencePath, { bigint: true });
    let afterRewrite: BigIntStats | undefined;
    let rewrittenDuringClose = false;
    fsPromisesMocks.open.mockImplementation(async (candidatePath, flags, mode) => {
      const handle = await actual.open(candidatePath, flags, mode);
      let canonicalOpenedPath: string;
      try {
        canonicalOpenedPath = await actual.realpath(String(candidatePath));
      } catch {
        return handle;
      }
      if (canonicalOpenedPath !== evidencePath) return handle;

      const originalClose = handle.close.bind(handle);
      return Object.assign(handle, {
        close: async () => {
          if (!rewrittenDuringClose) {
            for (let attempt = 0; attempt < 10; attempt += 1) {
              await writeFile(evidencePath, replacement, 'utf8');
              afterRewrite = await stat(evidencePath, { bigint: true });
              if (afterRewrite.ctimeNs !== beforeEvidence.ctimeNs) break;
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
            rewrittenDuringClose = true;
          }
          await originalClose();
        }
      });
    });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'claude',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    expect(rewrittenDuringClose).toBe(true);
    expect(afterRewrite?.dev).toBe(beforeEvidence.dev);
    expect(afterRewrite?.ino).toBe(beforeEvidence.ino);
    expect(afterRewrite?.size).toBe(beforeEvidence.size);
    expect(afterRewrite?.ctimeNs).not.toBe(beforeEvidence.ctimeNs);
  });

  test('does not accept older Codex evidence when a malformed newer year returns during the final sessions close', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = '65234567-e89b-42d3-a456-426614174032';
    const cwd = '/workspace/final-sessions-close-race';
    const sessionsPath = path.join(homeDir, '.codex', 'sessions');
    const evidencePath = path.join(
      sessionsPath,
      '2025',
      '08',
      '13',
      `rollout-2025-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    const malformedNewerYear = path.join(sessionsPath, '2026');
    const hiddenNewerYear = path.join(homeDir, 'hidden-malformed-newer-year');
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd }
      })}\n`,
      'utf8'
    );
    await writeFile(malformedNewerYear, 'not a directory', 'utf8');
    await rename(malformedNewerYear, hiddenNewerYear);

    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
    const beforeSessions = await stat(sessionsPath, { bigint: true });
    let restoredDuringClose = false;
    fsPromisesMocks.open.mockImplementation(async (candidatePath, flags, mode) => {
      const handle = await actual.open(candidatePath, flags, mode);
      let canonicalOpenedPath: string;
      try {
        canonicalOpenedPath = await actual.realpath(String(candidatePath));
      } catch {
        return handle;
      }
      if (canonicalOpenedPath !== sessionsPath) return handle;

      const originalClose = handle.close.bind(handle);
      return Object.assign(handle, {
        close: async () => {
          if (!restoredDuringClose) {
            await rename(hiddenNewerYear, malformedNewerYear);
            const epochMarker = new Date(Date.now() + 86_400_000);
            await utimes(sessionsPath, epochMarker, epochMarker);
            restoredDuringClose = true;
          }
          await originalClose();
        }
      });
    });

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: false,
      code: 'evidence-unsafe-file',
      error: 'provider session evidence file is unsafe'
    });
    const afterSessions = await stat(sessionsPath, { bigint: true });
    expect(restoredDuringClose).toBe(true);
    expect(afterSessions.dev).toBe(beforeSessions.dev);
    expect(afterSessions.ino).toBe(beforeSessions.ino);
    expect(afterSessions.mtimeNs).not.toBe(beforeSessions.mtimeNs);
  });

  test('preserves the shared case-insensitive UUID grammar for exact Codex evidence', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'desk-provider-evidence-'));
    temporaryHomes.push(homeDir);
    const providerSessionId = 'ABCDEF01-E89B-42D3-A456-426614174032';
    const cwd = '/workspace/uppercase-uuid';
    const evidencePath = path.join(
      homeDir,
      '.codex',
      'sessions',
      '2026',
      '08',
      '13',
      `rollout-2026-08-13T10-00-00-${providerSessionId}.jsonl`
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd } })}\n`,
      'utf8'
    );

    await expect(
      verifyProviderSessionEvidence({
        provider: 'codex',
        providerSessionId,
        selected: { cwd },
        homeDir,
        notBeforeMs: Date.now() - 1_000
      })
    ).resolves.toEqual({
      ok: true,
      provider: 'codex',
      providerSessionId,
      evidencePath: await realpath(evidencePath)
    });
  });
});
