import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest';

describe('desk manifest ui mode', () => {
  it('defaults SDK-backed agent sessions to native ui mode when none is declared', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        cwd: ~/projects/alpha
        agent: claude
        uiMode: native
      - name: plain
        cwd: ~/projects/alpha
        agent: codex
`);
    const specs = buildSessionSpecs(manifest, { homeDir: '/workspace', namespace: 'agentdesk' });
    expect(specs.map((spec) => spec.uiMode)).toEqual(['native', 'native']);
  });

  it('honors an explicit terminal uiMode and keeps custom-command sessions terminal', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: old-school
        cwd: ~/projects/alpha
        agent: claude
        uiMode: terminal
      - name: scripted
        cwd: ~/projects/alpha
        command: htop
`);
    const specs = buildSessionSpecs(manifest, { homeDir: '/workspace', namespace: 'agentdesk' });
    expect(specs.map((spec) => spec.uiMode)).toEqual(['terminal', 'terminal']);
  });

  it('carries an optional model through parse and spec derivation', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        cwd: ~/projects/alpha
        agent: opencode
        uiMode: native
        model: zai-coding-plan/glm-5.2
`);
    const [spec] = buildSessionSpecs(manifest, { homeDir: '/workspace', namespace: 'agentdesk' });
    expect(spec.model).toBe('zai-coding-plan/glm-5.2');
  });

  it('builds the static agent-host command for native sessions', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        cwd: ~/projects/alpha
        agent: claude
        uiMode: native
`);
    const [spec] = buildSessionSpecs(manifest, { homeDir: '/workspace', namespace: 'agentdesk' });
    expect(spec.command).toBe("cd '/workspace/projects/alpha' && exec desk agent-host");
  });

  it('rejects native ui mode for bash sessions at parse time', () => {
    expect(() =>
      parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: shell
        cwd: ~/projects/alpha
        agent: bash
        uiMode: native
`)
    ).toThrow(/native/);
  });

  it('rejects native ui mode for custom-command sessions at parse time', () => {
    expect(() =>
      parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: custom
        command: htop
        uiMode: native
`)
    ).toThrow(/native/);
  });

  it('rejects native ui mode when the session has no supported agent', () => {
    expect(() =>
      parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: mystery
        cwd: ~/projects/alpha
        uiMode: native
`)
    ).toThrow();
  });

  it('rejects unknown ui mode values at parse time', () => {
    expect(() =>
      parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        cwd: ~/projects/alpha
        agent: claude
        uiMode: fancy
`)
    ).toThrow(/uiMode/);
  });
});

