import { describe, expect, it } from 'vitest';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest';

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
        command:
          "cd '/workspace/projects/alpha' && DESK_TMUX_SESSION='agentdesk-group-1-alpha-00000000' DESK_AGENT='codex' codex -c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always resume '00000000-0000-7000-8000-000000000001'"
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
        command:
          "cd '/workspace/projects/project-μ' && DESK_TMUX_SESSION='agentdesk-group-1-project-mu-00000000' DESK_AGENT='codex' codex -c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always resume '00000000-0000-7000-8000-000000000002'"
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
          - name: codex
            agent: codex
            bypassPermissions: true
          - name: opencode
            agent: opencode
            resume: ses_12a31855dffeHTCs6tcfOmsddP
`);

    const commands = buildSessionSpecs(manifest, { homeDir: '/workspace' }).map((session) => session.command);
    expect(commands[0]).toBe("cd '/workspace/projects/sample' && exec bash");
    // Agent launches carry explicit Desk identity for globally installed hooks.
    expect(commands[1]).toContain("cd '/workspace/projects/sample' && DESK_TMUX_SESSION='agentdesk-sample-main-claude-");
    expect(commands[1]).toContain("DESK_AGENT='claude' claude");
    expect(commands[1]).toContain('--settings');
    expect(commands[1]).toContain('preferredNotifChannel');
    expect(commands[1]).toContain("--dangerously-skip-permissions --resume 'abc123'");
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
      - name: codex
        cwd: ~/projects/sample
        agent: codex
        resume: abc123
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
