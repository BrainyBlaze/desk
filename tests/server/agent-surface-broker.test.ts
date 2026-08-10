import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AgentSurfaceBroker,
  installAgentSurfaceBroker,
  type AgentSurfaceBrokerOptions
} from '../../src/server/agentSurfaceBroker';
import {
  deriveAgentHostToken,
  getOrCreateAgentHostSecret
} from '../../src/server/agentHostToken';
import type {
  AgentHostClientFrame,
  AgentHostServerFrame,
  AgentSurfaceEvent,
  AgentUiClientFrame,
  AgentUiServerFrame
} from '../../src/core/agentSurfaceProtocol';
import type { AgentStateEnvelope } from '../../src/shared/controlPlane/contract';

const SECRET = getOrCreateAgentHostSecret();

function tokenFor(session: string, agent: string): string {
  return deriveAgentHostToken(SECRET, session, agent);
}

const NOOP_AGENT_STATE_PUBLISHER = (): void => undefined;

/** In-memory WebSocket pair that lets a test act as both broker-side server and a peer. */
interface TestPeer {
  ws: WebSocket;
  received: unknown[];
  send(frame: unknown): void;
  close(): void;
  waitFor<T = unknown>(predicate: (frame: unknown) => boolean, timeoutMs?: number): Promise<T>;
}

async function startBroker(
  options: AgentSurfaceBrokerOptions = {},
  installOptions: { maxPayloadBytes?: number } = {}
): Promise<{ broker: AgentSurfaceBroker; close: () => void; port: number; connectHost: () => Promise<TestPeer>; connectBrowser: () => Promise<TestPeer> }> {
  const httpServer: Server = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = httpServer.address() as { port: number };
  const broker = new AgentSurfaceBroker({
    publishAgentState: NOOP_AGENT_STATE_PUBLISHER,
    bindProviderSession: async () => ({ ok: true, kind: 'already-bound' }),
    readProviderSessionBinding: ({ deskSessionId }) => ({
      ok: false,
      code: 'provider-session-not-found',
      error: `Desk session not found: ${deskSessionId}`
    }),
    completeLaunchAuthorization: async () => undefined,
    terminateNativeGeneration: async () => undefined,
    ...options,
    resolveSecret: () => SECRET
  });
  const dispose = installAgentSurfaceBroker(httpServer as never, broker, installOptions);
  return {
    broker,
    port: addr.port,
    close: () => {
      dispose();
      httpServer.close();
    },
    connectHost: () => connectTo(`ws://127.0.0.1:${addr.port}/ws/agent-host`),
    connectBrowser: () => connectTo(`ws://127.0.0.1:${addr.port}/ws/agent-ui`)
  };
}

function connectTo(url: string): Promise<TestPeer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received: unknown[] = [];
    const peer: TestPeer = {
      ws,
      received,
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: () => ws.close(),
      waitFor: <T = unknown>(predicate: (frame: unknown) => boolean, timeoutMs = 500) =>
        new Promise<T>((res, rej) => {
          const start = Date.now();
          const tick = (): void => {
            const found = received.find(predicate);
            if (found) {
              res(found as T);
              return;
            }
            if (Date.now() - start > timeoutMs) {
              rej(new Error('waitFor timeout'));
              return;
            }
            setTimeout(tick, 10);
          };
          tick();
        })
    };
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
    ws.on('open', () => resolve(peer));
    ws.on('error', reject);
  });
}

function event(seq: number, kind: AgentSurfaceEvent['kind'], overrides: Record<string, unknown> = {}): AgentSurfaceEvent {
  return {
    kind,
    seq,
    ts: new Date().toISOString(),
    ...overrides
  } as AgentSurfaceEvent;
}

function hostHello(
  session: string,
  agent: 'claude' | 'codex' | 'opencode',
  pid = 1,
  overrides: Partial<Extract<AgentHostClientFrame, { type: 'hello' }>> = {}
): Extract<AgentHostClientFrame, { type: 'hello' }> {
  return {
    type: 'hello',
    session,
    agent,
    token: tokenFor(session, agent),
    pid,
    generation: 1,
    producerInstanceId: `native-${session}-${pid}`,
    ...overrides
  };
}

const PROVIDER_SESSION_IDS = {
  claude: '11111111-2222-4333-8444-555555555555',
  codex: '019ec5e5-78dc-7eb3-99d9-2a98122d6ad7',
  opencode: 'ses_abc123def456ghi789jkl012mno345pqr678stu901vwx'
} as const;

