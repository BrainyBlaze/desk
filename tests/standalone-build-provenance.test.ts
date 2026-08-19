import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStandalone } from '../scripts/build-standalone.js';
import {
  computeRuntimeSourceFingerprint,
  standaloneProvenancePath
} from '../src/shared/runtimeProvenance.js';

const roots: string[] = [];

function write(root: string, relativePath: string, content = ''): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-standalone-build-'));
  roots.push(root);
  write(root, 'package.json', '{"version":"0.4.0"}\n');
  write(root, 'package-lock.json', '{}\n');
  write(root, 'tsconfig.json', '{}\n');
  write(root, 'vite.config.ts', 'export default {};\n');
  write(root, 'index.html', '<main></main>\n');
  write(root, 'src/cli/main.ts', 'export const cli = true;\n');
  write(root, 'src/server/standalone-entry.ts', 'export {};\n');
  write(root, 'scripts/build-standalone.ts', 'export {};\n');
  write(root, 'scripts/make-assets.mjs', 'export {};\n');
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('standalone build provenance', () => {
  it('stamps a successful binary with the exact source fingerprint', async () => {
    const root = sourceRoot();
    const outfile = join(root, 'libexec', 'desk-standalone');
    const build = vi.fn(async (options: { compile: { outfile: string } }) => {
      writeFileSync(options.compile.outfile, 'binary');
      return { success: true, logs: [] };
    });
    vi.stubGlobal('Bun', { build });

    await buildStandalone({ outfile, sourceRoot: root });

    expect(build).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(standaloneProvenancePath(outfile), 'utf8'))).toEqual({
      schemaVersion: 1,
      sourceFingerprint: computeRuntimeSourceFingerprint(root)
    });
  });

  it('removes an output compiled while source inputs were changing', async () => {
    const root = sourceRoot();
    const outfile = join(root, 'libexec', 'desk-standalone');
    vi.stubGlobal('Bun', {
      build: vi.fn(async (options: { compile: { outfile: string } }) => {
        writeFileSync(options.compile.outfile, 'mixed binary');
        write(root, 'src/cli/main.ts', 'export const cli = false;\n');
        return { success: true, logs: [] };
      })
    });

    await expect(buildStandalone({ outfile, sourceRoot: root })).rejects.toThrow(
      'runtime source changed during standalone compilation'
    );
    expect(existsSync(outfile)).toBe(false);
    expect(existsSync(standaloneProvenancePath(outfile))).toBe(false);
  });
});
