import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  computeRuntimeSourceFingerprint,
  writeStandaloneBuildProvenance
} from '../src/shared/runtimeProvenance.js';
import {
  classifyPackageRoot,
  createServeLaunch,
  findPackageRoot,
  parseServeOptions,
  runServeLaunch,
  type ServeOptions
} from '../src/cli/serveCommand.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const temporaryRoots: string[] = [];

function makePackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-serve-command-'));
  temporaryRoots.push(root);
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

function addArtifact(root: string, relativePath: string): string {
  const artifact = join(root, relativePath);
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, '');
  return artifact;
}

function makeSourceRoot(): string {
  const root = makePackageRoot();
  for (const [path, content] of [
    ['package-lock.json', '{}'],
    ['tsconfig.json', '{}'],
    ['vite.config.ts', 'export default {}'],
    ['index.html', '<main></main>'],
    ['src/cli/main.ts', 'export {}'],
    ['scripts/build-standalone.ts', 'export {}'],
    ['scripts/make-assets.mjs', 'export {}']
  ] as const) {
    const artifact = addArtifact(root, path);
    writeFileSync(artifact, content);
  }
  return root;
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected function to throw');
}

function expectOnlyArtifactLookup(artifact: string): void {
  expect(vi.mocked(existsSync).mock.calls).toEqual([[artifact]]);
}

