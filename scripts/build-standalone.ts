// Compile the single-file desk server with `bun build --compile`.
//
// This is the ONLY place that knows about the standalone build. Two plugins do
// all the work that the shared source is kept free of:
//   • swap        — redirect `./lspResolver.js` / `./uiAsset.js` / `./ptyBackend.js`
//                   to their `.standalone.ts` siblings (asset tarballs; the
//                   Bun.Terminal pty backend that replaces node-pty under bun).
//   • embedNodePty — rewrite node-pty's dynamic native require into a static
//                   literal so the bundler embeds pty.node. Dormant once the pty
//                   backend is swapped (node-pty leaves the standalone graph),
//                   kept as a guard in case anything else pulls node-pty in.
//
// Run after `vite build` + `node scripts/make-assets.mjs`.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const root = resolve(import.meta.dir, '..');

const swap: BunPlugin = {
  name: 'desk-standalone-swap',
  setup(build) {
    build.onResolve({ filter: /[\\/](lspResolver|uiAsset|ptyBackend)\.js$/ }, (args) => ({
      path: resolve(dirname(args.importer), args.path.replace(/\.js$/, '.standalone.ts'))
    }));
  }
};

const embedNodePty: BunPlugin = {
  name: 'desk-embed-node-pty',
  setup(build) {
    build.onLoad({ filter: /node-pty[\\/]lib[\\/]utils\.js$/ }, async (args) => {
      // node-pty's native lands in build/Release on Linux (built from source) or
      // prebuilds/<platform>-<arch> on macOS/Windows (shipped prebuilds). Embed
      // the one that exists for THIS build host via a static literal require.
      const ptyRoot = resolve(dirname(args.path), '..');
      const rel = [
        'build/Release/pty.node',
        `prebuilds/${process.platform}-${process.arch}/pty.node`
      ].find((candidate) => existsSync(resolve(ptyRoot, candidate)));
      if (!rel) {
        throw new Error(
          `build-standalone: node-pty native not found for ${process.platform}-${process.arch}`
        );
      }
      const original = await Bun.file(args.path).text();
      const patched = original.replace(
        'var lastError;',
        `var lastError;\n    try { return { dir: "./", module: require(${JSON.stringify('../' + rel)}) }; } catch (e) { lastError = e; }`
      );
      if (patched === original) {
        throw new Error('build-standalone: node-pty loader anchor not found');
      }
      return { contents: patched, loader: 'js' };
    });
  }
};

// Compile desk's standalone binary. `extraPlugins` lets a downstream build add
// bundler plugins — e.g. an outer image build can swap `./embeddedPlugins.js`
// to compile deployment-specific plugins into the binary while keeping this
// repository cloud-free.
export async function buildStandalone({
  outfile,
  extraPlugins = []
}: {
  outfile: string;
  extraPlugins?: BunPlugin[];
}): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(root, 'src/server/standalone-entry.ts')],
    compile: { outfile },
    plugins: [swap, embedNodePty, ...extraPlugins]
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error('build-standalone: bun build failed');
  }
}

// Run as a script (`bun run scripts/build-standalone.ts`) → compile desk's own
// plugin-free binary. When imported, only the `buildStandalone` export runs.
if (import.meta.main) {
  await buildStandalone({ outfile: resolve(root, 'desk-server') });
  console.log('build-standalone: wrote desk-server');
}
