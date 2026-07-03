---
title: "Operations"
description: "Run Desk day to day: server lifecycle, telemetry, attention, terminal health, channels diagnostics, and recovery controls."
---

Desk is an operator console for running agents. The operations surfaces show host pressure, session health, pending attention, and queue diagnostics while work is active.

## Server lifecycle

There are two supported runtime shapes:

- `desk serve`: source-checkout runtime with the Desk API mounted into Vite server middleware
- standalone binary: no Vite runtime, embedded UI assets, same Desk API mounted on a plain HTTP server

Both bind to `127.0.0.1:5173` by default. See [Distribution and deployment](/distribution-deployment) for runtime and release details.

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
- running tmux sessions
- attention state
- unread event count
- managed agent LSP status
- channels runtime state

Desk drops attention markers for tmux sessions that no longer exist, so a dead session does not keep a stale lamp.

## Attention and events

Desk captures terminal notifications from attached and unattached sessions.

Attached sessions are sniffed from PTY output:

- OSC 9 messages can become `turn-complete`, `approval-requested`, or `input-requested`
- bare BEL becomes a generic `bell`

Unattached sessions are detected through tmux `window_bell_flag` and `window_activity` polling.

When a typed OSC 9 event arrives shortly after a generic bell, Desk upgrades the fresh bell event instead of creating a duplicate card.

Touching a terminal acknowledges that session's unread events. The events drawer can also mark individual events, all events, or events by kind as read.

## Terminal health

Desk's terminal broker keeps one WebSocket per browser tab and subscribes that connection to visible and warm terminal surfaces.

Operational guards include:

- visible-only output delivery so hidden cells do not parse terminal streams
- snapshot-on-reveal from tmux capture-pane
- bounded warm PTY retention
- output backpressure counters
- resize minimums to avoid durable tiny tmux windows
- startup repair for configured tiny windows

The broker metrics endpoint is:

```text
GET /api/terminal-broker-metrics
```

It reports active browser clients, active PTYs, warm idle PTYs, visible subscriptions, hidden subscriptions, and dropped output frames.

## Session controls

The agents toolbar and session rows expose recovery actions:

- refresh state
- start missing sessions
- restart a session
- repair a terminal
- inspect session metadata
- delete configured sessions
- open or attach to a tmux session

`desk up` has the same start-missing behavior as the UI **Up** control. It does not replace running sessions.

## Emergency kill switch

The emergency kill switch is deliberately broad.

It terminates:

- every tmux session whose name starts with `agentdesk-`
- any tmux session whose pane command is a Codex or Claude CLI
- any remaining host `codex` or `claude` CLI process found by `ps`

This is not limited to the current project or only sessions configured in the active manifest. Treat it as a host-wide stop control for Codex and Claude work.

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

Regular channel notifications are idempotent: once tmux accepts the paste, the queue advances. Pane probes and ACK files are diagnostics and evidence, not the authority for normal channel-notification delivery. Standalone onboarding or operator prompts still use the legacy verifier path.

## Logs and troubleshooting

Start with:

```bash
desk status
desk capture <name|tmux-session|resume-id> --lines 200
tmux list-sessions
```

For UI-visible runtime state, check:

- `/api/pulse`
- `/api/terminal-broker-metrics`
- the events drawer
- the channels engine console

For GitHub or Projects failures, check `gh auth status` and whether the token has the required scopes.

## Next steps

- Use [Troubleshooting and FAQ](/troubleshooting) for symptom-based diagnosis.
- Read [API and runtime reference](/api-runtime-reference) for the routes behind
  the runtime surfaces.
- Read [Run Desk securely](/guide-deploy-securely) before running Desk on a
  remote development box.
