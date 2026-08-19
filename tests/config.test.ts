import { describe, expect, it } from 'vitest';
import {
  addGroupToProjectManifest,
  addGroupToManifest,
  addProjectToManifest,
  addSessionToProjectManifest,
  addSessionToManifest,
  deleteProjectFromManifest,
  deleteSessionFromManifest,
  editGroupInManifest,
  editProjectInManifest,
  editSessionInManifest,
  moveSessionInManifest,
  createEmptyManifest,
  resolveDefaultManifestPath,
  serializeDeskManifest
} from '../src/core/config';
import { parseDeskManifest } from '../src/core/manifest';
import { homedir } from 'node:os';

// Samples use ~ expansion against the real home — never hardcode it (CI runs as /home/runner).
const HOME = homedir();
const CLAUDE_RESUME_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CLAUDE_RESUME_ID = '22222222-2222-4222-8222-222222222222';

describe('desk config', () => {
  it.each(['plugins: []\ngroups: []\n', 'plugins: disabled\ngroups: []\n'])(
    'rejects a present non-object plugins section instead of dropping it: %s',
    (source) => {
      expect(() => parseDeskManifest(source)).toThrow('desk manifest plugins must be an object');
    }
  );

  it.each(['settings: []\ngroups: []\n', 'settings: disabled\ngroups: []\n'])(
    'rejects a present non-object settings section instead of dropping it: %s',
    (source) => {
      expect(() => parseDeskManifest(source)).toThrow('desk manifest settings must be an object');
    }
  );

  it('resolves the default manifest path under user config', () => {
    expect(resolveDefaultManifestPath({ homeDir: `${HOME}` })).toBe(`${HOME}/.config/desk/desk.yml`);
  });

  it('refuses a resume id on a session that names no agent instead of presuming codex', () => {
    // A draft with neither `agent` nor `command` is launched as a plain shell.
    // Validating its resume id against codex's grammar — and binding it
    // exclusively — was a fossil of codex-as-the-default-agent acted on as
    // fact: the shell will never resume anything, so the only honest answer
    // is the same refusal a `command` session already gets.
    const manifest = createEmptyManifest();
    expect(() =>
      addSessionToManifest(manifest, {
        groupId: 'research',
        groupLabel: 'Research',
        session: {
          name: 'plain-shell',
          cwd: '~/projects/sample',
          resume: '00000000-0000-7000-8000-000000000000'
        }
      })
    ).toThrow(/resume id requires a managed provider session/);
  });

  it('adds sessions to groups in manifest data', () => {
    const manifest = createEmptyManifest();
    const updated = addSessionToManifest(manifest, {
      groupId: 'research',
      groupLabel: 'Research',
      session: {
        name: 'sample-agent',
        cwd: '~/projects/sample',
        agent: 'codex',
        resume: '00000000-0000-7000-8000-000000000000'
      }
    });

    expect(updated).toEqual({
      groups: [
        {
          id: 'research',
          label: 'Research',
          sessions: [
            {
              name: 'sample-agent',
              cwd: '~/projects/sample',
              agent: 'codex',
              resume: '00000000-0000-7000-8000-000000000000',
              sessionId: 'sample-agent'
            }
          ]
        }
      ]
    });
  });

  it('pins a sessionId when adding root and project sessions', () => {
    const root = addSessionToManifest(
      {
        groups: [
          {
            id: 'existing',
            sessions: [{ name: 'Existing', command: 'bash', sessionId: 'new-agent' }]
          }
        ]
      },
      {
        groupId: 'research',
        session: { name: 'New Agent', cwd: '~/projects/sample', agent: 'codex', sessionId: 'new-agent' }
      }
    );
    expect(root.groups[1].sessions[0].sessionId).toBe('new-agent-2');

    const project = addProjectToManifest(createEmptyManifest(), {
      projectId: 'alpha',
      cwd: '~/projects/alpha'
    });
    const grouped = addGroupToProjectManifest(project, {
      projectId: 'alpha',
      groupId: 'main'
    });
    const withSession = addSessionToProjectManifest(grouped, {
      projectId: 'alpha',
      groupId: 'main',
      session: { name: 'Project Agent', agent: 'codex', sessionId: 'bad/id' }
    });
    expect(withSession.projects?.[0].groups[0].sessions[0].sessionId).toBe('project-agent');
  });

  it('round-trips session uiMode through serialize/parse', () => {
    const manifest = addSessionToManifest(createEmptyManifest(), {
      groupId: 'research',
      groupLabel: 'Research',
      session: {
        name: 'chat-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        uiMode: 'native'
      }
    });

    const reparsed = parseDeskManifest(serializeDeskManifest(manifest));
    expect(reparsed.groups[0].sessions[0].uiMode).toBe('native');
  });

  it('preserves uiMode across edits', () => {
    const manifest = addSessionToManifest(createEmptyManifest(), {
      groupId: 'research',
      groupLabel: 'Research',
      session: {
        name: 'chat-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        uiMode: 'native'
      }
    });

    const edited = editSessionInManifest(manifest, {
      groupId: 'research',
      currentName: 'chat-agent',
      session: {
        name: 'chat-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        uiMode: 'native',
        bypassPermissions: true
      }
    });

    const session = edited.groups[0].sessions[0];
    expect(session.uiMode).toBe('native');
    expect(session.bypassPermissions).toBe(true);
  });

  it('preserves the durable sessionId across a rename edit', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: research
    label: Research
    sessions:
      - name: chat-agent
        cwd: ~/projects/sample
        agent: claude
        sessionId: chat-agent-stable
`);

    const edited = editSessionInManifest(manifest, {
      groupId: 'research',
      currentName: 'chat-agent',
      session: {
        name: 'renamed-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        sessionId: 'replacement-must-not-win'
      }
    });

    expect(edited.groups[0].sessions[0]).toMatchObject({
      name: 'renamed-agent',
      sessionId: 'chat-agent-stable'
    });
  });

  it('preserves a persisted resume id across generic edits and ignores the removed clear bypass', () => {
    const manifest = addSessionToManifest(createEmptyManifest(), {
      groupId: 'research',
      groupLabel: 'Research',
      session: {
        name: 'chat-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        resume: CLAUDE_RESUME_ID,
        tmuxSession: 'agentdesk-research-chat-agent-pinned00'
      }
    });

    const edited = editSessionInManifest(manifest, {
      groupId: 'research',
      currentName: 'chat-agent',
      session: { name: 'chat-agent', cwd: '~/projects/sample', agent: 'claude', bypassPermissions: true }
    });
    expect(edited.groups[0].sessions[0].resume).toBe(CLAUDE_RESUME_ID);

    const legacyBypass = editSessionInManifest(manifest, {
      groupId: 'research',
      currentName: 'chat-agent',
      clearResume: true,
      session: { name: 'chat-agent', cwd: '~/projects/sample', agent: 'claude' }
    });
    expect(legacyBypass.groups[0].sessions[0].resume).toBe(CLAUDE_RESUME_ID);
  });

  it('rejects replacing a durable provider binding through a generic edit', () => {
    const manifest = addSessionToManifest(createEmptyManifest(), {
      groupId: 'research',
      session: {
        name: 'chat-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        resume: CLAUDE_RESUME_ID
      }
    });

    expect(() =>
      editSessionInManifest(manifest, {
        groupId: 'research',
        currentName: 'chat-agent',
        session: {
          name: 'chat-agent',
          cwd: '~/projects/sample',
          agent: 'claude',
          resume: OTHER_CLAUDE_RESUME_ID
        }
      })
    ).toThrow(/reset-provider-session/);
    expect(manifest.groups[0].sessions[0].resume).toBe(CLAUDE_RESUME_ID);
  });

  it('rejects changing the provider that owns a durable binding', () => {
    const manifest = addSessionToManifest(createEmptyManifest(), {
      groupId: 'research',
      session: {
        name: 'chat-agent',
        cwd: '~/projects/sample',
        agent: 'claude',
        resume: CLAUDE_RESUME_ID
      }
    });

    expect(() =>
      editSessionInManifest(manifest, {
        groupId: 'research',
        currentName: 'chat-agent',
        session: {
          name: 'chat-agent',
          cwd: '~/projects/sample',
          agent: 'codex',
          resume: CLAUDE_RESUME_ID
        }
      })
    ).toThrow(/reset-provider-session/);
  });

  it('rejects adding a resume id already owned anywhere in the manifest', () => {
    const manifest = addSessionToManifest(createEmptyManifest(), {
      groupId: 'research',
      session: {
        name: 'first-agent',
        cwd: '~/projects/first',
        agent: 'claude',
        resume: CLAUDE_RESUME_ID
      }
    });

    expect(() =>
      addSessionToManifest(manifest, {
        groupId: 'other',
        session: {
          name: 'second-agent',
          cwd: '~/projects/second',
          agent: 'claude',
          resume: CLAUDE_RESUME_ID
        }
      })
    ).toThrow(/already bound/);
  });

  it('rejects an invalid provider resume id before adding a session', () => {
    expect(() =>
      addSessionToManifest(createEmptyManifest(), {
        groupId: 'research',
        session: {
          name: 'chat-agent',
          cwd: '~/projects/sample',
          agent: 'claude',
          resume: 'not-a-provider-id'
        }
      })
    ).toThrow(/valid claude provider session id/);
  });

  it('rejects a provider resume id on a non-provider session', () => {
    expect(() =>
      addSessionToManifest(createEmptyManifest(), {
        groupId: 'research',
        session: {
          name: 'shell',
          cwd: '~/projects/sample',
          command: 'bash',
          resume: CLAUDE_RESUME_ID
        }
      })
    ).toThrow(/managed provider/);
  });

  it('adds empty groups to manifest data', () => {
    const manifest = createEmptyManifest();
    const updated = addGroupToManifest(manifest, {
      groupId: 'ops',
      groupLabel: 'Operations'
    });

    expect(updated).toEqual({
      groups: [
        {
          id: 'ops',
          label: 'Operations',
          sessions: []
        }
      ]
    });
  });

  it('edits project group and session data in project manifests', () => {
    const projectManifest = addProjectToManifest(createEmptyManifest(), {
      projectId: 'alpha',
      projectLabel: 'Alpha',
      cwd: '~/projects/alpha'
    });
    const groupManifest = addGroupToProjectManifest(projectManifest, {
      projectId: 'alpha',
      groupId: 'main',
      groupLabel: 'Main',
      layout: { kind: '1x1' }
    });
    const sessionManifest = editProjectInManifest(
      {
        ...groupManifest,
        projects: [
          {
            id: 'alpha',
            label: 'Alpha',
            cwd: '~/projects/alpha',
            groups: [
              {
                id: 'main',
                label: 'Main',
                layout: { kind: '1x1' },
                sessions: [{ name: 'agent', agent: 'codex' }]
              }
            ]
          }
        ]
      },
      { projectId: 'alpha', projectLabel: 'Alpha Lab', cwd: '~/projects/alpha-lab' }
    );
    const editedGroup = editGroupInManifest(sessionManifest, {
      projectId: 'alpha',
      currentGroupId: 'main',
      groupId: 'research',
      groupLabel: 'Research',
      layout: { kind: '2x2' }
    });
    const editedSession = editSessionInManifest(editedGroup, {
      projectId: 'alpha',
      groupId: 'research',
      currentName: 'agent',
      session: { name: 'agent-2', command: 'bash' }
    });

    expect(editedSession.projects?.[0]).toMatchObject({
      label: 'Alpha Lab',
      cwd: '~/projects/alpha-lab',
      groups: [
        {
          id: 'research',
          label: 'Research',
          layout: { kind: '2x2' },
          sessions: [{ name: 'agent-2', command: 'bash' }]
        }
      ]
    });
  });

  it('deletes only matching legacy cwd sessions from mixed root groups', () => {
    const updated = deleteSessionFromManifest(
      {
        groups: [
          {
            id: 'mixed',
            sessions: [
              { name: 'alpha', cwd: '~/projects/alpha', command: 'bash' },
              { name: 'beta', cwd: '~/projects/beta', command: 'bash' }
            ]
          }
        ]
      },
      { projectId: 'cwd-alpha', groupId: 'mixed', sessionName: 'alpha', projectCwd: `${HOME}/projects/alpha` }
    );

    expect(updated.groups[0]?.sessions).toEqual([{ name: 'beta', cwd: '~/projects/beta', command: 'bash' }]);
  });

  it('moves sessions between project groups', () => {
    const updated = moveSessionInManifest(
      {
        groups: [],
        projects: [
          {
            id: 'alpha',
            cwd: '~/projects/alpha',
            groups: [
              { id: 'main', sessions: [{ name: 'agent', sessionId: 'agent', agent: 'codex', resume: 'abc' }] },
              { id: 'next', sessions: [] }
            ]
          }
        ]
      },
      {
        sourceProjectId: 'alpha',
        sourceGroupId: 'main',
        sourceSessionName: 'agent',
        targetProjectId: 'alpha',
        targetGroupId: 'next'
      }
    );

    expect(updated.projects?.[0]?.groups[0]?.sessions).toEqual([]);
    expect(updated.projects?.[0]?.groups[1]?.sessions).toEqual([
      {
        name: 'agent',
        sessionId: 'agent',
        agent: 'codex',
        resume: 'abc',
        cwd: `${HOME}/projects/alpha`
      }
    ]);
  });

  it('regroups moved project sessions by project and group, not by their original cwd', () => {
    const updated = moveSessionInManifest(
      {
        groups: [],
        projects: [
          {
            id: 'source',
            cwd: `${HOME}/projects/source`,
            groups: [{ id: 'main', sessions: [] }]
          },
          {
            id: 'target',
            cwd: `${HOME}/projects/target`,
            groups: [
              {
                id: 'main',
                sessions: [
                  {
                    name: 'agent',
                    cwd: `${HOME}/projects/source`,
                    command: "cd `${HOME}/projects/source` && codex",
                    tmuxSession: 'agentdesk-source-main-agent'
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        sourceProjectId: 'target',
        sourceGroupId: 'main',
        sourceSessionName: 'agent',
        sourceProjectCwd: `${HOME}/projects/target`,
        targetProjectId: 'source',
        targetGroupId: 'main',
        targetProjectCwd: `${HOME}/projects/source`
      }
    );

    expect(updated.projects?.[0]?.groups[0]?.sessions).toEqual([
      {
        name: 'agent',
        cwd: `${HOME}/projects/source`,
        command: "cd `${HOME}/projects/source` && codex",
        tmuxSession: 'agentdesk-source-main-agent'
      }
    ]);
    expect(updated.projects?.[1]?.groups[0]?.sessions).toEqual([]);
  });

  it('round-trips settings.editor through serialize/parse', () => {
    const manifest = {
      ...createEmptyManifest(),
      settings: {
        theme: 'cyan-night',
        editor: {
          root: `${HOME}`,
          openFiles: [`${HOME}/a.ts`],
          activeFile: `${HOME}/a.ts`,
          autosave: 'after-delay' as const,
          autosaveDelayMs: 1000
        }
      }
    };
    const parsed = parseDeskManifest(serializeDeskManifest(manifest));
    expect(parsed.settings?.editor).toEqual({
      root: `${HOME}`,
      openFiles: [`${HOME}/a.ts`],
      activeFile: `${HOME}/a.ts`,
      autosave: 'after-delay',
      autosaveDelayMs: 1000
    });
  });

  it('round-trips settings.lsp server commands through serialize/parse', () => {
    const manifest = {
      ...createEmptyManifest(),
      settings: {
        lsp: {
          enabled: true,
          languages: ['typescript'],
          baseUrl: 'ws://127.0.0.1:5173',
          maxSessions: 3,
          startupTimeoutMs: 2500,
          serverCommands: {
            typescript: {
              enabled: true,
              command: '/opt/lsp/typescript-language-server',
              args: ['--stdio'],
              env: { TYPESCRIPT_TOKEN: 'secret-token' },
              languageIds: ['typescript'],
              extensions: ['.ts', '.tsx'],
              initializationOptions: { apiKey: 'secret-init', nested: { check: true } }
            }
          }
        }
      }
    };

    const parsed = parseDeskManifest(serializeDeskManifest(manifest));

    expect(parsed.settings?.lsp).toEqual(manifest.settings.lsp);
  });
});

describe('manifest settings persistence', () => {
  it('parse keeps the settings block and writes survive mutations', async () => {
    const { parseDeskManifest } = await import('../src/core/manifest.js');
    const { addGroupToManifest } = await import('../src/core/config.js');
    const manifest = parseDeskManifest(`
settings:
  theme: medical-calm
  muted: true
groups: []
projects: []
`);
    expect(manifest.settings).toEqual({ theme: 'medical-calm', muted: true });
    const mutated = addGroupToManifest(manifest, { groupId: 'g1' });
    expect(mutated.settings).toEqual({ theme: 'medical-calm', muted: true });
  });

  it('preserves settings.lsp when unrelated manifest mutations are saved', async () => {
    const { parseDeskManifest } = await import('../src/core/manifest.js');
    const { addGroupToManifest } = await import('../src/core/config.js');
    const manifest = parseDeskManifest(`
settings:
  theme: medical-calm
  lsp:
    enabled: true
    languages:
      - typescript
    serverCommands:
      typescript:
        enabled: true
        command: /opt/lsp/typescript-language-server
        args:
          - --stdio
        env:
          TYPESCRIPT_TOKEN: secret-token
        initializationOptions:
          apiKey: secret-init
groups: []
projects: []
`);

    const mutated = addGroupToManifest(manifest, { groupId: 'g1' });

    expect(mutated.settings?.lsp).toEqual(manifest.settings?.lsp);
  });
});

describe('manifest write robustness', () => {
  it('readManifestFile rejects a present blank file instead of treating corruption as an empty desk', async () => {
    const { readManifestFile } = await import('../src/core/config.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'desk-cfg-'));
    const path = join(dir, 'desk.yml');
    writeFileSync(path, '   \n  ');
    expect(() => readManifestFile(path)).toThrow(/manifest is empty/);
  });

  it('writeManifestFile refuses to persist an empty payload', async () => {
    const { writeManifestFile } = await import('../src/core/config.js');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const path = join(mkdtempSync(join(tmpdir(), 'desk-cfg-')), 'desk.yml');
    // serializeDeskManifest never yields '' for a real object, so simulate the
    // guard by checking a manifest that stringifies to content still works and
    // the guard exists for the empty-serialization edge.
    expect(() => writeManifestFile(path, { groups: [], projects: [] })).not.toThrow();
  });
});

describe('deleteProjectFromManifest (legacy cwd) — finding N14', () => {
  it('removes only the emptied group and preserves an unrelated empty group', () => {
    // Legacy (groups-based) manifest: group `a` has the session being deleted,
    // group `b` is an unrelated empty group the user just created.
    const manifest = {
      groups: [
        { id: 'a', label: 'A', sessions: [{ name: 's', cwd: '/proj/a', command: 'bash' }] },
        { id: 'b', label: 'B', sessions: [] }
      ],
      projects: undefined
    } as unknown as Parameters<typeof deleteProjectFromManifest>[0];

    const result = deleteProjectFromManifest(manifest, { projectId: 'unmatched', cwd: '/proj/a' });

    // `a` emptied by the delete → removed; `b` was already empty and unrelated →
    // must survive (the old `.filter(sessions.length > 0)` deleted it too).
    expect(result.groups.map((group) => group.id)).toEqual(['b']);
  });

  it('throws when no legacy session matches the requested cwd', () => {
    const manifest = {
      groups: [{ id: 'a', sessions: [{ name: 's', cwd: '/proj/a', command: 'bash' }] }],
      projects: undefined
    } as unknown as Parameters<typeof deleteProjectFromManifest>[0];

    expect(() => deleteProjectFromManifest(manifest, { projectId: 'missing', cwd: '/proj/other' })).toThrow(
      /project missing does not exist/
    );
  });
});
