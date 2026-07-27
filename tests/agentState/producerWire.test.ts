import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDeskAgentEventShim } from '../../src/core/agentHooks.js';
import { buildOpencodeAttentionPlugin } from '../../src/core/agentState/opencodeProducer.js';
import { observationEnvelope } from '../../src/core/agentState/providerAdapter.js';
import { parseAgentStateEnvelope } from '../../src/shared/controlPlane/index.js';

/**
 * The WIRE test: a real hook shim process produces a body, and that body has to
 * survive the public route's strict parser.
 *
 * Both halves were tested in isolation and both were green while the seam
 * between them was dead — every hook POST was rejected and terminal agents
 * reported no state at all. A suite that never runs one side's output through
 * the other side's parser cannot see that.
 */
let home: string;
let capture: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'desk-producer-wire-'));
  capture = join(home, 'posted.jsonl');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Runs the emitted shim with `fetch` replaced by a recorder, so the assertion
 * is made against the bytes the shim would really send.
 */
function runHook(event: string, input: string, extraEnv: Record<string, string> = {}): void {
  // The shim ships verbatim — its shebang is only valid at byte zero, so the
  // recorder is preloaded rather than prepended. Testing a doctored copy would
  // defeat the point of a wire test.
  const shimPath = join(home, 'shim.mjs');
  writeFileSync(shimPath, buildDeskAgentEventShim());
  const recorderPath = join(home, 'recorder.mjs');
  writeFileSync(
    recorderPath,
    `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(capture)}, init.body + '\\n');
  return { ok: true, status: 200 };
};
`
  );
  const result = spawnSync(process.execPath, ['--import', recorderPath, shimPath, '--event', event, '--agent', 'claude'], {
    input,
    env: {
      ...process.env,
      HOME: home,
      DESK_SESSION_ID: 'work-claude',
      DESK_SESSION_GENERATION: '5',
      DESK_PRODUCER_STATE_DIR: join(home, 'producers'),
      ...extraEnv
    },
    encoding: 'utf8',
    timeout: 15_000
  });
  expect(result.status, result.stderr).toBe(0);
}

function posted(): Array<Record<string, unknown>> {
  try {
    return readCapture()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function readCapture(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(capture, 'utf8') as string;
}

describe('a hook body survives the public route parser', () => {
  it('turns one real hook POST into a canonical envelope', () => {
    runHook('UserPromptSubmit', JSON.stringify({ prompt: 'do the thing' }));
    const bodies = posted();
    expect(bodies).toHaveLength(1);

    // The seam: the adapter maps the producer body into the canonical envelope
    // the route accepts. Without it every POST is a 400 and the session's
    // state stays unknown forever.
    const envelope = observationEnvelope(bodies[0], { observedAt: 1_760_000_000_000 });
    expect(envelope.kind).toBe('envelope');
    if (envelope.kind !== 'envelope') return;
    expect(() => parseAgentStateEnvelope(envelope.envelope)).not.toThrow();
    expect(envelope.envelope.facts).toEqual([{ kind: 'activity', activity: 'working' }]);
  });

  it('carries the START of a session all the way to an idle fact', () => {
    // A started session is at its prompt. This is the path that keeps an idle
    // fleet off `unknown`, and it has to survive the wire, not just the mapper.
    runHook('SessionStart', JSON.stringify({ source: 'startup' }));
    const envelope = observationEnvelope(posted()[0], { observedAt: 1_760_000_000_000 });
    expect(envelope.kind).toBe('envelope');
    if (envelope.kind !== 'envelope') return;
    expect(() => parseAgentStateEnvelope(envelope.envelope)).not.toThrow();
    expect(envelope.envelope.facts).toEqual([{ kind: 'activity', activity: 'idle' }]);
  });

  it('accepts — without error — a hook that asserts nothing', () => {
    // SessionEnd retires the producer and says nothing about activity: the
    // daemon watches the process exit itself. Rejecting it would turn an
    // ordinary shutdown into a reported failure.
    runHook('SessionEnd', JSON.stringify({ reason: 'logout' }));
    const result = observationEnvelope(posted()[0], { observedAt: 1 });
    expect(result.kind).toBe('no-facts');
  });
});

describe('sequencing survives the one-shot hook process', () => {
  it('keeps ONE producer identity and a rising sequence across separate invocations', () => {
    // Every hook firing is its OWN node process. In-memory identity therefore
    // resets to seq 1 on each event, and an authority that fences on
    // (producerInstanceId, producerSeq) accepts the first event and rejects
    // every one after it — the session silently stops reporting.
    runHook('UserPromptSubmit', JSON.stringify({ prompt: 'one' }));
    runHook('PreToolUse', JSON.stringify({ tool_name: 'Bash' }));
    runHook('Stop', JSON.stringify({}));

    const bodies = posted();
    expect(bodies).toHaveLength(3);
    const instances = new Set(bodies.map((body) => body.producerInstanceId));
    expect(instances.size, 'one producer per session generation, not per process').toBe(1);
    expect(bodies.map((body) => body.producerSeq)).toEqual([1, 2, 3]);
    expect(new Set(bodies.map((body) => body.eventId)).size, 'event ids stay unique').toBe(3);
  });

  it('starts a NEW producer identity for a new generation', () => {
    // A respawn is a new generation: its producer must be distinguishable, or
    // fencing cannot reject writes from the producer that outlived the old one.
    runHook('UserPromptSubmit', JSON.stringify({ prompt: 'gen 5' }));
    runHook('UserPromptSubmit', JSON.stringify({ prompt: 'gen 6' }), { DESK_SESSION_GENERATION: '6' });

    const bodies = posted();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].producerInstanceId).not.toBe(bodies[1].producerInstanceId);
    expect(bodies[1].producerSeq).toBe(1);
  });
});

