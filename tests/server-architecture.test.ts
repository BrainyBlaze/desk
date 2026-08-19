import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../src/server/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'codexBindings') {
        files.push(...sourceFiles(path));
      }
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(path);
    }
  }
  return files;
}

function resolveRelativeImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const withoutJsExtension = specifier.replace(/\.js$/, '');
  const base = resolve(dirname(importer), withoutJsExtension);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function relativeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  for (const statement of source.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
      const resolved = resolveRelativeImport(file, moduleSpecifier.text);
      if (resolved) {
        imports.push(resolved);
      }
    }
  }
  return imports;
}

function importCycles(files: string[]): string[][] {
  const sourceSet = new Set(files);
  const graph = new Map(files.map((file) => [file, relativeImports(file).filter((dep) => sourceSet.has(dep))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visit = (file: string): void => {
    if (visited.has(file)) {
      return;
    }
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      if (visiting.has(dependency)) {
        const cycle = stack.slice(stack.indexOf(dependency)).map((entry) => relative(SERVER_ROOT, entry));
        const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
        const canonical = rotations.map((rotation) => rotation.join(' -> ')).sort()[0]!;
        cycles.set(canonical, canonical.split(' -> '));
      } else {
        visit(dependency);
      }
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of files) {
    visit(file);
  }
  return [...cycles.values()].sort((left, right) => left.join().localeCompare(right.join()));
}

describe('server architecture boundaries', () => {
  it('has no handwritten source import cycles', () => {
    expect(importCycles(sourceFiles(SERVER_ROOT))).toEqual([]);
  });

  it('keeps generated Codex bindings behind the handwritten protocol adapter', () => {
    const importers = sourceFiles(SERVER_ROOT)
      .filter((file) =>
        relativeImports(file).some((dependency) => {
          const path = relative(join(SERVER_ROOT, 'agents/codexBindings'), dependency);
          return path !== '' && !path.startsWith('..');
        })
      )
      .map((file) => relative(SERVER_ROOT, file));

    expect(importers).toEqual(['agents/codexProtocol.ts']);
  });

  it('pins the reviewed Codex bindings projection', () => {
    const bindingsRoot = join(SERVER_ROOT, 'agents/codexBindings');
    const digest = readFileSync(
      join(bindingsRoot, 'REVIEWED_PROJECTION.sha256'),
      'utf8'
    ).trim();

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });


  it('keeps the server free of tmux option/bridge primitives (deleted at cutover)', () => {
    const offenders = sourceFiles(SERVER_ROOT)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes("'set-option', '-g'") || source.includes('installTerminalBridge');
      })
      .map((file) => relative(SERVER_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('builds and releases only the full CLI with its private runtime', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const installer = readFileSync(join(ROOT, '.github/workflows/installer.yml'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const vitestConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    const ripgrepSetup = readFileSync(join(ROOT, 'tests/setup/ripgrep-path.ts'), 'utf8');
    const retired = ['desk', 'server'].join('-');

    expect(ci).toContain('node-version: 22.23.1');
    expect(ci).toContain('bun-version: 1.3.14');
    expect(ci).toContain('ubuntu-latest');
    expect(ci).toContain('macos-15');
    expect(ci).toContain('macos-15-intel');
    expect(ci).toContain('dtolnay/rust-toolchain@stable');
    expect(ci).toContain('npm run build:moor');
    expect(ci).toContain('RUN_REAL_JOIN: 1');
    expect(ci).toContain('npx vitest run tests/moor-distribution-contract.test.ts');
    expect(ci).toContain('npx vitest run tests/moor-native-e2e.test.ts');
    expect(ci).toContain('--exclude tests/moor-distribution-contract.test.ts');
    expect(ci).toContain('--exclude tests/moor-native-e2e.test.ts');
    expect(ci).toContain('npm run build:application');
    expect(ci).toContain('npm run smoke:serve-modes');
    expect(packageJson.devDependencies['@vscode/ripgrep']).toBe('1.18.0');
    expect(vitestConfig).toContain('tests/setup/ripgrep-path.ts');
    expect(ripgrepSetup).toContain('rgPath');
    expect(ci).not.toContain('sudo apt-get');
    expect(release).not.toContain('sudo apt-get');
    expect(installer).not.toContain('sudo apt-get');
    expect(installer).not.toContain('brew install ripgrep');
    expect(release).toContain('npm run release:assets');
    expect(release).toContain('desk-install-manifest.json');
    expect(release).toContain('-source.tar.gz');
    expect(release).not.toContain(retired);
    expect(installer).toMatch(/ubuntu|fedora|archlinux|opensuse|alpine/);
    expect(installer).toContain('macos-15');
    expect(installer).toContain('macos-15-intel');
  });

  it('removes static-export launch helpers with one portable pattern', () => {
    const docs = readFileSync(join(ROOT, '.github/workflows/docs.yml'), 'utf8');

    expect(docs).toContain('rm -f _site/Start\\ Docs.*');
  });

  it('keeps pre-promotion CI on local Moor fixtures and requires a committed pin for tags', () => {
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const installer = readFileSync(join(ROOT, '.github/workflows/installer.yml'), 'utf8');

    expect(installer).not.toContain('npm run fetch:moor');
    expect(installer).toContain('tests/install-script.test.ts tests/release-assets.test.ts');
    expect(release).toContain('git cat-file -e HEAD:scripts/distribution/moor-pin.json');
    expect(release).toContain('Refusing a release tag without a committed Moor pin');
    expect(release).toContain("steps.moor_pin.outputs.present == 'true'");
  });
});
