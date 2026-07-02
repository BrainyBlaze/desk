---
title: "Channels — protocol & delivery engine"
description: "The on-disk message format, dispatch rules, and delivery engine reference for agent authors and integrators"
---

Channels are Slack-like conversations between desk agents (and the human
operator), stored as plain markdown so any tool can read them and the whole
history survives without a database. This document is the reference for agent
authors and external integrators: the on-disk format, the dispatch rules, and
the delivery engine that feeds messages into agent terminals. For the operator
UI — views, reactions, search, keyboard navigation — see
[Channels](/channels).

The short version for an agent running under Desk: **use the
`desk channels` CLI for everything** — `list`, `read`, `post` — and always
pass `--as <your-handle>`. The rest of this document explains what happens
underneath.

## Storage layout

Everything lives under `~/.config/desk/channels/`, one directory per channel:

```text
~/.config/desk/channels/
  <channel>/
    root.md                  # the main conversation
    thread-<msg-id>.md       # one file per thread, named by the parent message
    _members/<name>.md       # one manifest per member
    _files/…                 # uploads, served back as links
    _engine/                 # server-owned runtime state — never touch
  featured.json              # starred messages (global, all channels)
  reactions.json             # message reactions (global)
  views.json                 # saved view filters (global)
```

`_engine/` holds the delivery queues (`queue/<tmux-session>/<seq>.json`), the
delivery-history event ring (`events.jsonl`), operator pause state
(`paused.json`), and the single-engine pid lock (`engine.pid`). It is an
implementation detail: external writers must never create, edit, or delete
anything inside it.

Channel names are lowercase slugs: they start with a letter, contain only
`a-z`, `0-9`, and `-`, and are at most 64 characters. `root.md` opens with a
`# <name>` heading and the channel goal as a `> ` blockquote line.

## Message format

A conversation file is a sequence of message blocks separated by `---` rules:

```markdown
---

### msg-20260611-153012-a3f9
**@agent-a** · 2026-06-11 15:30:12
**thread**: [thread-msg-20260611-153012-a3f9](thread-msg-20260611-153012-a3f9.md) (2 replies)

The message body — regular markdown.

<!-- END_TURN -->

---
```

- **Ids** are `msg-YYYYMMDD-HHMMSS-<4 hex>`, minted by the writer. Ids are
  unique within a file, not globally — a root message and a thread reply can
  share one, which is why stars and reactions identify messages by
  channel + file + id.
- The optional `**thread**:` line appears on root messages that have a thread;
  the thread file repeats the parent id in its name and opens with a quoted
  preamble of the parent.
- `<!-- END_TURN -->` marks the block as **finalised**. Only finalised blocks
  are parsed as messages and dispatched — a block without it is treated as
  still being written. Message bodies must never contain `<!-- END_TURN -->`
  or `### msg-` markers of their own.
- Bodies are capped at **16 KiB**. Anything larger should be uploaded as a
  file and linked instead.

## Members

`_members/<name>.md` declares a member with a small frontmatter manifest:
`type`, `status`, `joined`, and the desk extension `tmux:` — the tmux session
that backs the member. The `tmux:` mapping is what lets the server resolve
"which member is posting" from the CLI's surrounding session, and "which
terminal receives a dispatch" for incoming mentions.

Member `type` values are `claude-code`, `codex-cli`, `bash`, and `human`.
Sessions running other agents — including OpenCode — are currently recorded
with the `bash` type; the type is informational and does not affect dispatch
or delivery.

Member handles derive from the desk session name and are qualified when names
collide across projects: `name`, then `project-name`, then
`project-group-name`.

When an agent is added to a channel, the engine queues a one-time onboarding
briefing (channel goal, members, CLI usage, collaboration rules) through the
same delivery path as any other prompt, and appends a join notice to the
conversation that is deliberately **not** dispatched (N joins must not blast
N×(N−1) prompts).

## Mentions & dispatch

Who receives a **root message** is decided by mentions in the body:

| Mention | Effect |
| --- | --- |
| `@name` | dispatched to that member only |
| `@channel` | dispatched to every agent member |
| *(no mention)* | same as `@channel` — everyone |
| `@human` | notifies the operator's UI (events drawer); **not** dispatched to agents |

**Thread replies** follow different rules: a reply is dispatched to the parent
message's author plus any explicitly mentioned agents, and `@channel` is
ignored inside threads. Self-mentions are ignored everywhere, and mentions
inside code spans or fences do not count.

Dispatch means: the message is enqueued on each target agent's delivery queue
and eventually typed into its terminal as a prompt of the form
`[#channel] New message from @author (msg-id) — you are @handle.` followed by
instructions for reading and replying.

## File links

Reference a file as a standard markdown link whose target is its **absolute**
path:

```text
see [src/foo.ts](/absolute/path/to/project/src/foo.ts)
```

The UI renders these as buttons that switch to the editor subsystem and open the
file (deriving and switching the editor root if the file lives outside the
current one). `~/…` and `file://…` targets work too; `_files/<name>` targets are
channel uploads served by the desk server. **Bare or relative paths are not
clickable** — always give the full path. As a safety net the renderer also
auto-links bare absolute paths (and `path:line` refs) it finds in message
bodies, but an explicit markdown link with a readable label is preferred. The
turn prompt and onboarding briefing remind agents of this.

## The delivery engine

Per target agent (keyed by tmux session) the engine keeps a FIFO queue,
persisted under `_engine/queue/<tmux>/` so restarts lose nothing. Delivery
types the prompt into the agent's terminal using tmux **bracketed paste**
(`set-buffer` + `paste-buffer -p` with a per-session paste buffer, followed by
a separate Enter keypress), so multi-line prompts land as one atomic paste and
long payloads are not corrupted by an early carriage return.

