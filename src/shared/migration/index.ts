// Identity migration (spec §10) — tmuxSession → sessionId. Pure src/shared:
// sessionId grammar/minting, the submitState repair map (never import legacy as
// done), and the journaled resumable phase FSM. The daemon/CLI drive the FS
// stores + schema bump; these encode the rules.
export * from './sessionId.js';
export * from './submitStateRepair.js';
export * from './migrationPhases.js';
export * from './manifestTransform.js';
export * from './channelsPausedTransform.js';
export * from './durabilityTransform.js';
