// The Channels subsystem.
//
// Everything outside this directory should enter here. The subsystem is six
// replaceable parts (see `ports.ts`) assembled behind an HTTP surface and a
// runtime lifecycle; which file happens to hold which part is nobody else's
// business, and has changed twice already.
//
// The browser client and the CLI are the deliberate exception: they import
// TYPES straight from `protocol/`, because routing an erased type import
// through this module would make the web bundle name server runtime code.

export {
  handleChannelsRequest,
  initChannelsRuntime,
  disposeChannelsRuntime,
  resetChannelsRuntime
} from './api.js';
export type { ChannelsRuntimeOptions } from './api.js';

export { acquireChannelsRuntimeOwner } from './runtimeOwner.js';
export type { ChannelsRuntimeOwner } from './runtimeOwner.js';

export { resolveChannelsHome, ensureChannelsHome } from './store/fileStore.js';

// The extension surface.
export * from './ports.js';
