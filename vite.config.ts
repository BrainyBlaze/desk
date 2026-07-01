import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { deskApiPlugin } from './src/server/vitePlugin';

// Host allow-list for the dev/preview server. Vite rejects requests whose Host
// header isn't allowed (DNS-rebinding protection for a locally-exposed dev
// server). When Desk is served behind a reverse proxy on a host that varies,
// that check gets in the way, so it's configurable:
//   - DESK_ALLOWED_HOSTS set -> use it (`*`/`true` = any; else a comma list,
//                               where `.example.com` matches all subdomains)
//   - else (local dev)       -> Vite's secure default (localhost / IP only)
function allowedHosts(): true | string[] | undefined {
  const explicit = process.env.DESK_ALLOWED_HOSTS?.trim();
  if (explicit) {
    if (explicit === '*' || explicit === 'true') {
      return true;
    }
    return explicit.split(',').map((h) => h.trim()).filter(Boolean);
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), deskApiPlugin()],
  build: {
    // tsc compiles src/** into dist/** (cli, core, server, shared, ui, web), and
    // `vite build` *empties* its own outDir — so the UI bundle must land in a dir
    // that mirrors NO src/ folder, else it wipes compiled server code. In
    // particular dist/ui holds the shared client+server `src/ui/*` (model.ts), so
    // the bundle goes to dist/public. The prod server (standalone) serves it.
    outDir: 'dist/public',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: allowedHosts()
  },
  preview: {
    allowedHosts: allowedHosts()
  }
});