async function authorizeHost(
  broker: AgentSurfaceBroker,
  host: TestPeer,
  session: string,
  agent: keyof typeof PROVIDER_SESSION_IDS,
  seq = 1
): Promise<void> {
  host.send({
    type: 'event',
    event: event(seq, 'session-info', { agentSessionId: PROVIDER_SESSION_IDS[agent] })
  });
  await waitUntil(
    () => broker.snapshot().find((entry) => entry.session === session)?.lastSeq === seq
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitUntil timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentSurfaceBroker — host handshake', () => {
  it('accepts hello with a valid token + sends hello-ack with lastSeq=0 for a fresh session', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode', 123));
    const ack = await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    expect(ack).toMatchObject({ type: 'hello-ack', lastSeq: 0 });
    host.close();
    harness.close();
  });

  it('rejects hello with a wrong-token and closes the socket', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode', 123, { token: 'wrong' }));
    const err = await host.waitFor((f) => (f as { type?: string }).type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'invalid-frame' });
    harness.close();
  });

  it('rejects first frame that is not hello', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send({ type: 'event', event: event(1, 'status', { state: 'idle' }) });
    const err = await host.waitFor((f) => (f as { type?: string }).type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'invalid-frame' });
    harness.close();
  });
});

describe('AgentSurfaceBroker — transport payload limits', () => {
  it('closes oversized raw frames on both host and browser sockets before parsing', async () => {
    const harness = await startBroker({}, { maxPayloadBytes: 128 });
    for (const connect of [harness.connectHost, harness.connectBrowser]) {
      const peer = await connect();
      const closed = new Promise<number>((resolve) => peer.ws.once('close', resolve));
      peer.ws.send('x'.repeat(129));
      await expect(closed).resolves.toBe(1009);
    }
    harness.close();
  });
});

