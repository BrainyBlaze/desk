# Channels Live Delivery Domain Cleanup

## Goal

Make the live Channels diagnostics describe only states the current runtime can
produce, without changing delivery semantics or the fail-closed legacy submit
state repair.

## Design

- Keep exactly six live delivery block reasons: `offline`, `booting`,
  `draining`, `send-failed`, `submit-stuck-paste`, and
  `submit-stuck-submit`.
- Rename the drain single-flight hold from `busy` to `draining`; it describes
  engine ownership, not agent activity.
- Remove the unreachable pending delivery ACK state, timers, callbacks, and
  tests. Current delivery remains message/native to `submitted`, and terminal
  prompts through submit verification.
- Leave `submitStateRepair` and historical `delivery-ack-timeout` decoding
  unchanged. They protect persisted pre-cutover queue data and are outside this
  live-runtime cleanup.

## Verification

1. Add behavior assertions at the production paths for every live block reason.
2. Prove the rename with a failing wedged-drain test before implementation.
3. Run focused delivery, engine, model, migration, and UI tests.
4. Run TypeScript checks and the full real-join test gate.
5. Commit and push only after the worktree diff is clean and scoped.
