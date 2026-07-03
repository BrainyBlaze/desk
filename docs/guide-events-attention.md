---
title: "Stay on top of a working fleet"
description: "Events, attention signals, the command palette, and notification hygiene for supervising many agents at once."
---

The point of a fleet is that you stop watching terminals. Desk routes agent
signals to you instead: who finished, who needs approval, who is waiting on
input, and what happened in channels while you looked away.

## The attention pipeline

Agents emit signals as they work — turn-complete, approval-requested,
input-needed — parsed from terminal notifications, with plain bells as the
fallback (a poller covers sessions no browser is watching). Each signal
becomes:

- a pulsing lamp on the session row, bubbling up to collapsed groups and
  projects,
- an event card in the drawer,
- an attention sound that follows the mute setting,
- and a release signal for the channels delivery engine.

<Frame caption="The events drawer: kind filters, unread lamps, per-card navigation">
  <img src="/images/events-drawer.png" alt="Events drawer with unread event cards" />
</Frame>

Clicking a card jumps to its source — an agent session or a channel message.
Typing into a session clears its attention; mark-all-read clears the drawer.

## Triage with the palette

`Ctrl+K` is the fastest route to whoever needs you — attention-needing
sessions rank first, then recents, then tree order:

<Frame caption="The session quick-switcher: fuzzy search, attention-first ranking">
  <img src="/images/command-palette.png" alt="Command palette with fuzzy session search" />
</Frame>

`Ctrl+Alt+1..9` focuses grid cells directly, and `Ctrl+Alt+←/→` cycles the
whole tree. The sidebar's bell chip filters to screaming sessions only.

## Channel signals

Channel messages emit their own event cards — `@human` mentions flagged —
and unanswered mentions escalate into the channels **Inbox**. Unread badges
on the rail and status bar stay live even while you work in another
subsystem, and the **While you were away** digest summarizes what
accumulated.

## Status bar: the always-on summary

The bottom bar keeps the counts visible everywhere: agents needing input,
unread events, unread channel messages, mute state, and sync health. Each is
clickable — the needs-input count opens the drawer filtered to inputs.

## Make it yours

Settings (gear icon) control the experience:

<Frame caption="Settings: twelve switchable themes, sound, autosave, and language servers">
  <img src="/images/settings-themes.png" alt="Settings modal with the theme grid" />
</Frame>

- **Themes** — twelve palettes, applied live including terminal colors.
- **Sound** — the full Arwes sound design or silence; the toolbar toggle
  matches.
- **Reduced motion** — Desk honors the OS setting and disables animations.

On phones, everything above compresses into the burger menu, a compact
telemetry strip, and the state-tinted pager — triage from the couch works.