describe('AgentSurfaceBroker — surface subscription + snapshot', () => {
  it('sends ready on browser connect', async () => {
    const harness = await startBroker();
    const browser = await harness.connectBrowser();
    const ready = await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    expect(ready).toMatchObject({ type: 'ready', version: 1 });
    browser.close();
    harness.close();
  });

  it('snapshot reflects conversation ring + lastSeq without a second semantic state', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'codex'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'codex');
    host.send({ type: 'event', event: event(2, 'status', { state: 'idle' }) });
    host.send({ type: 'event', event: 2, } as never); // placeholder to ensure waitFor race
    // Two committed events
    host.send({ type: 'event', event: event(3, 'assistant-message', { id: 'm1', turnId: 'm1', markdown: 'hi' }) });
    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's1', surfaceId: 'surf-1', visible: true });
    const snapshot = await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      session: 's1',
      surfaceId: 'surf-1',
      lastSeq: 3
    });
    expect(snapshot).not.toHaveProperty('state');
    if (!(snapshot as { events?: unknown[] }).events) throw new Error('events missing');
    expect((snapshot as { events: { kind: string }[] }).events.map((e) => e.kind)).toContain('assistant-message');
    browser.close();
    host.close();
    harness.close();
  });

  it('evicts the oldest committed events when the replay byte budget is reached', async () => {
    const first = event(2, 'assistant-message', { id: 'm1', turnId: 't1', markdown: 'a'.repeat(256) });
    const second = event(3, 'assistant-message', { id: 'm2', turnId: 't2', markdown: 'b'.repeat(256) });
    const harness = await startBroker({ ringSize: 10, ringMaxBytes: Buffer.byteLength(JSON.stringify(second)) + 8 });
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'codex'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'codex');
    host.send({ type: 'event', event: first });
    host.send({ type: 'event', event: second });

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's1', surfaceId: 'surf-1', visible: true });
    const snapshot = await browser.waitFor<{ type: string; events: AgentSurfaceEvent[] }>(
      (f) => (f as { type?: string }).type === 'snapshot'
    );

    expect(snapshot.events.map((retained) => retained.seq)).toEqual([3]);
    browser.close();
    host.close();
    harness.close();
  });

  it('live-forwards an individually oversized event without flushing prior replay history', async () => {
    const retained = event(2, 'assistant-message', { id: 'm1', turnId: 't1', markdown: 'small' });
    const oversized = event(3, 'assistant-message', { id: 'm2', turnId: 't2', markdown: 'x'.repeat(1024) });
    const harness = await startBroker({ ringSize: 10, ringMaxBytes: Buffer.byteLength(JSON.stringify(retained)) + 8 });
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'codex'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'codex');
    host.send({ type: 'event', event: retained });

    const liveBrowser = await harness.connectBrowser();
    await liveBrowser.waitFor((f) => (f as { type?: string }).type === 'ready');
    liveBrowser.send({ type: 'subscribe', session: 's1', surfaceId: 'live', visible: true });
    await liveBrowser.waitFor((f) => (f as { type?: string }).type === 'snapshot');
    host.send({ type: 'event', event: oversized });
    await liveBrowser.waitFor(
      (f) => (f as { type?: string; event?: { seq?: number } }).type === 'event' && (f as { event?: { seq?: number } }).event?.seq === 3
    );

    const replayBrowser = await harness.connectBrowser();
    await replayBrowser.waitFor((f) => (f as { type?: string }).type === 'ready');
    replayBrowser.send({ type: 'subscribe', session: 's1', surfaceId: 'replay', visible: true });
    const snapshot = await replayBrowser.waitFor<{ type: string; events: AgentSurfaceEvent[] }>(
      (f) => (f as { type?: string }).type === 'snapshot'
    );
    expect(snapshot.events.map((event) => event.seq)).toEqual([2]);

    replayBrowser.close();
    liveBrowser.close();
    host.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — visibility-gated forwarding', () => {
  it('visible surface receives delta events; hidden does not', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'claude'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'claude');

    const visible = await harness.connectBrowser();
    await visible.waitFor((f) => (f as { type?: string }).type === 'ready');
    visible.send({ type: 'subscribe', session: 's1', surfaceId: 'vis', visible: true });
    await visible.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    const hidden = await harness.connectBrowser();
    await hidden.waitFor((f) => (f as { type?: string }).type === 'ready');
    hidden.send({ type: 'subscribe', session: 's1', surfaceId: 'hid', visible: false });
    // hidden subscription sends no snapshot (visible=false)

    host.send({ type: 'event', event: event(2, 'assistant-delta', { turnId: 't1', text: 'chunk' }) });
    const visFrame = await visible.waitFor((f) => (f as { type?: string; event?: { kind: string } }).type === 'event' && (f as { event: { kind: string } }).event?.kind === 'assistant-delta');
    expect(visFrame).toBeDefined();
    // hidden should not have received the delta — wait briefly to be sure
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hidden.received.some((f) => (f as { type?: string }).type === 'event')).toBe(false);

    // Both surfaces receive committed events regardless of visibility
    host.send({ type: 'event', event: event(3, 'assistant-message', { id: 't1', turnId: 't1', markdown: 'commit' }) });
    await visible.waitFor((f) => (f as { type?: string; event?: { kind: string } }).type === 'event' && (f as { event: { kind: string } }).event?.kind === 'assistant-message');
    await hidden.waitFor((f) => (f as { type?: string; event?: { kind: string } }).type === 'event' && (f as { event: { kind: string } }).event?.kind === 'assistant-message');

    visible.close();
    hidden.close();
    host.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — surface → host command routing', () => {
  it('rejects commands from a subscribed but hidden surface', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's1', surfaceId: 'hidden', visible: false });
    browser.send({ type: 'send', session: 's1', surfaceId: 'hidden', text: 'must not send' });
    browser.send({ type: 'respond-permission', session: 's1', surfaceId: 'hidden', requestId: 'perm-1', optionId: 'allow' });
    browser.send({ type: 'interrupt', session: 's1', surfaceId: 'hidden' });

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 500;
      const poll = (): void => {
        if (browser.received.filter((f) => (f as { type?: string }).type === 'error').length >= 3) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('timed out waiting for hidden-surface errors'));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });

    expect(browser.received.filter((f) => (f as { type?: string }).type === 'error')).toHaveLength(3);
    expect(host.received.filter((f) => ['inject', 'respond-permission', 'interrupt'].includes((f as { type?: string }).type ?? ''))).toHaveLength(0);
    browser.close();
    host.close();
    harness.close();
  });

  it('rejects permission responses and interrupts from an unsubscribed surface', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'respond-permission', session: 's1', surfaceId: 'unsubscribed', requestId: 'perm-1', optionId: 'allow' });
    browser.send({ type: 'interrupt', session: 's1', surfaceId: 'unsubscribed' });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 500;
      const poll = (): void => {
        const errors = browser.received.filter((f) => (f as { type?: string }).type === 'error');
        if (errors.length >= 2) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('timed out waiting for subscription errors'));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    const errors = browser.received.filter((f) => (f as { type?: string }).type === 'error');
    expect(errors).toHaveLength(2);
    expect(host.received.filter((f) => ['respond-permission', 'interrupt'].includes((f as { type?: string }).type ?? ''))).toHaveLength(0);
    browser.close();
    host.close();
    harness.close();
  });

  it('subscribe + send forwards an inject command to the host with a fresh requestId', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's1', surfaceId: 'surf-1', visible: true });
    await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    browser.send({ type: 'send', session: 's1', surfaceId: 'surf-1', text: 'hello' });
    const injectFrame = await host.waitFor((f) => (f as { type?: string }).type === 'inject') as unknown as AgentHostServerFrame;
    if ((injectFrame as { type: string }).type !== 'inject') throw new Error('narrow');
    expect((injectFrame as { text: string }).text).toBe('hello');
    expect((injectFrame as { source: string }).source).toBe('ui');
    const requestId = (injectFrame as { requestId: string }).requestId;
    expect(typeof requestId).toBe('string');

    // Host replies command-result ok:true — broker should not forward to browser (only errors)
    host.send({ type: 'command-result', requestId, ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(browser.received.some((f) => (f as { type?: string }).type === 'error')).toBe(false);

    browser.close();
    host.close();
    harness.close();
  });

  it('command-result ok:false surfaces a typed error frame to the originating surface', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's1', surfaceId: 'surf-1', visible: true });
    await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    browser.send({ type: 'send', session: 's1', surfaceId: 'surf-1', text: 'fail' });
    const injectFrame = await host.waitFor((f) => (f as { type?: string }).type === 'inject');
    const requestId = (injectFrame as { requestId: string }).requestId;
    host.send({
      type: 'command-result',
      requestId,
      ok: false,
      error: { code: 'send-while-busy', message: 'driver mid-turn', retryable: false }
    });

    const err = await browser.waitFor((f) => (f as { type?: string }).type === 'error');
    expect(err).toMatchObject({
      type: 'error',
      session: 's1',
      code: 'send-while-busy',
      message: 'driver mid-turn'
    });

    browser.close();
    host.close();
    harness.close();
  });

  it('send to a session with no host raises adapter-unavailable error', async () => {
    const harness = await startBroker();
    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's-no-host', surfaceId: 'surf-1', visible: true });
    browser.send({ type: 'send', session: 's-no-host', surfaceId: 'surf-1', text: 'hi' });
    const err = await browser.waitFor((f) => (f as { type?: string; code?: string }).type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'adapter-unavailable' });
    browser.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — host reconnect semantics', () => {
  it('new pid hello resets ring + lastSeq (broker ring reset per spec §4)', async () => {
    const harness = await startBroker();
    const host1 = await harness.connectHost();
    host1.send(hostHello('s1', 'codex', 100));
    await host1.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host1, 's1', 'codex');
    host1.send({ type: 'event', event: event(2, 'assistant-message', { id: 'm1', turnId: 'm1', markdown: 'old' }) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    host1.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // New pid reconnects
    const host2 = await harness.connectHost();
    host2.send(hostHello('s1', 'codex', 200));
    const ack = await host2.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    expect(ack).toMatchObject({ type: 'hello-ack', lastSeq: 0 }); // ring was reset

    host2.close();
    harness.close();
  });

  it('same pid reconnect (transient drop) keeps ring + lastSeq', async () => {
    const harness = await startBroker();
    const host1 = await harness.connectHost();
    host1.send(hostHello('s1', 'codex', 100));
    await host1.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host1, 's1', 'codex');
    host1.send({ type: 'event', event: event(5, 'assistant-message', { id: 'm1', turnId: 'm1', markdown: 'data' }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    host1.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const host2 = await harness.connectHost();
    host2.send(hostHello('s1', 'codex', 100));
    const ack = await host2.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    expect(ack).toMatchObject({ type: 'hello-ack', lastSeq: 5 });

    host2.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — canonical native observations', () => {
  it('publishes generation-fenced facts and correlations in producer order', async () => {
    const published: AgentStateEnvelope[] = [];
    const observedAt = Date.parse('2026-07-27T15:00:00.000Z');
    const harness = await startBroker({
      now: () => observedAt,
      publishAgentState: (envelope) => {
        published.push(envelope);
      }
    });
    const host = await harness.connectHost();
    host.send(
      hostHello('s1', 'claude', 41, {
        generation: 7,
        producerInstanceId: 'native-instance-7'
      })
    );
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'claude');

    host.send({
      type: 'event',
      event: event(2, 'status', {
        state: 'processing',
        ts: '2026-07-27T14:59:58.000Z'
      })
    });
    host.send({
      type: 'event',
      event: event(3, 'tool-start', {
        toolUseId: 'tool-1',
        name: 'Read',
        summary: 'reading'
      })
    });
    host.send({
      type: 'event',
      event: event(4, 'permission-request', {
        requestId: 'perm-1',
        variant: 'file-edit',
        title: 'Edit file',
        options: [{ id: 'allow', label: 'Allow', treatment: 'allow' }]
      })
    });
    host.send({
      type: 'event',
      event: event(5, 'turn-complete', { turnId: 'turn-1' })
    });

    await waitUntil(() => published.length === 6);
    expect(published.map((envelope) => envelope.producerSeq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(published.map((envelope) => envelope.eventId)).toEqual([
      'native-instance-7:1',
      'native-instance-7:2',
      'native-instance-7:3',
      'native-instance-7:4',
      'native-instance-7:5',
      'native-instance-7:6'
    ]);
    expect(published[0]).toMatchObject({
      schemaVersion: 3,
      sessionId: 's1',
      generation: 7,
      provider: 'claude',
      mode: 'native',
      producer: 'claude-native',
      producerInstanceId: 'native-instance-7',
      invocationId: 'native-instance-7:1',
      occurredAt: observedAt,
      observedAt,
      facts: [
        { kind: 'activity', activity: 'unknown' },
        { kind: 'health', health: { status: 'healthy' } }
      ]
    });
    expect(published[2]).toMatchObject({
      occurredAt: Date.parse('2026-07-27T14:59:58.000Z'),
      facts: [{ kind: 'activity', activity: 'working' }]
    });
    expect(published[3]).toMatchObject({
      facts: [{ kind: 'activity', activity: 'working' }],
      correlation: { toolUseId: 'tool-1' }
    });
    expect(published[4]).toMatchObject({
      facts: [
        {
          kind: 'blocked',
          wait: { kind: 'permission-file-edit', owner: 'operator', detail: 'Edit file' }
        }
      ],
      correlation: { permissionId: 'perm-1' }
    });
    expect(published[5]).toMatchObject({
      facts: [{ kind: 'activity', activity: 'idle' }],
      correlation: { turnId: 'turn-1' }
    });

    host.close();
    harness.close();
  });

  it('publishes unknown + degraded when the authoritative native host disconnects', async () => {
    const published: AgentStateEnvelope[] = [];
    const harness = await startBroker({
      publishAgentState: (envelope) => {
        published.push(envelope);
      }
    });
    const host = await harness.connectHost();
    host.send(
      hostHello('s1', 'opencode', 9, {
        generation: 3,
        producerInstanceId: 'native-instance-3'
      })
    );
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');
    await waitUntil(() => published.length === 2);

    host.close();
    await waitUntil(() => published.length === 3);
    expect(published[2]).toMatchObject({
      sessionId: 's1',
      generation: 3,
      producer: 'opencode-native',
      producerInstanceId: 'native-instance-3',
      producerSeq: 3,
      facts: [
        { kind: 'activity', activity: 'unknown' },
        {
          kind: 'health',
          health: {
            status: 'degraded',
            reason: 'native-host-disconnected'
          }
        }
      ]
    });

    harness.close();
  });

  it('contains no attention synthesis or broker-owned semantic current state', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/server/agentSurfaceBroker.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /AttentionSink|attentionTracker|notifyAgentSignal|synthesizeAttention|currentState/
    );
  });
});

describe('AgentSurfaceBroker — server-internal injectUserMessage', () => {
  it('rejects when no host is connected', async () => {
    const harness = await startBroker();
    await expect(harness.broker.injectUserMessage('s-no-host', 'hi', 'channel')).rejects.toMatchObject({
      code: 'adapter-unavailable'
    });
    harness.close();
  });

  it('forwards inject to host with source=channel and resolves on command-result ok:true', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');

    const injectPromise = harness.broker.injectUserMessage('s1', 'channel msg', 'channel');
    const injectFrame = await host.waitFor((f) => (f as { type?: string }).type === 'inject') as unknown as { requestId: string; source: string; text: string };
    expect(injectFrame.source).toBe('channel');
    expect(injectFrame.text).toBe('channel msg');
    host.send({ type: 'command-result', requestId: injectFrame.requestId, ok: true });
    await expect(injectPromise).resolves.toBeUndefined();

    host.close();
    harness.close();
  });

  it('rejects server-internal injectUserMessage with the typed command-result error on ok:false', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send(hostHello('s1', 'opencode'));
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host, 's1', 'opencode');

    const injectPromise = harness.broker.injectUserMessage('s1', 'channel msg', 'channel');
    const injectFrame = (await host.waitFor((f) => (f as { type?: string }).type === 'inject')) as unknown as { requestId: string };
    host.send({
      type: 'command-result',
      requestId: injectFrame.requestId,
      ok: false,
      error: { code: 'send-while-busy', message: 'driver mid-turn', retryable: true }
    });

    await expect(injectPromise).rejects.toMatchObject({
      code: 'send-while-busy',
      message: 'driver mid-turn',
      retryable: true
    });

    host.close();
    harness.close();
  });
});

