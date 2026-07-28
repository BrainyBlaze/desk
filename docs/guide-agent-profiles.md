---
title: "Run agents under separate accounts"
sidebarTitle: "Agent profiles"
description: "Give each session its own provider account: create profiles, assign them, and understand what moves with a profile and what does not."
---

One machine, several accounts. A work Claude account and a personal one; a
Codex account per client; a shared team account you keep away from your own.
Without profiles every agent Desk launches uses whichever account that CLI
happens to be logged into — so the answer to "which account is this agent
spending?" is "the last one I logged in as", for all of them at once.

A **profile** is a named provider account. Assign one to a session and that
session runs as that account, whatever the others are doing.

## What a profile actually is

Desk does not hold your credentials or log in on your behalf. It points the
agent CLI at a directory of its own:

```text
~/.config/desk/profiles/<profile-id>
```

for `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). The CLI then
authenticates into that directory exactly as it would into `~/.claude` or
`~/.codex`, and writes its own credential files there. Desk creates the
directory `0700` and never reads what the CLI puts in it.

A profiled launch also **unsets inherited provider credentials** —
`ANTHROPIC_API_KEY` and friends — so an ambient key in your shell cannot
silently outrank the account you picked. Choosing a profile means choosing it.

## Create a profile

<Steps>
  <Step title="Open Settings → Profiles">
    The gear icon in the toolbar. Profiles is the first section.

    <Frame caption="The Profiles settings panel: one row per provider account">
      <img src="/images/settings-profiles.png" alt="Desk settings showing the agent profiles panel with claude and codex accounts" />
    </Frame>
  </Step>

  <Step title="Add the account">
    Pick the provider (`claude` or `codex`) and give it a label you will
    recognise in a dropdown — an email address works well. Desk mints the id
    from the label.
  </Step>

  <Step title="Sign in inside the profile">
    A new profile is empty: it has no credentials until the CLI writes some.
    Assign it to a session, start that session, and log in there. An ambient
    login in your own terminal does **not** carry over — that is the point.
  </Step>
</Steps>

You can also create one without leaving the session form: the **+** beside the
Profile picker opens Settings and brings you back with what you had typed
still in place.

## Assign a profile to a session

In **Add session** or **Edit session**, the Profile row sits directly under the
agent picker:

- **Ambient account** — the default. The CLI uses whatever it is logged into.
- **A named profile** — the session runs as that account.

The picker only offers profiles whose provider matches the session's agent; a
Claude session cannot be pointed at a Codex account. In the manifest the field
is `profileId`, and a mismatch is a manifest error rather than a quiet
fall-back to ambient — see [Configuration](/configuration#agent-profiles).

## What moves with a profile, and what does not

This is the part worth reading twice.

| Moves with the profile | Stays where it was |
| --- | --- |
| Provider credentials and login state | Your manifest, groups, and layouts |
| The CLI's own settings for that account | Channels, membership, and delivery queues |
| **Conversation transcripts** | Notes, editor state, git |

The third row is the one that surprises people. Claude Code keeps its
conversation history *inside its config directory*, so a session's transcripts
live in whichever profile it ran under.

<Warning>
Changing a live session's profile points it at a different history. The
conversation it was resuming is still on disk under the old profile, but
`--resume` will not find it from the new one, and the session starts fresh.

Decide the account before a long conversation, not during one.
</Warning>

## Back it up

`~/.config/desk/profiles` holds real credentials. A backup that copies
`desk.yml`, `channels`, and `notes` but skips it restores a workspace whose
agents are all logged out. Back up the whole of `~/.config/desk` — see the
[backup answer](/troubleshooting#what-should-i-back-up).

## Troubleshooting

**The agent asks me to log in again after I assigned a profile.** Expected: a
fresh profile has no credentials. Log in inside that session once.

**My conversation disappeared after switching profiles.** It did not — it is
under the previous profile's directory. Switch the session back to that
profile to resume it, or start a fresh conversation under the new one.

**The profile picker does not show my account.** Its provider must match the
session's agent. A profile created as `codex` never appears on a Claude
session.

## Next steps

- [Configuration](/configuration#agent-profiles) documents the manifest schema.
- [Run Desk securely](/guide-deploy-securely) covers how to treat the profile
  directory.
- [Set up a multi-agent workspace](/guide-create-agent-fleet) builds the fleet
  these profiles attach to.
