import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSurfaceClient,
  defaultBaseUrl,
  type AgentSurfaceSocket,
  type SurfaceHandlers
} from '../src/web/agentSurface/agentSurfaceClient.js';

class FakeSocket implements AgentSurfaceSocket {
  readyState = 0;
  sent: string[] = [];
  private handlers: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  addEventListener(type: string, handler: (e: { data?: unknown }) => void): void {
    (this.handlers[type] ??= []).push(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

const noopHandlers: SurfaceHandlers = { onSnapshot: () => {}, onEvent: () => {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agentSurfaceClient WS scheme', () => {
  it('uses wss:// on a secure (https) page so native surfaces are not mixed-content-blocked', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'desk.example.ts.net' });
    expect(defaultBaseUrl()).toBe('wss://desk.example.ts.net');
  });

  it('uses ws:// on a plain http page', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    expect(defaultBaseUrl()).toBe('ws://localhost:5173');
  });
});

describe('agentSurfaceClient connection resilience', () => {
  it('does not wedge when the socket constructor throws (mixed content / bad URL)', () => {
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const client = new AgentSurfaceClient((_url) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('SecurityError: mixed content'); // what new WebSocket() throws
      }
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    }, 'ws://test');

    // First attempt throws synchronously. Before the fix, `connecting` leaked
    // true and every later ensureConnection() early-returned — permanently
    // wedged in "reconnecting" with a dead Retry button.
    client.subscribe('s1', 'sess', true, noopHandlers);
    // A subsequent attempt must actually run (flag not leaked).
    client.subscribe('s2', 'sess2', true, noopHandlers);

    expect(calls).toBe(2);
    expect(sockets).toHaveLength(1);
  });
});
