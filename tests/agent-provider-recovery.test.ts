import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  parseSessionStateSnapshot
} from '../src/shared/controlPlane/index.js';
import { moorEventStoreDir, moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import {
  createTerminalDaemon,
  type TerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

const PROVIDER_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaa';

class FakeUpgradeServer {
  listeners: UpgradeListener[] = [];

  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }

  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }
}

describe('daemon OpenCode recovery', () => {
  let home: string;
  let daemon: TerminalDaemon | undefined;
  let now: number;

  let priorTmpdir: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-agent-recovery-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
    priorTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = home; // event-store root derives from the spawn env TMPDIR
    now = 1_000;
  });

  afterEach(() => {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    daemon?.dispose();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function start(
    fetch: typeof globalThis.fetch,
    options: { activate?: boolean } = {}
  ): TerminalDaemon {
    daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      now: () => now,
      fetch,
      hookInstallationProbe: (provider) => ({
        provider,
        installed: true,
        trust: 'not-applicable'
      })
    });
    const ensured = daemon.router.sessions.ensure(
      'opencode-a',
      { rows: 24, cols: 80 },
      {
        kind: 'agent',
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal'
      }
    );
    expect(ensured).toMatchObject({ ok: true, generation: 2 });
    expect(
      daemon.agentEvent({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 2,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 1,
        eventId: 'plugin-a:push:1',
        invocationId: 'turn-1',
        occurredAt: 900,
        observedAt: 950,
        facts: [{ kind: 'heartbeat' }]
      }, { kind: 'producer-bootstrap' })
    ).toMatchObject({ kind: 'accepted' });
    const registration = {
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 2,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 2,
        endpoint: 'http://127.0.0.1:4096/',
        providerSessionId: PROVIDER_SESSION_ID,
        observedAt: 975
      } as const;
    expect(daemon.agentEndpoint(registration)).toMatchObject({
      kind: 'accepted',
      active: false
    });
    expect(daemon.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
    if (options.activate !== false) {
      const { observedAt: _observedAt, ...activation } = registration;
      void daemon.activateAgentEndpoint(activation);
    }
    return daemon;
  }

  it('uses only the registered provider session and emits canonical poll evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
        JSON.stringify({
          stale_other_conversation: { type: 'busy' },
          [PROVIDER_SESSION_ID]: { type: 'idle' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const running = start(fetch);
    await vi.waitFor(() => {
      expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle'
      });
    });
    now = 1_100;

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'reconciled' }
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4096/session/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'idle',
      evidence: {
        producerInstanceId: 'plugin-a',
        transport: 'poll',
        producerSeq: 2
      }
    });
  });

  it('fences reconciliation and provider-scoped events until exact activation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ [PROVIDER_SESSION_ID]: { type: 'idle' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const running = start(fetch, { activate: false });

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'endpoint-unregistered' }
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      running.agentEvent(
        {
          schemaVersion: AGENT_STATE_SCHEMA_VERSION,
          sessionId: 'opencode-a',
          generation: 2,
          provider: 'opencode',
          mode: 'terminal',
          producer: 'opencode-terminal',
          producerInstanceId: 'plugin-a',
          producerSeq: 3,
          eventId: 'plugin-a:push:3',
          invocationId: 'turn-3',
          occurredAt: 1_000,
          observedAt: 1_000,
          facts: [{ kind: 'activity', activity: 'working' }]
        },
        { kind: 'provider-session', providerSessionId: PROVIDER_SESSION_ID }
      )
    ).toMatchObject({ kind: 'rejected', reason: 'provider-session-unregistered' });

    await expect(
      running.activateAgentEndpoint({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 2,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 2,
        endpoint: 'http://127.0.0.1:4096/',
        providerSessionId: PROVIDER_SESSION_ID
      })
    ).resolves.toMatchObject({ kind: 'activated' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects a push fact from a different provider session without mutating state', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('poll intentionally unavailable'));
    const running = start(fetch);

    expect(
      running.agentEvent(
        {
          schemaVersion: AGENT_STATE_SCHEMA_VERSION,
          sessionId: 'opencode-a',
          generation: 2,
          provider: 'opencode',
          mode: 'terminal',
          producer: 'opencode-terminal',
          producerInstanceId: 'plugin-a',
          producerSeq: 3,
          eventId: 'plugin-a:push:3',
          invocationId: 'turn-3',
          occurredAt: 1_000,
          observedAt: 1_000,
          facts: [{ kind: 'activity', activity: 'working' }]
        },
        { kind: 'provider-session', providerSessionId: PROVIDER_SESSION_ID }
      )
    ).toMatchObject({ kind: 'accepted' });

    expect(
      running.agentEvent(
        {
          schemaVersion: AGENT_STATE_SCHEMA_VERSION,
          sessionId: 'opencode-a',
          generation: 2,
          provider: 'opencode',
          mode: 'terminal',
          producer: 'opencode-terminal',
          producerInstanceId: 'plugin-a',
          producerSeq: 4,
          eventId: 'plugin-a:push:4',
          invocationId: 'turn-4',
          occurredAt: 1_010,
          observedAt: 1_010,
          facts: [{ kind: 'activity', activity: 'idle' }]
        },
        { kind: 'provider-session', providerSessionId: 'provider-b' }
      )
    ).toEqual({
      kind: 'rejected',
      reason: 'provider-session-mismatch'
    });

    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'working'
    });
  });

  it('reconciles immediately after accepting a provider endpoint registration', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ [PROVIDER_SESSION_ID]: { type: 'idle' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const running = start(fetch);

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle',
        evidence: {
          producerInstanceId: 'plugin-a',
          transport: 'poll',
          producerSeq: 1
        }
      });
    });
  });

  it('does not aggregate another provider session into the selected Desk session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ stale_other_conversation: { type: 'busy' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const running = start(fetch);

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'unknown'
      });
    });
  });

  it('keeps unknown when the registered provider endpoint is unreachable', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('connection refused'));
    const running = start(fetch);

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'poll-failed' }
    ]);
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
  });

  it('isolates an unexpected recovery failure to its session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const running = start(fetch);
    const endpointPath = join(home, '_engine', 'agent-endpoints.json');
    rmSync(endpointPath, { force: true });
    mkdirSync(endpointPath);

    await expect(
      running.reconcileAgentProviders(['opencode-a', 'missing'])
    ).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'recovery-error' },
      { sessionId: 'missing', kind: 'skipped', reason: 'not-opencode-session' }
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
  });
});

