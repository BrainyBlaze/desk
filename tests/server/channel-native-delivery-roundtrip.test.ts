import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentSurfaceBroker, installAgentSurfaceBroker, type AttentionSink } from '../../src/server/agentSurfaceBroker';
import {
  deriveAgentHostToken,
  getOrCreateAgentHostSecret
} from '../../src/server/agentHostToken';
import type { AgentHostServerFrame, AgentUiServerFrame } from '../../src/core/agentSurfaceProtocol';

/**
 * Spec §8 C3 invariant lock: a channel message dispatched to a native session must
 * arrive at every subscribed surface as a `user-message` event carrying source='channel'
 * — proving the channels-engine → broker → host → driver → broker → surface round-trip
 * preserves the origin tag end-to-end.
 *
 * The agent's reply-back-to-channel half of C3 needs a real agent and lives in the
 * env-gated probe suite; this test locks the broker-visible half hermetically.
 */

const SECRET = getOrCreateAgentHostSecret();
const NOOP_ATTENTION: AttentionSink = {
  pushEvent: () => undefined,
  notifySignal: () => undefined,
  raise: () => undefined
};

function tokenFor(session: string, agent: string): string {
  return deriveAgentHostToken(SECRET, session, agent);
}

interface TestPeer {
  ws: WebSocket;
  received: unknown[];
  send(frame: unknown): void;
  close(): void;
  waitFor<T = unknown>(predicate: (frame: unknown) => boolean, timeoutMs?: number): Promise<T>;
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
      waitFor: <T = unknown>(predicate: (frame: unknown) => boolean, timeoutMs = 800) =>
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

async function startStack(): Promise<{
  broker: AgentSurfaceBroker;
  close: () => void;
  port: number;
  connectHost: () => Promise<TestPeer>;
  connectBrowser: () => Promise<TestPeer>;
}> {
  const httpServer: Server = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = httpServer.address() as { port: number };
  const broker = new AgentSurfaceBroker({ resolveSecret: () => SECRET, attention: NOOP_ATTENTION });
  const dispose = installAgentSurfaceBroker(httpServer as never, broker);
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

/**
 * Fake host that simulates the agent driver's optimistic user-message emission on
 * inject (the channels-engine → broker → host → driver → broker → surface round-trip).
 *
 * Real drivers (opencode/claude/codex) emit a local user-message with the caller's
 * source immediately on inject(); the host stamps seq/ts and forwards it. This fake
 * reproduces that behavior so we can verify the C3 invariant end-to-end at the
 * protocol layer without spawning a real agent.
 */
async function attachFakeDriverHost(host: TestPeer, session: string, agent: string, pid: number): Promise<void> {
  host.send({ type: 'hello', session, agent, token: tokenFor(session, agent), pid });
  await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
  let seq = 0;
  host.ws.on('message', (raw) => {
    let frame: AgentHostServerFrame;
    try {
      frame = JSON.parse(String(raw)) as AgentHostServerFrame;
    } catch {
      return;
    }
    if (frame.type === 'inject') {
      // Optimistic local user-message with the caller's source — mirrors opencodeDriver.inject
      seq += 1;
      host.send({
        type: 'event',
        event: {
          kind: 'user-message',
          id: `local-${frame.requestId}`,
          text: frame.text,
          source: frame.source,
          seq,
          ts: new Date().toISOString()
        }
      });
      // Ack the command so injectUserMessage resolves
      host.send({ type: 'command-result', requestId: frame.requestId, ok: true });
    }
  });
}

describe('spec §8 C3 invariant: channel → native → user-message source=channel round-trip', () => {
  it('broker.injectUserMessage(source=channel) reaches every subscribed surface as user-message source=channel', async () => {
    const harness = await startStack();
    const host = await harness.connectHost();
    await attachFakeDriverHost(host, 'sess-c3', 'opencode', 1);

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 'sess-c3', surfaceId: 'surf-1', visible: true });
    await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    // channels-engine-style call: broker.injectUserMessage(session, text, 'channel')
    await harness.broker.injectUserMessage('sess-c3', 'channel says hi', 'channel');

    const userMessageFrame = await browser.waitFor(
      (f) =>
        (f as { type?: string; event?: { kind: string; source?: string; text?: string } }).type === 'event' &&
        (f as { event: { kind: string } }).event?.kind === 'user-message'
    );
    expect(userMessageFrame).toMatchObject({
      type: 'event',
      session: 'sess-c3',
      event: { kind: 'user-message', text: 'channel says hi', source: 'channel' }
    });

    host.close();
    browser.close();
    harness.close();
  });

  it('multiple surfaces (visible + hidden) both receive the channel-origin user-message', async () => {
    const harness = await startStack();
    const host = await harness.connectHost();
    await attachFakeDriverHost(host, 'sess-c3-multi', 'opencode', 1);

    const visible = await harness.connectBrowser();
    await visible.waitFor((f) => (f as { type?: string }).type === 'ready');
    visible.send({ type: 'subscribe', session: 'sess-c3-multi', surfaceId: 'vis', visible: true });
    await visible.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    const hidden = await harness.connectBrowser();
    await hidden.waitFor((f) => (f as { type?: string }).type === 'ready');
    hidden.send({ type: 'subscribe', session: 'sess-c3-multi', surfaceId: 'hid', visible: false });

    await harness.broker.injectUserMessage('sess-c3-multi', 'ping', 'channel');

    // user-message is committed (not transient) so both visible AND hidden surfaces get it
    const visFrame = await visible.waitFor(
      (f) =>
        (f as { type?: string; event?: { kind: string; source?: string } }).type === 'event' &&
        (f as { event: { kind: string } }).event?.kind === 'user-message' &&
        (f as { event: { source?: string } }).event?.source === 'channel'
    );
    expect(visFrame).toBeDefined();
    const hidFrame = await hidden.waitFor(
      (f) =>
        (f as { type?: string; event?: { kind: string; source?: string } }).type === 'event' &&
        (f as { event: { kind: string } }).event?.kind === 'user-message' &&
        (f as { event: { source?: string } }).event?.source === 'channel'
    );
    expect(hidFrame).toBeDefined();

    host.close();
    visible.close();
    hidden.close();
    harness.close();
  });

  it('ui-origin inject (the surface Send button) preserves source=ui through the round-trip', async () => {
    const harness = await startStack();
    const host = await harness.connectHost();
    await attachFakeDriverHost(host, 'sess-c3-ui', 'claude', 1);

    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 'sess-c3-ui', surfaceId: 'surf-1', visible: true });
    await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    browser.send({ type: 'send', session: 'sess-c3-ui', surfaceId: 'surf-1', text: 'typed in composer' });

    const userMessageFrame = await browser.waitFor(
      (f) =>
        (f as { type?: string; event?: { kind: string; source?: string } }).type === 'event' &&
        (f as { event: { kind: string } }).event?.kind === 'user-message'
    );
    expect(userMessageFrame).toMatchObject({
      type: 'event',
      event: { kind: 'user-message', source: 'ui', text: 'typed in composer' }
    });

    host.close();
    browser.close();
    harness.close();
  });
});

void WebSocketServer; // re-exported import sanity
void (undefined as unknown as AgentUiServerFrame);
