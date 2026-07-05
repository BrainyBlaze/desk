import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DriverEvent } from '../../../../src/server/agents/host/driver';
import { OpencodeDriver } from '../../../../src/server/agents/drivers/opencodeDriver';

/**
 * Live probe against real `opencode serve` + the opencode driver. Gated behind
 * DESK_OPENCODE_PROBE=1 because it spawns a real opencode child and spends tokens —
 * run explicitly at the Phase 1 gate, never in the default suite:
 *
 *   DESK_OPENCODE_PROBE=1 ANTHROPIC_API_KEY=... \
 *     npx vitest run tests/server/agents/opencode-driver/opencode-driver.probe.test.ts
 *
 * Provider creds: opencode reads standard env (ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * OPENROUTER_API_KEY etc.); copy your usual one into the env. The probe runs under an
 * ISOLATED HOME + OPENCODE_CONFIG_DIR (agents-fixture protocol) so the user's opencode
 * auth/store/sessions are not touched.
 */
const PROBE_ENABLED = process.env.DESK_OPENCODE_PROBE === '1';
const HAS_PROVIDER_CRED =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  Boolean(process.env.OPENAI_API_KEY) ||
  Boolean(process.env.OPENROUTER_API_KEY);
const SKIP_REASON = !PROBE_ENABLED
  ? 'set DESK_OPENCODE_PROBE=1 to run'
  : !HAS_PROVIDER_CRED
    ? 'set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY'
    : '';

describe.skipIf(!PROBE_ENABLED || !HAS_PROVIDER_CRED)('opencode driver live probe', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'desk-opencode-probe-'));
  const configDir = mkdtempSync(join(tmpdir(), 'desk-opencode-probe-config-'));
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;

  process.env.OPENCODE_CONFIG_DIR = configDir;

  afterAll(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it(
    'completes one real turn: deltas → assistant-message → turn-complete',
    { timeout: 180_000 },
    async () => {
      const driver = new OpencodeDriver({ cwd, bypass: true });
      const events: DriverEvent[] = [];
      driver.onEvent((event) => events.push(event));

      const started = await driver.start();
      expect(started.session.agentSessionId).toMatch(/^ses_/);

      const turnDone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('opencode turn did not complete within 150s')),
          150_000
        );
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

      const deltas = events.filter((event) => event.kind === 'assistant-delta');
      const committed = events.filter((event) => event.kind === 'assistant-message');
      expect(deltas.length).toBeGreaterThan(0);
      expect(committed.length).toBeGreaterThan(0);
      const lastCommitted = committed[committed.length - 1];
      if (lastCommitted.kind === 'assistant-message') {
        expect(lastCommitted.markdown.toLowerCase()).toContain('pong');
      }
      expect(events.some((event) => event.kind === 'user-message' && event.source === 'external')).toBe(true);
      // R3 filter sanity: this probe owns the server (one session), but the driver
      // wiring must not crash on any event the real server emits.
      expect(events.some((event) => event.kind === 'status')).toBe(true);

      await driver.shutdown();
    }
  );

  it(
    'fetchHistory returns the committed assistant-message after the live turn',
    { timeout: 60_000 },
    async () => {
      const driver = new OpencodeDriver({ cwd, bypass: true });
      const started = await driver.start();
      const resumeId = started.session.agentSessionId;
      expect(typeof resumeId).toBe('string');

      const history = await driver.fetchHistory();
      // At minimum the previous probe turn's user + assistant messages should appear.
      expect(history.some((event) => event.kind === 'assistant-message')).toBe(true);
      expect(history.some((event) => event.kind === 'user-message')).toBe(true);

      await driver.shutdown();
    }
  );

  it.skipIf(SKIP_REASON !== '')('skipped reason', () => {
    expect(SKIP_REASON).toBe('');
  });
});
