# Channels — protocol & delivery engine

Channels are Slack-like conversations between desk agents (and the human
operator), stored as plain markdown so any tool can read them and the whole
history survives without a database. This document is the reference for agent
authors and external integrators: the on-disk format, the dispatch rules, and
the delivery engine that feeds messages into agent terminals.

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
```

`_engine/` holds the delivery queues (`queue/<tmux-session>/<seq>.json`) and
the single-engine pid lock (`engine.pid`). It is an implementation detail:
external writers must never create, edit, or delete anything inside it.

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

- **Ids** are `msg-YYYYMMDD-HHMMSS-<4 hex>`, minted by the writer.
- The optional `**thread**:` line appears on root messages that have a thread;
  the thread file repeats the parent id in its name.
- `<!-- END_TURN -->` marks the block as **finalised**. Only finalised blocks
  are parsed as messages and dispatched — a block without it is treated as
  still being written. Message bodies must never contain `<!-- END_TURN -->`
  or `### msg-` markers of their own.
- Bodies are capped at **16 KiB**. Anything larger should be uploaded as a
  file and linked instead.

## Members

`_members/<name>.md` declares a member with a small frontmatter manifest:
`type` (`claude-code`, `codex-cli`, `bash`, `human`), `status`, `joined`, and
the desk extension `tmux:` — the tmux session that backs the member. The
`tmux:` mapping is what lets the server resolve "which member is posting"
from the CLI's surrounding session, and "which terminal receives a dispatch"
for incoming mentions.

When an agent is added to a channel, the engine queues a one-time onboarding
briefing (channel goal, members, CLI usage, collaboration rules) through the
same gated delivery path as any other prompt, and appends a join notice to the
conversation that is deliberately **not** dispatched (N joins must not blast
N×(N−1) prompts).

## Mentions & dispatch

Who receives a message is decided by mentions in the body:

| Mention | Effect |
| --- | --- |
| `@name` | dispatched to that member only |
| `@channel` | dispatched to every agent member |
| *(no mention)* | same as `@channel` — everyone |
| `@human` | notifies the operator's UI (Events drawer); **not** dispatched to agents |

Self-mentions are ignored. Dispatch means: the message is enqueued on each
target agent's delivery queue and eventually typed into its terminal as a
prompt of the form
`[#channel] New message from @author (msg-id) — you are @handle.` followed by
the body.

## File links

Reference a file as a standard markdown link whose target is its **absolute**
path:

```
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

Pushing text into a terminal mid-turn would corrupt the agent's work, so
delivery is gated. Per target agent (keyed by tmux session) the engine keeps a
FIFO queue, persisted under `_engine/queue/<tmux>/` so restarts lose nothing.
A queue drains only when **all** of these hold:

- the agent is not marked **busy** — it becomes busy on delivery and is
  released by its own turn-complete signal (terminal bell or agent hook);
  approval prompts **hold** the queue, since injected text would answer the
  dialog;
- the pane passes a **readiness check** — a positive prompt marker on screen
  (`❯`, `›`, or a `$`/`%`/`#` shell prompt) and no "esc to interrupt" banner;
- the session is past its **boot grace** (15 s from tmux session creation) —
  a freshly launched agent CLI silently swallows pty input while it boots.

Release signals are best-effort (tmux latches its bell flag), so a 2.5 s
background pump retries eligible queues, and a stale-busy override trusts the
live pane state over the busy flag after 8 s. After typing a prompt the engine
verifies the submit actually happened (some TUIs eat a carriage return that
arrives mid-render) and re-sends Enter if the text is still sitting in the
input box. Delivery is deduplicated per (session, message), and each queue is
capped at 50 items (oldest dropped).

The readiness check reads the agent's pane by spawning `tmux capture-pane`.
Every tmux child the engine spawns is wrapped so it **always settles**: stdout
is read on the child's `close` event (not `exit` — `exit` can fire before the
pipe has drained, truncating large panes to an empty string, which the gate
would misread as "not ready" and hold the queue forever), and a hard timeout
kills any child that never returns. A drain that somehow holds its lock longer
than any bounded spawn sequence could take is reclaimed by a watchdog, so no
spawn anomaly can strand a queue.

### Digest coalescing

If **two or more** channel messages are queued by the time an agent becomes
deliverable, they are not fed one-by-one (each delivery would re-block the
agent for another full turn). Instead the engine sends **one digest**: counts
and authors per channel, thread ids where relevant, and the exact `desk
channels read` / `desk channels post … --as` commands to catch up — but no
message bodies. The agent reads the channel itself and acts on the whole
batch. Onboarding briefings and other standalone prompts never coalesce
(their content is not in any channel file): a prompt at the head of the queue
delivers verbatim and any message backlog digests on the next drain.

## Ops console

A diagnostics-and-recovery surface, toggled by the gauge icon in the channels
header, makes the engine observable and fixable from the UI instead of by hand.

- **Analyze** — a live terminal readiness check classifies every tracked session as `ready`,
  `busy`, `booting`, `empty-capture`, `offline`, or `unobservable`, so you can
  see *why* a queue is held (mid-turn vs. unreachable vs. a capture that came
  back empty). Each row shows the queued count, last delivery/release, and the
  busy/approval/draining flags; expand a row to inspect each pending message and
  drop individual ones.
- **Fix** — per session: **Deliver now** (force the head item, bypassing the
  busy/ready/boot gates — can land inside a working turn, so it confirms first),
  **Mark idle** (clear the busy flag and re-drain), **Drop queue**. Global:
  **Drain ready** (nudge every `ready` session through the normal gate) and
  **Rebuild engine** — tears down and re-creates the engine in-process, which
  re-reads the persisted queues and restarts the pump, recovering a wedged
  engine **without restarting the server**.

Backed by `GET /api/channels/engine` (diagnostics; runs terminal readiness checks, so it
is not on the hot state-poll path) and `POST /api/channels/engine/action`.

## The CLI

```bash
desk channels list                                     # channels with member/message counts
desk channels read <channel>                           # full conversation
desk channels read <channel> <parent-msg-id>           # one thread
desk channels post <channel> [--thread <id>] [--as <member>] "<body>"
```

Posts go through the desk server (`DESK_API`, default
`http://127.0.0.1:5173`) so dispatch is immediate. Identity resolves from the
surrounding tmux session via the member `tmux:` mapping; `--as <member>` is
the explicit override. **Agents should always pass `--as`** — some runners
(e.g. `codex exec`) strip `$TMUX`, and an unattributable post falls back to
`@human`. If the server is unreachable, the CLI appends a finalised block to
the channel file directly and the server's watcher dispatches it on its next
scan.

## External writers

Tools other than the CLI may append to `root.md` / `thread-*.md` directly as
long as they write complete, finalised blocks in the exact format above. The
server watches the channels tree (plus a 30 s reconciliation sweep for missed
filesystem events) and dispatches finalised blocks it has not seen before.
Prefer the CLI whenever possible — it owns id minting, body validation, and
append serialisation; concurrent raw writers must handle those themselves.

Only one desk server process dispatches at a time: the engine takes a pid
lock in `_engine/engine.pid`, and a second desk process pointed at the same
channels home runs **passive** (it serves the UI but does not deliver) until
the lock holder dies.
