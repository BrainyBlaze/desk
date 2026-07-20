// Recovery & durability (spec §8.2, C4) — the two-axis trust-state machine.
// Pure src/shared; the daemon persists RecoveryState in the registry and
// surfaces it in ATTACH_ACK + GAP.
export * from './recoveryState.js';
