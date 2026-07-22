---
title: "Agent integrations"
description: "How Desk launches Codex, Claude, OpenCode, bash, and custom commands, including resume ids, permissions, attention, and LSP access."
---

Desk runs every managed session under an atch master. The browser is a view
over that durable process.

Built-in agents add launch flags, resume behavior, permission handling, and
attention signals on top of that atch base.

## Supported session kinds

Built-in `agent` values:

- `codex`
- `claude`
- `opencode`
- `bash`

Any session can also use a custom `command`.

```yaml
- name: api-server
  cwd: ~/projects/product
  command: npm run dev
```

Custom commands are terminal sessions. They do not get built-in agent resume or permission logic unless the command implements compatible behavior itself.

## Session identity

Every session has a durable `sessionId`. Desk preserves it across edits and
uses it for the atch socket, terminal state, channels delivery, attention, and
agent events. The agent's resume id remains a separate provider-owned value.

Desk sets these environment variables for managed launches:

```text
DESK_SESSION_ID=<durable Desk session id>
DESK_AGENT=<agent name>
```

## Codex

Codex sessions launch with Desk notification settings:

```text
codex -c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always
```

When permission bypass is enabled, Desk adds Codex's dangerous bypass flag.

When `resume` is set, Desk launches Codex in resume mode.

When LSP agent access is enabled, Desk passes a `desk_lsp` MCP server definition to Codex so the agent can call Desk's language-server tools.

## Claude

Claude sessions use Claude Code's CLI and support:

- resume ids
- dangerous permission bypass
- optional MCP config for Desk LSP tools
- hook settings for attention and resume capture

Desk can install or write the required Claude hook settings through the hooks/config path.

## OpenCode

OpenCode sessions launch through the configured OpenCode binary. Desk resolves it from:

- `DESK_OPENCODE_BIN`
- `PATH`
- `~/.opencode/bin/opencode`

Desk uses a Desk-owned OpenCode config directory, normally:

```text
~/.config/desk/opencode
```

That directory contains Desk's attention plugin. Desk does not rely on the user's normal OpenCode config directory for its integration state.

OpenCode permission behavior is controlled per session through `OPENCODE_CONFIG_CONTENT`:

- bypass enabled: `permission["*"] = "allow"`
- bypass disabled: `permission["*"] = "ask"`

Desk also sets:

```text
OPENCODE_DISABLE_MOUSE=1
```

This preserves Desk/xterm selection and copy behavior.

OpenCode resume uses `ses_...` ids. Desk can discover recent OpenCode sessions from `opencode session list --format json` and persist a matching id.

## Bash

Bash sessions run:

```bash
cd <cwd> && exec bash
```

Bash does not have agent-specific permission bypass, resume capture, or LSP MCP wiring.

## Permission bypass

The Add Session modal shows a bypass-permissions option for Codex, Claude, and OpenCode.

The manifest field is:

```yaml
bypassPermissions: true
```

For Codex and Claude, Desk maps that field to the agent CLI's dangerous bypass mode.

For OpenCode, Desk maps it to a per-session OpenCode permission config. Unchecking the box makes OpenCode ask for tool permissions.

## Resume capture

Desk can start a session without `resume` and later capture the conversation id:

- Codex: reads Codex session records and startup shell snapshots
- Claude: receives hook events with `session_id`
- OpenCode: queries OpenCode's session list

Captured ids are validated before writing the manifest.

## Attention signals

Desk raises attention from terminal notifications and agent hooks.

Signal kinds include:

- `turn-complete`
- `approval-requested`
- `input-requested`
- `bell`
- `channel`

The terminal daemon parses PTY output into emulator events even when no browser
surface is subscribed, so bell and OSC 9 attention remains available for
unattached sessions.

Desk upgrades a fresh generic bell when a typed OSC 9 event arrives shortly afterward, so one turn does not create duplicate unread cards.

## Agent LSP access

When LSP is enabled and agent LSP access is enabled, Desk wires the `desk_lsp` MCP server into supported managed agents.

The server exposes language-server tools such as hover, definitions, references, diagnostics, symbols, completions, rename preparation, rename edits, formatting, and code actions.

The MCP surface is token-bound to the session workspace. Agents receive the token through a locked-down runtime env file or agent-specific MCP config. Tools return data and edits; they do not directly apply changes to files.

## Channels membership

Channels map Claude and Codex sessions to first-class member types. Other agents, including OpenCode, currently enter channels through the generic bash-typed member path.

Do not assume an OpenCode-specific channel member type exists until the source adds one.
