import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { opencodeFacts, type OpencodeObservation } from '../../src/core/agentState/opencodeFacts.js';
import { buildOpencodeAttentionPlugin } from '../../src/core/agentState/opencodeProducer.js';
import type { AgentSemanticFact } from '../../src/core/agentState/facts.js';

/**
 * Drives the REAL plugin file that Desk installs into the OpenCode config, so
 * the thing under test is the artifact that ships — not a re-implementation of
 * it. The plugin's whole job is to observe typed events and post a bounded
 * slice; the meaning of that slice is asserted through the shared mapper, which
 * is what makes "did Desk learn the right fact" a single assertion.
 */

interface OpencodeHooks {
  event?: (input: { event: unknown }) => Promise<void>;
  'permission.ask'?: (input: unknown, output: unknown) => Promise<void>;
  'chat.message'?: (input: unknown, output: unknown) => Promise<void>;
  'tool.execute.before'?: (input: unknown, output: unknown) => Promise<void>;
  'tool.execute.after'?: (input: unknown, output: unknown) => Promise<void>;
}

let posted: Record<string, unknown>[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  posted = [];
  // The plugin keeps its heartbeat window in module state; a fresh module per
  // test keeps one test's beat from throttling the next.
  vi.resetModules();
  realFetch = globalThis.fetch;
  process.env.DESK_SESSION_ID = 'work-opencode';
  process.env.DESK_SESSION_GENERATION = '4';
  process.env.DESK_API = 'http://127.0.0.1:5173';
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    posted.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DESK_SESSION_ID;
  delete process.env.DESK_SESSION_GENERATION;
  delete process.env.DESK_API;
});

let pluginDir: string | undefined;
let pluginCounter = 0;

/**
 * Writes the GENERATED plugin to disk and imports it, so the artifact under
 * test is the one Desk actually installs. A unique filename per load defeats
 * the module cache, which the plugin's per-process identity and heartbeat
 * window depend on being fresh.
 */
async function loadHooks(): Promise<OpencodeHooks> {
  pluginDir ??= mkdtempSync(join(tmpdir(), 'desk-oc-plugin-'));
  pluginCounter += 1;
  const path = join(pluginDir, `desk-attention-${pluginCounter}.mjs`);
  writeFileSync(path, buildOpencodeAttentionPlugin());
  const module = (await import(path)) as unknown as {
    default: { server: (input: unknown) => Promise<OpencodeHooks> };
  };
  return module.default.server({});
}

/** The facts Desk learns from everything the plugin posted for one interaction. */
function learnedFacts(): AgentSemanticFact[] {
  return posted.flatMap((body) => opencodeFacts((body.observation ?? {}) as OpencodeObservation));
}

describe('opencode plugin reports the events that actually exist', () => {
  it('learns WORKING from a busy session status', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }
    });
    expect(learnedFacts()).toEqual([{ kind: 'activity', activity: 'working' }]);
  });

  it('learns IDLE from an idle session status', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } }
    });
    expect(learnedFacts()).toEqual([{ kind: 'activity', activity: 'idle' }]);
  });

  it('learns a PROVIDER wait from a retry status', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'retry', attempt: 3, message: 'overloaded' } }
      }
    });
    const facts = learnedFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].kind === 'blocked' && facts[0].wait.owner).toBe('provider');
  });

  it('learns an OPERATOR block from permission.updated — the real event name', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: {
        type: 'permission.updated',
        properties: { id: 'perm_1', sessionID: 'ses_1', messageID: 'm1', title: 'run rm -rf', metadata: {}, type: 'bash', time: { created: 1 } }
      }
    });
    const facts = learnedFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].kind === 'blocked' && facts[0].wait.owner).toBe('operator');
  });

  it('clears the block on permission.replied', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: { type: 'permission.replied', properties: { sessionID: 'ses_1', permissionID: 'perm_1', response: 'allow' } }
    });
    expect(learnedFacts()).toEqual([{ kind: 'unblocked' }]);
  });

  it('classifies an aborted turn as idle rather than a failure', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: {
        type: 'session.error',
        properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }
      }
    });
    expect(learnedFacts()).toEqual([{ kind: 'activity', activity: 'idle' }]);
  });

  it('routes a retryable API error to the provider, keeping the lamp dark', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { name: 'APIError', data: { message: 'rate limited', statusCode: 429, isRetryable: true } }
        }
      }
    });
    const facts = learnedFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].kind === 'blocked' && facts[0].wait.owner).toBe('provider');
  });
});

