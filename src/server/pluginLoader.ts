// Loads Desk plugins named in the `DESK_PLUGINS` env var (a comma-separated list
// of module specifiers) and returns them ready to pass to `installDeskApi`.
//
// This keeps Desk core free of any knowledge about specific plugins: the
// operator names the modules at deploy/build time (e.g. in `/etc/desk.env`), and
// Desk dynamically imports whatever they listed. Each module must default-export
// either a `DeskPlugin` or a zero-arg factory returning one. Unset/empty env =>
// no plugins => stock local-trust behavior.
import type { DeskPlugin } from './plugin.js';

function coercePlugin(specifier: string, exported: unknown): DeskPlugin {
  const candidate = typeof exported === 'function' ? (exported as () => DeskPlugin)() : exported;
  if (!candidate || typeof candidate !== 'object' || typeof (candidate as DeskPlugin).name !== 'string') {
    throw new Error(`DESK_PLUGINS: "${specifier}" did not export a DeskPlugin (or a factory returning one)`);
  }
  return candidate as DeskPlugin;
}

/** Parse a `DESK_PLUGINS` spec into module specifiers. */
export function parsePluginSpec(spec: string | undefined): string[] {
  if (!spec || !spec.trim()) {
    return [];
  }
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Dynamically import and instantiate the plugins named in `DESK_PLUGINS`. */
export async function loadPluginsFromEnv(spec: string | undefined = process.env.DESK_PLUGINS): Promise<DeskPlugin[]> {
  const specifiers = parsePluginSpec(spec);
  const plugins: DeskPlugin[] = [];
  for (const specifier of specifiers) {
    const mod = (await import(specifier)) as { default?: unknown; plugin?: unknown };
    plugins.push(coercePlugin(specifier, mod.default ?? mod.plugin ?? mod));
  }
  return plugins;
}