function buildClaudeResumeSpecCommand(cwd: string, resume: string): string {
  return buildSessionSpecs(
    parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: claude
        cwd: ${cwd}
        agent: claude
        resume: ${resume}
        uiMode: terminal
`),
    { homeDir: cwd }
  )[0].command;
}

function createClaudeLaunchFixture(options: { claudeScript: string }): {
  home: string;
  workspace: string;
  bin: string;
  shell: string;
  cleanup(): void;
  readClaudeArgs(): string[];
  readShellLog(): string;
} {
  const root = mkdtempSync(join(tmpdir(), 'desk-claude-launch-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  const shell = join(bin, 'pane-shell');
  writeFileSync(claude, options.claudeScript);
  writeFileSync(
    shell,
    `#!/bin/sh
printf '%s\n' 'shell kept alive' >> "$HOME/shell.log"
exit 0
`
  );
  chmodSync(claude, 0o755);
  chmodSync(shell, 0o755);
  return {
    home,
    workspace,
    bin,
    shell,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    readClaudeArgs: () => readText(join(home, 'claude-args.log')).trim().split('\n').filter(Boolean),
    readShellLog: () => readText(join(home, 'shell.log'))
  };
}

function runGeneratedCommand(
  command: string,
  fixture: { home: string; bin: string; shell: string }
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-lc', command], {
    cwd: fixture.home,
    env: { ...process.env, HOME: fixture.home, PATH: `${fixture.bin}:${process.env.PATH ?? ''}`, SHELL: fixture.shell },
    encoding: 'utf8'
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('desk manifest', () => {
  it('turns grouped Codex resume entries into stable session specs', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    label: Research
    sessions:
      - name: alpha
        cwd: ~/projects/alpha
        agent: codex
        resume: 00000000-0000-7000-8000-000000000001
      - name: project-mu
        cwd: ~/projects/project-μ
        agent: codex
        resume: 00000000-0000-7000-8000-000000000002
`);

    const specs = buildSessionSpecs(manifest, {
      homeDir: '/workspace',
      namespace: 'agentdesk'
    });

    expect(specs).toEqual([
      {
        groupId: 'group-1',
        groupLabel: 'Research',
        name: 'alpha',
        cwd: '/workspace/projects/alpha',
        agent: 'codex',
        resume: '00000000-0000-7000-8000-000000000001',
        bypassPermissions: undefined,
        groupLayout: undefined,
        groupOrder: undefined,
        order: undefined,
        tmuxSession: 'agentdesk-group-1-alpha-00000000',
        command: "cd '/workspace/projects/alpha' && exec desk agent-host",
        uiMode: 'native'
      },
      {
        groupId: 'group-1',
        groupLabel: 'Research',
        name: 'project-mu',
        cwd: '/workspace/projects/project-μ',
        agent: 'codex',
        resume: '00000000-0000-7000-8000-000000000002',
        bypassPermissions: undefined,
        groupLayout: undefined,
        groupOrder: undefined,
        order: undefined,
        tmuxSession: 'agentdesk-group-1-project-mu-00000000',
        command: "cd '/workspace/projects/project-μ' && exec desk agent-host",
        uiMode: 'native'
      }
    ]);
  });

  it('requires session cwd and either a command or a supported agent', () => {
    expect(() =>
      parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: broken
        cwd: ~/projects/alpha
        agent: unknown-agent
`)
    ).toThrow(/supported agent or command/);
  });

  it('allows command-only root sessions because custom commands can own cd behavior', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: beta
        command: cd '/workspace/projects/beta' && codex -c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always resume 'abc'
`);

    expect(buildSessionSpecs(manifest, { homeDir: '/workspace' })[0]).toMatchObject({
      name: 'beta',
      cwd: '/workspace',
      command: "cd '/workspace/projects/beta' && codex -c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always resume 'abc'"
    });
  });

  it('constructs shell commands for supported agents', () => {
    const manifest = parseDeskManifest(`
projects:
  - id: sample
    cwd: ~/projects/sample
    groups:
      - id: main
        sessions:
          - name: bash
            agent: bash
          - name: claude
            agent: claude
            bypassPermissions: true
            resume: abc123
            uiMode: terminal
          - name: codex
            agent: codex
            bypassPermissions: true
            uiMode: terminal
          - name: opencode
            agent: opencode
            resume: ses_12a31855dffeHTCs6tcfOmsddP
            uiMode: terminal
`);

    const commands = buildSessionSpecs(manifest, { homeDir: '/workspace' }).map((session) => session.command);
    expect(commands[0]).toBe("cd '/workspace/projects/sample' && exec bash");
    // Agent launches carry explicit Desk identity for globally installed hooks.
    expect(commands[1]).toContain("cd '/workspace/projects/sample' && desk_claude_session=");
    expect(commands[1]).toContain("DESK_TMUX_SESSION='agentdesk-sample-main-claude-");
    expect(commands[1]).toContain("DESK_AGENT='claude' claude");
    expect(commands[1]).toContain('--settings');
    expect(commands[1]).toContain('preferredNotifChannel');
    expect(commands[1]).toContain("--dangerously-skip-permissions --resume 'abc123'");
    expect(commands[1]).toContain('desk_claude_session="$HOME/.claude/projects/-workspace-projects-sample/abc123.jsonl"');
    expect(commands[1]).not.toContain('grep -q');
    expect(commands[1]).toContain('desk: claude --resume failed with exit $desk_claude_resume_status; trying --continue');
    expect(commands[1]).toContain('if [ -f "$desk_claude_session" ]; then touch "$desk_claude_session"; fi');
    expect(commands[1]).toContain('desk: claude --continue failed with exit $desk_claude_continue_status; leaving pane open for diagnostics');
    expect(commands[1]).toContain('exec "${SHELL:-/bin/sh}"');
    expect(commands[1]).toContain('--continue');
    expect(commands[2]).toContain("DESK_AGENT='codex' codex -c tui.notifications=true");
    expect(commands[2]).toContain('tui.notification_method=bel');
    expect(commands[2]).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(commands[3]).toContain("cd '/workspace/projects/sample' && ");
    expect(commands[3]).toContain("DESK_TMUX_SESSION='agentdesk-sample-main-opencode-");
    expect(commands[3]).toContain("DESK_AGENT='opencode'");
    expect(commands[3]).toContain('desk_opencode="${DESK_OPENCODE_BIN:-$(command -v opencode 2>/dev/null || true)}"');
    expect(commands[3]).toContain('desk_opencode="$HOME/.opencode/bin/opencode"');
    expect(commands[3]).toContain('desk_opencode_config="${DESK_OPENCODE_CONFIG_DIR:-}"');
    expect(commands[3]).toContain("desk_opencode_config='/workspace/.config/desk/opencode'");
    expect(commands[3]).toContain('OPENCODE_CONFIG_DIR="$desk_opencode_config"');
    expect(commands[3]).toContain('OPENCODE_DISABLE_MOUSE=1');
    expect(commands[3]).toContain('exec "$desk_opencode" --session \'ses_12a31855dffeHTCs6tcfOmsddP\'');
    expect(commands[3]).not.toContain('dangerously');
    // no bypassPermissions set -> defaults to yolo (allow) via per-session OPENCODE_CONFIG_CONTENT
    expect(commands[3]).toContain('OPENCODE_CONFIG_CONTENT=\'{"permission":{"*":"allow"}}\'');
  });

  it('falls back from claude resume to continue when the CLI cannot resume the id', () => {
    const fixture = createClaudeLaunchFixture({
      claudeScript: `#!/bin/sh
printf '%s\n' "$*" >> "$HOME/claude-args.log"
case " $* " in
  *" --resume "*) printf '%s\n' "No conversation found for resume" >&2; exit 31 ;;
  *" --continue"*) printf '%s\n' "continued"; exit 0 ;;
  *) printf '%s\n' "unexpected args: $*" >&2; exit 99 ;;
esac
`
    });
    try {
      const command = buildClaudeResumeSpecCommand(fixture.workspace, 'abc123');
      const result = runGeneratedCommand(command, fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('continued');
      expect(result.stderr).toContain('desk: claude --resume failed with exit 31; trying --continue');
      expect(fixture.readClaudeArgs()).toEqual([
        expect.stringContaining('--resume abc123'),
        expect.stringContaining('--continue')
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps a claude terminal pane alive with diagnostics when resume and continue both fail', () => {
    const fixture = createClaudeLaunchFixture({
      claudeScript: `#!/bin/sh
printf '%s\n' "$*" >> "$HOME/claude-args.log"
case " $* " in
  *" --resume "*) printf '%s\n' "resume missing" >&2; exit 31 ;;
  *" --continue"*) printf '%s\n' "continue missing" >&2; exit 32 ;;
  *) printf '%s\n' "unexpected args: $*" >&2; exit 99 ;;
esac
`
    });
    try {
      const command = buildClaudeResumeSpecCommand(fixture.workspace, 'abc123');
      const result = runGeneratedCommand(command, fixture);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('desk: claude --resume failed with exit 31; trying --continue');
      expect(result.stderr).toContain('desk: claude --continue failed with exit 32; leaving pane open for diagnostics');
      expect(fixture.readShellLog()).toEqual('shell kept alive\n');
    } finally {
      fixture.cleanup();
    }
  });

  it('maps the opencode bypass-permissions checkbox to the per-session permission ruleset', () => {
    const yolo = buildSessionSpecs(
      parseDeskManifest(`
projects:
  - id: sample
    name: Sample
    cwd: /workspace/projects/sample
    groups:
      - id: main
        sessions:
          - name: oc-yolo
            agent: opencode
            uiMode: terminal
            bypassPermissions: true
`),
      { homeDir: '/workspace' }
    )[0].command;
    const gated = buildSessionSpecs(
      parseDeskManifest(`
projects:
  - id: sample
    name: Sample
    cwd: /workspace/projects/sample
    groups:
      - id: main
        sessions:
          - name: oc-gated
            agent: opencode
            uiMode: terminal
            bypassPermissions: false
`),
      { homeDir: '/workspace' }
    )[0].command;
    // checked -> allow (no prompts); unchecked -> ask (OpenCode prompts per tool)
    expect(yolo).toContain('OPENCODE_CONFIG_CONTENT=\'{"permission":{"*":"allow"}}\'');
    expect(gated).toContain('OPENCODE_CONFIG_CONTENT=\'{"permission":{"*":"ask"}}\'');
  });

  it('keeps opencode resume discovery out of the generated shell command', () => {
    const command = buildSessionSpecs(
      parseDeskManifest(`
projects:
  - id: sample
    cwd: /workspace/projects/sample
    groups:
      - id: main
        sessions:
          - name: opencode
            agent: opencode
            uiMode: terminal
`),
      { homeDir: '/workspace' }
    )[0].command;

    expect(command).not.toContain('node -e');
    expect(command).not.toContain('session list');
    expect(command).toContain('DESK_OPENCODE_RESUME_ID');
  });

  it('applies MCP launch flags only when explicitly requested', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: claude
        cwd: ~/projects/sample
        agent: claude
        uiMode: terminal
      - name: codex
        cwd: ~/projects/sample
        agent: codex
        resume: abc123
        uiMode: terminal
`);

    const base = buildSessionSpecs(manifest, { homeDir: '/workspace' });
    expect(base.map((session) => session.command).join('\n')).not.toContain('DESK_LSP_ENV_FILE');

    const launch = buildSessionSpecs(manifest, {
      homeDir: '/workspace',
      agentMcp: () => ({
        envFilePath: '/tmp/app-lsp-managed-agents/123/session/env.json',
        claudeConfigPath: '/tmp/app-lsp-managed-agents/123/session/claude-mcp.json'
      })
    });

    expect(launch[0].command).toContain("--mcp-config '/tmp/app-lsp-managed-agents/123/session/claude-mcp.json'");
    expect(launch[0].command).not.toContain('file-token');
    expect(launch[1].command).toContain(
      "-c 'mcp_servers.desk_lsp.env.DESK_LSP_ENV_FILE=\"/tmp/app-lsp-managed-agents/123/session/env.json\"'"
    );
    expect(launch[1].command).toContain("resume 'abc123'");
    expect(base[0].command).not.toContain('/tmp/app-lsp-managed-agents');
  });
});

describe('claude resume command shell safety', () => {
  it('passes a hostile resume id as a shell-quoted argument, never raw in a double-quoted string', () => {
    const manifest = parseDeskManifest(`
projects:
  - id: sample
    cwd: ~/projects/sample
    groups:
      - id: main
        sessions:
          - name: claude
            agent: claude
            bypassPermissions: true
            resume: 'a$(id)b'
            uiMode: terminal
`);
    const [claude] = buildSessionSpecs(manifest, { homeDir: '/workspace' });
    const command = claude!.command;
    // The diagnostic echo prints the id via a shell-quoted %s arg (single quotes make $(id) inert)...
    expect(command).toContain("printf 'desk: claude resume id: %s\\n' 'a$(id)b'");
    // ...and never interpolates it raw into a double-quoted context (the pre-fix injection path).
    expect(command).not.toContain('resume id: a$(id)b');
    // The --resume argument stays quoted too.
    expect(command).toContain("--resume 'a$(id)b'");
  });
});
