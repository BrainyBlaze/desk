---
title: "Agent integrations"
description: "How Desk launches Codex, Claude, OpenCode, bash, and custom commands, including resume ids, permissions, attention, and LSP access."
---

Desk runs every managed session under a Moor holder. The browser is a view
over that durable process.

Built-in agents add launch flags, resume behavior, permission handling, and
attention signals on top of that Moor-managed lifetime.

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
uses it for the Moor control socket, terminal state, channels delivery,
attention, and agent events. The agent's resume id remains a separate
provider-owned value.

Desk sets these environment variables for managed launches:

```text
DESK_SESSION_ID=<durable Desk session id>
DESK_AGENT=<agent name>
DESK_SESSION_GENERATION=<positive integer, one per spawn>
```

`DESK_SESSION_GENERATION` is what lets Desk reject a report from a producer
that outlived a restart: a hook stamps the generation it was launched in, and
the daemon refuses anything carrying an older one. A hook process that inherits
no generation posts **nothing** — silence is the correct answer when an event
cannot be attributed, and it is why a session started before its hooks existed
reads `unknown` rather than reporting stale state.

A session bound to an [agent profile](/configuration#agent-profiles) also
receives that provider's credential-directory variable — `CLAUDE_CONFIG_DIR`
or `CODEX_HOME` — pointing at the profile root.

## Codex

Codex sessions launch as `codex`, with flags added for the features the session
enables. Desk no longer configures Codex's terminal notification settings:
state comes from Codex's own lifecycle hooks, so there is nothing to parse out
of the TUI.

When permission bypass is enabled, Desk adds Codex's dangerous bypass flag.

When `resume` is set, Desk launches Codex in resume mode.

When LSP agent access is enabled, Desk passes a `desk_lsp` MCP server definition to Codex so the agent can call Desk's language-server tools.

## Claude

Claude sessions use Claude Code's CLI and support:

- resume ids
- dangerous permission bypass
- optional MCP config for Desk LSP tools
- hook settings for state reporting and resume capture

Desk's Claude hooks live in **Desk's own settings file** and are handed to the
CLI with `--settings` at launch:

```text
~/.config/desk/claude/settings.json
```

Desk does not write `~/.claude/settings.json`. That file is the operator's —
their model, their hooks, their preferences — and a tool that installs its
reporting by editing it has taken something it was not given. The launch flag
achieves the same thing for the session Desk starts and leaves the operator's
file exactly as they wrote it. `desk hooks install` writes Desk's file.

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

## State reporting

Every supported CLI reports its own lifecycle to Desk through hooks that
`desk hooks install` writes. Each hook posts a small, bounded **observation** —
which event fired, and the few fields Desk needs from it — to
`/api/agent-event`. Desk decides what that observation *means* server-side, so
one definition of "working" serves every provider instead of one per adapter.

The facts a provider can assert:

| Fact | Asserts |
| --- | --- |
| `activity` | the session is `working` or `idle` |
| `blocked` / `unblocked` | a wait opened or closed, with who owns it — the operator or the provider |
| `tool` (`start` / `end`) | an open interval, which holds `working` across a tool that runs longer than the activity lease |
| `heartbeat` | the producer is alive, and nothing more |
| `health` | the session is degraded, with a reason |

Anything a provider does not assert stays **unknown**. Desk never fills the gap
from terminal output: the OSC 9 and BEL sniffing earlier versions used is gone,
along with the screen poller that backed it, because a signal that means
"something happened" cannot be told apart from one that means "a turn ended".

Attention is a projection of that state for the operator. It does not gate
channel delivery — see [the delivery engine](/channels-protocol#what-activity-does-and-does-not-gate).

<Note>
Hook configuration is read when a session launches. A session started before
`desk hooks install` ran reports nothing until it is restarted, and shows
`unknown` in the meantime.
</Note>

## Agent LSP access

When LSP is enabled and agent LSP access is enabled, Desk wires the `desk_lsp` MCP server into supported managed agents.

The server exposes language-server tools such as hover, definitions, references, diagnostics, symbols, completions, rename preparation, rename edits, formatting, and code actions.

The MCP surface is token-bound to the session workspace. Agents receive the token through a locked-down runtime env file or agent-specific MCP config. Tools return data and edits; they do not directly apply changes to files.

## Channels membership

Channels map Claude and Codex sessions to first-class member types. Other agents, including OpenCode, currently enter channels through the generic bash-typed member path.

Do not assume an OpenCode-specific channel member type exists until the source adds one.
