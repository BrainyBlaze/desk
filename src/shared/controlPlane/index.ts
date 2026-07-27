// Control plane (spec §6, contract C16) — public surface. Pure src/shared logic;
// the daemon supplies durable port implementations, the web server consumes the
// resolved model for projections (§6.7).
export * from './intake.js';
export * from './consumer.js';
export * from './generationLedger.js';
export * from './contract.js';
export * from './authority.js';
export * from './sessionSubject.js';
export * from './eventFeed.js';
export * from './producerEndpoint.js';
