// Control plane (spec §6, contract C16) — public surface. Pure src/shared logic;
// the daemon supplies durable port implementations, the web server consumes the
// resolved model for projections (§6.7).
export * from './model.js';
export * from './session.js';
export * from './intake.js';
export * from './consumer.js';
