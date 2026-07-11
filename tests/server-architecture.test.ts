import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../src/server/', import.meta.url));

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

  it('does not install the retired direct terminal websocket', () => {
    const compositionRoot = readFileSync(join(SERVER_ROOT, 'vitePlugin.ts'), 'utf8');
    const terminalPrimitives = readFileSync(join(SERVER_ROOT, 'terminalBridge.ts'), 'utf8');

    expect(compositionRoot).not.toContain('installTerminalBridge');
    expect(terminalPrimitives).not.toContain("'/ws/terminal'");
  });

  it('centralizes global tmux option commands in one module', () => {
    const optionOwners = sourceFiles(SERVER_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes("'set-option', '-g'"))
      .map((file) => relative(SERVER_ROOT, file));

    expect(optionOwners).toEqual(['tmuxOptions.ts']);
  });
});
