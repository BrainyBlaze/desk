import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILE_LOCK = fileURLToPath(new URL('../src/shared/fileLock.ts', import.meta.url));
const STANDALONE_ENTRY = fileURLToPath(new URL('../src/server/standalone-entry.ts', import.meta.url));
const BUILD_STANDALONE = fileURLToPath(new URL('../scripts/build-standalone.ts', import.meta.url));
const SMOKE_SERVE_MODES = fileURLToPath(new URL('../scripts/smoke-serve-modes.mjs', import.meta.url));

describe('standalone build dependency contract', () => {
  it('loads proper-lockfile through a static runtime import', () => {
    const text = readFileSync(FILE_LOCK, 'utf8');
    const source = ts.createSourceFile(FILE_LOCK, text, ts.ScriptTarget.Latest, true);
    const runtimeBindings = source.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'proper-lockfile'
      ) {
        return [];
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        return [];
      }
      return bindings.elements
        .filter((binding) => !binding.isTypeOnly)
        .map((binding) => (binding.propertyName ?? binding.name).text);
    });

    expect(runtimeBindings).toEqual(expect.arrayContaining(['lock', 'lockSync']));
    expect(text).not.toContain("require('proper-lockfile')");
  });

  it('dynamically loads the private runtime and starts it immediately', () => {
    const text = readFileSync(STANDALONE_ENTRY, 'utf8');
    const source = ts.createSourceFile(STANDALONE_ENTRY, text, ts.ScriptTarget.Latest, true);
    const staticImports = source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : []
    );

    expect(staticImports).not.toContain('./standalone.js');
    expect(staticImports).not.toContain('./embeddedPlugins.js');
    expect(text).toContain("import('./standalone.js')");
    expect(text).toContain("import('./embeddedPlugins.js')");
    expect(text).toContain('await startStandalone({ plugins: embeddedPlugins });');
    expect(text).not.toContain('standaloneCommand');
    expect(text).not.toContain('runStandaloneCommand');
    expect(text).not.toContain('process.argv');
  });

  it('emits the compiled runtime only at the private libexec path', () => {
    const text = readFileSync(BUILD_STANDALONE, 'utf8');

    expect(text).toContain("resolve(root, 'libexec', 'desk-standalone')");
    expect(text).not.toContain(`resolve(root, 'desk-${'server'}')`);
  });

  it('isolates smoke tmux state and never kills an unverified descendant pid', () => {
    const text = readFileSync(SMOKE_SERVE_MODES, 'utf8');

    expect(text).toContain('TMUX_TMPDIR');
    expect(text).toContain('HOME: smokeHome');
    expect(text).toContain('delete childEnvironment.TMUX');
    expect(text).toContain('delete childEnvironment.DESK_PLUGINS');
    expect(text).not.toContain("process.kill(pid, 'SIGKILL')");
  });
});
