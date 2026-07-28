import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDeskSnapshotFromManifest } from '../src/server/snapshot';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

describe('desk snapshot', () => {
  it('builds UI state from manifest content and running session ids', () => {
    const snapshot = buildDeskSnapshotFromManifest(
      `
groups:
  - id: research
    label: Research
    sessions:
      - name: sample-agent
        cwd: ~/projects/sample
        agent: codex
        resume: 00000000-0000-7000-8000-000000000000
        sessionId: sample-agent
`,
      new Set(['sample-agent']),
      {
        homeDir: '/workspace',
        manifestPath: '/workspace/.config/desk/desk.yml'
      }
    );

    expect(snapshot.configPath).toBe('/workspace/.config/desk/desk.yml');
    expect(snapshot.view.totals).toEqual({
      projects: 1,
      groups: 1,
      sessions: 1,
      running: 1,
      missing: 0
    });
    expect(snapshot.view.groups[0]?.sessions[0]?.spec.cwd).toBe('/workspace/projects/sample');
  });

  it('keeps newly added projects visible before they have groups', () => {
    const snapshot = buildDeskSnapshotFromManifest(
      `
groups: []
projects:
  - id: scratch
    label: Scratch
    cwd: ~/projects/scratch
    groups: []
`,
      new Set(),
      {
        homeDir: '/workspace',
        manifestPath: '/workspace/.config/desk/desk.yml'
      }
    );

    expect(snapshot.view.totals.projects).toBe(1);
    expect(snapshot.view.projects[0]).toMatchObject({
      id: 'scratch',
      label: 'Scratch',
      cwd: '~/projects/scratch',
      configured: true,
      groups: []
    });
  });

  it('keeps managed-agent LSP launch paths out of browser-visible session specs', () => {
    const snapshot = buildDeskSnapshotFromManifest(
      `
settings:
  lsp:
    enabled: true
    languages: [typescript]
    agents:
      enabled: true
groups:
  - id: research
    sessions:
      - name: sample-agent
        cwd: ~/projects/sample
        agent: codex
        uiMode: terminal
        sessionId: sample-agent
`,
      new Set(),
      {
        homeDir: '/workspace',
        manifestPath: '/workspace/.config/desk/desk.yml'
      }
    );

    const command = snapshot.view.groups[0]?.sessions[0]?.spec.command ?? '';
    expect(command).toContain('codex');
    expect(command).not.toContain('DESK_LSP_ENV_FILE');
    expect(command).not.toContain('desk-lsp-managed-agents');
    expect(command).not.toContain('mcp_servers.desk_lsp');
  });

  it('surfaces durable Claude continuity and profile-memory attention without changing liveness', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'desk-snapshot-continuity-'));
    try {
      const cwd = join(homeDir, 'projects', 'sample');
      const projectSlug = cwd.replace(/[^A-Za-z0-9._-]/g, '-');
      writeJson(
        join(
          homeDir,
          '.config',
          'desk',
          'continuity',
          'claude',
          'activations',
          'sample-agent.json'
        ),
        {
          policyVersion: 1,
          generationId: 'generation-1',
          deskSessionId: 'sample-agent',
          providerSessionId: '00000000-0000-7000-8000-000000000001',
          sourceProfileId: 'work',
          targetProfileId: 'personal',
          projectSlug,
          state: 'needs-attention',
          errorCode: 'continuity-resume-unconfirmed',
          observedProviderSessionId: '00000000-0000-7000-8000-000000000002'
        }
      );
      writeJson(
        join(
          homeDir,
          '.config',
          'desk',
          'continuity',
          'claude-memory',
          'projects',
          projectSlug,
          'branches',
          'personal',
          'state.json'
        ),
        {
          policyVersion: 1,
          profileId: 'personal',
          projectSlug,
          conflictIds: ['conflict-1', 'conflict-2']
        }
      );

      const snapshot = buildDeskSnapshotFromManifest(
        `
profiles:
  - id: personal
    provider: claude
    label: Personal
groups:
  - id: research
    sessions:
      - name: sample-agent
        cwd: ${cwd}
        agent: claude
        profileId: personal
        resume: 00000000-0000-7000-8000-000000000001
        sessionId: sample-agent
`,
        new Set(['sample-agent']),
        { homeDir }
      );

      expect(snapshot.view.groups[0]?.sessions[0]?.state).toBe('running');
      expect(snapshot.continuity.issues).toEqual([
        expect.objectContaining({
          sessionId: 'sample-agent',
          code: 'continuity-resume-unconfirmed'
        }),
        expect.objectContaining({
          sessionId: 'sample-agent',
          code: 'claude-memory-conflicts',
          count: 2
        })
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
