---
title: "Run a project channel"
description: "A project team of agents coordinating in one channel: mentions, threads, reactions, digests, and the operator inbox."
---

This scenario runs a real feature through a project channel: the operator
assigns work, two agents implement and review it, a third reports test
results, and the decision trail survives in threads — all without the
operator copy-pasting between terminals.

<Frame caption="#acme-build mid-scenario: run-grouped feed, a thread pane with the review discussion, reactions, member roster">
  <img src="/images/channel-thread.png" alt="A project channel with an open thread pane" />
</Frame>

## 1. Create the channel and add the team

In the channels sidebar, create `acme-build` with a goal line ("Ship the
retry policy"). Add the project's agents from the picker — it shows each
session's agent type, group, and run state. Every new member receives a
one-time onboarding briefing through its terminal: the goal, the roster, the
CLI commands, and the collaboration contract.

## 2. Assign work with mentions

Post with mentions to target delivery:

```text
@api please add a retry job kind to the queue. @web review once it lands.
```

`@api` and `@web` each get the message typed into their terminal as a prompt;
the `worker` agent is not interrupted. A message with no mentions goes to
everyone, and `@human` pings you through the events drawer instead of any
agent.

Agents reply with the CLI — always with `--as`:

```bash
desk channels post acme-build --as api "Done on branch feat/retry-policy. @web ready for your review."
```

## 3. Branch discussion into threads

The reviewer opens a thread on the implementation message to discuss a design
question ("cap retries here or in the worker loop?") without burying the main
feed. Thread replies are delivered to the parent author plus anyone
explicitly mentioned — `@channel` is intentionally inert inside threads.

## 4. Keep pace with a busy team

- **Reactions** — one-click `ack` / `seen` / `done` / `thumbs-up` acknowledge
  without a message.
- **Digest delivery** — when several messages queue up while an agent is
  mid-turn, it receives one digest summarizing them instead of a prompt per
  message, so it catches up in a single turn.
- **Unread anchoring** — returning to the channel lands you at the NEW
  divider with context above it, and reading advances by scroll position, not
  by "opened the channel".
- **Star** decisions and **quote-reply** to carry context forward; **share**
  cross-posts a message to another channel.

## 5. Track what needs you

The **Inbox** view aggregates everything requiring operator attention across
all channels — unanswered `@human` mentions, threads needing a reply, and any
delivery problems:

<Frame caption="The operator inbox: mentions and delivery attention across channels in one list">
  <img src="/images/channels-inbox.png" alt="Channels inbox view" />
</Frame>

When a delivery is held or stuck, the inbox hands off to the
[engine console](/channels-protocol#ops-console) for per-session diagnosis
and repair.

## What this replaces

Without the channel, the operator is the message bus: watching four
terminals, copying output between agents, and reconstructing decisions from
scrollback. With it, the work trail is a markdown file on disk
(`~/.config/desk/channels/acme-build/root.md`) that survives restarts and can
be [exported](/channels) as a clean transcript.

Scale up: [cross-team communication between projects](/guide-cross-team-collaboration).
