// The producer runtime, emitted as JavaScript.
//
// Two artifacts run inside an agent process and report observations: the hook
// shim (Claude, Codex) and the OpenCode plugin. Neither can import from Desk —
// the shim is written to disk and invoked by the agent CLI, the plugin is
// copied into the agent's own config tree — so the code they share is emitted
// from here rather than copy-pasted into both (R8.4). Identity, sequencing,
// and the bounded POST are exactly the parts that must not drift: two
// divergent sequence counters would break the authority's ordering guarantees
// in a way no unit test on either side would catch.
//
// The runtime carries NO judgement about what an observation means. It reports
// what was seen and stamps who saw it.

/** Producers registered in the control-plane contract, by provider. */
export const TERMINAL_PRODUCERS = {
  claude: 'claude-hooks',
  codex: 'codex-hooks',
  opencode: 'opencode-terminal'
} as const;

/**
 * Env var carrying the session's daemon generation into the agent process.
 *
 * Generation must be INHERITED, never resolved at the route: a producer that
 * outlived a respawn has to stamp the generation it was launched in, so the
 * authority can fence its late writes. A route that filled in "the current
 * generation" would stamp every stale event as fresh and turn fencing into
 * decoration. When it is absent the producer sends nothing rather than
 * guessing, and the session reads `unknown` — which is true.
 */
export const GENERATION_ENV_VAR = 'DESK_SESSION_GENERATION';

/** Exact OpenCode-internal session selected by this Desk terminal. */
export const OPENCODE_PROVIDER_SESSION_ENV_VAR = 'DESK_OPENCODE_SESSION_ID';

/** Operator-facing text copied out of an agent payload is bounded at the source. */
export const PRODUCER_MAX_DETAIL_CHARS = 200;

/**
 * The shared JS runtime. Defines `deskBounded`, `deskPost`, and
 * `deskThrottledPost`; the caller emits its own observation-building code on
 * top.
 *
 * `deskPost` is best effort by design: a Desk server that is down, slow, or
 * rejecting must never break the agent session it is observing. The failure is
 * not silent, though — a one-line diagnostic behind DESK_DEBUG keeps
 * "notifications stopped working" debuggable without polluting an alt-screen
 * TUI.
 */
/**
 * Env override for the producer state root, so a canary or a test can isolate
 * its sequence files from the operator's.
 */
export const PRODUCER_STATE_DIR_ENV = 'DESK_PRODUCER_STATE_DIR';

