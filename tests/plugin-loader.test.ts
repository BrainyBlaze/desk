import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPluginsFromEnv, parsePluginSpec } from '../src/server/pluginLoader';

const dir = mkdtempSync(join(tmpdir(), 'desk-plugins-'));
let seq = 0;

/** Write an ESM module to disk and return its file:// specifier (no commas). */
function modUrl(source: string): string {
  const file = join(dir, `plugin-${seq++}.mjs`);
  writeFileSync(file, source);
  return pathToFileURL(file).href;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parsePluginSpec', () => {
  it('returns [] for empty/undefined/whitespace', () => {
    expect(parsePluginSpec(undefined)).toEqual([]);
    expect(parsePluginSpec('')).toEqual([]);
    expect(parsePluginSpec('   ')).toEqual([]);
  });

  it('splits a comma list, trims, and drops empties', () => {
    expect(parsePluginSpec(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('loadPluginsFromEnv', () => {
  it('loads nothing when the spec is unset', async () => {
    expect(await loadPluginsFromEnv(undefined)).toEqual([]);
  });

  it('loads a default-exported plugin object', async () => {
    const plugins = await loadPluginsFromEnv(modUrl('export default { name: "obj" };'));
    expect(plugins.map((p) => p.name)).toEqual(['obj']);
  });

  it('instantiates a default-exported factory', async () => {
    const plugins = await loadPluginsFromEnv(modUrl('export default () => ({ name: "factory" });'));
    expect(plugins.map((p) => p.name)).toEqual(['factory']);
  });

  it('accepts a named `plugin` export', async () => {
    const plugins = await loadPluginsFromEnv(modUrl('export const plugin = { name: "named" };'));
    expect(plugins.map((p) => p.name)).toEqual(['named']);
  });

  it('loads several specifiers in order', async () => {
    const a = modUrl('export default { name: "a" };');
    const b = modUrl('export default () => ({ name: "b" });');
    const plugins = await loadPluginsFromEnv(`${a}, ${b}`);
    expect(plugins.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('throws when a module does not export a DeskPlugin', async () => {
    await expect(loadPluginsFromEnv(modUrl('export default { nope: true };'))).rejects.toThrow(
      /did not export a DeskPlugin/
    );
  });
});
