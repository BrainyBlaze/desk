import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeContinuityError,
  confirmClaudeSessionStart,
  prepareClaudeSessionHandoff,
  prepareClaudeSessionStart
} from '../src/server/claudeProfileContinuity.js';

const PROVIDER_SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROJECT_SLUG = '-work-repo';

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('Claude profile continuity', () => {
  let root: string;
  let sourceRoot: string;
  let targetRoot: string;
  let storeRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-claude-continuity-'));
    sourceRoot = join(root, 'source');
    targetRoot = join(root, 'target');
    storeRoot = join(root, 'store');
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('hardlinks only the selected session envelope and leaves profile-local state alone', () => {
    const transferred = [
      `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`,
      `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/subagents/agent.jsonl`,
      `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/tool-results/result.txt`,
      `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/workflows/flow.json`,
      `file-history/${PROVIDER_SESSION_ID}/checkpoint.txt`,
      `file-history/${PROVIDER_SESSION_ID}/.highwatermark`,
      `tasks/${PROVIDER_SESSION_ID}/1.json`,
      `tasks/${PROVIDER_SESSION_ID}/.highwatermark`
    ];
    for (const relativePath of transferred) {
      write(sourceRoot, relativePath, `source:${relativePath}`);
    }
    write(sourceRoot, `projects/${PROJECT_SLUG}/${OTHER_SESSION_ID}.jsonl`, 'other session');
    write(sourceRoot, `session-env/${PROVIDER_SESSION_ID}/secret`, 'SECRET=source');
    write(sourceRoot, 'bridge-pointer.json', '{"source":true}');
    write(sourceRoot, '.credentials.json', '{"token":"source"}');
    write(targetRoot, 'bridge-pointer.json', '{"target":true}');
    write(targetRoot, '.credentials.json', '{"token":"target"}');

    const result = prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });

    expect([...result.relativePaths].sort()).toEqual([...transferred].sort());
    for (const relativePath of transferred) {
      const source = join(sourceRoot, relativePath);
      const target = join(targetRoot, relativePath);
      const stored = join(storeRoot, 'sessions', PROVIDER_SESSION_ID, 'files', relativePath);
      expect(readFileSync(target, 'utf8')).toBe(`source:${relativePath}`);
      expect(statSync(target).ino).toBe(statSync(source).ino);
      expect(statSync(stored).ino).toBe(statSync(source).ino);
    }
    expect(readFileSync(join(targetRoot, 'bridge-pointer.json'), 'utf8')).toBe('{"target":true}');
    expect(readFileSync(join(targetRoot, '.credentials.json'), 'utf8')).toBe('{"token":"target"}');
    expect(() => statSync(join(targetRoot, 'session-env', PROVIDER_SESSION_ID, 'secret'))).toThrow();
    expect(() => statSync(join(targetRoot, 'projects', PROJECT_SLUG, `${OTHER_SESSION_ID}.jsonl`))).toThrow();
  });

  it('rejects an unknown session companion subtree before mutating the target', () => {
    write(sourceRoot, `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`, 'transcript');
    write(
      sourceRoot,
      `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/mystery/data.json`,
      'unknown'
    );

    expect(() =>
      prepareClaudeSessionHandoff({
        sourceRoot,
        targetRoot,
        storeRoot,
        cwd: '/work/repo',
        providerSessionId: PROVIDER_SESSION_ID,
        sourceProfileId: 'source',
        targetProfileId: 'target'
      })
    ).toThrowError(
      expect.objectContaining<Partial<ClaudeContinuityError>>({
        code: 'continuity-unknown-artifact',
        relativePath: `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/mystery`
      })
    );
    expect(existsSync(join(targetRoot, 'projects'))).toBe(false);
    expect(existsSync(join(storeRoot, 'sessions'))).toBe(false);
  });

  it('rejects symlinks inside an allowed session directory', () => {
    write(sourceRoot, `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`, 'transcript');
    const outside = write(root, 'outside.txt', 'outside');
    const link = join(
      sourceRoot,
      'projects',
      PROJECT_SLUG,
      PROVIDER_SESSION_ID,
      'tool-results',
      'link.txt'
    );
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(outside, link);

    expect(() =>
      prepareClaudeSessionHandoff({
        sourceRoot,
        targetRoot,
        storeRoot,
        cwd: '/work/repo',
        providerSessionId: PROVIDER_SESSION_ID,
        sourceProfileId: 'source',
        targetProfileId: 'target'
      })
    ).toThrowError(
      expect.objectContaining<Partial<ClaudeContinuityError>>({
        code: 'continuity-unsafe-file',
        relativePath: `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/tool-results/link.txt`
      })
    );
    expect(existsSync(join(targetRoot, 'projects'))).toBe(false);
  });

  it('requires the exact transcript before accepting companion artifacts', () => {
    write(
      sourceRoot,
      `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/subagents/agent.jsonl`,
      'orphan'
    );

    expect(() =>
      prepareClaudeSessionHandoff({
        sourceRoot,
        targetRoot,
        storeRoot,
        cwd: '/work/repo',
        providerSessionId: PROVIDER_SESSION_ID,
        sourceProfileId: 'source',
        targetProfileId: 'target'
      })
    ).toThrowError(
      expect.objectContaining<Partial<ClaudeContinuityError>>({
        code: 'continuity-missing-transcript'
      })
    );
    expect(existsSync(join(targetRoot, 'projects'))).toBe(false);
  });

  it('blocks divergent target state without overwriting it', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    write(sourceRoot, relativePath, 'source transcript');
    const target = write(targetRoot, relativePath, 'target transcript');

    expect(() =>
      prepareClaudeSessionHandoff({
        sourceRoot,
        targetRoot,
        storeRoot,
        cwd: '/work/repo',
        providerSessionId: PROVIDER_SESSION_ID,
        sourceProfileId: 'source',
        targetProfileId: 'target'
      })
    ).toThrowError(
      expect.objectContaining<Partial<ClaudeContinuityError>>({
        code: 'continuity-session-conflict',
        relativePath
      })
    );
    expect(readFileSync(target, 'utf8')).toBe('target transcript');
    expect(existsSync(join(storeRoot, 'sessions'))).toBe(false);
  });

  it('blocks an extra target artifact for the same session UUID', () => {
    const transcript = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const extra = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}/subagents/target-only.jsonl`;
    write(sourceRoot, transcript, 'same transcript');
    write(targetRoot, transcript, 'same transcript');
    write(targetRoot, extra, 'target-only state');

    expect(() =>
      prepareClaudeSessionHandoff({
        sourceRoot,
        targetRoot,
        storeRoot,
        cwd: '/work/repo',
        providerSessionId: PROVIDER_SESSION_ID,
        sourceProfileId: 'source',
        targetProfileId: 'target'
      })
    ).toThrowError(
      expect.objectContaining<Partial<ClaudeContinuityError>>({
        code: 'continuity-session-conflict',
        relativePath: extra
      })
    );
    expect(readFileSync(join(targetRoot, extra), 'utf8')).toBe('target-only state');
    expect(existsSync(join(storeRoot, 'sessions'))).toBe(false);
  });

  it('deduplicates a byte-identical target copy onto the source inode', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const source = write(sourceRoot, relativePath, 'same transcript');
    const target = write(targetRoot, relativePath, 'same transcript');
    expect(statSync(target).ino).not.toBe(statSync(source).ino);

    prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });

    expect(statSync(target).ino).toBe(statSync(source).ino);
  });

  it('durably records the committed generation and its artifact hashes', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    write(sourceRoot, relativePath, 'conversation');

    prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });

    const sessionRoot = join(storeRoot, 'sessions', PROVIDER_SESSION_ID);
    const generation = JSON.parse(readFileSync(join(sessionRoot, 'generation.json'), 'utf8')) as {
      generationId: string;
      policyVersion: number;
      providerSessionId: string;
      sourceProfileId: string;
      targetProfileId: string;
      artifacts: Array<{ relativePath: string; size: number; sha256: string }>;
    };
    const journal = JSON.parse(readFileSync(join(sessionRoot, 'journal.json'), 'utf8')) as {
      generationId: string;
      phase: string;
    };
    const commit = JSON.parse(readFileSync(join(sessionRoot, 'commit.json'), 'utf8')) as {
      generationId: string;
    };

    expect(generation).toMatchObject({
      policyVersion: 1,
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });
    expect(generation.artifacts).toEqual([
      expect.objectContaining({
        relativePath,
        size: Buffer.byteLength('conversation'),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    expect(journal).toEqual(
      expect.objectContaining({ generationId: generation.generationId, phase: 'committed' })
    );
    expect(commit).toEqual(expect.objectContaining({ generationId: generation.generationId }));
  });

  it('rolls back partial links when materialization fails before commit', () => {
    const transcript = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const task = `tasks/${PROVIDER_SESSION_ID}/1.json`;
    write(sourceRoot, transcript, 'conversation');
    write(sourceRoot, task, 'task');
    writeFileSync(join(targetRoot, 'tasks'), 'blocks the target task directory');

    expect(() =>
      prepareClaudeSessionHandoff({
        sourceRoot,
        targetRoot,
        storeRoot,
        cwd: '/work/repo',
        providerSessionId: PROVIDER_SESSION_ID,
        sourceProfileId: 'source',
        targetProfileId: 'target'
      })
    ).toThrow();

    const sessionRoot = join(storeRoot, 'sessions', PROVIDER_SESSION_ID);
    expect(existsSync(join(targetRoot, transcript))).toBe(false);
    expect(existsSync(join(sessionRoot, 'files', transcript))).toBe(false);
    expect(existsSync(join(sessionRoot, 'commit.json'))).toBe(false);
  });

  it('recovers an interrupted pre-commit operation before retrying the handoff', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const source = write(sourceRoot, relativePath, 'conversation');
    const sessionRoot = join(storeRoot, 'sessions', PROVIDER_SESSION_ID);
    const crashedGenerationId = '99999999-8888-4777-8666-555555555555';
    const partialTarget = join(targetRoot, relativePath);
    const partialStore = join(sessionRoot, 'files', relativePath);
    const staleBackup = join(
      sessionRoot,
      'backups',
      crashedGenerationId,
      'target',
      relativePath
    );
    for (const path of [partialTarget, partialStore, staleBackup]) {
      mkdirSync(join(path, '..'), { recursive: true });
      linkSync(source, path);
    }
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(
      join(sessionRoot, 'journal.json'),
      JSON.stringify({
        policyVersion: 1,
        generationId: crashedGenerationId,
        providerSessionId: PROVIDER_SESSION_ID,
        projectSlug: PROJECT_SLUG,
        sourceProfileId: 'source',
        targetProfileId: 'target',
        phase: 'preparing',
        links: [
          { relativePath, destination: 'store', existed: false },
          { relativePath, destination: 'target', existed: false }
        ]
      })
    );

    const result = prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });

    expect(result.generationId).not.toBe(crashedGenerationId);
    expect(existsSync(join(sessionRoot, 'backups', crashedGenerationId))).toBe(false);
    expect(statSync(partialTarget).ino).toBe(statSync(source).ino);
    expect(statSync(partialStore).ino).toBe(statSync(source).ino);
  });

  it('validates the prior committed target when a cleaned session moves back to its source profile', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const source = write(sourceRoot, relativePath, 'conversation');
    prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });
    rmSync(source);

    const result = prepareClaudeSessionHandoff({
      sourceRoot: targetRoot,
      targetRoot: sourceRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'target',
      targetProfileId: 'source'
    });

    expect(result.relativePaths).toContain(relativePath);
    expect(readFileSync(join(sourceRoot, relativePath), 'utf8')).toBe('conversation');
  });

  it('restores a missing active-profile artifact from the committed store before start', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    write(sourceRoot, relativePath, 'conversation');
    prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });
    const target = join(targetRoot, relativePath);
    rmSync(target);

    const result = prepareClaudeSessionStart({
      homeDir: root,
      profileRoot: targetRoot,
      profileId: 'target',
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID
    });

    expect(result.managed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('conversation');
    expect(statSync(target).ino).toBe(
      statSync(join(storeRoot, 'sessions', PROVIDER_SESSION_ID, 'files', relativePath)).ino
    );
  });

  it('captures atomic-renamed active-profile files into a new generation before start', () => {
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    write(sourceRoot, relativePath, 'conversation');
    const first = prepareClaudeSessionHandoff({
      sourceRoot,
      targetRoot,
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });
    const target = join(targetRoot, relativePath);
    const replacement = `${target}.replacement`;
    writeFileSync(replacement, 'conversation after restart');
    renameSync(replacement, target);

    const result = prepareClaudeSessionStart({
      homeDir: root,
      profileRoot: targetRoot,
      profileId: 'target',
      storeRoot,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID
    });

    const stored = join(storeRoot, 'sessions', PROVIDER_SESSION_ID, 'files', relativePath);
    expect(result.managed).toBe(true);
    expect(result.generationId).not.toBe(first.generationId);
    expect(readFileSync(stored, 'utf8')).toBe('conversation after restart');
    expect(statSync(stored).ino).toBe(statSync(target).ino);
  });

  it('opens a generation only after an exact provider SessionStart and then removes stale source links', () => {
    const home = join(root, 'home');
    const source = join(home, '.config', 'desk', 'profiles', 'source');
    const target = join(home, '.config', 'desk', 'profiles', 'target');
    const continuityStore = join(home, '.config', 'desk', 'continuity', 'claude');
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const sourceTranscript = write(source, relativePath, 'conversation');
    mkdirSync(target, { recursive: true });
    prepareClaudeSessionHandoff({
      sourceRoot: source,
      targetRoot: target,
      storeRoot: continuityStore,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });

    prepareClaudeSessionStart({
      homeDir: home,
      profileRoot: target,
      profileId: 'target',
      storeRoot: continuityStore,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      deskSessionId: 'desk-chat'
    });
    const activationPath = join(
      continuityStore,
      'sessions',
      PROVIDER_SESSION_ID,
      'activation.json'
    );
    expect(JSON.parse(readFileSync(activationPath, 'utf8'))).toEqual(
      expect.objectContaining({ state: 'starting-unconfirmed', deskSessionId: 'desk-chat' })
    );

    const confirmed = confirmClaudeSessionStart({
      homeDir: home,
      storeRoot: continuityStore,
      deskSessionId: 'desk-chat',
      providerSessionId: PROVIDER_SESSION_ID
    });

    expect(confirmed).toEqual(
      expect.objectContaining({ ok: true, generationId: expect.any(String) })
    );
    expect(existsSync(sourceTranscript)).toBe(false);
    expect(JSON.parse(readFileSync(activationPath, 'utf8'))).toEqual(
      expect.objectContaining({ state: 'ready', deskSessionId: 'desk-chat' })
    );
  });

  it('preserves links and records needs-attention for a mismatched provider SessionStart', () => {
    const home = join(root, 'home');
    const source = join(home, '.config', 'desk', 'profiles', 'source');
    const target = join(home, '.config', 'desk', 'profiles', 'target');
    const continuityStore = join(home, '.config', 'desk', 'continuity', 'claude');
    const relativePath = `projects/${PROJECT_SLUG}/${PROVIDER_SESSION_ID}.jsonl`;
    const sourceTranscript = write(source, relativePath, 'conversation');
    mkdirSync(target, { recursive: true });
    prepareClaudeSessionHandoff({
      sourceRoot: source,
      targetRoot: target,
      storeRoot: continuityStore,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      sourceProfileId: 'source',
      targetProfileId: 'target'
    });
    prepareClaudeSessionStart({
      homeDir: home,
      profileRoot: target,
      profileId: 'target',
      storeRoot: continuityStore,
      cwd: '/work/repo',
      providerSessionId: PROVIDER_SESSION_ID,
      deskSessionId: 'desk-chat'
    });

    const confirmed = confirmClaudeSessionStart({
      homeDir: home,
      storeRoot: continuityStore,
      deskSessionId: 'desk-chat',
      providerSessionId: OTHER_SESSION_ID
    });

    expect(confirmed).toEqual(
      expect.objectContaining({ ok: false, code: 'continuity-resume-unconfirmed' })
    );
    expect(existsSync(sourceTranscript)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(continuityStore, 'sessions', PROVIDER_SESSION_ID, 'activation.json'),
          'utf8'
        )
      )
    ).toEqual(expect.objectContaining({ state: 'needs-attention' }));
  });

  it('accepts SessionStart when the Desk session has no managed activation', () => {
    const home = join(root, 'home');

    expect(
      confirmClaudeSessionStart({
        homeDir: home,
        storeRoot: join(home, '.config', 'desk', 'continuity', 'claude'),
        deskSessionId: 'ordinary-claude-session',
        providerSessionId: PROVIDER_SESSION_ID
      })
    ).toEqual({ ok: true, managed: false });
  });
});
