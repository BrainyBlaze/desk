// Entry point for the compiled single-file desk server (`bun build --compile`,
// via scripts/build-standalone.ts). The bundled standalone.js no longer
// self-starts inside the bun bundle, so the entry starts the server explicitly.
// Host/port come from DESK_HOST / DESK_PORT; the UI and LSP servers are embedded.
//
// `embeddedPlugins` is the default empty list for desk's own binary; a downstream
// build (the cloud image) swaps that module to compile plugins into the binary.
// Runtime DESK_PLUGINS is still honored and merged on top.
import { startStandalone } from './standalone.js';
import { embeddedPlugins } from './embeddedPlugins.js';

startStandalone({ plugins: embeddedPlugins }).catch((error) => {
  console.error(error);
  process.exit(1);
});