// Test surface types for clarity (avoids naming collisions)
type _A = AgentUiClientFrame;
type _B = AgentUiServerFrame;
type _C = AgentHostClientFrame;

describe('AgentSurfaceBroker — exact provider-session binding', () => {
  const providerId = 'ses_abc123def456ghi789jkl012mno345pqr678stu901vwx';

  it('hydrates a durable binding before a surviving host replays non-identity events after server restart', async () => {
    const terminated: Array<{ sessionId: string; generation: number }> = [];
    const harness = await startBroker({
      readProviderSessionBinding: () => ({
        ok: true,
        provider: 'codex',
        providerSessionId: PROVIDER_SESSION_IDS.codex
      }),
      terminateNativeGeneration: async (sessionId, generation) => {
        terminated.push({ sessionId, generation });
      }
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-restarted-server', 'codex', 41, { generation: 7 }));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');

    host.send({
      type: 'event',
      event: event(1, 'assistant-message', {
        id: 'replayed-message',
        turnId: 'replayed-turn',
        markdown: 'survived restart'
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(terminated).toEqual([]);
    expect(harness.broker.snapshot()).toEqual([
      { session: 'sess-restarted-server', lastSeq: 1, hostConnected: true }
    ]);
    expect(host.received).not.toContainEqual(
      expect.objectContaining({ type: 'error' })
    );

    host.close();
    harness.close();
  });

  it('awaits persisted binding and launch completion before retention, publication, or fan-out', async () => {
    const order: string[] = [];
    let resolveBinding!: () => void;
    const bindingPending = new Promise<void>((resolve) => {
      resolveBinding = resolve;
    });
    const published: AgentStateEnvelope[] = [];
    const bindProviderSession = async () => {
      order.push('bind');
      await bindingPending;
      return { ok: true as const, kind: 'persisted' as const };
    };
    const harness = await startBroker({
      publishAgentState: (envelope) => {
        published.push(envelope);
        order.push('publish');
      },
      bindProviderSession,
      completeLaunchAuthorization: async () => {
        order.push('complete');
      },
      terminateNativeGeneration: async () => undefined
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-bind', 'opencode'));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    expect(published).toEqual([]);
    order.length = 0;

    const browser = await harness.connectBrowser();
    await browser.waitFor((frame) => (frame as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 'sess-bind', surfaceId: 'surface', visible: true });
    await browser.waitFor((frame) => (frame as { type?: string }).type === 'snapshot');
    browser.received.length = 0;

    host.send({ type: 'event', event: event(1, 'session-info', { agentSessionId: providerId }) });
    await waitUntil(() => order.includes('bind'));
    expect(order).toEqual(['bind']);
    expect(published).toEqual([]);
    expect(browser.received).toEqual([]);
    expect(harness.broker.snapshot()).toEqual([
      { session: 'sess-bind', lastSeq: 0, hostConnected: true }
    ]);

    resolveBinding();
    await browser.waitFor(
      (frame) =>
        (frame as { type?: string; event?: { kind?: string } }).type === 'event' &&
        (frame as { event?: { kind?: string } }).event?.kind === 'session-info'
    );
    await waitUntil(() => published.length === 2);
    expect(order).toEqual(['bind', 'complete', 'publish', 'publish']);
    expect(harness.broker.snapshot()[0]?.lastSeq).toBe(1);

    const replay = await harness.connectBrowser();
    await replay.waitFor((frame) => (frame as { type?: string }).type === 'ready');
    replay.send({ type: 'subscribe', session: 'sess-bind', surfaceId: 'replay', visible: true });
    const snapshot = await replay.waitFor<{ events: AgentSurfaceEvent[] }>(
      (frame) => (frame as { type?: string }).type === 'snapshot'
    );
    expect(snapshot.events).toEqual([
      expect.objectContaining({ kind: 'session-info', agentSessionId: providerId })
    ]);

    replay.close();
    browser.close();
    host.close();
    harness.close();
  });

  it('treats already-bound as success before publication and fan-out', async () => {
    const order: string[] = [];
    const harness = await startBroker({
      bindProviderSession: async () => {
        order.push('bind');
        return { ok: true, kind: 'already-bound' };
      },
      completeLaunchAuthorization: async () => {
        order.push('complete');
      },
      terminateNativeGeneration: async () => undefined,
      publishAgentState: () => {
        order.push('publish');
      }
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-bound', 'opencode'));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    expect(order).toEqual([]);

    host.send({ type: 'event', event: event(1, 'session-info', { agentSessionId: providerId }) });
    await waitUntil(() => order.length === 4);
    expect(order).toEqual(['bind', 'complete', 'publish', 'publish']);
    expect(harness.broker.snapshot()[0]?.lastSeq).toBe(1);

    host.close();
    harness.close();
  });

  it('uses the daemon completion route by default before authorizing a host', async () => {
    const previousFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, kind: 'not-required' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const harness = await startBroker({
      completeLaunchAuthorization: undefined
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    try {
      host.send(hostHello('sess-default-complete', 'opencode'));
      await host.waitFor(
        (frame) => (frame as { type?: string }).type === 'hello-ack'
      );
      host.send({
        type: 'event',
        event: event(1, 'session-info', { agentSessionId: providerId })
      });

      await waitUntil(() => fetchMock.mock.calls.length === 1);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:5178/control/provider-session/complete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            deskSessionId: 'sess-default-complete',
            provider: 'opencode',
            providerSessionId: providerId,
            generation: 1
          })
        })
      );
      await waitUntil(
        () =>
          harness.broker.snapshot()[0]?.lastSeq === 1
      );
    } finally {
      host.close();
      harness.close();
      globalThis.fetch = previousFetch;
    }
  });

  it('rejects a successful daemon response without a completion receipt', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    ) as typeof fetch;
    const terminated: Array<{ sessionId: string; generation: number }> = [];
    const harness = await startBroker({
      completeLaunchAuthorization: undefined,
      terminateNativeGeneration: async (sessionId, generation) => {
        terminated.push({ sessionId, generation });
      }
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    try {
      host.send(hostHello('sess-invalid-receipt', 'opencode'));
      await host.waitFor(
        (frame) => (frame as { type?: string }).type === 'hello-ack'
      );
      host.send({
        type: 'event',
        event: event(1, 'session-info', { agentSessionId: providerId })
      });

      await waitUntil(() => terminated.length === 1);
      await waitUntil(() => host.ws.readyState === WebSocket.CLOSED);
      expect(terminated).toEqual([
        { sessionId: 'sess-invalid-receipt', generation: 1 }
      ]);
      expect(harness.broker.snapshot()).toEqual([
        {
          session: 'sess-invalid-receipt',
          lastSeq: 0,
          hostConnected: false
        }
      ]);
    } finally {
      host.close();
      harness.close();
      globalThis.fetch = previousFetch;
    }
  });

  it('does not route browser commands before provider identity authorization', async () => {
    const harness = await startBroker({
      bindProviderSession: async () => ({ ok: true, kind: 'already-bound' }),
      completeLaunchAuthorization: async () => undefined,
      terminateNativeGeneration: async () => undefined
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-command-gate', 'opencode'));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');

    const browser = await harness.connectBrowser();
    await browser.waitFor((frame) => (frame as { type?: string }).type === 'ready');
    browser.send({
      type: 'subscribe',
      session: 'sess-command-gate',
      surfaceId: 'surface',
      visible: true
    });
    await browser.waitFor((frame) => (frame as { type?: string }).type === 'snapshot');
    browser.send({
      type: 'send',
      session: 'sess-command-gate',
      surfaceId: 'surface',
      text: 'must not reach the provider'
    });

    const error = await browser.waitFor(
      (frame) =>
        (frame as { type?: string; code?: string }).type === 'error' &&
        (frame as { code?: string }).code === 'adapter-unavailable'
    );
    expect(error).toMatchObject({
      type: 'error',
      code: 'adapter-unavailable'
    });
    expect(host.received).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'inject' })])
    );

    browser.close();
    host.close();
    harness.close();
  });

  it('treats launch-authorization completion failure as fatal before publication', async () => {
    const published: AgentStateEnvelope[] = [];
    const terminated: Array<{ sessionId: string; generation: number }> = [];
    const harness = await startBroker({
      bindProviderSession: async () => ({ ok: true, kind: 'persisted' }),
      completeLaunchAuthorization: async () => {
        throw new Error('launch ledger unavailable');
      },
      terminateNativeGeneration: async (sessionId: string, generation: number) => {
        terminated.push({ sessionId, generation });
      },
      publishAgentState: (envelope) => {
        published.push(envelope);
      }
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-complete', 'codex', 21, { generation: 11 }));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    expect(published).toEqual([]);

    host.send({
      type: 'event',
      event: event(1, 'session-info', {
        agentSessionId: '019ec5e5-78dc-7eb3-99d9-2a98122d6ad7'
      })
    });
    await waitUntil(() => terminated.length === 1);
    await waitUntil(() => host.ws.readyState === WebSocket.CLOSED);

    expect(terminated).toEqual([{ sessionId: 'sess-complete', generation: 11 }]);
    expect(published).toEqual([]);
    expect(harness.broker.snapshot()).toEqual([
      { session: 'sess-complete', lastSeq: 0, hostConnected: false }
    ]);
    harness.close();
  });

  it('cannot authorize a changed provider id when the host generation changes during binding', async () => {
    const firstId = '11111111-2222-4333-8444-555555555555';
    const secondId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const bindings: string[] = [];
    const completed: string[] = [];
    const terminated: Array<{ sessionId: string; generation: number }> = [];
    let resolveFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const harness = await startBroker({
      bindProviderSession: async (input) => {
        bindings.push(input.providerSessionId);
        if (bindings.length === 1) {
          await firstPending;
          return { ok: true, kind: 'persisted' };
        }
        return {
          ok: false,
          code: 'provider-session-mismatch',
          error: 'different provider session id'
        };
      },
      completeLaunchAuthorization: async (input) => {
        completed.push(input.providerSessionId);
      },
      terminateNativeGeneration: async (sessionId: string, generation: number) => {
        terminated.push({ sessionId, generation });
      },
      publishAgentState: NOOP_AGENT_STATE_PUBLISHER
    } as unknown as AgentSurfaceBrokerOptions);

    const firstHost = await harness.connectHost();
    firstHost.send(hostHello('sess-race', 'claude', 31, { generation: 1 }));
    await firstHost.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    firstHost.send({
      type: 'event',
      event: event(1, 'session-info', { agentSessionId: firstId })
    });
    await waitUntil(() => bindings.length === 1);

    const secondHost = await harness.connectHost();
    secondHost.send(hostHello('sess-race', 'claude', 32, { generation: 2 }));
    await secondHost.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    secondHost.send({
      type: 'event',
      event: event(1, 'session-info', { agentSessionId: secondId })
    });

    resolveFirst();
    await waitUntil(() => bindings.length === 2);
    await waitUntil(() => terminated.length === 1);
    await waitUntil(() => secondHost.ws.readyState === WebSocket.CLOSED);

    expect(bindings).toEqual([firstId, secondId]);
    expect(completed).toEqual([]);
    expect(terminated).toEqual([{ sessionId: 'sess-race', generation: 2 }]);
    expect(harness.broker.snapshot()).toEqual([
      { session: 'sess-race', lastSeq: 0, hostConnected: false }
    ]);

    firstHost.close();
    harness.close();
  });

  it('does not activate a resumed Claude host whose emitted identity mismatches the durable binding', async () => {
    const published: AgentStateEnvelope[] = [];
    const terminated: Array<{ sessionId: string; generation: number }> = [];
    const harness = await startBroker({
      bindProviderSession: async () => ({
        ok: false,
        code: 'provider-session-mismatch',
        error: 'different provider session id'
      }),
      completeLaunchAuthorization: async () => {
        throw new Error('must not complete');
      },
      terminateNativeGeneration: async (sessionId: string, generation: number) => {
        terminated.push({ sessionId, generation });
      },
      publishAgentState: (envelope) => {
        published.push(envelope);
      }
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-reject', 'claude', 17, { generation: 7 }));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    expect(published).toEqual([]);

    host.send({
      type: 'event',
      event: event(1, 'session-info', {
        agentSessionId: '019ec5e5-78dc-7eb3-99d9-2a98122d6ad7'
      })
    });
    await waitUntil(() => terminated.length === 1);
    await waitUntil(() => host.ws.readyState === WebSocket.CLOSED);

    expect(terminated).toEqual([{ sessionId: 'sess-reject', generation: 7 }]);
    expect(published).toEqual([]);
    expect(harness.broker.snapshot()).toEqual([
      { session: 'sess-reject', lastSeq: 0, hostConnected: false }
    ]);

    harness.close();
  });

  it('on binding storage failure retains and publishes nothing, closes the host, and terminates the exact generation', async () => {
    const published: AgentStateEnvelope[] = [];
    const terminated: Array<{ sessionId: string; generation: number }> = [];
    const harness = await startBroker({
      bindProviderSession: async () => {
        throw new Error('manifest unavailable');
      },
      completeLaunchAuthorization: async () => undefined,
      terminateNativeGeneration: async (sessionId: string, generation: number) => {
        terminated.push({ sessionId, generation });
      },
      publishAgentState: (envelope) => {
        published.push(envelope);
      }
    } as unknown as AgentSurfaceBrokerOptions);
    const host = await harness.connectHost();
    host.send(hostHello('sess-storage', 'codex', 19, { generation: 9 }));
    await host.waitFor((frame) => (frame as { type?: string }).type === 'hello-ack');
    expect(published).toEqual([]);

    host.send({
      type: 'event',
      event: event(1, 'session-info', {
        agentSessionId: '019ec5e5-78dc-7eb3-99d9-2a98122d6ad7'
      })
    });
    await waitUntil(() => terminated.length === 1);
    await waitUntil(() => host.ws.readyState === WebSocket.CLOSED);

    expect(terminated).toEqual([{ sessionId: 'sess-storage', generation: 9 }]);
    expect(published).toEqual([]);
    expect(harness.broker.snapshot()).toEqual([
      { session: 'sess-storage', lastSeq: 0, hostConnected: false }
    ]);

    harness.close();
  });
});

describe('AgentSurfaceBroker — reload snapshot reset (human BUG: duplicated transcript after session reload)', () => {
  it('pushes a replace-snapshot to subscribed surfaces when a NEW pid says hello', async () => {
    const harness = await startBroker();
    const host1 = await harness.connectHost();
    host1.send(hostHello('sr', 'claude', 100));
    await host1.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    await authorizeHost(harness.broker, host1, 'sr', 'claude');
    host1.send({ type: 'event', event: event(2, 'user-message', { id: 'user-1', text: 'hi', source: 'ui' }) });
    await waitUntil(() => harness.broker.snapshot()[0]?.lastSeq === 2);

    const browser = await harness.connectBrowser();
    browser.send({ type: 'subscribe', session: 'sr', surfaceId: 'surf-1', visible: true });
    await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');
    browser.received.length = 0;

    // Session reload: fresh host process with a NEW pid.
    const host2 = await harness.connectHost();
    host2.send(hostHello('sr', 'claude', 200));
    const snap = await browser.waitFor<{ type: string; events: unknown[] }>(
      (f) => (f as { type?: string }).type === 'snapshot'
    );
    expect(snap.events).toHaveLength(0);
    host1.close();
    host2.close();
    browser.close();
    harness.close();
  });
});
