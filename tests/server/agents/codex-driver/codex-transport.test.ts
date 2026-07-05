import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createCodexAppServerTransport, type CodexAppServerProcess } from '../../../../src/server/agents/drivers/codexDriver.js';

class FakeProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | null = null;
  readonly writes: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.writes.push(String(chunk)));
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? null;
    return true;
  }
}

describe('createCodexAppServerTransport', () => {
  it('sends JSONL requests, resolves matching responses, and emits notifications', async () => {
    const proc = new FakeProcess();
    const transport = createCodexAppServerTransport({ process: proc });
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));

    const request = transport.request('thread/read', { threadId: 'thread-1', includeTurns: true });
    expect(proc.writes).toEqual(['{"id":"1","method":"thread/read","params":{"threadId":"thread-1","includeTurns":true}}\n']);

    proc.stdout.write('{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[],"itemsView":{"type":"complete"},"status":"inProgress","error":null,"startedAt":1,"completedAt":null,"durationMs":null}}}\n');
    proc.stdout.write('{"id":"1","result":{"ok":true}}\n');

    await expect(request).resolves.toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: 'turn/started', params: { threadId: 'thread-1' } });
  });

  it('responds to server-initiated request ids and rejects JSON-RPC errors', async () => {
    const proc = new FakeProcess();
    const transport = createCodexAppServerTransport({ process: proc });
    const request = transport.request('turn/start', { threadId: 'thread-1', input: [] });

    await transport.respond('approval-1', { decision: 'decline' });
    proc.stdout.write('{"id":"1","error":{"code":-32000,"message":"turn failed"}}\n');

    expect(proc.writes[1]).toBe('{"id":"approval-1","result":{"decision":"decline"}}\n');
    await expect(request).rejects.toThrow('turn failed');
  });

  it('drops malformed stdout lines and continues parsing later JSONL responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const proc = new FakeProcess();
      const transport = createCodexAppServerTransport({ process: proc });
      const request = transport.request('thread/read', { threadId: 'thread-1' });

      expect(() => proc.stdout.write('codex warning: version drift\n')).not.toThrow();
      proc.stdout.write('{"id":"1","result":{"ok":true}}\n');

      await expect(request).resolves.toEqual({ ok: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring malformed codex app-server stdout line'));
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects pending requests when child stdin errors without throwing from the stream error event', async () => {
    const proc = new FakeProcess();
    const transport = createCodexAppServerTransport({ process: proc });
    const request = transport.request('thread/read', { threadId: 'thread-1' });

    expect(() => proc.stdin.emit('error', new Error('stdin gone'))).not.toThrow();

    await expect(request).rejects.toThrow('stdin gone');
  });

  it('closes the child process and rejects pending requests on exit', async () => {
    const proc = new FakeProcess();
    const transport = createCodexAppServerTransport({ process: proc });
    const request = transport.request('thread/read', { threadId: 'thread-1' });

    proc.emit('exit', 1, null);
    await expect(request).rejects.toThrow('codex app-server exited');
    await transport.close();

    expect(proc.killedWith).toBe('SIGTERM');
  });
});
