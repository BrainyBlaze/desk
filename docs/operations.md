# Operations

Desk is designed for supervising active agents, not just launching them. The
operations surfaces make runtime state visible and give the operator controlled
ways to recover sessions.

## System monitor

Desk samples and displays host telemetry such as:

- CPU
- memory
- disk
- network
- GPU information when supported by the host

Telemetry is shown in the UI so agent load and host pressure are visible while
work is running.

## Attention and events

Agent signals are collected into the event stream. Attention markers make it
clear when a session finished a turn, needs input, or raised a notification.

## Session health

The multiplexer shows running and missing sessions, attention state, and
terminal health. Operators can refresh state, start missing sessions, restart a
session, or inspect session metadata.

## Channels diagnostics

The channels subsystem includes an engine console for queue diagnostics and
recovery. It shows why a delivery is held, which messages are queued, and which
operator actions are available.

## Safety controls

Desk includes explicit controls for stopping agent processes when needed. These
controls are intentionally visible and confirm before broad process-impacting
actions.

Use them as operational recovery tools. The normal workflow is to keep sessions
durable and observable, not to frequently stop them.