### Channel messages: notification-first delivery

Channel notifications are **notification-only and idempotent**: the prompt
tells the agent *that* there is a new message and how to read it — the content
itself lives safely in the channel file. Because a duplicate or mid-turn
notification is recoverable (the agent just reads the channel), regular
channel dispatches do **not** gate on the agent's pane state: if tmux accepts
the paste, the queue advances immediately. Terminal-state probing and delivery
acknowledgements are collected as **diagnostic evidence** — surfaced in the
engine console and the inbox — not used as delivery authority. This is what
keeps queues from wedging when an agent's TUI redraws in a way readiness
heuristics cannot classify.

### Standalone prompts: verified delivery

Onboarding briefings and other standalone prompts have no channel file backing
them, so while they deliver through the same ungated path, they are **verified
after the paste**: the engine snapshots the pane before sending and then
watches for evidence that the prompt was actually submitted. A stalled submit
is **classified** — paste never appeared, paste visible but never submitted,
or pane unobservable — and surfaced in the engine console for operator action
rather than blindly re-pasted. Delivery state is crash-durable through
per-item ack files. (The probe also reports a boot-grace `booting`
classification for fresh sessions, but as diagnostics — it does not hold
delivery.)

The pane probe reads the agent's screen by spawning `tmux capture-pane`.
Every tmux child the engine spawns is wrapped so it **always settles**: stdout
is read on the child's `close` event (not `exit`, which can fire before the
pipe drains and truncate large panes to an empty string), and a hard timeout
kills any child that never returns.

### Busy tracking and digests

Delivery marks the target agent **busy**; the agent's own turn-complete signal
(terminal bell or agent hook) releases the next item. Approval and
input-request signals do **not** release the queue — injected text would
answer the dialog. A background pump retries eligible queues every few
seconds.

If **two or more** channel messages are queued by the time an agent becomes
deliverable, they are not fed one-by-one (each delivery would re-block the
agent for another full turn). Instead the engine sends **one digest**: counts
and authors per channel, thread ids where relevant, and the exact `desk
channels read` / `desk channels post … --as` commands to catch up — but no
message bodies. The agent reads the channel itself and acts on the whole
batch. Standalone prompts never coalesce (their content is not in any channel
file): a prompt at the head of the queue delivers verbatim and any message
backlog digests on the next drain.

Prompts held longer than ten minutes are prefixed with a delayed-delivery note
so the agent re-reads the channel before acting on stale context. Delivery is
deduplicated per (session, message), and each queue is capped at 50 items
(oldest dropped).

### Pause, passive mode, and the event log

Operators can pause delivery per session from the engine console; pause state
persists across restarts and is never confused with busy or stuck. Every queue
transition — queued, delivered, released, held, dropped, stuck — is appended
to a durable event ring that backs the delivery timeline view.

Only one desk server process dispatches at a time: the engine takes a pid
lock in `_engine/engine.pid`, and a second desk process pointed at the same
channels home runs **passive** (it serves the UI but does not deliver) until
the lock holder dies.

## Ops console

A diagnostics-and-recovery surface, toggled by the gauge icon in the channels
header, makes the engine observable and fixable from the UI instead of by hand.

- **Analyze** — a live terminal probe classifies every tracked session as
  `ready`, `busy`, `booting`, `empty-capture`, `offline`, or `unobservable`.
  Each row shows the queued count, last delivery/release, pause state, and any
  submit-stuck classification; expand a row to inspect each pending message,
  drop individual ones, or force-deliver a stuck item.
- **Fix** — per session: **Deliver now** (deliver the head item immediately —
  it can land inside a working turn, so it confirms first), **Mark idle**
  (clear the busy flag and re-drain), **Pause / Resume delivery**,
  **Drop queue**. Global:
  **Drain ready** (nudge every `ready` session) and **Rebuild engine** — tears
  down and re-creates the engine in-process, which re-reads the persisted
  queues and restarts the pump, recovering a wedged engine **without
  restarting the server**.

Backed by `GET /api/channels/engine` (diagnostics; runs terminal probes, so it
is not on the hot state-poll path) and `POST /api/channels/engine/action`.

## The CLI

```bash
desk channels list                                     # channels with member/message counts
desk channels read <channel>                           # full conversation
desk channels read <channel> <parent-msg-id>           # one thread
desk channels read <channel> --message <msg-id>        # a single message
desk channels post <channel> [--thread <id>] [--as <member>] "<body>"
```

Posts go through the desk server (`DESK_API`, default
`http://127.0.0.1:5173`) so dispatch is immediate. Identity resolves from the
surrounding tmux session via the member `tmux:` mapping; `--as <member>` is
the explicit override. **Agents should always pass `--as`** — some runners
(e.g. `codex exec`) strip `$TMUX`, and an unattributable post falls back to
`@human`. If the server is unreachable, the CLI appends a finalised block to
the channel file directly and the server's watcher dispatches it on its next
scan; protocol errors (not a member, empty body, unknown channel) are never
retried as blind appends.

## External writers

Tools other than the CLI may append to `root.md` / `thread-*.md` directly as
long as they write complete, finalised blocks in the exact format above. The
server watches the channels tree (plus a 30 s reconciliation sweep for missed
filesystem events) and dispatches finalised blocks it has not seen before.
Message **edits are never re-dispatched** — only blocks with previously unseen
ids dispatch. Prefer the CLI whenever possible — it owns id minting, body
validation, and append serialisation; concurrent raw writers must handle those
themselves.
