// desk-runtime daemon — pure cores (spec §3.2/§3.3). The daemon composes these
// with fs/process/socket adapters and the emulator port. Pure src/shared so the
// resource-safety + lock + version rules are unit-testable without spawning.
export * from './workerSupervisor.js';
export * from './instanceLock.js';
export * from './rpcEnvelope.js';
export * from './emulatorPort.js';
export * from './nativeLifecycle.js';
export * from './sessionGeometryStore.js';
export * from './sessionScreenCheckpointStore.js';
export * from './sessionRuntime.js';
export * from './daemonCore.js';