describe('the OpenCode plugin body survives the same parser', () => {
  it('turns a real plugin POST into a canonical envelope', async () => {
    // The shim and the plugin share one producer runtime, but they are two
    // artifacts: proving the wire for one proves nothing about the other. The
    // seam that was dead all afternoon was dead for BOTH.
    const pluginPath = join(home, 'plugin.mjs');
    writeFileSync(pluginPath, buildOpencodeAttentionPlugin());
    const recorderPath = join(home, 'plugin-recorder.mjs');
    writeFileSync(
      recorderPath,
      `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(capture)}, init.body + '\\n');
  return { ok: true, status: 200 };
};
`
    );
    const driverPath = join(home, 'plugin-driver.mjs');
    writeFileSync(
      driverPath,
      `const mod = await import(${JSON.stringify(pluginPath)});
const hooks = await mod.default.server({});
await hooks.event({
  event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }
});
`
    );
    const result = spawnSync(process.execPath, ['--import', recorderPath, driverPath], {
      env: {
        ...process.env,
        HOME: home,
        DESK_SESSION_ID: 'work-opencode',
        DESK_AGENT: 'opencode',
        DESK_SESSION_GENERATION: '5',
        DESK_PRODUCER_STATE_DIR: join(home, 'producers')
      },
      encoding: 'utf8',
      timeout: 15_000
    });
    expect(result.status, result.stderr).toBe(0);

    const bodies = posted();
    expect(bodies).toHaveLength(1);
    const envelope = observationEnvelope(bodies[0], { observedAt: 1_760_000_000_000 });
    expect(envelope.kind).toBe('envelope');
    if (envelope.kind !== 'envelope') return;
    expect(() => parseAgentStateEnvelope(envelope.envelope)).not.toThrow();
    expect(envelope.envelope.producer).toBe('opencode-terminal');
    expect(envelope.envelope.facts).toEqual([{ kind: 'activity', activity: 'working' }]);
  });
});

