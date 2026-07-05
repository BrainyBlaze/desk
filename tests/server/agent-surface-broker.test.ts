import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AgentSurfaceBroker,
  installAgentSurfaceBroker,
  type AttentionSink
} from '../../src/server/agentSurfaceBroker';
import {
  deriveAgentHostToken,
  getOrCreateAgentHostSecret
} from '../../src/server/agentHostToken';
import { readManifestFile, writeManifestFile, resolveManifestPath } from '../../src/core/config';
import type { DeskManifest } from '../../src/core/types';
import type {
  AgentHostClientFrame,
  AgentHostServerFrame,
  AgentSurfaceEvent,
  AgentUiClientFrame,
  AgentUiServerFrame
} from '../../src/core/agentSurfaceProtocol';

const SECRET = getOrCreateAgentHostSecret();

function tokenFor(session: string, agent: string): string {
  return deriveAgentHostToken(SECRET, session, agent);
}

const NOOP_ATTENTION: AttentionSink = {
  pushEvent: () => undefined,
  notifySignal: () => undefined,
  raise: () => undefined
};

/** In-memory WebSocket pair that lets a test act as both broker-side server and a peer. */
interface TestPeer {
  ws: WebSocket;
  received: unknown[];
  send(frame: unknown): void;
  close(): void;
  waitFor<T = unknown>(predicate: (frame: unknown) => boolean, timeoutMs?: number): Promise<T>;
}

async function startBroker(): Promise<{ broker: AgentSurfaceBroker; close: () => void; port: number; connectHost: () => Promise<TestPeer>; connectBrowser: () => Promise<TestPeer> }> {
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

describe('AgentSurfaceBroker — host handshake', () => {
  it('accepts hello with a valid token + sends hello-ack with lastSeq=0 for a fresh session', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'opencode', token: tokenFor('s1', 'opencode'), pid: 123 });
    const ack = await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    expect(ack).toMatchObject({ type: 'hello-ack', lastSeq: 0 });
    host.close();
    harness.close();
  });

  it('rejects hello with a wrong-token and closes the socket', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'opencode', token: 'wrong', pid: 123 });
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