describe('opencode plugin opens the turn and proves it is still alive', () => {
  it('opens the turn from the chat.message hook', async () => {
    const hooks = await loadHooks();
    await hooks['chat.message']?.({ sessionID: 'ses_1' }, { message: {}, parts: [] });
    expect(learnedFacts()).toEqual([{ kind: 'activity', activity: 'working' }]);
  });

  it('opens a tool INTERVAL rather than beating, so a long tool holds working', async () => {
    // Two beats cannot prove liveness across a gap longer than the lease; an
    // open interval can. callID is what pairs the edges.
    const hooks = await loadHooks();
    await hooks['tool.execute.before']?.({ tool: 'bash', sessionID: 'ses_1', callID: 'c1' }, { args: {} });
    expect(learnedFacts()).toEqual([{ kind: 'tool', phase: 'start' }]);
  });

  it('collapses a burst of streaming deltas to one beat per window', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-27T10:00:00.000Z'));
      const hooks = await loadHooks();
      for (let i = 0; i < 50; i += 1) {
        await hooks.event?.({ event: { type: 'message.part.updated', properties: { sessionID: 'ses_1' } } });
      }
      // A per-token post would flood the server; the lease only needs one.
      expect(posted).toHaveLength(1);

      // Past the window, liveness must be provable again — otherwise a long
      // turn would decay to unknown while it is demonstrably still running.
      vi.setSystemTime(new Date('2026-07-27T10:00:06.000Z'));
      await hooks.event?.({ event: { type: 'message.part.updated', properties: { sessionID: 'ses_1' } } });
      expect(posted).toHaveLength(2);
      expect(learnedFacts()).toEqual([{ kind: 'heartbeat' }, { kind: 'heartbeat' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks on the permission.ask hook slot', async () => {
    const hooks = await loadHooks();
    await hooks['permission.ask']?.({ id: 'perm_1', sessionID: 'ses_1', title: 'edit file' }, { status: 'ask' });
    const facts = learnedFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].kind === 'blocked' && facts[0].wait.kind).toBe('approval');
  });
});

describe('the plugin stays a dumb, bounded observer', () => {
  it('posts nothing at all for events Desk does not act on', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({ event: { type: 'todo.updated', properties: {} } });
    await hooks.event?.({ event: { type: 'lsp.updated', properties: {} } });
    await hooks.event?.({ event: { type: 'file.edited', properties: {} } });
    expect(posted).toEqual([]);
  });

  // server.connected looks like a start signal and is not one. OpenCode
  // documents it as the FIRST EVENT OF EVERY /event SSE CONNECTION — "First
  // event is `server.connected`, then bus events" — so it fires again whenever
  // a client reconnects, including in the middle of a running turn. Mapping it
  // to idle would overwrite `working` on reconnect and reopen delivery mid-turn.
  // A session's cold start is OpenCode's to answer through reconciliation, not
  // something to infer from a transport event.
  it('stays silent on server.connected — it is a CONNECTION event, not a session start', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({ event: { type: 'server.connected', properties: {} } });
    expect(posted).toEqual([]);
    expect(learnedFacts()).toEqual([]);
  });

  it('never posts without a Desk session identity', async () => {
    delete process.env.DESK_SESSION_ID;
    const hooks = await loadHooks();
    await hooks.event?.({
      event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }
    });
    expect(posted).toEqual([]);
  });

  it('bounds the operator-facing text it copies out of a payload', async () => {
    const hooks = await loadHooks();
    await hooks.event?.({
      event: {
        type: 'permission.updated',
        properties: { id: 'p', sessionID: 'ses_1', messageID: 'm', title: 'T'.repeat(5000), metadata: {}, type: 'bash', time: { created: 1 } }
      }
    });
    const observation = posted[0]?.observation as OpencodeObservation | undefined;
    // Assert the slice EXISTS before asserting its bound — an absent
    // observation would otherwise satisfy a length check and pass for the
    // wrong reason.
    expect(observation?.permissionTitle).toBeTypeOf('string');
    expect(observation?.permissionTitle?.length).toBeLessThanOrEqual(200);
  });
});
