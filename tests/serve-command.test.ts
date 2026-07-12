import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createServeLaunch,
  findPackageRoot,
  parseServeOptions,
  type ServeOptions
} from '../src/cli/serveCommand.js';

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

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('parseServeOptions', () => {
  it('defaults to Vite on the loopback host and port 5173', () => {
    expect(parseServeOptions([], {})).toEqual({
      mode: 'vite',
      host: '127.0.0.1',
      port: 5173
    });
  });

  it('treats --standalone as a boolean flag', () => {
    expect(parseServeOptions(['--standalone', '--port', '6000'], {})).toEqual({
      mode: 'standalone',
      host: '127.0.0.1',
      port: 6000
    });
  });

  it('accepts serve flags in any order', () => {
    expect(parseServeOptions(['--port', '6000', '--host', '0.0.0.0', '--standalone'], {})).toEqual({
      mode: 'standalone',
      host: '0.0.0.0',
      port: 6000
    });
  });

  it('uses environment defaults when flags are absent', () => {
    expect(parseServeOptions([], { DESK_HOST: '0.0.0.0', DESK_PORT: '7000' })).toEqual({
      mode: 'vite',
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
    ).toEqual({ mode: 'vite', host: 'localhost', port: 6000 });
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

  it('rejects unexpected positional arguments', () => {
    expect(() => parseServeOptions(['--standalone', 'true'], {})).toThrow('unexpected argument true');
  });
});

describe('serve launch planning', () => {
  const viteOptions: ServeOptions = { mode: 'vite', host: '127.0.0.1', port: 5173 };
  const standaloneOptions: ServeOptions = { mode: 'standalone', host: '0.0.0.0', port: 6000 };

  it('finds a package root from a nested module URL', () => {
    const root = makePackageRoot();
    writeFileSync(join(root, 'vite.config.ts'), '');
    const nestedModule = addArtifact(root, 'dist/cli/main.js');

    expect(findPackageRoot(pathToFileURL(nestedModule).href)).toBe(root);
  });

  it('selects the Vite JavaScript entry with strict port handling', () => {
    const root = makePackageRoot();
    const viteEntry = addArtifact(root, 'node_modules/vite/bin/vite.js');

    expect(createServeLaunch(root, viteOptions, '/runtime/node')).toMatchObject({
      command: '/runtime/node',
      args: [viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
      cwd: root
    });
  });

  it('selects the private standalone executable and passes host and port through the environment', () => {
    const root = makePackageRoot();
    const standaloneEntry = addArtifact(root, 'libexec/desk-standalone');
    const parentEnv = { KEEP_ME: 'yes' };

    expect(createServeLaunch(root, standaloneOptions, '/runtime/node', parentEnv)).toMatchObject({
      command: standaloneEntry,
      args: [],
      cwd: root,
      env: { KEEP_ME: 'yes', DESK_HOST: '0.0.0.0', DESK_PORT: '6000' }
    });
  });

  it('reports only the missing Vite artifact and asks for reinstall', () => {
    const root = makePackageRoot();
    addArtifact(root, 'libexec/desk-standalone');

    const message = thrownMessage(() => createServeLaunch(root, viteOptions, '/runtime/node'));

    expect(message).toMatch(/vite.*reinstall/i);
    expect(message).not.toMatch(/standalone|bun/i);
  });

  it('reports only the missing standalone artifact and asks for reinstall', () => {
    const root = makePackageRoot();
    addArtifact(root, 'node_modules/vite/bin/vite.js');

    const message = thrownMessage(() => createServeLaunch(root, standaloneOptions, '/runtime/node'));

    expect(message).toMatch(/standalone.*reinstall/i);
    expect(message).not.toMatch(/vite/i);
  });
});