export function buildProducerRuntime(): string {
  return `import * as deskFs from 'node:fs';
import * as deskPath from 'node:path';
import * as deskOs from 'node:os';

const DESK_TERMINAL_PRODUCERS = ${JSON.stringify(TERMINAL_PRODUCERS)};
const DESK_MAX_DETAIL = ${PRODUCER_MAX_DETAIL_CHARS};
const DESK_SCHEMA_VERSION = 3;

// One shim binary serves several providers, so the provider is selected once
// at startup rather than baked in. An unrecognised provider posts nothing: the
// contract binds producer to provider, and a mismatched pair is rejected by
// the authority anyway — better to be silent (and read unknown) than to send
// events that will be thrown away without a trace.
let DESK_PROVIDER;
let DESK_PRODUCER;
function deskUseProvider(provider) {
  DESK_PRODUCER = DESK_TERMINAL_PRODUCERS[provider];
  DESK_PROVIDER = DESK_PRODUCER ? provider : undefined;
}

// Identity and sequence are DURABLE, keyed by session generation.
//
// A hook is a one-shot process: Claude and Codex spawn a fresh node for every
// event. Per-process identity would therefore mint a new producer and restart
// the sequence at 1 on every hook, and an authority fencing on
// (producerInstanceId, producerSeq) would accept the first event of a session
// and silently reject every one after it. The producer is the hook
// INSTALLATION for a generation, not the process that happens to be running.
//
// A new generation deliberately gets a new identity: that is what lets the
// authority fence writes from a producer that outlived a respawn.
function deskStateDir() {
  const override = process.env.${PRODUCER_STATE_DIR_ENV};
  if (override) return override;
  return deskPath.join(process.env.HOME || deskOs.homedir(), '.local', 'share', 'desk', 'producers');
}

/** sessionId is a path segment here; keep it to characters a filename allows. */
function deskSafeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

/**
 * Atomic-directory mutex: mkdir succeeds for exactly one caller. Parallel tool
 * batches fire several hooks at once, and two of them reading the same counter
 * would hand out one sequence number twice — which the authority reads as a
 * replay and drops.
 *
 * A holder that dies leaves the directory behind, so a lock older than the
 * steal window is taken over rather than waited on forever: a stuck hook must
 * never wedge the agent's turn.
 */
function deskWithLock(lockPath, run) {
  const STEAL_AFTER_MS = 5000;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      deskFs.mkdirSync(lockPath);
      try {
        return run();
      } finally {
        try { deskFs.rmdirSync(lockPath); } catch (_) { /* released by a stealer */ }
      }
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - deskFs.statSync(lockPath).mtimeMs;
        if (age > STEAL_AFTER_MS) {
          deskFs.rmdirSync(lockPath);
          continue;
        }
      } catch (_) { /* vanished under us; retry */ }
      deskSleep(10);
    }
  }
  // Bounded: proceeding unsequenced would corrupt ordering, so the producer
  // stays silent for this event instead. Silence reads as unknown; a bad
  // sequence reads as a confident lie.
  return undefined;
}

function deskSleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* one-shot process: a spin is cheaper than a thread */ }
}

function deskClaimSequence(sessionId, generation) {
  const dir = deskStateDir();
  deskFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = deskPath.join(dir, deskSafeSegment(sessionId) + '-' + String(generation) + '.json');
  return deskWithLock(file + '.lock', () => {
    let state;
    try {
      const parsed = JSON.parse(deskFs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.instanceId === 'string' && Number.isSafeInteger(parsed.seq)) {
        state = parsed;
      }
    } catch (_) { /* absent or unreadable: mint a fresh producer */ }
    if (!state) {
      const minted =
        (globalThis.crypto && globalThis.crypto.randomUUID && globalThis.crypto.randomUUID()) ||
        String(process.pid) + '-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
      state = { instanceId: minted, seq: 0 };
    }
    state.seq += 1;
    // Crash-durable, not merely process-durable. rename() is atomic but the
    // BYTES may still be in the page cache: a power loss could roll the
    // sequence back, and the authority would then read a replayed number from
    // this generation forever. Both syncs are needed — the file for its
    // contents, the directory for the rename itself.
    const tmp = file + '.tmp';
    const fd = deskFs.openSync(tmp, 'w', 0o600);
    try {
      deskFs.writeFileSync(fd, JSON.stringify(state));
      deskFs.fsyncSync(fd);
    } finally {
      deskFs.closeSync(fd);
    }
    deskFs.renameSync(tmp, file);
    const dirFd = deskFs.openSync(dir, 'r');
    try {
      deskFs.fsyncSync(dirFd);
    } finally {
      deskFs.closeSync(dirFd);
    }
    return state;
  });
}

function deskBounded(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > DESK_MAX_DETAIL ? trimmed.slice(0, DESK_MAX_DETAIL - 1) + '\\u2026' : trimmed;
}

function deskGeneration() {
  const raw = Number(process.env.${GENERATION_ENV_VAR});
  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

async function deskPost(observation) {
  const sessionId = process.env.DESK_SESSION_ID;
  const generation = deskGeneration();
  // No identity, no generation, or no recognised producer means the event
  // cannot be fenced or bound. Sending it anyway would be worse than silence:
  // it would be accepted as belonging to whatever generation is current.
  if (!sessionId || !generation || !observation || !DESK_PRODUCER) return false;
  const claim = deskClaimSequence(sessionId, generation);
  if (!claim) return false;
  const now = Date.now();
  const eventId = claim.instanceId + ':' + String(claim.seq);
  const body = {
    schemaVersion: DESK_SCHEMA_VERSION,
    sessionId: sessionId,
    generation: generation,
    provider: DESK_PROVIDER,
    mode: 'terminal',
    producer: DESK_PRODUCER,
    producerInstanceId: claim.instanceId,
    producerSeq: claim.seq,
    eventId: eventId,
    // Correlates every fact derived from THIS observation; the authority
    // deduplicates on eventId and groups on invocationId.
    invocationId: eventId,
    occurredAt: now,
    observation: observation
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch((process.env.DESK_API || 'http://127.0.0.1:5173') + '/api/agent-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // fetch resolves for 4xx/5xx, so a server that REJECTS the event would
    // otherwise leave no trail at all.
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return true;
  } catch (err) {
    if (process.env.DESK_DEBUG) {
      process.stderr.write('[desk-producer] agent-event POST failed: ' + (err && err.message ? err.message : String(err)) + '\\n');
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Producer endpoint registration.
 *
 * Recovery after a restart needs an ADDRESS to ask, and only the producer
 * knows it: the OpenCode plugin is handed its server URL at load, and Desk
 * has no other way to learn it. Without this the promised "reconcile on
 * restart" path cannot run at all, and a session stays unknown until its agent
 * happens to act again.
 *
 * The agent's own session id travels with it because one Desk session hosts
 * MANY internal agent sessions. Polling the whole status map and taking any
 * busy entry would resurrect the state of a different conversation — a stale
 * busy is exactly the confident wrong answer this design exists to prevent.
 *
 * This is transport metadata, not a fact: it never enters the canonical
 * envelope, which carries only what an agent did.
 */
let deskRegisteredEndpoint;
let deskRegisteredProviderSession;

async function deskRegisterEndpoint(serverUrl, providerSessionId) {
  const sessionId = process.env.DESK_SESSION_ID;
  const generation = deskGeneration();
  if (!sessionId || !generation || !DESK_PRODUCER || !serverUrl) return false;
  // Re-register only when something actually changed: a new internal agent
  // session is a new poll target, and re-sending the same pair every event
  // would be pure noise on the control plane.
  if (deskRegisteredEndpoint === serverUrl && deskRegisteredProviderSession === providerSessionId) return true;
  // Registration claims from the SAME durable sequence as events, so the
  // daemon can bind this metadata to a producer identity it has already seen.
  // Unbound endpoint metadata is spoofable: anything that can reach the port
  // could name a poll target, and the daemon would have no way to tell it from
  // the real producer. Claiming here leaves gaps in the event stream's numbers;
  // that is fine — the contract is monotonicity, not contiguity.
  const claim = deskClaimSequence(sessionId, generation);
  if (!claim) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch((process.env.DESK_API || 'http://127.0.0.1:5173') + '/api/agent-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        schemaVersion: DESK_SCHEMA_VERSION,
        sessionId: sessionId,
        generation: generation,
        provider: DESK_PROVIDER,
        mode: 'terminal',
        producer: DESK_PRODUCER,
        producerInstanceId: claim.instanceId,
        producerSeq: claim.seq,
        endpoint: String(serverUrl),
        providerSessionId: providerSessionId
      })
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    deskRegisteredEndpoint = serverUrl;
    deskRegisteredProviderSession = providerSessionId;
    return true;
  } catch (err) {
    // Registration failing must never break the agent. The cost is a slower
    // recovery, not a wrong state: without an endpoint the session simply
    // reads unknown after a restart, which is true.
    if (process.env.DESK_DEBUG) {
      process.stderr.write('[desk-producer] endpoint registration failed: ' + (err && err.message ? err.message : String(err)) + '\\n');
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Heartbeats only refresh a lease, so a burst collapses to one per window.
// Streaming hooks can fire per token; a POST per token would flood the server
// to prove something one POST already proves.
const DESK_HEARTBEAT_WINDOW_MS = 5000;
let deskLastBeatAt = 0;
async function deskThrottledPost(observation) {
  const now = Date.now();
  if (now - deskLastBeatAt < DESK_HEARTBEAT_WINDOW_MS) return;
  deskLastBeatAt = now;
  await deskPost(observation);
}
`;
}
