import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyResumeToManifest,
  findOpencodeResume,
  isValidResumeId,
  isValidResumeIdForAgent,
  parseRolloutMeta
} from '../src/server/resumeCapture.js';
import {
  readPendingResumeCaptures,
  removePendingResumeCapture,
  upsertPendingResumeCapture
} from '../src/core/resumeCaptureState.js';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';

const manifestSource = `
projects:
  - id: demo
    cwd: /workspace/projects/demo
    groups:
      - id: main
        sessions:
          - { name: fresh, agent: codex }
          - { name: resumed, agent: codex, resume: 11111111-aaaa-7000-8000-000000000001 }
          - { name: open, agent: opencode }
`;

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('parseRolloutMeta', () => {
  it('extracts id + cwd from a session_meta line', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { id: 'abc-123', cwd: '/x', extra: 1 } });
    expect(parseRolloutMeta(line)).toEqual({ id: 'abc-123', cwd: '/x' });
  });

  it('rejects other records and garbage', () => {
    expect(parseRolloutMeta('{"type":"turn","payload":{}}')).toBeNull();
    expect(parseRolloutMeta('not json')).toBeNull();
  });
});

describe('applyResumeToManifest', () => {
  const homeDir = '/workspace';

  it('sets resume and pins the current tmux name', () => {
    const manifest = parseDeskManifest(manifestSource);
    const fresh = buildSessionSpecs(manifest, { homeDir }).find((s) => s.name === 'fresh')!;
    expect(fresh.resume).toBeUndefined();

    const updated = applyResumeToManifest(manifest, fresh.tmuxSession, '019eaaaa-bbbb-7000-8000-000000000002', homeDir);
    expect(updated).not.toBeNull();
    const session = updated!.projects![0]!.groups[0]!.sessions.find((s) => s.name === 'fresh')!;
    expect(session.resume).toBe('019eaaaa-bbbb-7000-8000-000000000002');
    expect(session.tmuxSession).toBe(fresh.tmuxSession);

    // The rebuilt spec must keep the SAME tmux name (pin works) and gain the resume.
    const rebuilt = buildSessionSpecs(updated!, { homeDir }).find((s) => s.name === 'fresh')!;
    expect(rebuilt.tmuxSession).toBe(fresh.tmuxSession);
    expect(rebuilt.resume).toBe('019eaaaa-bbbb-7000-8000-000000000002');
    expect(rebuilt.command).toContain("resume '019eaaaa-bbbb-7000-8000-000000000002'");
  });

  it('does not touch sessions that already have a resume', () => {
    const manifest = parseDeskManifest(manifestSource);
    const resumed = buildSessionSpecs(manifest, { homeDir }).find((s) => s.name === 'resumed')!;
    expect(applyResumeToManifest(manifest, resumed.tmuxSession, 'zzz', homeDir)).toBeNull();
  });

  it('refuses ids already claimed by another session', () => {
    const manifest = parseDeskManifest(manifestSource);
    const fresh = buildSessionSpecs(manifest, { homeDir }).find((s) => s.name === 'fresh')!;
    expect(applyResumeToManifest(manifest, fresh.tmuxSession, '11111111-aaaa-7000-8000-000000000001', homeDir)).toBeNull();
  });

  it('rejects non-UUID resume ids (manifest/shell injection guard)', () => {
    const manifest = parseDeskManifest(manifestSource);
    const fresh = buildSessionSpecs(manifest, { homeDir }).find((s) => s.name === 'fresh')!;
    for (const evil of ["'; rm -rf / #", 'abc', '../../etc/passwd', '019eb151-8bf0-7bb2-96bc-8958725d5974x']) {
      expect(applyResumeToManifest(manifest, fresh.tmuxSession, evil, homeDir)).toBeNull();
    }
    expect(isValidResumeId('019eb151-8bf0-7bb2-96bc-8958725d5974')).toBe(true);
    expect(isValidResumeId("'; touch /tmp/pwn'")).toBe(false);
  });

  it('accepts OpenCode ses_ ids only for OpenCode sessions', () => {
    const manifest = parseDeskManifest(manifestSource);
    const open = buildSessionSpecs(manifest, { homeDir }).find((s) => s.name === 'open')!;
    const codex = buildSessionSpecs(manifest, { homeDir }).find((s) => s.name === 'fresh')!;
    const resume = 'ses_12a31855dffeHTCs6tcfOmsddP';

    expect(isValidResumeIdForAgent('opencode', resume)).toBe(true);
    expect(isValidResumeIdForAgent('codex', resume)).toBe(false);
    expect(isValidResumeIdForAgent('opencode', "ses_12a31855dffeHTCs6tcfOmsddP'; touch /tmp/pwn")).toBe(false);

    const updated = applyResumeToManifest(manifest, open.tmuxSession, resume, homeDir);
    expect(updated).not.toBeNull();
    const session = updated!.projects![0]!.groups[0]!.sessions.find((s) => s.name === 'open')!;
    expect(session.resume).toBe(resume);
    expect(session.tmuxSession).toBe(open.tmuxSession);
    expect(applyResumeToManifest(manifest, codex.tmuxSession, resume, homeDir)).toBeNull();
  });

  it('returns null for unknown tmux sessions', () => {
    const manifest = parseDeskManifest(manifestSource);
    expect(applyResumeToManifest(manifest, 'nope', 'id', homeDir)).toBeNull();
  });
});

describe('opencode resume capture writeback', () => {
  it('fails closed when capture has no launch timestamp metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-opencode-capture-'));
    try {
      const cwd = join(root, 'project');
      mkdirSync(cwd);
      const stubPath = join(root, 'opencode-stub.js');
      writeFileSync(
        stubPath,
        `#!/usr/bin/env node
if (process.argv[2] === 'session' && process.argv[3] === 'list') {
  process.stdout.write(JSON.stringify([
    { id: 'ses_12a31855dffeHTCs6tcfOmsddP', title: 'old', created: 1000, updated: 9000, projectId: 'global', directory: ${JSON.stringify(cwd)} }
  ]));
}
`
      );
      chmodSync(stubPath, 0o755);
      process.env = {
        ...originalEnv,
        HOME: root,
        DESK_OPENCODE_BIN: stubPath
      };

      await expect(findOpencodeResume(cwd)).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pending resume capture state', () => {
  it('persists, updates, and removes pending capture metadata by tmux session', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-resume-capture-state-'));
    try {
      const statePath = join(root, 'captures.json');
      upsertPendingResumeCapture(
        {
          tmuxSession: 'desk-open',
          agent: 'opencode',
          cwd: '/repo',
          sinceMs: 1000,
          deadlineMs: 2000,
          launchResumeId: 'ses_12a31855dffeHTCs6tcfOmsddP'
        },
        { path: statePath }
      );
      upsertPendingResumeCapture(
        {
          tmuxSession: 'desk-open',
          agent: 'opencode',
          cwd: '/repo',
          sinceMs: 3000,
          deadlineMs: 4000
        },
        { path: statePath }
      );

      expect(readPendingResumeCaptures({ path: statePath })).toEqual([
        {
          tmuxSession: 'desk-open',
          agent: 'opencode',
          cwd: '/repo',
          sinceMs: 3000,
          deadlineMs: 4000
        }
      ]);

      removePendingResumeCapture('desk-open', { path: statePath });
      expect(readPendingResumeCaptures({ path: statePath })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
