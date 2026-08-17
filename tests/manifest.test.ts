import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSessionSpecs,
  collectSessions,
  ManifestValidationError,
  parseDeskManifest
} from '../src/core/manifest';

// A session exactly as Desk v0.3.1 wrote it once it had started (the shape a
// never-upgraded install still carries): the retired `tmuxSession` key, no
// `sessionId`. Taken from a real pre-cutover backup, values shortened.
const PRE_CUTOVER_STARTED_SESSION = `
projects:
  - id: brainyblaze
    label: brainyblaze
    cwd: ~/projects/brainyblaze
    groups:
      - id: site
        label: site
        sessions:
          - name: codex
            cwd: /home/dev/projects/brainyblaze
            agent: codex
            resume: 019f4b95-d315-7092-8603-7a8781aa653b
            bypassPermissions: true
            uiMode: terminal
            tmuxSession: agentdesk-brainyblaze-site-codex-019f4b95
`;

// The same era, a session that never started: v0.3.1 wrote no identity at all.
const PRE_CUTOVER_UNSTARTED_SESSION = `
groups:
  - id: main
    sessions:
      - name: legacy
        cwd: /workspace
        command: bash
`;

describe('desk manifest native identity boundary', () => {
  // The cutover migration that used to rewrite these manifests is gone (PR 78
  // deleted it with the engine lock it was welded to). The refusal therefore
  // has to name the one remedy that still exists — boot Desk v0.3.2, the last
  // release that migrates — instead of "run the sessionId migration".
  it('refuses a v0.3.1 started session by naming the retired key and the support floor', () => {
    let caught: unknown;
    try {
      parseDeskManifest(PRE_CUTOVER_STARTED_SESSION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestValidationError);
    const message = (caught as Error).message;
    expect(message).toContain('session codex');
    expect(message).toContain('tmuxSession');
    expect(message).toContain('Desk v0.3.1 or older');
    expect(message).toContain('boot Desk v0.3.2 once');
    expect(message).toContain('does not migrate');
    expect(message).not.toMatch(/run the .*migration/);
  });

  it('refuses a v0.3.1 session that never started (no identity at all) with the same floor, and says what a hand-written session needs', () => {
    let caught: unknown;
    try {
      parseDeskManifest(PRE_CUTOVER_UNSTARTED_SESSION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestValidationError);
    const message = (caught as Error).message;
    expect(message).toContain('session legacy has no sessionId');
    expect(message).toContain('boot Desk v0.3.2 once');
    expect(message).toContain('does not migrate');
    // A hand-written session is the other way to arrive here; the operator
    // must be told the grammar, not sent to a release they may not need.
    expect(message).toContain('^[a-z][a-z0-9-]{2,63}$');
  });

  it('a present but malformed sessionId is a bad id, not a pre-cutover store — no floor is named', () => {
    let caught: unknown;
    try {
      parseDeskManifest(`
groups:
  - id: main
    sessions:
      - name: shouty
        sessionId: Not-Valid
        cwd: /workspace
        command: bash
`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestValidationError);
    expect((caught as Error).message).toContain('session shouty has "Not-Valid" sessionId');
    expect((caught as Error).message).not.toContain('v0.3.2');
  });

  it('collectSessions walks top-level groups then projects, in order', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: main
    sessions:
      - name: one
        sessionId: one
        cwd: /workspace
        command: bash
projects:
  - id: proj
    label: proj
    cwd: /workspace
    groups:
      - id: g
        sessions:
          - name: two
            sessionId: two
            command: bash
          - name: three
            sessionId: three
            command: bash
`);
    expect(collectSessions(manifest).map((session) => session.sessionId)).toEqual(['one', 'two', 'three']);
  });

  it('rejects duplicate runtime sessionIds before building specs', () => {
    expect(() =>
      parseDeskManifest(`
groups:
  - id: main
    sessions:
      - name: one
        sessionId: same-id
        cwd: /workspace
        command: bash
      - name: two
        sessionId: same-id
        cwd: /workspace
        command: bash
`)
    ).toThrow(/duplicate sessionId/);
  });

  it('builds runtime specs with sessionId as the only lifecycle identity', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: main
    sessions:
      - name: alpha
        sessionId: alpha
        cwd: /workspace
        command: bash
`);

    const [spec] = buildSessionSpecs(manifest, { homeDir: '/workspace' });
    expect(spec.sessionId).toBe('alpha');
    expect(spec).not.toHaveProperty('tmuxSession');
  });
});

describe('desk manifest ui mode', () => {
  // Terminal is the default for a declared-nothing session, and native is
  // opt-in. The session form pre-selects terminal for the same reason, and the
  // two must agree: while they disagreed, an operator editing the manifest by
  // hand got a different default from one using the UI.
  it('defaults an undeclared uiMode to terminal, and honours an explicit native', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        sessionId: chat
        cwd: ~/projects/alpha
        agent: claude
        uiMode: native
      - name: plain
        sessionId: plain
        cwd: ~/projects/alpha
        agent: codex
`);
    const specs = buildSessionSpecs(manifest, { homeDir: '/workspace' });
    expect(specs.map((spec) => spec.uiMode)).toEqual(['native', 'terminal']);
  });

  it('honors an explicit terminal uiMode and keeps custom-command sessions terminal', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: old-school
        sessionId: old-school
        cwd: ~/projects/alpha
        agent: claude
        uiMode: terminal
      - name: scripted
        sessionId: scripted
        cwd: ~/projects/alpha
        command: htop
`);
    const specs = buildSessionSpecs(manifest, { homeDir: '/workspace' });
    expect(specs.map((spec) => spec.uiMode)).toEqual(['terminal', 'terminal']);
  });

  it('carries an optional model through parse and spec derivation', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        sessionId: chat
        cwd: ~/projects/alpha
        agent: opencode
        uiMode: native
        model: zai-coding-plan/glm-5.2
`);
    const [spec] = buildSessionSpecs(manifest, { homeDir: '/workspace' });
    expect(spec.model).toBe('zai-coding-plan/glm-5.2');
  });

  it('builds the static agent-host command for native sessions', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: chat
        sessionId: chat
        cwd: ~/projects/alpha
        agent: claude
        uiMode: native
`);
    const [spec] = buildSessionSpecs(manifest, { homeDir: '/workspace' });
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
        sessionId: claude
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
        sessionId: alpha
        cwd: ~/projects/alpha
        agent: codex
        uiMode: native
        resume: 00000000-0000-7000-8000-000000000001
      - name: project-mu
        sessionId: project-mu
        cwd: ~/projects/project-μ
        agent: codex
        uiMode: native
        resume: 00000000-0000-7000-8000-000000000002
`);
    // `uiMode` is declared because this test is about resume entries becoming
    // stable specs, not about what an undeclared mode resolves to — that has
    // its own test, and leaving it implicit here would couple the two.

    const specs = buildSessionSpecs(manifest, { homeDir: '/workspace' });

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
        sessionId: 'alpha',
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
        sessionId: 'project-mu',
        command: "cd '/workspace/projects/project-μ' && exec desk agent-host",
        uiMode: 'native'
      }
    ]);
  });

  it('fails closed on invalid or duplicate persisted sessionIds', () => {
    expect(() => parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: unsafe
        cwd: /workspace
        command: bash
        sessionId: bad/id
`)).toThrow(/sessionId/);

    expect(() => parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: unsafe-type
        cwd: /workspace
        command: bash
        sessionId: true
`)).toThrow(/sessionId/);

    expect(() => parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: one
        cwd: /workspace
        command: bash
        sessionId: same-id
      - name: two
        cwd: /workspace
        command: bash
        sessionId: same-id
`)).toThrow(/duplicate sessionId "same-id"/);
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
        sessionId: beta
        command: cd '/workspace/projects/beta' && codex resume 'abc'