describe('AgentSurfaceBroker — surface subscription + snapshot', () => {
  it('sends ready on browser connect', async () => {
    const harness = await startBroker();
    const browser = await harness.connectBrowser();
    const ready = await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    expect(ready).toMatchObject({ type: 'ready', version: 1 });
    browser.close();
    harness.close();
  });

  it('snapshot reflects ring + lastSeq + state when visible subscription arrives', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'codex', token: tokenFor('s1', 'codex'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    host.send({ type: 'event', event: event(1, 'status', { state: 'idle' }) });
    host.send({ type: 'event', event: 2, } as never); // placeholder to ensure waitFor race
    // Two committed events
    host.send({ type: 'event', event: event(2, 'assistant-message', { id: 'm1', turnId: 'm1', markdown: 'hi' }) });
    const browser = await harness.connectBrowser();
    await browser.waitFor((f) => (f as { type?: string }).type === 'ready');
    browser.send({ type: 'subscribe', session: 's1', surfaceId: 'surf-1', visible: true });
    const snapshot = await browser.waitFor((f) => (f as { type?: string }).type === 'snapshot');
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      session: 's1',
      surfaceId: 'surf-1',
      state: 'idle',
      lastSeq: 2
    });
    if (!(snapshot as { events?: unknown[] }).events) throw new Error('events missing');
    expect((snapshot as { events: { kind: string }[] }).events.map((e) => e.kind)).toContain('assistant-message');
    browser.close();
    host.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — visibility-gated forwarding', () => {
  it('visible surface receives delta events; hidden does not', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'claude', token: tokenFor('s1', 'claude'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

    const visible = await harness.connectBrowser();
    await visible.waitFor((f) => (f as { type?: string }).type === 'ready');
    visible.send({ type: 'subscribe', session: 's1', surfaceId: 'vis', visible: true });
    await visible.waitFor((f) => (f as { type?: string }).type === 'snapshot');

    const hidden = await harness.connectBrowser();
    await hidden.waitFor((f) => (f as { type?: string }).type === 'ready');
    hidden.send({ type: 'subscribe', session: 's1', surfaceId: 'hid', visible: false });
    // hidden subscription sends no snapshot (visible=false)

    host.send({ type: 'event', event: event(1, 'assistant-delta', { turnId: 't1', text: 'chunk' }) });
    const visFrame = await visible.waitFor((f) => (f as { type?: string; event?: { kind: string } }).type === 'event' && (f as { event: { kind: string } }).event?.kind === 'assistant-delta');
    expect(visFrame).toBeDefined();
    // hidden should not have received the delta — wait briefly to be sure
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hidden.received.some((f) => (f as { type?: string }).type === 'event')).toBe(false);

    // Both surfaces receive committed events regardless of visibility
    host.send({ type: 'event', event: event(2, 'assistant-message', { id: 't1', turnId: 't1', markdown: 'commit' }) });
    await visible.waitFor((f) => (f as { type?: string; event?: { kind: string } }).type === 'event' && (f as { event: { kind: string } }).event?.kind === 'assistant-message');
    await hidden.waitFor((f) => (f as { type?: string; event?: { kind: string } }).type === 'event' && (f as { event: { kind: string } }).event?.kind === 'assistant-message');

    visible.close();
    hidden.close();
    host.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — surface → host command routing', () => {
  it('subscribe + send forwards an inject command to the host with a fresh requestId', async () => {
    const harness = await startBroker();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'opencode', token: tokenFor('s1', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

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
    host.send({ type: 'hello', session: 's1', agent: 'opencode', token: tokenFor('s1', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

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
    host1.send({ type: 'hello', session: 's1', agent: 'codex', token: tokenFor('s1', 'codex'), pid: 100 });
    await host1.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    host1.send({ type: 'event', event: event(1, 'assistant-message', { id: 'm1', turnId: 'm1', markdown: 'old' }) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    host1.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // New pid reconnects
    const host2 = await harness.connectHost();
    host2.send({ type: 'hello', session: 's1', agent: 'codex', token: tokenFor('s1', 'codex'), pid: 200 });
    const ack = await host2.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    expect(ack).toMatchObject({ type: 'hello-ack', lastSeq: 0 }); // ring was reset

    host2.close();
    harness.close();
  });

  it('same pid reconnect (transient drop) keeps ring + lastSeq', async () => {
    const harness = await startBroker();
    const host1 = await harness.connectHost();
    host1.send({ type: 'hello', session: 's1', agent: 'codex', token: tokenFor('s1', 'codex'), pid: 100 });
    await host1.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    host1.send({ type: 'event', event: event(5, 'assistant-message', { id: 'm1', turnId: 'm1', markdown: 'data' }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    host1.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const host2 = await harness.connectHost();
    host2.send({ type: 'hello', session: 's1', agent: 'codex', token: tokenFor('s1', 'codex'), pid: 100 });
    const ack = await host2.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    expect(ack).toMatchObject({ type: 'hello-ack', lastSeq: 5 });

    host2.close();
    harness.close();
  });
});

describe('AgentSurfaceBroker — attention synthesis', () => {
  it('status awaiting-permission raises approval-requested', async () => {
    const raised: Array<{ session: string; kind: string }> = [];
    const harness = await new Promise<{ broker: AgentSurfaceBroker; close: () => void; port: number; connectHost: () => Promise<TestPeer>; connectBrowser: () => Promise<TestPeer> }>((resolve) => {
      const httpServer = createServer();
      httpServer.listen(0, '127.0.0.1', () => {
        const port = (httpServer.address() as { port: number }).port;
        const broker = new AgentSurfaceBroker({
          resolveSecret: () => SECRET,
          attention: {
            pushEvent: (session, kind) => raised.push({ session, kind }),
            notifySignal: () => undefined,
            raise: () => undefined
          }
        });
        const dispose = installAgentSurfaceBroker(httpServer as never, broker);
        resolve({
          broker,
          close: () => { dispose(); httpServer.close(); },
          port,
          connectHost: () => connectTo(`ws://127.0.0.1:${port}/ws/agent-host`),
          connectBrowser: () => connectTo(`ws://127.0.0.1:${port}/ws/agent-ui`)
        });
      });
    });

    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'claude', token: tokenFor('s1', 'claude'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    host.send({ type: 'event', event: event(1, 'status', { state: 'awaiting-permission' }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(raised.some((e) => e.session === 's1' && e.kind === 'approval-requested')).toBe(true);

    host.close();
    harness.close();
  });

  it('turn-complete pushes turn-complete event', async () => {
    const pushed: string[] = [];
    const harness = await new Promise<{ broker: AgentSurfaceBroker; close: () => void; port: number; connectHost: () => Promise<TestPeer> }>((resolve) => {
      const httpServer = createServer();
      httpServer.listen(0, '127.0.0.1', () => {
        const port = (httpServer.address() as { port: number }).port;
        const broker = new AgentSurfaceBroker({
          resolveSecret: () => SECRET,
          attention: {
            pushEvent: (_s, kind) => pushed.push(kind),
            notifySignal: () => undefined,
            raise: () => undefined
          }
        });
        const dispose = installAgentSurfaceBroker(httpServer as never, broker);
        resolve({
          broker,
          close: () => { dispose(); httpServer.close(); },
          port,
          connectHost: () => connectTo(`ws://127.0.0.1:${port}/ws/agent-host`)
        });
      });
    });
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 's1', agent: 'claude', token: tokenFor('s1', 'claude'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');
    host.send({ type: 'event', event: event(1, 'turn-complete', { turnId: 't1' }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toContain('turn-complete');

    host.close();
    harness.close();
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
    host.send({ type: 'hello', session: 's1', agent: 'opencode', token: tokenFor('s1', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

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
    host.send({ type: 'hello', session: 's1', agent: 'opencode', token: deriveAgentHostToken(SECRET, 's1', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

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

describe('AgentSurfaceBroker — session-info → persistSessionResume (spec §6)', () => {
  let manifestDir: string;
  let manifestPath: string;

  beforeEach(() => {
    manifestDir = mkdtempSync(join(tmpdir(), 'desk-broker-resume-'));
    manifestPath = join(manifestDir, 'desk.yml');
    const manifest: DeskManifest = {
      groups: [
        {
          id: 'g1',
          sessions: [
            {
              name: 's1',
              cwd: manifestDir,
              agent: 'opencode',
              uiMode: 'native',
              tmuxSession: 'sess-test-resume'
            }
          ]
        }
      ]
    };
    writeManifestFile(manifestPath, manifest);
  });

  afterEach(() => {
    rmSync(manifestDir, { recursive: true, force: true });
  });

  async function startBrokerWithResumeSink(): Promise<{
    broker: AgentSurfaceBroker;
    close: () => void;
    connectHost: () => Promise<TestPeer>;
  }> {
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as { port: number }).port;
    const broker = new AgentSurfaceBroker({
      resolveSecret: () => SECRET,
      attention: NOOP_ATTENTION,
      persistResume: (tmuxSession, resume) => {
        const manifest = readManifestFile(manifestPath);
        let wrote = false;
        for (const group of manifest.groups) {
          for (const session of group.sessions) {
            if (session.tmuxSession === tmuxSession && !session.resume) {
              session.resume = resume;
              wrote = true;
            }
          }
        }
        if (wrote) {
          writeManifestFile(manifestPath, manifest);
        }
        return wrote;
      }
    });
    const dispose = installAgentSurfaceBroker(httpServer as never, broker);
    return {
      broker,
      close: () => {
        dispose();
        httpServer.close();
      },
      connectHost: () => connectTo(`ws://127.0.0.1:${port}/ws/agent-host`)
    };
  }

  it('fresh session-info with valid opencode resume id → manifest gains resume + pinned tmuxSession', async () => {
    const harness = await startBrokerWithResumeSink();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 'sess-test-resume', agent: 'opencode', token: tokenFor('sess-test-resume', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

    host.send({
      type: 'event',
      event: event(1, 'session-info', { agentSessionId: 'ses_abc123def456ghi789jkl012mno345pqr678stu901vwx' })
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const updated = readManifestFile(manifestPath);
    const session = updated.groups[0]!.sessions[0]!;
    expect(session.resume).toBe('ses_abc123def456ghi789jkl012mno345pqr678stu901vwx');
    expect(session.tmuxSession).toBe('sess-test-resume');

    host.close();
    harness.close();
  });

  it('malformed resume id is NOT persisted (validation gate)', async () => {
    const harness = await startBrokerWithResumeSink();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 'sess-test-resume', agent: 'opencode', token: tokenFor('sess-test-resume', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

    host.send({ type: 'event', event: event(1, 'session-info', { agentSessionId: 'not-a-valid-id' }) });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const updated = readManifestFile(manifestPath);
    expect(updated.groups[0]!.sessions[0]!.resume).toBeUndefined();

    host.close();
    harness.close();
  });

  it('repeated session-info is idempotent (guard skips after first successful persist)', async () => {
    const harness = await startBrokerWithResumeSink();
    const host = await harness.connectHost();
    host.send({ type: 'hello', session: 'sess-test-resume', agent: 'opencode', token: tokenFor('sess-test-resume', 'opencode'), pid: 1 });
    await host.waitFor((f) => (f as { type?: string }).type === 'hello-ack');

    const validId = 'ses_def456ghi789jkl012mno345pqr678stu901vwx999abc';
    host.send({ type: 'event', event: event(1, 'session-info', { agentSessionId: validId }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    host.send({ type: 'event', event: event(2, 'session-info', { agentSessionId: validId }) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updated = readManifestFile(manifestPath);
    expect(updated.groups[0]!.sessions[0]!.resume).toBe(validId);

    host.close();
    harness.close();
  });
});

import { beforeEach as _beforeEach, afterEach as _afterEach } from 'vitest';
void _beforeEach;
void _afterEach;
