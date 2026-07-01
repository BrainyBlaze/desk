import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildClaudeHooksSettings,
  buildCodexHooksConfig,
  buildDeskAgentEventShim,
  codexHookPreflightStatus,
  installAgentHooks
} from '../src/core/agentHooks.js';

describe('agent hook configuration generation', () => {
  it('generates Codex command hooks only and does not invent unsupported SessionEnd hooks', () => {
    const config = buildCodexHooksConfig('/workspace/.local/share/desk/hooks/desk-agent-event');

    expect(Object.keys(config.hooks).sort()).toEqual([
      'PermissionRequest',
      'SessionStart',
      'Stop',
      'UserPromptSubmit'
    ]);
    expect(JSON.stringify(config)).toContain('"type":"command"');
    expect(JSON.stringify(config)).not.toContain('"type":"http"');
    expect(JSON.stringify(config)).not.toContain('SessionEnd');
    expect(JSON.stringify(config)).toContain('/workspace/.local/share/desk/hooks/desk-agent-event');
  });

  it('generates Claude command hooks with the lifecycle events Desk needs', () => {
    const settings = buildClaudeHooksSettings('/workspace/.local/share/desk/hooks/desk-agent-event');

    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'UserPromptSubmit'
    ]);
    expect(JSON.stringify(settings)).toContain('"type":"command"');
    expect(JSON.stringify(settings)).toContain("--event 'Stop'");
    expect(JSON.stringify(settings)).toContain("--event 'UserPromptSubmit'");
  });

  it('tracks Codex hooks as degraded until trust and boot preflight both succeed', () => {
    expect(
      codexHookPreflightStatus({
        installed: true,
        trusted: false,
        sessionStartSeen: false
      })
    ).toEqual({ active: false, degradedReason: 'codex-hook-untrusted' });

    expect(
      codexHookPreflightStatus({
        installed: true,
        trusted: true,
        sessionStartSeen: false
      })
    ).toEqual({ active: false, degradedReason: 'hook-not-firing' });

    expect(
      codexHookPreflightStatus({
        installed: true,
        trusted: true,
        sessionStartSeen: true
      })
    ).toEqual({ active: true });
  });

  it('produces a prompt-safe shim script that posts typed events and exits cleanly', () => {
    const shim = buildDeskAgentEventShim();

    expect(shim).toContain('process.stdin');
    expect(shim).toContain('DESK_TMUX_SESSION');
    expect(shim).toContain('/api/agent-event');
    expect(shim).toContain('schemaVersion: 2');
    expect(shim).toContain('process.exit(0)');
    expect(shim).not.toContain('console.log');
  });

  it('installs global hook files idempotently without clobbering existing hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-'));
    try {
      const codexPath = join(home, '.codex', 'hooks.json');
      const claudePath = join(home, '.claude', 'settings.json');
      mkdirSync(dirname(codexPath), { recursive: true });
      mkdirSync(dirname(claudePath), { recursive: true });
      writeFileSync(codexPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-codex' }] }] } }));
      writeFileSync(claudePath, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-claude' }] }] } }));

      const installed = installAgentHooks({ homeDir: home });
      installAgentHooks({ homeDir: home });

      expect(existsSync(installed.shimPath)).toBe(true);
      expect(statSync(installed.shimPath).mode & 0o111).not.toBe(0);
      expect(readFileSync(installed.shimPath, 'utf8')).toContain('/api/agent-event');

      const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
      expect(JSON.stringify(codex)).toContain('echo keep-codex');
      expect(JSON.stringify(codex)).toContain('desk-agent-event');
      expect(JSON.stringify(codex)).toContain('UserPromptSubmit');
      expect(JSON.stringify(codex).match(/desk-agent-event/g)?.length).toBe(4);

      const claude = JSON.parse(readFileSync(claudePath, 'utf8'));
      expect(claude.theme).toBe('dark');
      expect(JSON.stringify(claude)).toContain('echo keep-claude');
      expect(JSON.stringify(claude)).toContain('desk-agent-event');
      expect(JSON.stringify(claude)).toContain('UserPromptSubmit');
      expect(JSON.stringify(claude).match(/desk-agent-event/g)?.length).toBe(8);

      expect(readFileSync(installed.opencodePluginPath, 'utf8')).toContain('/api/agent-event');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
