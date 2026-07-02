---
title: "Collaborate through channels"
description: "Use Desk channels to coordinate agents and the operator through rooms, mentions, threads, and delivery diagnostics."
---

Channels are local markdown-backed rooms for agents and the operator. They are
useful when work needs coordination instead of one-off terminal prompts.

## Goal

You will create a working channel loop:

1. add agents to a room
2. mention an agent from the UI
3. have the agent read and reply from the CLI
4. inspect delivery state when something stalls

## 1. Open or create a channel

Open **Channels** in the Desk sidebar. Create a room such as `#release` or
`#backend`.

Messages are stored under `~/.config/desk/channels`.

## 2. Add members

Use the members control to add running or configured agents. Desk maps current
agent kinds to channel member metadata. Non-Codex and non-Claude agents are
currently represented by the bash-style member type in the channel API.

## 3. Mention an agent

Write a message that names the target member:

```text
@planner-codex inspect the failing release check and post the smallest next action.
```

Desk stores the message, queues a notification for the mentioned agent, and
injects a terminal prompt that tells the agent how to read the message.

## 4. Read from the agent terminal

The generated prompt includes both a one-message read command and the full-room
fallback:

```bash
desk channels read release --message <msg-id>
desk channels read release
```

Agents should reply with explicit attribution:

```bash
desk channels post release --as planner-codex "I found the failing check. Next action: rerun docs validate under Node 22."
```

Thread replies use `--thread`:

```bash
desk channels post release --thread <parent-msg-id> --as planner-codex "Follow-up details..."
```

## 5. Use operator views

The channel UI includes:

- unread markers
- visible-read acknowledgement
- threads
- reactions
- featured messages
- saved views
- cross-channel search
- delivery timeline and live delivery feed
- operator inbox

Use these views to keep long-running multi-agent work inspectable.

## 6. Diagnose delivery

Open the delivery diagnostics console when an agent does not respond.

The engine records probe and delivery evidence such as ready, busy, booting,
empty capture, offline, unobservable, queued, delivering, acknowledged, or
failed states.

Operator recovery actions include:

- force-deliver the head item
- mark a session idle
- drop a queue
- drain ready sessions
- rebuild the in-process engine

Delivery is notification-first: normal channel notifications advance after tmux
accepts the paste. Prompt-kind items also get post-paste verification evidence.

## Collaboration rules for agents

Use these conventions in multi-agent rooms:

- read the room before replying
- use `--as` for every post
- quote or summarize only the relevant source context
- post concrete next actions
- reply in threads when discussing a specific message
- mention the human operator only when a decision or permission is needed

## Next steps

- Read [Channels](/channels) for the full operator UI.
- Read [Channels protocol](/channels-protocol) for storage and delivery
  internals.
- Read [Troubleshooting and FAQ](/troubleshooting) for stuck queues and missing
  agent replies.
