# Item 11 — Child-agent / subtask nesting (design gate)

Status: AMENDED per codex review (msg-224708) — codex scope narrowed to tool-row-only v1. Awaiting final ack.

## Problem

All three agents can spawn child agents (claude Task subagents, codex
collabAgentToolCall, opencode subtask commands). Today their activity either
flattens into the parent transcript (claude/codex) or is filtered out entirely
(opencode R3 excludes child-session events). archpowers renders child-agent
events nested under the spawning tool call; desk should too.

## Per-agent reality (verified in SDKs/bindings)

- claude SDK: every streamed message carries `parent_tool_use_id` (null for the
  main thread; the spawning Task tool's tool_use id for subagent traffic). The
  driver currently ignores it.
- codex app-server (AMENDED per codex review 2026-07-06): `collabAgentToolCall`
  items carry id/senderThreadId/receiverThreadIds but NO nested progress — child
  activity lives in SEPARATE threads which the driver's threadId filter drops
  today. Attribution would require indexing receiverThreadIds → parent item id
  and fetching/subscribing those receiver threads. That child-thread read path
  is NOT taken in v1: codex stays tool-row-only, nested transcript support
  explicitly DEFERRED (same honest pattern as opencode below).
- opencode: `Command.subtask` marks subtask commands; child sessions have their
  own session ids with a parent reference (driver's belongsToSession currently
  drops them — R3 was deliberate for v1).

## Protocol change (additive, one field)

`AgentSurfaceEventBase` gains:

```ts
/** When set, this event belongs to the child agent spawned by that tool call. */
parentToolUseId?: string;
```

- Envelope-level (like seq/ts) so ANY event kind can be attributed without
  per-kind unions. Validators: optional non-empty string; absent = main thread.
- Ring/snapshot/backfill carry it transparently. Old events parse unchanged.

## Driver mapping

- claude: stamp `parentToolUseId` from `parent_tool_use_id` on all mapped
  events (live + history — the store records it per message).
- codex: v1 = tool-row-only (collabAgentToolCall renders as a tool row, as it
  already does after the item-6 mapping); nested child-thread transcripts
  deferred with this note. No parentToolUseId stamping from the codex driver
  in v1.
- opencode: v1 keeps R3 (child sessions dropped) — flip only if the child
  events can be cheaply attributed via their parent reference; otherwise defer
  to v1.1 with an explicit note. NO silent half-support.

## Rendering (rowsModel + surface)

- Rows with `parentToolUseId` group INSIDE the matching tool row's accordion as
  an indented child transcript (reuse existing row renderers at reduced scale).
- Orphaned children (parent tool row missing/pruned): render flat with a small
  "subagent" author prefix — visible, never dropped.
- Child rows do not affect the unread separator / jump pill counts (they belong
  to the parent's visual block).

## Tests

- Protocol: validator accepts/rejects the optional parentToolUseId (RED first).
- claude driver: history + live mapping stamps parentToolUseId from
  parent_tool_use_id.
- codex fixture: asserts collabAgentToolCall remains tool-row-only and does
  NOT stamp parentToolUseId in v1.
- rowsModel: grouping, orphan fallback, separator-count exclusion.

## Out of scope (explicit)

Interactive child-agent control (interrupting a subagent, per-child composers),
cross-session opencode child rendering, and any recursive nesting beyond one
level (children of children flatten into their nearest rendered ancestor).
