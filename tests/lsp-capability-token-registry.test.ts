import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLspCapabilityTokenRegistry } from '../src/server/lsp/capabilityTokenRegistry';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-token-root-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createLspCapabilityTokenRegistry', () => {
  it('mints non-repeating high-entropy tokens bound to the real workspace root', async () => {
    const registry = createLspCapabilityTokenRegistry();
    const first = registry.mint(root);
    const second = registry.mint(root);
    const realRoot = await realpath(root);

    expect(first.workspaceRoot).toBe(realRoot);
    expect(second.workspaceRoot).toBe(realRoot);
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(registry.resolve(first.token)).toEqual({ workspaceRoot: realRoot });
    expect(registry.resolve(second.token)).toEqual({ workspaceRoot: realRoot });
  });

  it('rejects missing or non-directory workspace roots before minting', () => {
    const registry = createLspCapabilityTokenRegistry();
    const filePath = join(root, 'file.txt');
    writeFileSync(filePath, 'not a directory');

    expect(() => registry.mint(join(root, 'missing'))).toThrow(/existing directory/i);
    expect(() => registry.mint(filePath)).toThrow(/existing directory/i);
  });

  it('revokes individual tokens and dispose clears every token', () => {
    const registry = createLspCapabilityTokenRegistry();
    const first = registry.mint(root);
    const second = registry.mint(root);

    registry.revoke(first.token);
    expect(registry.resolve(first.token)).toBeUndefined();
    expect(registry.resolve(second.token)).toBeDefined();

    registry.dispose();
    expect(registry.resolve(second.token)).toBeUndefined();
  });
});
