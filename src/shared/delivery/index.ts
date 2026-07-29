// Delivery-phase engine (spec §6.10, H1) — public surface. Pure src/shared
// logic: the phase FSM (accepted != delivered) + the CMD_CACHE idempotency
// store. The daemon wires the transport + confirmation adapters and persists
// both fsync-on-write.
export * from './phases.js';
export * from './cmdCache.js';
