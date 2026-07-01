// Production server — serves the embedded UI and mounts the full Desk backend,
// with NO Vite in the runtime. Vite is a build-time tool: it bundles the client
// into dist/public (via `vite build`), which the standalone build embeds into the
// binary and extracts at runtime. The backend was never Vite-coupled —
// `installDeskApi` only needs a Node httpServer + a connect middleware stack.
//
//   request → [plugin middleware] → [/api router + WS bridges] → [static UI (SPA)]
//
// Launched by standalone-entry.ts inside the compiled binary (`build:standalone`).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import connect from 'connect';
import sirv from 'sirv';
import type { Connect } from 'vite';
import { installDeskApi } from './vitePlugin.js';
import { loadPluginsFromEnv } from './pluginLoader.js';
import { resolveEmbeddedUiDir } from './uiAsset.js';
import type { DeskPlugin } from './plugin.js';

export interface StandaloneOptions {
  host?: string;
  port?: number;
  /** Plugins composed in addition to those named in DESK_PLUGINS (merged on top). */
  plugins?: DeskPlugin[];
}

export async function startStandalone(options: StandaloneOptions = {}): Promise<void> {
  const host = options.host ?? process.env.DESK_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.DESK_PORT ?? '5173');
  const uiDir = resolveEmbeddedUiDir();

  if (!existsSync(join(uiDir, 'index.html'))) {
    throw new Error(`built UI not found at ${uiDir}`);
  }

  const plugins = [...(await loadPluginsFromEnv()), ...(options.plugins ?? [])];

  const app = connect();
  const httpServer = createServer(app);

  // Plugin middleware (e.g. an auth gate) + /api router + the WS bridges.
  // Registered first so it runs before the static handler below.
  installDeskApi({ httpServer, middlewares: app as unknown as Connect.Server }, { plugins });

  // Static assets last, with `single` (SPA history fallback) so client-side
  // routes resolve to index.html. /api is always terminated upstream (it never
  // calls next), so it can't fall through to here.
  app.use(sirv(uiDir, { single: true, etag: true, gzip: true, brotli: true }));

  httpServer.listen(port, host, () => {
    console.log(`desk (standalone) serving on http://${host}:${port}`);
  });
}
