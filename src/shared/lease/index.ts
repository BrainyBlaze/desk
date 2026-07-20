// Controller / resize lease (spec §7.5/§7.9) — pure state machine. The daemon
// owns one LeaseState per session and drives it from LEASE_CLAIM/RELEASE frames
// + heartbeat + a TTL sweep timer.
export * from './leaseState.js';
