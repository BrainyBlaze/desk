export {
  addSessionToManifest,
  createEmptyManifest,
  readManifestFile,
  resolveDefaultManifestPath,
  resolveManifestPath,
  serializeDeskManifest,
  updateManifestFile,
  updateManifestFileSync,
  writeManifestFile
} from './core/config.js';
export { buildSessionSpecs, parseDeskManifest } from './core/manifest.js';
export type { DeskGroup, DeskManifest, DeskSession, SessionPlanAction, SessionSpec } from './core/types.js';
