import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeskSettings, SessionSpec } from '../src/core/types';
import { createManagedAgentLspWiring } from '../src/server/lsp/managedAgentLspWiring';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('managed agent LSP wiring', () => {
  it('is default off and leaves sessions path-free', () => {
    const wiring = createWiring();

    const launch = wiring.prepare(baseSession(), { lsp: { enabled: true, languages: ['typescript'] } });

    expect(launch).toBeUndefined();
    expect(wiring.minted).toHaveLength(0);
  });

  it('mints a root-bound token and writes only a 0600 env file plus non-secret launch config', () => {
    const wiring = createWiring();

    const launch = wiring.prepare(baseSession(), enabledSettings());

    expect(launch).toBeDefined();
    expect(wiring.minted).toEqual(['/workspace']);
    expect(launch?.session.command).toContain('--mcp-config');
    expect(launch?.session.command).toContain('claude-mcp.json');
    expect(launch?.session.command).not.toContain('token-1');
    expect(launch?.session.command).not.toContain('env.json');
    expect(launch?.envFilePath).toContain('/desk-lsp-managed-agents/');
    expect(statSync(launch!.envFilePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(launch!.envFilePath, 'utf8'))).toEqual({
      DESK_API: 'http://127.0.0.1:6123',
      DESK_LSP_TOKEN: 'token-1',
      DESK_LSP_WORKSPACE_ROOT: '/workspace'
    });
    expect(JSON.parse(readFileSync(join(dirname(launch!.envFilePath), 'claude-mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        desk_lsp: {
          command: 'desk-lsp-mcp',
          args: [],
          env: { DESK_LSP_ENV_FILE: launch!.envFilePath }
        }
      }
    });

    launch?.cleanup();
    expect(wiring.revoked).toEqual(['token-1']);
    expect(existsSync(launch!.envFilePath)).toBe(false);
  });

  it('fails closed before mint when the canonical API URL is unavailable', () => {
    const wiring = createWiring({ apiBaseUrl: undefined });

    expect(() => wiring.prepare(baseSession(), enabledSettings())).toThrow(/Desk API URL unavailable/);
    expect(wiring.minted).toHaveLength(0);
  });

  it('cleans tracked tokens on reconciliation and cleanupAll', () => {
    const wiring = createWiring();
    const first = wiring.prepare({ ...baseSession(), tmuxSession: 'agentdesk-one' }, enabledSettings());
    const second = wiring.prepare({ ...baseSession(), tmuxSession: 'agentdesk-two' }, enabledSettings());

    expect(wiring.minted).toEqual(['/workspace', '/workspace']);
    wiring.reconcile(new Set(['agentdesk-two']));
    expect(wiring.revoked).toEqual(['token-1']);
    expect(existsSync(first!.envFilePath)).toBe(false);
    expect(existsSync(second!.envFilePath)).toBe(true);

    wiring.cleanupAll();
    expect(wiring.revoked).toEqual(['token-1', 'token-2']);
    expect(existsSync(second!.envFilePath)).toBe(false);
  });
});

function createWiring(options: { apiBaseUrl?: string } = {}) {
  const parent = join(tmpdir(), 'desk-lsp-managed-agents');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const runtimeRoot = mkdtempSync(join(parent, `test-${process.pid}-`));
  tempRoots.push(runtimeRoot);
  const minted: string[] = [];
  const revoked: string[] = [];
  let nextToken = 1;
  const wiring = createManagedAgentLspWiring({
    runtimeRoot,
    getApiBaseUrl: () => ('apiBaseUrl' in options ? options.apiBaseUrl : 'http://127.0.0.1:6123'),
    tokenRegistry: {
      mint(workspaceRoot: string) {
        minted.push(workspaceRoot);
        return { token: `token-${nextToken++}`, workspaceRoot };
      },
      revoke(token: string) {
        revoked.push(token);
      }
    }
  });
  return Object.assign(wiring, { minted, revoked });
}

function baseSession(): SessionSpec {
  return {
    groupId: 'group',
    groupLabel: 'Group',
    name: 'agent',
    cwd: '/workspace',
    agent: 'claude',
    tmuxSession: 'agentdesk-group-agent-12345678',
    command: "cd '/workspace' && claude"
  };
}

function enabledSettings(): DeskSettings {
  return {
    lsp: {
      enabled: true,
      languages: ['typescript'],
      agents: { enabled: true }
    }
  };
}
