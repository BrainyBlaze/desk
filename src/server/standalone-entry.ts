// Entry point for the compiled single-file desk server (`bun build --compile`,
// via scripts/build-standalone.ts). The bundled standalone.js no longer
// self-starts inside the bun bundle, so the entry starts the server explicitly.
// Host/port come from DESK_HOST / DESK_PORT; the UI and LSP servers are embedded.
//
// `embeddedPlugins` is the default empty list for desk's own binary; a downstream
// build (the cloud image) swaps that module to compile plugins into the binary.
// Runtime DESK_PLUGINS is still honored and merged on top.
import { runStandaloneCommand } from './standaloneCommand.js';

try {
  process.exitCode = await runStandaloneCommand(process.argv.slice(2), {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
    start: async () => {
      const [{ startStandalone }, { embeddedPlugins }] = await Promise.all([
        import('./standalone.js'),
        import('./embeddedPlugins.js')
      ]);
      await startStandalone({ plugins: embeddedPlugins });
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
