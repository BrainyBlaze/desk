---
title: "Operations"
description: "Run Desk day to day: server lifecycle, telemetry, attention, terminal health, channels diagnostics, and recovery controls."
---

Desk is an operator console for running agents. The operations surfaces show host pressure, session health, pending attention, and queue diagnostics while work is active.

## Server lifecycle

The one CLI exposes two explicit runtime shapes:

- `desk serve`: private Bun runtime with embedded UI assets and no Vite
- `desk serve --dev`: Node/Vite runtime with the Desk API mounted as middleware

Both bind to `127.0.0.1:5173` by default, supervise their child process group,
and fail without switching modes. Each server supervises the terminal daemon.
If no executable Moor binary can be resolved, terminal transport fails closed
and reports missing while the rest of the workspace remains available. Send
Ctrl-C to the CLI process for clean shutdown. See
[Distribution and deployment](/distribution-deployment) for runtime and release
details.

## System monitor

Desk samples host telemetry on a background loop and serves the latest cached snapshot through `/api/pulse`.

The snapshot includes:

- hostname, platform, kernel, and uptime
- CPU thread count, load average, and usage percentage
- memory totals and usage
- root filesystem usage
- disk read/write rates from `/proc/diskstats`
- aggregate network RX/TX rates from `/proc/net/dev`
- NVIDIA GPU metrics through `nvidia-smi` when available
- Intel GPU utilization through `intel_gpu_top` when available

GPU commands are run asynchronously with timeouts so telemetry does not block terminal streams. If a probe fails, Desk keeps the last good snapshot or marks that GPU source unavailable.

## Pulse model

The browser polls pulse state while visible. The pulse response combines:

- the cached system snapshot
- running session ids
- attention state
- unread event count
- managed agent LSP status
- channels runtime state

Desk drops attention markers for sessions that no longer exist, so a dead session does not keep a stale lamp.

## Attention and events

Agent state is reported by the agents, not inferred from their output. Desk
installs lifecycle hooks into each supported CLI; those hooks post typed facts
to the daemon, which keeps one canonical state per session on three
independent axes:

| Axis | Values | Meaning |
| --- | --- | --- |
| `lifecycle` | `starting`, `running`, `exited` | is there a process |
| `activity` | `working`, `idle`, `blocked`, `unknown` | what is it doing |
| `health` | `healthy`, `degraded` + reason | can we still believe the above |

`unknown` is a first-class answer, not a failure: a session whose producer has
not reported has no evidence behind it, and Desk says so instead of guessing.
The commonest cause is a session started before `desk hooks install` ran — hook
configuration is read at launch, so such a session must be restarted before it
can report.

Touching a terminal acknowledges that session's unread events. The events drawer can also mark individual events, all events, or events by kind as read.

## Terminal health

Desk keeps one binary terminal WebSocket per browser tab. Hidden terminal
surfaces retain their channel with `VISIBILITY false`, but cannot send input or
resize the child and receive no output deltas. Reveal reuses that channel and
starts from a fresh daemon snapshot; actual removal or transport loss
unsubscribes. The supervised terminal daemon owns Moor holder connections,
emulator snapshots, and generation state.

Operational guards include:

- visible-only output delivery so hidden cells do not parse terminal streams
- server-enforced input suppression and queued-input revocation for hidden retained channels
- snapshot-on-reveal from the daemon's xterm emulator
- per-session generation fencing so stale output cannot corrupt a new process
- retryable Moor store rotations; only a repeated unchanged hash mismatch is corruption
- bounded frame sizes, heartbeat detection, and resubscription after gaps
- private, per-user Moor socket roots

## Session controls

The agents toolbar and session rows expose recovery actions:

- refresh state
- start missing sessions
- restart a session
- repair a terminal
- inspect session metadata
- delete configured sessions
- open or attach to a Moor session

`desk up` has the same start-missing behavior as the UI **Up** control. It does not replace running sessions.

## Emergency kill switch

The emergency kill switch combines configured-session retirement with a
host-level supported-agent process sweep.

It terminates:

- every Moor session in the active manifest, through the terminal daemon
- any remaining host `codex` or `claude` CLI process found by `ps`

The Moor retirement is manifest-scoped, but the process sweep is host-wide.
Treat it as a host-wide stop control for Codex and Claude work.

## Channels diagnostics

The channels engine has an operations console for queue and delivery state.

It can show:

- queued messages
- delivery timeline events
- paused sessions
- submit-state files such as delivering, delivered, and stuck
- passive-mode state when another engine owns the lock
- per-session diagnostics from pane probes

Operator actions include:

- pause or resume a member session
- drop a queue item
- force-deliver an item
- clear a queue
- mark a member idle
- rebuild the engine
- drain ready sessions

Regular channel notifications are idempotent: once the terminal daemon accepts
the input, the queue advances. Emulator probes and ACK files are diagnostics
and evidence, not the authority for normal channel-notification delivery.

## Logs and troubleshooting

Start with:

```bash
desk status
desk capture <name|sessionId|resume> --lines 200
```

For UI-visible runtime state, check:

- `/api/pulse`
- the events drawer
- the channels engine console

For GitHub or Projects failures, check `gh auth status` and whether the token has the required scopes.

## Next steps

- Use [Troubleshooting and FAQ](/troubleshooting) for symptom-based diagnosis.
- Read [API and runtime reference](/api-runtime-reference) for the routes behind
  the runtime surfaces.
- Read [Run Desk securely](/guide-deploy-securely) before running Desk on a
  remote development box.
