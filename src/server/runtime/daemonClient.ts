// Web-server → daemon RPC client (spec §3.2/§3.4). The web server is a CLIENT of
// the daemon: it connects to the daemon's unix control socket and issues
// versioned RPC (ensure/list/state/stop) over newline-framed JSON. Mirrors
// DaemonServer. Node net + rpcEnvelope; responses are id-correlated so calls can
// be concurrent.

import { connect, type Socket } from 'node:net';
import { decodeResponse, encodeRequest, RpcError, type RpcResponse } from '../../shared/runtime/rpcEnvelope.js';

export class DaemonClient {
  private sock: Socket | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();

  connect(sockPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(sockPath);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.removeListener('error', reject);
        sock.setEncoding('utf8');
        this.sock = sock;
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', () => this.failAll(new Error('daemon socket error')));
        sock.on('close', () => this.failAll(new Error('daemon socket closed')));
        resolve();
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      let res: RpcResponse;
      try {
        res = decodeResponse(line);
      } catch {
        continue; // malformed line — ignore (no id to correlate)
      }
      const waiter = this.pending.get(res.id);
      if (waiter !== undefined) {
        this.pending.delete(res.id);
        waiter.resolve(res);
      }
    }
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  /** Issue one RPC call; resolves with the response (ok or error envelope). */
  call(method: string, params?: unknown): Promise<RpcResponse> {
    if (this.sock === null) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock!.write(encodeRequest(method, id, params) + '\n');
    });
  }

  /** Convenience: throw on an error envelope, else return the result. */
  private async ok<T>(method: string, params?: unknown): Promise<T> {
    const res = await this.call(method, params);
    if (!res.ok) throw new RpcError('method-error', `${res.error?.code}: ${res.error?.message}`);
    return res.result as T;
  }

  ping(): Promise<{ pong: boolean; version: number }> {
    return this.ok('ping');
  }
  ensure(sessionId: string, rows: number, cols: number): Promise<{ generation: number; created: boolean }> {
    return this.ok('ensure', { sessionId, rows, cols });
  }
  list(): Promise<{ sessionId: string; generation: number; state: string; source: string }[]> {
    return this.ok('list');
  }
  state(sessionId: string): Promise<{ state: string; source: string; generation: number }> {
    return this.ok('state', { sessionId });
  }
  retire(sessionId: string): Promise<{ retired: boolean }> {
    return this.ok('retire', { sessionId });
  }

  close(): void {
    if (this.sock !== null) {
      this.sock.destroy();
      this.sock = null;
    }
    this.failAll(new Error('client closed'));
  }
}
