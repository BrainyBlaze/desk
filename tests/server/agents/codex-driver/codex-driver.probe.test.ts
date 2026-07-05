import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCodexDriver } from '../../../../src/server/agents/drivers/codexDriver';
import type { DriverEvent } from '../../../../src/server/agents/host/driver';

/**
 * Live probe against real `codex app-server` + the Codex driver. Gated behind
 * DESK_CODEX_PROBE=1 because it spawns a real Codex child and spends tokens -
 * run explicitly at the driver gate, never in the default suite:
 *
 *   DESK_CODEX_PROBE=1 npx vitest run tests/server/agents/codex-driver/codex-driver.probe.test.ts
 *
 * The probe runs under an isolated CODEX_HOME (agents-fixture protocol).
 * auth.json is copied in so the session authenticates, but the user's
 * config/hooks stay out; this verifies the driver's app-server mapping, not the
 * local Codex environment.
 */
const PROBE_ENABLED = process.env.DESK_CODEX_PROBE === '1';
const REAL_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const HAS_AUTH = existsSync(REAL_AUTH_PATH);
const SKIP_REASON = !PROBE_ENABLED
  ? 'set DESK_CODEX_PROBE=1 to run'
  : !HAS_AUTH
    ? 'authenticate codex so ~/.codex/auth.json exists'
    : '';

describe.skipIf(!PROBE_ENABLED || !HAS_AUTH)('codex driver live probe', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'desk-codex-probe-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'desk-codex-probe-home-'));

  if (PROBE_ENABLED && existsSync(REAL_AUTH_PATH)) {
    copyFileSync(REAL_AUTH_PATH, join(codexHome, 'auth.json'));
  }

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  it(
    'completes one real app-server turn and exposes committed history',
    { timeout: 180_000 },
    async () => {
      const driver = createCodexDriver({
        cwd,
        transportOptions: { env: { ...process.env, CODEX_HOME: codexHome } }
      });
      const events: DriverEvent[] = [];
      driver.onEvent((event) => events.push(event));

      try {
        const started = await driver.start();
        expect(typeof started.session.agentSessionId).toBe('string');
        expect(started.status).toMatchObject({ kind: 'status' });

        const turnDone = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('codex turn did not complete within 150s')), 150_000);
          driver.onEvent((event) => {
            if (event.kind === 'turn-complete') {
              clearTimeout(timer);
              resolve();
            }
            if (event.kind === 'agent-error') {
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

        const history = await driver.fetchHistory();
        expect(history.some((event) => event.kind === 'assistant-message')).toBe(true);
        expect(history.some((event) => event.kind === 'user-message')).toBe(true);
      } finally {
        await driver.shutdown();
      }
    }
  );

  it.skipIf(SKIP_REASON !== '')('skipped reason', () => {
    expect(SKIP_REASON).toBe('');
  });
});
