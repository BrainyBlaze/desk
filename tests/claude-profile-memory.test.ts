import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  recordClaudeProfileMemorySyncFailure,
  syncClaudeProfileMemory
} from '../src/server/claudeProfileMemory.js';

const CWD = '/work/project';
const PROJECT_SLUG = '-work-project';

function memoryRoot(home: string, profileId: string): string {
  return join(
    home,
    '.config',
    'desk',
    'profiles',
    profileId,
    'projects',
    PROJECT_SLUG,
    'memory'
  );
}

function writeMemory(
  home: string,
  profileId: string,
  relativePath: string,
  content: string | Buffer
): string {
  const path = join(memoryRoot(home, profileId), relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('Claude profile memory branches', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(): { home: string; storeRoot: string } {
    root = mkdtempSync(join(tmpdir(), 'desk-claude-memory-'));
    const home = join(root, 'home');
    return {
      home,
      storeRoot: join(home, '.config', 'desk', 'continuity', 'claude-memory')
    };
  }

  it('propagates opaque memory files between profile branches through a project canonical', () => {
    const { home, storeRoot } = setup();
    writeMemory(home, 'source', 'MEMORY.md', '# Source memory');
    writeMemory(home, 'source', 'facts/binary.bin', Buffer.from([0, 255, 12, 4]));

    expect(
      syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'source', cwd: CWD })
        .conflicts
    ).toEqual([]);
    expect(
      syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'target', cwd: CWD })
        .conflicts
    ).toEqual([]);

    expect(readFileSync(join(memoryRoot(home, 'target'), 'MEMORY.md'), 'utf8')).toBe(
      '# Source memory'
    );
    expect(readFileSync(join(memoryRoot(home, 'target'), 'facts/binary.bin'))).toEqual(
      Buffer.from([0, 255, 12, 4])
    );
  });

  it('eventually exchanges independent files without overwriting either branch', () => {
    const { home, storeRoot } = setup();
    writeMemory(home, 'source', 'MEMORY.md', 'base');
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'source', cwd: CWD });
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'target', cwd: CWD });

    writeMemory(home, 'source', 'facts/source.md', 'from source');
    writeMemory(home, 'target', 'facts/target.md', 'from target');
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'source', cwd: CWD });
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'target', cwd: CWD });
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'source', cwd: CWD });

    expect(readFileSync(join(memoryRoot(home, 'source'), 'facts/target.md'), 'utf8')).toBe(
      'from target'
    );
    expect(readFileSync(join(memoryRoot(home, 'target'), 'facts/source.md'), 'utf8')).toBe(
      'from source'
    );
  });

  it('preserves the profile copy and all three versions when the same file diverges', () => {
    const { home, storeRoot } = setup();
    writeMemory(home, 'source', 'MEMORY.md', 'base');
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'source', cwd: CWD });
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'target', cwd: CWD });

    writeMemory(
      home,
      'source',
      'MEMORY.md',
      '---\noriginSessionId: source-session\n---\nsource'
    );
    syncClaudeProfileMemory({ homeDir: home, storeRoot, profileId: 'source', cwd: CWD });
    writeMemory(
      home,
      'target',
      'MEMORY.md',
      '---\noriginSessionId: target-session\n---\ntarget'
    );

    const result = syncClaudeProfileMemory({
      homeDir: home,
      storeRoot,
      profileId: 'target',
      cwd: CWD
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      relativePath: 'MEMORY.md',
      canonicalOriginSessionId: 'source-session',
      profileOriginSessionId: 'target-session'
    });
    expect(readFileSync(join(memoryRoot(home, 'target'), 'MEMORY.md'), 'utf8')).toContain(
      'target'
    );
    const conflictRoot = result.conflicts[0]?.recordPath;
    expect(conflictRoot).toBeTruthy();
    expect(readFileSync(join(conflictRoot!, 'base'), 'utf8')).toBe('base');
    expect(readFileSync(join(conflictRoot!, 'canonical'), 'utf8')).toContain('source');
    expect(readFileSync(join(conflictRoot!, 'profile'), 'utf8')).toContain('target');
  });

  it('reports an unsafe profile artifact without following it or blocking synchronization', () => {
    const { home, storeRoot } = setup();
    const external = join(root, 'outside');
    writeFileSync(external, 'secret');
    const memory = memoryRoot(home, 'source');
    mkdirSync(memory, { recursive: true });
    symlinkSync(external, join(memory, 'linked'));

    const result = syncClaudeProfileMemory({
      homeDir: home,
      storeRoot,
      profileId: 'source',
      cwd: CWD
    });

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        relativePath: 'linked',
        reason: 'unsafe-profile-artifact'
      })
    ]);
    expect(existsSync(join(memory, 'linked'))).toBe(true);
    expect(readdirSync(join(storeRoot, 'projects', PROJECT_SLUG, 'canonical', 'files'))).toEqual(
      []
    );
  });

  it('persists a sync failure until the next successful branch synchronization', () => {
    const { home, storeRoot } = setup();
    const options = {
      homeDir: home,
      storeRoot,
      profileId: 'source',
      cwd: CWD
    };
    const statePath = join(
      storeRoot,
      'projects',
      PROJECT_SLUG,
      'branches',
      'source',
      'state.json'
    );

    recordClaudeProfileMemorySyncFailure(options, new Error('disk unavailable'));
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      conflictIds: [],
      syncError: 'disk unavailable'
    });

    syncClaudeProfileMemory(options);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).not.toHaveProperty('syncError');
  });
});
