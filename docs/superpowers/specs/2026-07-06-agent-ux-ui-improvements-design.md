# Agent UX/UI improvements design

Status: approved for the full 11-item program by `@human` in `#desk-multiplexor` on 2026-07-06.

This spec covers the visual and interaction follow-up to native UI mode. It does not change the native-mode protocol contract in `docs/native-ui-mode-spec.md`; protocol/schema changes remain separately gated.

## Goals

- Make native agent cells feel responsive during slow model/provider turns.
- Keep the user's primary controls near the composer.
- Prevent long injected channel/system payloads from overwhelming transcripts.
- Keep blocking permission requests visible until answered.
- Bring agent transcript readability closer to Desk Channels without copying channel-only features.
- Preserve the latest-message and reading-history scroll behavior shipped in `f5dbae7`.

## Phasing

Phase A is the immediate implementation lane:

1. Add visible working and first-token feedback.
2. Preserve drafts per native agent session/cell.
3. Collapse long injected/system/user payloads by default.
4. Dock pending permission cards above the composer.
5. Move Stop into the composer Send slot while processing or tool-executing.

Phase B follows after Phase A browser verification:

6. Improve row anatomy with clearer author/time/action affordances.
7. Strengthen tool state clarity for running/error/done rows.
8. Add a native-session unread/latest-viewed separator.

Phase C follows Phase B:

9. Add a slash-command palette backed by agent command discovery.
10. Add turn collapse and feed virtualization for long transcripts.
11. Add child-agent/subtask nesting after a short protocol event-shape design gate.

## Ownership

- Claude lane: items 1, 2, 5, 8, 9.
- Codex lane: items 3, 4, 6, 7, 10.
- Joint design gate: item 11, because subtask nesting needs attribution/event-shape decisions before code.

When a file is shared, changes are serialized by explicit channel handoff. `NativeAgentSurface.tsx` is currently a shared surface; only one agent edits it at a time. CSS work should be scoped to clearly labeled sections or small targeted selectors.

## Phase A Design

### 1. Working and first-token feedback

While a turn is active but no assistant delta is visible yet, show a compact working row below the latest transcript row and mirror the state in the composer. The indicator should disappear once assistant text, tool activity, permission state, completion, interruption, or error arrives.

The row should be subtle but visible in screenshots. It must not add committed history rows or change replay semantics.

### 2. Draft preservation

Composer text is currently local component state. Preserve draft text by native session/cell key so switching tabs, warm layouts, or remounting a cell does not discard user input.

Drafts should clear only after a successful send, not when Send is disabled or broker connection is down.

### 3. Payload collapse

Long injected/system/user payloads should render as compact expandable rows. The primary target is channel onboarding and notification text, which currently dominates the agent transcript and hides the actual conversation.

Initial rule: collapse rows that are system rows or user rows above a conservative length threshold, plus rows matching known channel-notification/onboarding shapes. The collapsed header should expose the source/type and enough preview text to identify the payload. Expanding must preserve full text and markdown/code safety.

This is presentational only. The underlying row model and replay events remain intact.

### 4. Permission dock

Pending permission cards should be rendered in a persistent dock directly above the composer, not only inline in the scrollable feed. The dock keeps the active approval visible while the agent waits.

The dock owns the active action controls. If an inline historical permission row is later added, it must be non-blocking/history-only and cannot duplicate active approval actions.

### 5. Composer Stop

The existing header Stop control is functional but far from the user's focus. During `processing` or `tool-executing`, the composer Send slot should become Stop and call the existing interrupt path. Header status remains secondary context.

The Stop affordance should be visually distinct from disabled `Wait...`, because it is an available action.

## Phase B Design

### 6. Row anatomy

Adopt the useful parts of Desk Channels row structure: clearer author/gutter alignment, hover timestamps, copy affordances for assistant/code/tool content, and less ambiguous spacing between turns.

Do not add channel-only concepts such as reactions, members, or thread controls to native agent rows.

### 7. Tool state clarity

The row model and CSS already represent running/error/done states, but live rows still read too similarly. Running tools should have an unmistakable active treatment; completed tools should clearly show outcome and offer details/copy without dominating the feed.

### 8. Unread/latest-viewed separator

Add a native-session separator for content that arrived after the user's last viewed position. It should pair with the jump-to-latest pill and must not reintroduce scroll yanking.

## Phase C Design

### 9. Slash-command palette

Typing `/` opens completions from the relevant agent discovery API where available. Commands that cannot run in native mode remain honestly blocked with visible explanations.

### 10. Turn collapse and virtualization

Long sessions need turn-level collapse and virtualization similar to channels. Preserve scroll anchoring and latest-message behavior while reducing DOM and visual load.

### 11. Child-agent/subtask nesting

Nested child-agent/subtask display needs a short design gate before implementation. The team must decide how the protocol attributes subtask ownership, parent turn, and lifecycle before adding UI.

## Verification

Each item needs:

- A focused regression/unit test where behavior is deterministic.
- `npm run check` or the narrowest equivalent typecheck/lint gate required by the touched files.
- Browser verification on live `:5195`.
- A screenshot for visible UI changes before calling the item complete.

Phase A completion requires screenshots showing: working feedback, preserved draft behavior, collapsed long payload, docked permission request, and composer Stop.
