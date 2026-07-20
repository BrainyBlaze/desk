// Loss-aware browser protocol (spec §7.4/§7.6/§7.7) — public surface. The
// binary WS framing between the web server and a browser tab. Pure src/shared;
// the web server and the browser terminalBrokerClient both build against it.
export * from './frames.js';
export * from './codec.js';
export * from './querySuppression.js';
