import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';
import { readPendingResumeCaptures } from '../src/core/resumeCaptureState.js';
import { prepareSessionForLaunch, runPlan } from '../src/core/runner.js';

const execFileAsync = promisify(execFile);
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('opencode launch resume fallback', () => {
  it('launches opencode with the single recent cwd session when resume is unset', async () => {
    const now = Date.now();
    const result = await runPreparedOpencodeCommandWithSessions([
      {
        id: 'ses_recent',
        title: 'recent',
        created: now - 2 * 60 * 60 * 1000,
        updated: now - 1000,
        projectId: 'global',
        directory: '__CWD__'
      },
      {
        id: 'ses_stale',
        title: 'stale',
        created: now - 10 * 24 * 60 * 60 * 1000,
        updated: now - 9 * 24 * 60 * 60 * 1000,
        projectId: 'global',
        directory: '__CWD__'
      }
    ]);

    expect(result.finalArgs).toEqual(['--session', 'ses_recent']);
    expect(result.command).not.toContain('node -e');
  });

  it('launches opencode fresh when recent cwd session fallback is ambiguous', async () => {
    const now = Date.now();
    const result = await runPreparedOpencodeCommandWithSessions([
      {
        id: 'ses_first',
        title: 'first',
        created: now - 5000,
        updated: now - 5000,
        projectId: 'global',
        directory: '__CWD__'
      },
      {
        id: 'ses_second',
        title: 'second',
        created: now - 4000,
        updated: now - 4000,
        projectId: 'global',
        directory: '__CWD__'
      }
    ]);

    expect(result.finalArgs).toEqual([]);
  });

  it('launches opencode fresh when the only cwd session is stale', async () => {
    const now = Date.now();
    const result = await runPreparedOpencodeCommandWithSessions([
      {
        id: 'ses_stale',
        title: 'stale',
        created: now - 10 * 24 * 60 * 60 * 1000,
        updated: now - 8 * 24 * 60 * 60 * 1000,
        projectId: 'global',
        directory: '__CWD__'
      }
    ]);

    expect(result.finalArgs).toEqual([]);
  });
});

describe('opencode launch config materialization', () => {
  it('prepares the Desk-owned opencode config for real runPlan starts but not dry-run', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-opencode-config-launch-'));
    try {
      const cwd = join(root, 'project');
      const bin = join(root, 'bin');
      const configDir = join(root, 'opencode-config');
      const statePath = join(root, 'resume-captures.json');
      mkdirSync(cwd);
      mkdirSync(bin);
      const tmuxPath = join(bin, 'tmux');
      writeFileSync(
        tmuxPath,
        `#!/usr/bin/env node
process.exit(0);
`
      );
      chmodSync(tmuxPath, 0o755);
      process.env = {
        ...originalEnv,
        PATH: `${bin}:${originalEnv.PATH ?? ''}`,
        DESK_OPENCODE_CONFIG_DIR: configDir,
        DESK_RESUME_CAPTURE_STATE_PATH: statePath
      };
      const spec = buildSessionSpecs(
        parseDeskManifest(`
projects:
  - id: sample
    cwd: ${cwd}
    groups:
      - id: main
        sessions:
          - name: opencode
            agent: opencode
`),
        { homeDir: root }
      )[0]!;
      const plan = [{ type: 'start' as const, session: spec, argv: ['new-session', '-d', '-s', spec.tmuxSession] }];

      expect(runPlan(plan, true)).toBe(0);
      expect(existsSync(join(configDir, 'plugin', 'desk-attention.js'))).toBe(false);
      expect(readPendingResumeCaptures({ path: statePath })).toEqual([]);

      expect(runPlan(plan, false)).toBe(0);
      expect(existsSync(join(configDir, 'opencode.json'))).toBe(true);
      expect(existsSync(join(configDir, 'plugin', 'desk-attention.js'))).toBe(true);
      expect(readPendingResumeCaptures({ path: statePath })).toEqual([
        expect.objectContaining({
          tmuxSession: spec.tmuxSession,
          agent: 'opencode',
          cwd
        })
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function runPreparedOpencodeCommandWithSessions(
  sessions: Array<{
    id: string;
    title: string;
    created: number;
    updated: number;
    projectId: string;
    directory: string;
  }>
): Promise<{ command: string; finalArgs: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'desk-opencode-runner-'));
  try {
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const sessionsPath = join(root, 'sessions.json');
    const argsPath = join(root, 'args.jsonl');
    const stubPath = join(root, 'opencode-stub.js');
    writeFileSync(
      sessionsPath,
      JSON.stringify(sessions.map((session) => ({ ...session, directory: session.directory.replace('__CWD__', cwd) })))
    );
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'session' && args[1] === 'list') {
  process.stdout.write(fs.readFileSync(process.env.TEST_OPENCODE_SESSIONS, 'utf8'));
  process.exit(0);
}
fs.writeFileSync(process.env.TEST_OPENCODE_ARGS, JSON.stringify(args) + '\\n', { flag: 'a' });
`
    );
    chmodSync(stubPath, 0o755);

    const spec = buildSessionSpecs(
      parseDeskManifest(`
projects:
  - id: sample
    cwd: ${cwd}
    groups:
      - id: main
        sessions:
          - name: opencode
            agent: opencode
`),
      { homeDir: root }
    )[0];
    const prepared = prepareSessionForLaunch(spec, {
      env: {
        ...process.env,
        DESK_OPENCODE_BIN: stubPath,
        TEST_OPENCODE_ARGS: argsPath,
        TEST_OPENCODE_SESSIONS: sessionsPath
      },
      homeDir: root
    });
    await execFileAsync('bash', ['-lc', prepared.command], {
      env: {
        ...process.env,
        DESK_OPENCODE_BIN: stubPath,
        TEST_OPENCODE_ARGS: argsPath,
        TEST_OPENCODE_SESSIONS: sessionsPath
      }
    });
    const lines = readFileSync(argsPath, 'utf8').trim().split('\n');
    return { command: prepared.command, finalArgs: JSON.parse(lines.at(-1)!) as string[] };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
