---
title: "Agents and terminals"
description: "Durable tmux sessions, agent lifecycle, resume, and attention signals"
---

The agent multiplexer is Desk's core surface. It lets one operator supervise
many coding-agent sessions without losing process lifetime, terminal state, or
attention signals.

## Supported agents

Desk has built-in profiles for:

- Claude Code
- OpenAI Codex
- OpenCode
- bash

Each profile prepares the agent-specific launch command, environment, resume
metadata, and attention signal integration needed by that CLI.

## Durable tmux sessions

Every managed session runs inside a deterministic tmux session. This gives Desk
three important properties:

- closing the browser does not kill the agent
- restarting Desk reattaches to running work
- sessions can be captured, repaired, or restarted without changing the UI
  model

The browser terminal is a view of a tmux-backed process, not the process owner.

## Groups and layouts

Groups let operators organize agents by project, lane, or responsibility. Each
group can use a fixed grid such as `2x2` or a custom cell count. Sessions can be
assigned to cells and rearranged from the UI.

## Terminal rendering

Desk uses xterm.js in the browser and a server-side terminal broker for session
transport. The broker keeps terminal transport independent from React mounts,
uses a single browser connection for multiplexed terminal traffic, and renders
only visible terminal cells.

Scrollback is handled through tmux capture for normal append-style agents and
through application-owned scroll controls for full-screen terminal UI programs.

## Resume support

Agent profiles can capture and reuse conversation identifiers when supported by
the agent CLI. This lets a restarted session continue the same agent
conversation instead of starting from a blank state.

## Attention signals

Desk watches for agent turn-complete and input-needed signals. Signals appear
as attention markers in the UI and are also used by the channels engine to avoid
delivering prompts into an agent that is still busy.

## Operational controls

The multiplexer includes controls to:

- refresh session state
- start missing sessions
- restart or repair individual sessions
- inspect session metadata
- stop managed agent processes when necessary

These controls are operational tools, not the center of the product story: the
main value is sustained supervision of a large agent fleet.
