import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DriverEvent } from '../../../../src/server/agents/host/driver';
import { createClaudeDriver } from '../../../../src/server/agents/drivers/claudeDriver';

/**
 * Live probe against the real Claude Agent SDK + claude install. Gated behind
 * DESK_CLAUDE_PROBE=1 because it needs an authenticated claude and spends
 * tokens — run explicitly at the Phase 1 gate, never in the default suite:
 *
 *   DESK_CLAUDE_PROBE=1 npx vitest run tests/server/agents/claude-driver/claude-driver.probe.test.ts
 *
 * The probe runs under an ISOLATED CLAUDE_CONFIG_DIR (agents-fixture protocol):
 * credentials are copied in so the session authenticates, but the user's
 * settings/hooks stay out — dev machines run SessionStart hook stacks that can
 * legitimately delay init for minutes, and this probe verifies the driver's
 * protocol mapping, not the local hook environment.
 */
const PROBE_ENABLED = process.env.DESK_CLAUDE_PROBE === '1';

describe.skipIf(!PROBE_ENABLED)('claude driver live probe', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'desk-claude-probe-'));
  const configDir = mkdtempSync(join(tmpdir(), 'desk-claude-probe-config-'));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const realCredentials = join(homedir(), '.claude', '.credentials.json');
  if (PROBE_ENABLED && existsSync(realCredentials)) {
    copyFileSync(realCredentials, join(configDir, '.credentials.json'));
  }
  process.env.CLAUDE_CONFIG_DIR = configDir;

  afterAll(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it(
    'completes one real turn and exposes the session for backfill',
    { timeout: 180_000 },
    async () => {
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      const driver = createClaudeDriver({ cwd, bypassPermissions: true });
      const events: DriverEvent[] = [];
      driver.onEvent((event) => events.push(event));

      const started = await driver.start();
      expect(started.status).toMatchObject({ kind: 'status', state: 'idle' });

      const turnDone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('turn did not complete')), 150_000);
        driver.onEvent((event) => {
          if (event.kind === 'turn-complete') {
            clearTimeout(timer);
            resolve();
          }
          if (event.kind === 'agent-error' && event.fatal) {
            clearTimeout(timer);
            reject(new Error(event.message));
          }
        });
      });

      await driver.inject('Reply with exactly the single word: pong', 'external');
      await turnDone;

      const committed = events.filter((event) => event.kind === 'assistant-message');
      expect(committed.length).toBeGreaterThan(0);
      const lastCommitted = committed[committed.length - 1];
      if (lastCommitted.kind === 'assistant-message') {
        expect(lastCommitted.markdown.toLowerCase()).toContain('pong');
      }
      expect(events.some((event) => event.kind === 'user-message' && event.source === 'external')).toBe(true);
      expect(events[events.length - 1]).toMatchObject({ kind: 'status', state: 'idle' });

      await driver.shutdown();
    }
  );
});
