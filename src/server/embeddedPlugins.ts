// Build-time seam for compiling plugins straight into the standalone binary.
//
// Desk's own binary embeds NO plugins (this default). A downstream standalone
// build can swap this module via the bundler to embed plugins at build time.
// Plugins are injected by the outer build, never referenced here. Runtime
// `DESK_PLUGINS` still works and is merged on top.
import type { DeskPlugin } from './plugin.js';

export const embeddedPlugins: DeskPlugin[] = [];
