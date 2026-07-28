import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpec } from '../../src/core/types.js';
import {
  executeClaudeProfileHandoff,
  requiresClaudeProfileHandoff
} from '../../src/server/claudeProfileContinuity.js';
import { profileRoot } from '../../src/shared/agentProfiles.js';

const PROVIDER_SESSION_ID = '11111111-2222-4333-8444-555555555555';

function spec(profileId: string): SessionSpec {
  return {
    groupId: 'g',
    groupLabel: 'G',
    projectId: 'p',
    projectLabel: 'P',
    name: 'chat',
    cwd: '/work/repo',
    agent: 'claude',
    sessionId: 'desk-chat',
    command: 'claude',
    uiMode: 'terminal',
    profileId,
    resume: PROVIDER_SESSION_ID
  };
}

describe('Claude profile handoff lifecycle', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'desk-claude-handoff-'));
    const transcript = join(
      profileRoot('source', homeDir),
      'projects',
      '-work-repo',
      `${PROVIDER_SESSION_ID}.jsonl`
    );
    mkdirSync(join(transcript, '..'), { recursive: true });
    writeFileSync(transcript, 'conversation');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('recognizes only a same-conversation Claude profile change', () => {
    expect(requiresClaudeProfileHandoff(spec('source'), spec('target'))).toBe(true);
    expect(requiresClaudeProfileHandoff(spec('source'), spec('source'))).toBe(false);
    expect(
      requiresClaudeProfileHandoff(
        spec('source'),
        { ...spec('target'), resume: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
      )
    ).toBe(false);
    expect(
      requiresClaudeProfileHandoff(
        { ...spec('source'), agent: 'codex' },
        { ...spec('target'), agent: 'codex' }
      )
    ).toBe(false);
  });

  it('retires, prepares, commits, and starts in that order for a running session', async () => {
    const order: string[] = [];
    const result = await executeClaudeProfileHandoff({
      oldSpec: spec('source'),
      newSpec: spec('target'),
      homeDir,
      wasRunning: true,
      syncMemory: ({ profileId }) => {
        order.push(`memory-${profileId}`);
        return { profileId, projectSlug: '-work-repo', conflicts: [] };
      },
      retire: async () => {
        order.push('retire');
        return { ok: true };
      },
      commit: () => {
        order.push('commit');
      },
      startTarget: async () => {
        order.push('start-target');
        return { ok: true };
      },
      restoreSource: vi.fn(async () => ({ ok: true })),
      onPrepared: () => {
        order.push('prepare');
      }
    });

    expect(result).toEqual({ ok: true, committed: true });
    expect(order).toEqual([
      'retire',
      'memory-source',
      'memory-target',
      'prepare',
      'commit',
      'start-target'
    ]);
  });

  it('restores the source and never commits when preparation fails', async () => {
    const order: string[] = [];
    const commit = vi.fn();
    const startTarget = vi.fn(async () => ({ ok: true }));
    const restoreSource = vi.fn(async () => {
      order.push('restore-source');
      return { ok: true };
    });
    const targetTranscript = join(
      profileRoot('target', homeDir),
      'projects',
      '-work-repo',
      `${PROVIDER_SESSION_ID}.jsonl`
    );
    mkdirSync(join(targetTranscript, '..'), { recursive: true });
    writeFileSync(targetTranscript, 'divergent', { flag: 'wx' });

    const result = await executeClaudeProfileHandoff({
      oldSpec: spec('source'),
      newSpec: spec('target'),
      homeDir,
      wasRunning: true,
      retire: async () => {
        order.push('retire');
        return { ok: true };
      },
      commit,
      startTarget,
      restoreSource
    });

    expect(result.ok).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toContain('continuity-session-conflict');
    expect(order).toEqual(['retire', 'restore-source']);
    expect(commit).not.toHaveBeenCalled();
    expect(startTarget).not.toHaveBeenCalled();
  });

  it('rolls back prepared links when the manifest commit is rejected', async () => {
    const sourceTranscript = join(
      profileRoot('source', homeDir),
      'projects',
      '-work-repo',
      `${PROVIDER_SESSION_ID}.jsonl`
    );
    const targetTranscript = join(
      profileRoot('target', homeDir),
      'projects',
      '-work-repo',
      `${PROVIDER_SESSION_ID}.jsonl`
    );
    mkdirSync(join(targetTranscript, '..'), { recursive: true });
    writeFileSync(targetTranscript, 'conversation');
    const originalTargetInode = statSync(targetTranscript).ino;
    const storeTranscript = join(
      homeDir,
      '.config',
      'desk',
      'continuity',
      'claude',
      'sessions',
      PROVIDER_SESSION_ID,
      'files',
      'projects',
      '-work-repo',
      `${PROVIDER_SESSION_ID}.jsonl`
    );
    const restoreSource = vi.fn(async () => ({ ok: true }));

    const result = await executeClaudeProfileHandoff({
      oldSpec: spec('source'),
      newSpec: spec('target'),
      homeDir,
      wasRunning: true,
      retire: async () => ({ ok: true }),
      commit: () => {
        throw new Error('manifest-changed-concurrently');
      },
      startTarget: vi.fn(async () => ({ ok: true })),
      restoreSource
    });

    expect(result).toEqual({
      ok: false,
      committed: false,
      error: 'manifest-changed-concurrently'
    });
    expect(restoreSource).toHaveBeenCalledOnce();
    expect(readFileSync(sourceTranscript, 'utf8')).toBe('conversation');
    expect(readFileSync(targetTranscript, 'utf8')).toBe('conversation');
    expect(statSync(targetTranscript).ino).toBe(originalTargetInode);
    expect(statSync(targetTranscript).ino).not.toBe(statSync(sourceTranscript).ino);
    expect(existsSync(storeTranscript)).toBe(false);
  });

  it('prepares and commits a stopped session without starting it', async () => {
    const order: string[] = [];
    const retire = vi.fn(async () => ({ ok: true }));
    const startTarget = vi.fn(async () => ({ ok: true }));
    const restoreSource = vi.fn(async () => ({ ok: true }));

    const result = await executeClaudeProfileHandoff({
      oldSpec: spec('source'),
      newSpec: spec('target'),
      homeDir,
      wasRunning: false,
      retire,
      commit: () => {
        order.push('commit');
      },
      startTarget,
      restoreSource,
      onPrepared: () => {
        order.push('prepare');
      }
    });

    expect(result).toEqual({ ok: true, committed: true });
    expect(order).toEqual(['prepare', 'commit']);
    expect(retire).not.toHaveBeenCalled();
    expect(startTarget).not.toHaveBeenCalled();
    expect(restoreSource).not.toHaveBeenCalled();
  });

  it('does not resurrect the old profile after the manifest committed', async () => {
    const restoreSource = vi.fn(async () => ({ ok: true }));
    const result = await executeClaudeProfileHandoff({
      oldSpec: spec('source'),
      newSpec: spec('target'),
      homeDir,
      wasRunning: true,
      retire: async () => ({ ok: true }),
      commit: () => undefined,
      startTarget: async () => ({ ok: false, error: 'attach failed' }),
      restoreSource
    });

    expect(result).toEqual({ ok: false, committed: true, error: 'attach failed' });
    expect(restoreSource).not.toHaveBeenCalled();
  });

  it('reports memory synchronization failures without blocking the profile handoff', async () => {
    const startTarget = vi.fn(async () => ({ ok: true }));
    const result = await executeClaudeProfileHandoff({
      oldSpec: spec('source'),
      newSpec: spec('target'),
      homeDir,
      wasRunning: true,
      syncMemory: ({ profileId }) => {
        if (profileId === 'source') throw new Error('memory store unavailable');
        return { profileId, projectSlug: '-work-repo', conflicts: [] };
      },
      retire: async () => ({ ok: true }),
      commit: () => undefined,
      startTarget,
      restoreSource: vi.fn(async () => ({ ok: true }))
    });

    expect(result).toEqual({
      ok: true,
      committed: true,
      memoryWarnings: ['source: memory store unavailable']
    });
    expect(startTarget).toHaveBeenCalledOnce();
  });
});