`);

    expect(buildSessionSpecs(manifest, { homeDir: '/workspace' })[0]).toMatchObject({
      name: 'beta',
      cwd: '/workspace',
      command: "cd '/workspace/projects/beta' && codex resume 'abc'"
    });
  });

  it('constructs shell commands for qwen, kimi and grok', () => {
    const manifest = parseDeskManifest(`
projects:
  - id: sample
    cwd: ~/projects/sample
    groups:
      - id: main
        sessions:
          - name: qwen
            sessionId: qwen
            agent: qwen
            bypassPermissions: true
            resume: 123e4567-e89b-12d3-a456-426614174000
          - name: kimi
            sessionId: kimi
            agent: kimi
            bypassPermissions: true
            resume: kimi-session-abc
          - name: grok
            sessionId: grok
            agent: grok
            resume: a1b2c3d4e5f6
`);
    const commands = buildSessionSpecs(manifest, { homeDir: '/workspace' }).map((session) => session.command);
    expect(commands[0]).toContain("DESK_SESSION_ID='qwen' DESK_AGENT='qwen' qwen");
    expect(commands[0]).toContain("--resume '123e4567-e89b-12d3-a456-426614174000'");
    expect(commands[0]).toContain('--yolo');
    expect(commands[1]).toContain("DESK_SESSION_ID='kimi' DESK_AGENT='kimi' kimi");
    expect(commands[1]).toContain("--session 'kimi-session-abc'");
    expect(commands[1]).toContain('--yolo');
    expect(commands[2]).toContain("DESK_SESSION_ID='grok' DESK_AGENT='grok' grok");
    expect(commands[2]).toContain("--session 'a1b2c3d4e5f6'");
    expect(commands[2]).not.toContain('--yolo');
    // every resume launch is guarded: a rejected id keeps the pane alive.
    for (const i of [0, 1, 2]) {
      expect(commands[i]).toContain('desk_resume_status=$?');
      expect(commands[i]).toContain('exec "${SHELL:-/bin/sh}"');
      expect(commands[i]).toContain('to start a fresh session');
    }
  });

  it('does not wrap a resume guard around a fresh (no-resume) launch', () => {
    const manifest = parseDeskManifest(`