// ---- committed moor event store fixture -------------------------------------
// Mirrors the byte rules of the real holder's four-slot committed store (the
// same rules tests/helpers/fake-moor-holder.ts enforces): body.N is canonical
// NDJSON (header + transition records), commit.N is the 92-byte MOORCMT1
// record carrying generation/epoch/index/range plus SHA-256(body) and CRC32C.

const storeEncoder = new TextEncoder();

/** §1.2 posix identity: tag 0x01 followed by the absolute rendezvous path. */
function moorStoreIdentity(sessionPath: string): Uint8Array {
  const bytes = Buffer.from(sessionPath);
  const identity = new Uint8Array(1 + bytes.length);
  identity[0] = 1;
  identity.set(bytes, 1);
  return identity;
}

function moorStoreHeader(generation: number, next: number, identity: Uint8Array): string {
  return `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(identity).toString('base64')}","generation":${generation},"epoch":0,"next_seq":${next},"first_retained":0}\n`;
}

function moorCommitRecord(
  slot: 0 | 1,
  generation: number,
  index: bigint,
  end: bigint,
  body: Uint8Array
): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(storeEncoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = slot;
  record[10] = slot;
  record[11] = 1; // MoorStoreKind.Event
  view.setUint32(12, generation, true);
  view.setUint32(16, 0, true); // epoch 0
  view.setBigUint64(24, index, true);
  view.setBigUint64(32, BigInt(body.length), true);
  view.setBigUint64(40, 0n, true); // start = first_retained
  view.setBigUint64(48, end, true); // end = next_seq
  record.set(createHash('sha256').update(body).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

/**
 * A REAL committed store the holder would leave behind: the canonical EMPTY
 * snapshot in slot 0 at initialization, every append re-committing the full
 * body into the alternate slot with a monotonically increasing commit index.
 */
/** A full OB-39 MoorStatus descriptor for a stubbed moor join. */
function fakeMoorStatus(
  sessionPath: string,
  generation: number,
  storeDir: string,
  frontier: { bodySlot: 0 | 1; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array }
) {
  return {
    identity: moorStoreIdentity(sessionPath),
    generation,
    incarnation: new Uint8Array(16).fill(0xa1),
    layout: 2,
    eventIdentity: new Uint8Array(Buffer.from(storeDir)), // raw posix bytes — no tag (real-binary form)
    bodySlot: frontier.bodySlot,
    commitIndex: frontier.commitIndex,
    bodyLength: frontier.bodyLength,
    bodyHash: frontier.bodyHash,
    wallStart: 1n,
    monotonicStart: 1n,
    bootIdentity: new Uint8Array(16).fill(0xb2),
    directory: new Uint8Array(0),
    pid: 4321,
    containment: 1,
    birthToken: new Uint8Array(16).fill(0xc3),
    replay: { first: 0n, last: 0n, start: 0n, end: 0n, complete: true, modesExact: true },
    ownsLease: true,
    viewers: true,
    running: true,
    eventWritable: true,
    leaseEpoch: 1,
    semanticFlags: 0,
    semanticPending: 0,
    log: { health: 0, epoch: 0, index: 0n, retainedStart: 0n, retainedEnd: 0n }
  };
}

class MoorStoreFixture {
  private readonly lines: string[] = [];
  private index = 1n;
  private slot: 0 | 1 = 0;
  private lastBodyLength = 0n;
  private lastBodyHash = new Uint8Array(32);

  frontier(): { bodySlot: 0 | 1; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array } {
    return {
      bodySlot: this.slot,
      commitIndex: this.index,
      bodyLength: this.lastBodyLength,
      bodyHash: this.lastBodyHash.slice()
    };
  }

  constructor(
    private readonly directory: string,
    private readonly generation: number,
    private readonly identity: Uint8Array
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const body = storeEncoder.encode(moorStoreHeader(generation, 0, identity));
    writeFileSync(join(directory, 'body.0'), body, { mode: 0o600 });
    writeFileSync(join(directory, 'commit.0'), moorCommitRecord(0, generation, 1n, 0n, body), {
      mode: 0o600
    });
    writeFileSync(join(directory, 'body.1'), new Uint8Array(), { mode: 0o600 });
    writeFileSync(join(directory, 'commit.1'), new Uint8Array(), { mode: 0o600 });
    this.lastBodyLength = BigInt(body.length);
    this.lastBodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  }

  append(type: string, ts: number | string, tail = ''): void {
    const seq = this.lines.length; // sequences are consumed from 0
    this.lines.push(`{"type":"${type}","ts":${ts},"epoch":0,"seq":${seq},"kind":"transition"${tail}}\n`);
    const next = this.lines.length;
    const body = storeEncoder.encode(
      moorStoreHeader(this.generation, next, this.identity) + this.lines.join('')
    );
    this.index += 1n;
    this.slot = this.slot === 0 ? 1 : 0;
    writeFileSync(join(this.directory, `body.${this.slot}`), body, { mode: 0o600 });
    writeFileSync(
      join(this.directory, `commit.${this.slot}`),
      moorCommitRecord(this.slot, this.generation, this.index, BigInt(next), body),
      { mode: 0o600 }
    );
    this.lastBodyLength = BigInt(body.length);
    this.lastBodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  }
}

describe('daemon moor title recovery', () => {
  let home: string;
  let daemon: TerminalDaemon | undefined;

  let priorTmpdir: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-moor-recovery-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
    priorTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = home; // event-store root derives from the spawn env TMPDIR
  });

  afterEach(async () => {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    await new Promise((resolve) => setTimeout(resolve, 10));
    daemon?.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps replayed history silent and recovers downtime title changes across a restart', async () => {
    const sessionId = 'opencode-a';
    const sessionPath = join(home, sessionId); // moor rendezvous: no .sock suffix
    const storeDir = moorEventStoreDir(moorEventStoreRoot('/bin/false'), sessionId, 2);
    const subject = {
      kind: 'agent' as const,
      provider: 'opencode' as const,
      mode: 'terminal' as const,
      producer: 'opencode-terminal' as const
    };
    const diagnostics: string[] = [];
    const create = () =>
      createTerminalDaemon({
        homeRoot: home,
        moorBinPath: '/bin/false',
        moorSocketRoot: home,
        httpServer: new FakeUpgradeServer(),
        moorEventPollIntervalMs: 5,
        onMoorEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.code),
        hookInstallationProbe: (provider) => ({
          provider,
          installed: true,
          trust: 'not-applicable'
        })
      });

    const first = create();
    daemon = first;
    let store: MoorStoreFixture | undefined;
    vi.spyOn(first.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (spawnSessionId, options) => {
        const ensured = first.router.sessions.ensure(
          spawnSessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId: spawnSessionId,
          generation: ensured.generation
        });
        expect(prepared).toEqual({ storeDir });
        // The holder materializes the committed store during launch.
        store = new MoorStoreFixture(
          storeDir,
          ensured.generation,
          moorStoreIdentity(options.sessionPath)
        );
        return {
          ...ensured,
          moorStatus: fakeMoorStatus(
            options.sessionPath,
            ensured.generation,
            storeDir,
            store.frontier()
          )
        };
      }
    );
    await expect(
      first.provision(sessionId, {
        command: ['opencode'],
        geometry: { rows: 24, cols: 80 },
        subject
      })
    ).resolves.toMatchObject({ ok: true, generation: 2 });

    store!.append('state', '1.250', ',"state":"idle","title":"Ready","truncated":false');
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle'
      });
    });
    const firstLatestSeq = first.events().latestSeq;
    expect(firstLatestSeq).toBeGreaterThan(0);

    store!.append('state', 2, ',"state":"busy","title":"\u280b x","truncated":false');
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'working'
      });
    });
    expect(first.events().latestSeq).toBe(firstLatestSeq);

    first.dispose();
    daemon = undefined;
    // Let any in-flight observer poll finish before the store advances, then
    // commit a transition while the daemon is DOWN.
    await new Promise((resolve) => setTimeout(resolve, 25));
    store!.append('state', 3, ',"state":"idle","title":"Ready","truncated":false');

    const second = create();
    daemon = second;
    // Native re-adoption at the durable ledger generation; the wire attach is
    // stubbed (the surviving holder is emulated by the pre-populated store),
    // and the adopted OB-39 authority is supplied via the status getter.
    vi.spyOn(second.router.sessions, 'moorAttachMaster').mockResolvedValue(true);
    const restored = await second.router.sessions.restoreAndAttachMoor(sessionId, {
      sessionPath,
      killSpec: { binPath: '/bin/true', args: [] },
      subject
    });
    expect(restored).toMatchObject({ ok: true, generation: 2 });
    vi.spyOn(second.router.sessions, 'moorStatus').mockReturnValue(
      fakeMoorStatus(sessionPath, 2, storeDir, store!.frontier())
    );
    vi.spyOn(second.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (spawnSessionId, options) => {
        const prepared = await options.prepareSpawn?.({
          sessionId: spawnSessionId,
          generation: 2
        });
        expect(prepared).toEqual({ storeDir });
        return {
          ok: true,
          generation: 2,
          created: false,
          moorStatus: fakeMoorStatus(options.sessionPath, 2, storeDir, store!.frontier())
        };
      }
    );
    await expect(
      second.provision(sessionId, {
        command: ['opencode'],
        geometry: { rows: 24, cols: 80 },
        subject
      })
    ).resolves.toMatchObject({ ok: true, generation: 2 });

    const snapshot = second.agentStates().snapshots[0];
    expect(snapshot).toBeDefined();
    expect(parseSessionStateSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot?.subject).toMatchObject({
      kind: 'agent',
      activity: 'idle',
      evidence: { source: 'terminal-title', observedAt: 3_000 }
    });
    expect(second.terminalObservation(sessionId)).toMatchObject({
      generation: 2,
      activity: 'idle',
      activityAt: 3_000,
      title: 'Ready'
    });
    // The moor observer's replay cursor is in-memory only: after a restart the
    // WHOLE committed store replays as consumed history — silenced — and the
    // downtime catch-up publishes exactly ONE summary event carrying the
    // final caught-up state (the busy→idle completion committed while the
    // daemon was down), never the replayed history itself.
    expect(second.events().latestSeq).toBe(firstLatestSeq + 1);
    const summary = second.events().items[0];
    expect(summary).toMatchObject({ kind: 'agent-idle', sessionId, generation: 2 });
    expect(diagnostics).toEqual([]);

    store!.append('state', 4, ',"state":"busy","title":"\u280b x","truncated":false');
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'working'
      });
    });
    // A live busy transition projects no desk event \u2014 the count stays at the
    // restart summary.
    expect(second.events().latestSeq).toBe(firstLatestSeq + 1);

    // The committed store is append-only (truncation would be terminal
    // corruption, never a resync): a post-restart LIVE idle transition
    // publishes as ever, on top of the one catch-up summary.
    store!.append('state', 5, ',"state":"idle","title":"Ready","truncated":false');
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle'
      });
    });
    expect(second.events().latestSeq).toBe(firstLatestSeq + 2);
    expect(diagnostics).toEqual([]);
  });
});
