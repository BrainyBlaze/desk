---
title: "Agent integrations"
description: "How Desk launches Codex, Claude, OpenCode, Qwen, Kimi, Grok, bash, and custom commands, including resume ids, permissions, attention, and LSP access."
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
- `qwen`
- `kimi`
- `grok`
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

## Qwen

Qwen sessions launch as `qwen` (Qwen Code, a Gemini-CLI fork). Desk supports:

- resume ids (`--resume <id>`, a UUID)
- hook settings for state reporting and resume capture

When LSP agent access is enabled, Desk wires `desk_lsp` for Qwen too: the
server is registered once in `~/.qwen/settings.json` (Qwen has no per-session
MCP flag), and each Desk launch carries the session's `DESK_LSP_ENV_FILE` in
the environment. Outside Desk the entry is inert — the tools resolve their
token from that variable and report an error without it.

Qwen's hooks are Claude-compatible and live in:

```text
~/.qwen/settings.json
```

`desk hooks install` merges Desk's hooks into that file without touching the
operator's other settings; if the file is malformed JSON it is backed up and
skipped rather than overwritten. Qwen reads a command hook's `timeout` in
**milliseconds** (unlike Claude/Codex, which use seconds), so Desk writes
`10000` there.

Permission bypass maps to Qwen's `--yolo` (auto-approve all tools; needs Qwen
Code ≥0.21.13 — older CLIs reject the flag, and Qwen's own auto-updater keeps
the effective version current).

Qwen mints a **new resume id on every launch** and only persists a resumable
session after the first message is exchanged. A Qwen pane restarted before any
input therefore carries an id the CLI rejects; Desk keeps the pane alive (see
[Resume capture](#resume-capture)) rather than letting it exit.

Qwen needs a provider credential. Point it at Alibaba ModelStudio, a third-party
key, or any OpenAI-compatible endpoint through Qwen's own `Connect a Provider`
flow.

## Kimi

Kimi sessions launch as `kimi` (Kimi Code). Desk supports:

- resume ids (`--session <id>`, an opaque `session_...` value)
- permission bypass (`--yolo`)
- hook settings for state reporting and resume capture

Kimi's hooks are TOML `[[hooks]]` blocks appended to:

```text
~/.kimi-code/config.toml
```

`desk hooks install` rewrites only Desk's own blocks and leaves operator-authored
hooks in place; a config whose `hooks` key is not an array of tables is skipped
rather than corrupted. Validate with `kimi doctor`.

Kimi's coding endpoint needs an active Kimi (Moonshot) membership for OAuth, or
a provider key added through `kimi provider`.

## Grok

Grok sessions launch as `grok` (superagent-ai's grok-cli, published to npm as
`grok-dev`; it runs under Bun). Desk supports:

- resume ids (`--session <id>`, a 12-hex value)
- hook settings for state reporting and resume capture

Grok's hooks are Claude-compatible and live in:

```text
~/.grok/user-settings.json
```

Grok has **no per-tool approval system**, so there is no permission-bypass flag
and the bypass checkbox is hidden for it. Grok also fires `SessionStart` lazily
on the first prompt (not at launch), so a freshly launched Grok pane reads
`unknown` until the first message, and its tool hooks fire only for the bash
tool — long non-bash tool runs rest on the heartbeat rather than a tool
interval. Grok cannot join `desk_lsp` yet: it reads MCP servers only from its
global settings and spawns them with a sanitized environment, so the
per-session token cannot reach the server.

<Note>
`desk hooks install` only writes a new agent's hook config when that CLI's
config directory already exists, so a machine that never installed Qwen, Kimi,
or Grok is left untouched.
</Note>

## Bash

Bash sessions run:

```bash
cd <cwd> && exec bash
```

Bash does not have agent-specific permission bypass, resume capture, or LSP MCP wiring.

## Permission bypass

The Add Session modal shows a bypass-permissions option for Codex, Claude, OpenCode, Qwen, and Kimi.

The manifest field is:

```yaml
bypassPermissions: true
```

For Codex and Claude, Desk maps that field to the agent CLI's dangerous bypass mode; for Qwen and Kimi it maps to `--yolo`.

For OpenCode, Desk maps it to a per-session OpenCode permission config. Unchecking the box makes OpenCode ask for tool permissions.

Grok has no bypass flag (it has no per-tool approvals at all): the checkbox is hidden for it, and `bypassPermissions: true` on a Grok session is a manifest error rather than a silent no-op. (A `bash` session still ignores the field silently, as before.)

## Resume capture

Desk can start a session without `resume` and later capture the conversation id:

- Codex: reads Codex session records and startup shell snapshots
- Claude, Qwen, Kimi, Grok: receive hook events carrying the provider session id
- OpenCode: queries OpenCode's session list

Captured ids are validated before writing the manifest.

A resume id is a hint, not a guarantee. If the CLI rejects it — most often a Qwen
session restarted before its first message, or any conversation the provider no
longer has — Desk keeps the pane alive with a diagnostic and a shell instead of
letting it exit. Start fresh by running the agent without a resume id, or clear
the binding with `desk reset-provider-session <sessionId> --force`.

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

When LSP is enabled and agent LSP access is enabled, Desk wires the `desk_lsp` MCP server into supported managed agents (Codex, Claude, and Qwen).

The server exposes language-server tools such as hover, definitions, references, diagnostics, symbols, completions, rename preparation, rename edits, formatting, and code actions.

The MCP surface is token-bound to the session workspace. Agents receive the token through a locked-down runtime env file or agent-specific MCP config. Tools return data and edits; they do not directly apply changes to files.

## Channels membership

Channels give Claude, Codex, Qwen, Kimi, and Grok sessions their own first-class member type. OpenCode still enters channels through the generic bash-typed member path.

The member type is a roster/notice label only — no delivery or supervisor behavior gates on it — so a bash-typed member still participates fully. Do not assume an OpenCode-specific channel member type exists until the source adds one.