projects:
  - id: sample
    cwd: ~/projects/sample
    groups:
      - id: main
        sessions:
          - name: qwen
            sessionId: qwen
            agent: qwen
`);
    const command = buildSessionSpecs(manifest, { homeDir: '/workspace' })[0].command;
    expect(command).not.toContain('desk_resume_status');
    expect(command).not.toContain('exec "${SHELL:-/bin/sh}"');
  });

  it('keeps silently ignoring bypassPermissions on shell sessions as before', () => {
    const manifest = parseDeskManifest(`
projects:
  - id: sample
    cwd: ~/projects/sample
    groups:
      - id: main
        sessions:
          - name: shell
            sessionId: shell
            agent: bash
            bypassPermissions: true
`);
    const commands = buildSessionSpecs(manifest, { homeDir: '/workspace' }).map((session) => session.command);
    expect(commands[0]).toContain('bash');
  });

  it('rejects bypassPermissions for agents that cannot honor it', () => {
    expect(() =>
      parseDeskManifest(`
projects:
  - id: sample
    cwd: ~/projects/sample
    groups:
      - id: main
        sessions:
          - name: qwen
            sessionId: qwen
            agent: grok
            bypassPermissions: true
`)
    ).toThrow(/cannot use bypassPermissions/);
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
            sessionId: bash-x
            agent: bash
          - name: claude
            sessionId: claude
            agent: claude
            bypassPermissions: true
            resume: abc123
            uiMode: terminal
          - name: codex
            sessionId: codex
            agent: codex
            bypassPermissions: true
            uiMode: terminal
          - name: opencode
            sessionId: opencode
            agent: opencode
            resume: ses_12a31855dffeHTCs6tcfOmsddP
            uiMode: terminal
`);

    const commands = buildSessionSpecs(manifest, { homeDir: '/workspace' }).map((session) => session.command);
    expect(commands[0]).toBe("cd '/workspace/projects/sample' && exec bash");
    // Agent launches carry explicit Desk identity for globally installed hooks.
    expect(commands[1]).toContain("cd '/workspace/projects/sample' && ");
    expect(commands[1]).toContain("DESK_SESSION_ID='claude'");
    expect(commands[1]).not.toContain('DESK_TMUX_SESSION');
    expect(commands[1]).not.toContain('tmux display-message');
    // Claude's terminal defaults to the classic renderer with mouse capture
    // off so desk's xterm owns scroll/selection/right-click; the env sits
    // between the Desk identity and the binary.
    expect(commands[1]).toContain(
      "DESK_AGENT='claude' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_DISABLE_MOUSE=1 claude"
    );
    // `--settings` points at DESK'S OWN file, never at the operator's. The
    // retired form inlined a JSON blob carrying terminal-bell settings and
    // hooks of a schema the route now rejects; this one names a file Desk
    // writes and owns, so the operator's ~/.claude/settings.json is never
    // touched by Desk at all.
    expect(commands[1]).toContain('--settings');
    expect(commands[1]).toContain('/.config/desk/claude/settings.json');
    expect(commands[1]).not.toContain('preferredNotifChannel');
    expect(commands[1]).toContain("--dangerously-skip-permissions --resume 'abc123'");
    expect(commands[1]).not.toContain('grep -q');
    expect(commands[1]).toContain('desk: exact claude --resume failed with exit $desk_claude_resume_status; leaving pane open for diagnostics');
    expect(commands[1]).toContain('exec "${SHELL:-/bin/sh}"');
    expect(commands[1]).not.toContain('--continue');
    expect(commands[2]).toContain("DESK_SESSION_ID='codex' DESK_AGENT='codex' codex");
    // The BEL launch flags are gone with the rest of the terminal-bell era: a
    // bell is an edge with no author, and any child ringing it looked
    // identical to the agent finishing a turn.
    expect(commands[2]).not.toContain('tui.notification_method=bel');
    expect(commands[2]).not.toContain('tui.notifications=true');
    expect(commands[2]).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(commands[3]).toContain("cd '/workspace/projects/sample' && ");
    expect(commands[3]).toContain("DESK_SESSION_ID='opencode'");
    expect(commands[3]).not.toContain('DESK_TMUX_SESSION');
    expect(commands[3]).toContain("DESK_AGENT='opencode'");
    expect(commands[3]).toContain('desk_opencode="${DESK_OPENCODE_BIN:-$(command -v opencode 2>/dev/null || true)}"');
    expect(commands[3]).toContain('desk_opencode="$HOME/.opencode/bin/opencode"');
    expect(commands[3]).toContain('desk_opencode_config="${DESK_OPENCODE_CONFIG_DIR:-}"');
    expect(commands[3]).toContain("desk_opencode_config='/workspace/.config/desk/opencode'");
    expect(commands[3]).toContain('OPENCODE_CONFIG_DIR="$desk_opencode_config"');
    expect(commands[3]).toContain('OPENCODE_DISABLE_MOUSE=1');
    expect(commands[3]).toContain(
      "DESK_OPENCODE_SESSION_ID='ses_12a31855dffeHTCs6tcfOmsddP'"
    );
    expect(commands[3]).toContain('exec "$desk_opencode" --session \'ses_12a31855dffeHTCs6tcfOmsddP\'');
    expect(commands[3]).not.toContain('dangerously');
    // no bypassPermissions set -> defaults to yolo (allow) via per-session OPENCODE_CONFIG_CONTENT
    expect(commands[3]).toContain('OPENCODE_CONFIG_CONTENT=\'{"permission":{"*":"allow"}}\'');
  });

  it('never substitutes another Claude conversation when the exact resume id fails', () => {
    const fixture = createClaudeLaunchFixture({
      claudeScript: `#!/bin/sh
printf '%s\n' "$*" >> "$HOME/claude-args.log"
case " $* " in
  *" --resume "*) printf '%s\n' "No conversation found for resume" >&2; exit 31 ;;
  *) printf '%s\n' "unexpected args: $*" >&2; exit 99 ;;
esac
`
    });
    try {
      const command = buildClaudeResumeSpecCommand(fixture.workspace, 'abc123');
      const result = runGeneratedCommand(command, fixture);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('desk: exact claude --resume failed with exit 31; leaving pane open for diagnostics');
      expect(fixture.readClaudeArgs()).toEqual([expect.stringContaining('--resume abc123')]);
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
            sessionId: oc-yolo
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
            sessionId: oc-gated
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
            sessionId: opencode
            agent: opencode
            uiMode: terminal
`),
      { homeDir: '/workspace' }
    )[0].command;

    expect(command).not.toContain('node -e');
    expect(command).not.toContain('session list');
    expect(command).toContain('DESK_OPENCODE_RESUME_ID');
    expect(command).toContain(
      'DESK_OPENCODE_SESSION_ID="$DESK_OPENCODE_RESUME_ID"'
    );
  });

  it('applies MCP launch flags only when explicitly requested', () => {
    const manifest = parseDeskManifest(`
groups:
  - id: group-1
    sessions:
      - name: claude
        sessionId: claude
        cwd: ~/projects/sample
        agent: claude
        uiMode: terminal
      - name: codex
        sessionId: codex
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
            sessionId: claude
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

describe('desk manifest malformed top-level keys (finding N12)', () => {
  it('rejects unknown top-level keys instead of silently dropping a misspelled groups key', () => {
    expect(() => parseDeskManifest('gropus: []')).toThrow(ManifestValidationError);
    expect(() => parseDeskManifest('gropus: []')).toThrow(/unknown top-level key "gropus"/);
  });

  it('throws when groups is present but not a list (does not silently empty the config)', () => {
    // An indentation slip that turns `groups:` into a scalar used to be coerced
    // to [] — dropping every project/session with no diagnostic, then persisted
    // as empty on the next write. It must fail loud instead.
    expect(() => parseDeskManifest('groups: oops')).toThrow(/"groups" must be a list/);
  });

  it('throws when projects is present but not a list', () => {
    expect(() => parseDeskManifest('projects: nope')).toThrow(/"projects" must be a list/);
  });

  it('still treats an absent key as an empty config (no false positive)', () => {
    expect(() => parseDeskManifest('settings: {}')).not.toThrow();
    expect(parseDeskManifest('settings: {}').groups).toEqual([]);
  });
});
