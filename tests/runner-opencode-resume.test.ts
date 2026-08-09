import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';
import {
  atchCommandFor,
  planDeskUp,
  runPlan,
  startSession
} from '../src/core/runner.js';
import type { SessionSpec } from '../src/core/types.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('opencode launch continuity', () => {
  it('does not inspect cwd sessions or rewrite a resume-less launch', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-opencode-no-inference-'));
    try {
      const cwd = join(root, 'project');
      const markerPath = join(root, 'session-list-called');
      const stubPath = writeSessionListStub(root, cwd, markerPath);
      process.env = {
        ...originalEnv,
        DESK_OPENCODE_BIN: stubPath,
        TEST_OPENCODE_PROBE_MARKER: markerPath
      };
      const spec = opencodeSpec(root, cwd);

      const plan = planDeskUp([spec], { probeSession: () => false });

      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ type: 'start', session: spec });
      expect(plan[0]!.session.command).toBe(spec.command);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('passes a resume-less launch through startSession without a session-list probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-opencode-start-no-inference-'));
    try {
      const cwd = join(root, 'project');
      const markerPath = join(root, 'session-list-called');
      const stubPath = writeSessionListStub(root, cwd, markerPath);
      process.env = {
        ...originalEnv,
        DESK_OPENCODE_BIN: stubPath,
        DESK_OPENCODE_CONFIG_DIR: join(root, 'opencode-config'),
        TEST_OPENCODE_PROBE_MARKER: markerPath
      };
      const spec = opencodeSpec(root, cwd);
      const control = vi.fn().mockResolvedValue({ ok: true });

      await expect(
        startSession(spec, { probeSession: () => false, control })
      ).resolves.toEqual({ ok: true });

      expect(control).toHaveBeenCalledOnce();
      expect(control.mock.calls[0]![1]).toMatchObject({
        sessionId: spec.sessionId,
        command: atchCommandFor(spec)
      });
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves an explicit manifest resume id in the launched command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-opencode-explicit-resume-'));
    try {
      const cwd = join(root, 'project');
      process.env = {
        ...originalEnv,
        DESK_OPENCODE_CONFIG_DIR: join(root, 'opencode-config')
      };
      const spec = opencodeSpec(
        root,
        cwd,
        'ses_12a31855dffeHTCs6tcfOmsddP'
      );
      const control = vi.fn().mockResolvedValue({ ok: true });

      await expect(
        startSession(spec, { probeSession: () => false, control })
      ).resolves.toEqual({ ok: true });

      expect(spec.command).toContain("--session 'ses_12a31855dffeHTCs6tcfOmsddP'");
      expect(control.mock.calls[0]![1]).toMatchObject({
        sessionId: spec.sessionId,
        command: atchCommandFor(spec)
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe('opencode launch config materialization', () => {
  it('prepares Desk-owned config without creating pending capture state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-opencode-config-launch-'));
    try {
      const cwd = join(root, 'project');
      const configDir = join(root, 'opencode-config');
      const statePath = join(root, 'resume-captures.json');
      process.env = {
        ...originalEnv,
        DESK_OPENCODE_CONFIG_DIR: configDir,
        DESK_RESUME_CAPTURE_STATE_PATH: statePath
      };
      const spec = opencodeSpec(root, cwd);
      const plan = [{ type: 'start' as const, session: spec }];
      const control = vi.fn().mockResolvedValue({ ok: true });

      expect(await runPlan(plan, true, { control })).toBe(0);
      expect(control).not.toHaveBeenCalled();
      expect(existsSync(join(configDir, 'plugin', 'desk-attention.js'))).toBe(false);
      expect(existsSync(statePath)).toBe(false);

      expect(await runPlan(plan, false, { control })).toBe(0);
      expect(control).toHaveBeenCalledOnce();
      expect(existsSync(join(configDir, 'opencode.json'))).toBe(true);
      expect(existsSync(join(configDir, 'plugin', 'desk-attention.js'))).toBe(true);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function opencodeSpec(
  root: string,
  cwd: string,
  resume?: string
): SessionSpec {
  mkdirSync(cwd, { recursive: true });
  const resumeLine = resume ? `\n            resume: ${resume}` : '';
  return buildSessionSpecs(
    parseDeskManifest(`
projects:
  - id: sample
    cwd: ${cwd}
    groups:
      - id: main
        sessions:
          - name: opencode
            sessionId: opencode
            agent: opencode
            uiMode: terminal${resumeLine}
`),
    { homeDir: root }
  )[0]!;
}

function writeSessionListStub(
  root: string,
  cwd: string,
  markerPath: string
): string {
  const stubPath = join(root, 'opencode-stub.cjs');
  writeFileSync(
    stubPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.TEST_OPENCODE_PROBE_MARKER, 'called');
process.stdout.write(JSON.stringify([{
  id: 'ses_12a31855dffeHTCs6tcfOmsddP',
  title: 'recent',
  created: Date.now() - 2000,
  updated: Date.now() - 1000,
  projectId: 'global',
  directory: ${JSON.stringify(cwd)}
}]));
`
  );
  chmodSync(stubPath, 0o755);
  expect(markerPath).toBeTruthy();
  return stubPath;
}
