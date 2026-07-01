import { describe, expect, it } from 'vitest';
import { buildDeskSnapshotFromManifest } from '../src/server/snapshot';

describe('desk snapshot', () => {
  it('builds UI state from manifest content and running tmux sessions', () => {
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
`,
      new Set(['agentdesk-research-sample-agent-00000000']),
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
});
