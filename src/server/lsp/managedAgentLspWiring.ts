import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentCommand } from '../../core/manifest.js';
import type { DeskSettings, SessionSpec } from '../../core/types.js';

interface TokenRegistry {
  mint(workspaceRoot: string): { token: string; workspaceRoot: string };
  revoke(token: string): void;
}

export interface ManagedAgentLspWiringOptions {
  tokenRegistry: TokenRegistry;
  getApiBaseUrl: () => string | undefined;
  runtimeRoot?: string;
}

export interface ManagedAgentLspLaunch {
  session: SessionSpec;
  envFilePath: string;
  cleanup: () => void;
}

export function createManagedAgentLspWiring(options: ManagedAgentLspWiringOptions) {
  const runtimeRoot = options.runtimeRoot ?? join(tmpdir(), 'desk-lsp-managed-agents', String(process.pid));
  const tracked = new Map<string, { token: string; dir: string }>();

  function prepare(session: SessionSpec, settings: DeskSettings | undefined): ManagedAgentLspLaunch | undefined {
    if (!shouldWire(session, settings)) {
      return undefined;
    }
    const apiBaseUrl = options.getApiBaseUrl();
    if (!apiBaseUrl) {
      throw new Error('Desk API URL unavailable for managed agent LSP wiring');
    }
    cleanup(session.tmuxSession);
    const dir = join(runtimeRoot, safePathPart(session.tmuxSession));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(runtimeRoot, 0o700);
    chmodSync(dir, 0o700);

    let token = '';
    try {
      const binding = options.tokenRegistry.mint(session.cwd);
      token = binding.token;
      const envFilePath = join(dir, 'env.json');
      writeFileSync(
        envFilePath,
        JSON.stringify({
          DESK_API: apiBaseUrl,
          DESK_LSP_TOKEN: binding.token,
          DESK_LSP_WORKSPACE_ROOT: binding.workspaceRoot
        }),
        { mode: 0o600 }
      );
      chmodSync(envFilePath, 0o600);

      const launchConfig =
        session.agent === 'claude'
          ? writeClaudeConfig(dir, envFilePath)
          : { envFilePath };
      const command = buildAgentCommand(session, session.cwd, homedir(), session.tmuxSession, launchConfig);
      tracked.set(session.tmuxSession, { token: binding.token, dir });
      return {
        session: { ...session, command },
        envFilePath,
        cleanup: () => cleanup(session.tmuxSession)
      };
    } catch (error) {
      if (token) {
        options.tokenRegistry.revoke(token);
      }
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  function cleanup(tmuxSession: string): void {
    const entry = tracked.get(tmuxSession);
    if (!entry) {
      return;
    }
    tracked.delete(tmuxSession);
    options.tokenRegistry.revoke(entry.token);
    rmSync(entry.dir, { recursive: true, force: true });
  }

  function cleanupAll(): void {
    for (const tmuxSession of [...tracked.keys()]) {
      cleanup(tmuxSession);
    }
  }

  function reconcile(runningSessions: Set<string>): void {
    for (const tmuxSession of [...tracked.keys()]) {
      if (!runningSessions.has(tmuxSession)) {
        cleanup(tmuxSession);
      }
    }
  }

  return { prepare, cleanup, cleanupAll, reconcile };
}

function shouldWire(session: SessionSpec, settings: DeskSettings | undefined): boolean {
  const lsp = settings?.lsp;
  return (
    lsp?.enabled === true &&
    Array.isArray(lsp.languages) &&
    lsp.languages.some((language) => typeof language === 'string' && language.trim() !== '') &&
    lsp.agents?.enabled === true &&
    (session.agent === 'claude' || session.agent === 'codex') &&
    session.customCommand !== true
  );
}

function writeClaudeConfig(dir: string, envFilePath: string) {
  const claudeConfigPath = join(dir, 'claude-mcp.json');
  writeFileSync(
    claudeConfigPath,
    JSON.stringify({
      mcpServers: {
        desk_lsp: {
          command: 'desk-lsp-mcp',
          args: [],
          env: { DESK_LSP_ENV_FILE: envFilePath }
        }
      }
    }),
    { mode: 0o600 }
  );
  chmodSync(claudeConfigPath, 0o600);
  return { envFilePath, claudeConfigPath };
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