beforeEach(() => {
  vi.mocked(existsSync).mockClear();
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('parseServeOptions', () => {
  it('defaults to automatic runtime selection on the loopback host and port 5173', () => {
    expect(parseServeOptions([], {})).toEqual({
      mode: 'auto',
      host: '127.0.0.1',
      port: 5173
    });
  });

  it('treats --dev as a boolean flag that selects Vite', () => {
    expect(parseServeOptions(['--dev', '--port', '6000'], {})).toEqual({
      mode: 'vite',
      host: '127.0.0.1',
      port: 6000
    });
  });

  it('accepts serve flags in any order', () => {
    expect(parseServeOptions(['--port', '6000', '--host', '0.0.0.0', '--dev'], {})).toEqual({
      mode: 'vite',
      host: '0.0.0.0',
      port: 6000
    });
  });

  it('uses environment defaults when flags are absent', () => {
    expect(parseServeOptions([], { DESK_HOST: '0.0.0.0', DESK_PORT: '7000' })).toEqual({
      mode: 'auto',
      host: '0.0.0.0',
      port: 7000
    });
  });

  it('gives flags precedence over environment defaults', () => {
    expect(
      parseServeOptions(['--host', 'localhost', '--port', '6000'], {
        DESK_HOST: '0.0.0.0',
        DESK_PORT: '7000'
      })
    ).toEqual({ mode: 'auto', host: 'localhost', port: 6000 });
  });

  it.each([
    [['--host', ''], {}],
    [[], { DESK_HOST: '' }]
  ] as const)('rejects an empty host from argv or the environment', (argv, env) => {
    expect(() => parseServeOptions(argv, env)).toThrow('host must not be empty');
  });

  it.each(['not-a-number', '5173.5', '0', '65536'])('rejects invalid port %s', (port) => {
    expect(() => parseServeOptions(['--port', port], {})).toThrow('port must be an integer from 1 through 65535');
  });

  it('accepts both port boundaries', () => {
    expect(parseServeOptions(['--port', '1'], {}).port).toBe(1);
    expect(parseServeOptions(['--port', '65535'], {}).port).toBe(65535);
  });

  it.each([
    [['--dev', '--dev'], '--dev may be specified only once'],
    [['--standalone', '--standalone'], '--standalone may be specified only once'],
    [['--host', 'one', '--host', 'two'], '--host may be specified only once'],
    [['--port', '5173', '--port', '5174'], '--port may be specified only once']
  ] as const)('rejects duplicate flags in %j', (argv, message) => {
    expect(() => parseServeOptions(argv, {})).toThrow(message);
  });

  it.each(['--host', '--port'])('rejects a missing value for %s', (flag) => {
    expect(() => parseServeOptions([flag], {})).toThrow(`${flag} requires a value`);
  });

  it('rejects unknown flags', () => {
    expect(() => parseServeOptions(['--unknown'], {})).toThrow('unknown option --unknown');
  });

  it('accepts --standalone as an explicit immutable-runtime override', () => {
    expect(parseServeOptions(['--standalone'], {})).toEqual({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 5173
    });
  });

  it('rejects conflicting runtime overrides', () => {
    expect(() => parseServeOptions(['--dev', '--standalone'], {})).toThrow(
      '--dev and --standalone are mutually exclusive'
    );
  });

  it('rejects unexpected positional arguments', () => {
    expect(() => parseServeOptions(['--dev', 'true'], {})).toThrow('unexpected argument true');
  });
});

describe('serve launch planning', () => {
  const autoOptions: ServeOptions = { mode: 'auto', host: '127.0.0.1', port: 5173 };
  const viteOptions: ServeOptions = { mode: 'vite', host: '127.0.0.1', port: 5173 };
  const standaloneOptions: ServeOptions = { mode: 'standalone', host: '0.0.0.0', port: 6000 };

  it('finds a complete source package root', () => {
    const root = makePackageRoot();
    writeFileSync(join(root, 'vite.config.ts'), '');
    addArtifact(root, 'src/cli/main.ts');
    const nestedModule = addArtifact(root, 'src/cli/serveCommand.ts');

    expect(findPackageRoot(pathToFileURL(nestedModule).href)).toBe(root);
  });

  it('finds a built package root with only dist/cli/main.js as its marker', () => {
    const root = makePackageRoot();
    const nestedModule = addArtifact(root, 'dist/cli/main.js');

    expect(findPackageRoot(pathToFileURL(nestedModule).href)).toBe(root);
  });

  it('rejects a package tree with neither package-root marker', () => {
    const root = makePackageRoot();
    const nestedModule = addArtifact(root, 'src/cli/serveCommand.ts');

    expect(() => findPackageRoot(pathToFileURL(nestedModule).href)).toThrow(
      'cannot locate the desk package root (reinstall desk)'
    );
  });

  it('classifies a complete source checkout ahead of stale built artifacts', () => {
    const root = makePackageRoot();
    addArtifact(root, 'vite.config.ts');
    addArtifact(root, 'src/cli/main.ts');
    addArtifact(root, 'dist/cli/main.js');

    expect(classifyPackageRoot(root)).toBe('source');
  });

  it('classifies a built-only package as a distribution', () => {
    const root = makePackageRoot();
    addArtifact(root, 'dist/cli/main.js');

    expect(classifyPackageRoot(root)).toBe('distribution');
  });

  it('automatically launches Vite from a source checkout even when stale standalone exists', () => {
    const root = makePackageRoot();
    addArtifact(root, 'vite.config.ts');
    addArtifact(root, 'src/cli/main.ts');
    const viteEntry = addArtifact(root, 'node_modules/vite/bin/vite.js');
    addArtifact(root, 'libexec/desk-standalone');

    expect(createServeLaunch(root, autoOptions, '/runtime/node')).toMatchObject({
      command: '/runtime/node',
      args: [viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort']
    });
  });

  it('automatically launches standalone from a distribution package', () => {
    const root = makePackageRoot();
    addArtifact(root, 'dist/cli/main.js');
    const standaloneEntry = addArtifact(root, 'libexec/desk-standalone');

    expect(createServeLaunch(root, autoOptions, '/runtime/node')).toMatchObject({
      command: standaloneEntry,
      args: []
    });
  });

  it('selects the Vite JavaScript entry with strict port handling and probes only that artifact', () => {
    const root = makePackageRoot();
    const viteEntry = addArtifact(root, 'node_modules/vite/bin/vite.js');

    expect(createServeLaunch(root, viteOptions, '/runtime/node')).toMatchObject({
      command: '/runtime/node',
      args: [viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
      cwd: root
    });
    expectOnlyArtifactLookup(viteEntry);
  });

  it('selects the private standalone executable from a distribution and passes the resolved environment', () => {
    const root = makePackageRoot();
    addArtifact(root, 'dist/cli/main.js');
    const standaloneEntry = addArtifact(root, 'libexec/desk-standalone');
    const parentEnv = { KEEP_ME: 'yes' };

    expect(createServeLaunch(root, standaloneOptions, '/runtime/node', parentEnv)).toMatchObject({
      command: standaloneEntry,
      args: [],
      cwd: root,
      env: {
        KEEP_ME: 'yes',
        DESK_HOST: '0.0.0.0',
        DESK_PORT: '6000',
        DESK_DAEMON_NODE: '/runtime/node'
      }
    });
    expect(vi.mocked(existsSync).mock.calls).toContainEqual([standaloneEntry]);
    expect(vi.mocked(existsSync).mock.calls).not.toContainEqual([
      join(root, 'node_modules', 'vite', 'bin', 'vite.js')
    ]);
  });

  it('rejects an unstamped standalone runtime from a source checkout', () => {
    const root = makeSourceRoot();
    addArtifact(root, 'libexec/desk-standalone');

    expect(() => createServeLaunch(root, standaloneOptions, '/runtime/node')).toThrow(
      'Standalone runtime provenance is missing; run npm run build:standalone'
    );
  });

  it('launches an explicitly selected source standalone only when its provenance is current', () => {
    const root = makeSourceRoot();
    const standaloneEntry = addArtifact(root, 'libexec/desk-standalone');
    writeStandaloneBuildProvenance(
      standaloneEntry,
      computeRuntimeSourceFingerprint(root)
    );

    expect(createServeLaunch(root, standaloneOptions, '/runtime/node')).toMatchObject({
      command: standaloneEntry,
      args: []
    });
  });

  it('reports only the missing Vite artifact and asks for reinstall', () => {
    const root = makePackageRoot();
    addArtifact(root, 'libexec/desk-standalone');
    const viteEntry = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

    const message = thrownMessage(() => createServeLaunch(root, viteOptions, '/runtime/node'));

    // Assert the whole sentence, exactly, like the standalone sibling below.
    // The earlier `not.toMatch(/standalone|bun/i)` ran against the full message
    // — which embeds `viteEntry`, an absolute path under TMPDIR that the test
    // does not control. CI builds TMPDIR as `mktemp -d /var/tmp/desk-vitest.XXXXXX`,
    // so a run whose random suffix contained `bun` (or `standalone`) failed a
    // green codebase. The exact message is what the assertion means anyway, and
    // it names only the Vite artifact, so it is strictly stronger and path-proof.
    expect(message).toBe(`Vite runtime is missing at ${viteEntry}; reinstall desk`);
    expectOnlyArtifactLookup(viteEntry);
  });

  it('reports only the missing standalone artifact and asks for reinstall', () => {
    const root = makePackageRoot();
    addArtifact(root, 'dist/cli/main.js');
    addArtifact(root, 'node_modules/vite/bin/vite.js');
    const standaloneEntry = join(root, 'libexec', 'desk-standalone');

    const message = thrownMessage(() => createServeLaunch(root, standaloneOptions, '/runtime/node'));

    expect(message).toBe(`Standalone runtime is missing at ${standaloneEntry}; reinstall desk`);
    expect(vi.mocked(existsSync).mock.calls).toContainEqual([standaloneEntry]);
  });
});

describe('serve launch supervision', () => {
  it('rejects spawn errors without leaking signal listeners', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const missingRuntime = join(tmpdir(), `desk-missing-runtime-${process.pid}-${Date.now()}`);

    await expect(
      runServeLaunch({
        command: missingRuntime,
        args: [],
        cwd: tmpdir(),
        env: process.env,
        label: 'missing runtime'
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });
});
