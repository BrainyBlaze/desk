import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILE_LOCK = new URL('../src/shared/fileLock.ts', import.meta.url);

describe('standalone build dependency contract', () => {
  it('loads proper-lockfile through a static runtime import', () => {
    const text = readFileSync(FILE_LOCK, 'utf8');
    const source = ts.createSourceFile(FILE_LOCK.pathname, text, ts.ScriptTarget.Latest, true);
    const runtimeImports = source.statements.filter(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        !statement.importClause?.isTypeOnly &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === 'proper-lockfile'
    );

    expect(runtimeImports).toHaveLength(1);
    expect(text).not.toContain("require('proper-lockfile')");
  });
});