describe('the plugin registers where Desk can poll it back', () => {
  it('publishes its server url at load and pins the provider session it is watching', () => {
    // Recovery needs an ADDRESS. Only the plugin is handed one, and only it
    // knows WHICH internal agent session Desk is following — one Desk session
    // hosts many, and polling the whole status map could resurrect a busy
    // state belonging to a different conversation.
    const pluginPath = join(home, 'plugin.mjs');
    writeFileSync(pluginPath, buildOpencodeAttentionPlugin());
    const recorderPath = join(home, 'plugin-recorder.mjs');
    writeFileSync(
      recorderPath,
      // The recorder MIMICS the intake: an endpoint for a producer the daemon
      // has never accepted an event from is refused as unregistered. A
      // recorder that always answers 200 cannot see an ordering bug, because a
      // failed registration is silent by design.
      `import { appendFileSync } from 'node:fs';
const bound = new Set();
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const refused = url.endsWith('/api/agent-endpoint') && !bound.has(body.producerInstanceId);
  if (url.endsWith('/api/agent-event')) bound.add(body.producerInstanceId);
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ url, body, ok: !refused }) + '\\n');
  return refused ? { ok: false, status: 404 } : { ok: true, status: 200 };
};
`
    );
    const driverPath = join(home, 'plugin-driver.mjs');
    writeFileSync(
      driverPath,
      `const mod = await import(${JSON.stringify(pluginPath)});
const hooks = await mod.default.server({ serverUrl: new URL('http://127.0.0.1:4096/') });
await hooks.event({
  event: { type: 'session.status', properties: { sessionID: 'ses_alpha', status: { type: 'busy' } } }
});
await hooks.event({
  event: { type: 'session.status', properties: { sessionID: 'ses_alpha', status: { type: 'idle' } } }
});
`
    );
    const result = spawnSync(process.execPath, ['--import', recorderPath, driverPath], {
      env: {
        ...process.env,
        HOME: home,
        DESK_SESSION_ID: 'work-opencode',
        DESK_AGENT: 'opencode',
        DESK_SESSION_GENERATION: '5',
        DESK_PRODUCER_STATE_DIR: join(home, 'producers')
      },
      encoding: 'utf8',
      timeout: 15_000
    });
    expect(result.status, result.stderr).toBe(0);

    const calls = posted() as Array<{ url: string; body: Record<string, unknown>; ok: boolean }>;
    const registrations = calls.filter((call) => call.url.endsWith('/api/agent-endpoint'));

    // ORDER IS THE POINT: the producer is bound by an accepted event BEFORE
    // its address is offered. Registering first cannot work — the daemon has
    // no identity to attach the address to — and it fails silently.
    const firstEvent = calls.findIndex((call) => call.url.endsWith('/api/agent-event'));
    const firstRegistration = calls.findIndex((call) => call.url.endsWith('/api/agent-endpoint'));
    expect(firstEvent).toBeGreaterThanOrEqual(0);
    expect(firstRegistration).toBeGreaterThan(firstEvent);

    // Every registration is ACCEPTED. A refused one would mean we offered the
    // address before the identity existed.
    expect(registrations.every((call) => call.ok)).toBe(true);
    expect(registrations).toHaveLength(1);
    expect(registrations[0].body).toMatchObject({
      sessionId: 'work-opencode',
      generation: 5,
      producer: 'opencode-terminal',
      endpoint: 'http://127.0.0.1:4096/',
      providerSessionId: 'ses_alpha'
    });

    // Registration is BOUND to the producer identity. Unbound endpoint
    // metadata is spoofable: anything that can reach the port could name a
    // poll target, and the daemon could not tell it from the real producer.
    const identities = new Set(registrations.map((call) => call.body.producerInstanceId));
    expect(identities.size).toBe(1);
    expect([...identities][0]).toBeTypeOf('string');

    // One sequence across BOTH channels. Registrations consume numbers, so the
    // event stream shows gaps — monotonicity is the contract, not contiguity.
    const sequences = calls.map((call) => call.body.producerSeq as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    // The endpoint is TRANSPORT metadata and must never reach the canonical
    // envelope, which carries only what an agent did.
    for (const call of calls.filter((entry) => entry.url.endsWith('/api/agent-event'))) {
      expect(call.body.endpoint).toBeUndefined();
      expect(call.body.providerSessionId).toBeUndefined();
    }
  });
});

describe('a long tool keeps the session working', () => {
  it('carries a paired interval through the real shim, unthrottled, with its id', () => {
    // The gate this exists for: a build or a test run outlives the 15s working
    // lease. Two beats cannot prove liveness across that gap, but an OPEN
    // interval can — so the edges must survive intact, with the id that pairs
    // them, and must never be throttled away.
    runHook('PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_01' }));
    runHook('PostToolUse', JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_01' }));

    const bodies = posted().filter((body) => 'observation' in body);
    expect(bodies).toHaveLength(2);

    const start = observationEnvelope(bodies[0], { observedAt: 1 });
    const end = observationEnvelope(bodies[1], { observedAt: 2 });
    expect(start.kind).toBe('envelope');
    expect(end.kind).toBe('envelope');
    if (start.kind !== 'envelope' || end.kind !== 'envelope') return;

    expect(start.envelope.facts).toEqual([{ kind: 'tool', phase: 'start' }]);
    expect(end.envelope.facts).toEqual([{ kind: 'tool', phase: 'end' }]);
    // Same id on both edges: the authority closes an interval BY ID, and a
    // mismatched pair would leak the open one and close nothing.
    expect(start.envelope.correlation?.toolUseId).toBe('toolu_01');
    expect(end.envelope.correlation?.toolUseId).toBe('toolu_01');
  });

  it('closes the interval when the tool FAILS', () => {
    // Closing only on success leaks an open interval on every failing tool,
    // parking the session on the long open-tool ceiling instead of its short
    // working lease.
    runHook('PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_02' }));
    runHook('PostToolUseFailure', JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_02' }));

    const bodies = posted().filter((body) => 'observation' in body);
    const end = observationEnvelope(bodies[1], { observedAt: 2 });
    expect(end.kind).toBe('envelope');
    if (end.kind !== 'envelope') return;
    expect(end.envelope.facts).toEqual([{ kind: 'tool', phase: 'end' }]);
    expect(end.envelope.correlation?.toolUseId).toBe('toolu_02');
  });

  it('degrades to a plain beat when the agent gives no tool id', () => {
    // An unpaired edge is worse than no edge: it would open an interval nobody
    // can close. A beat claims less and stays true.
    runHook('PreToolUse', JSON.stringify({ tool_name: 'Bash' }));
    const result = observationEnvelope(posted()[0], { observedAt: 1 });
    expect(result.kind).toBe('envelope');
    if (result.kind !== 'envelope') return;
    expect(result.envelope.facts).toEqual([{ kind: 'heartbeat' }]);
    expect(result.envelope.correlation).toBeUndefined();
  });
});
