export {
  addSessionToManifest,
  createEmptyManifest,
  readManifestFile,
  resolveDefaultManifestPath,
  resolveManifestPath,
  serializeDeskManifest,
  writeManifestFile
} from './core/config.js';
export { buildSessionSpecs, parseDeskManifest } from './core/manifest.js';
export { createAttachArgv, createCaptureArgv, createTmuxPlan } from './core/tmux.js';
export type { DeskGroup, DeskManifest, DeskSession, SessionSpec, TmuxPlanAction } from './core/types.js';
