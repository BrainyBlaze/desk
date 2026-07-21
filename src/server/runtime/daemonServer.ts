// Daemon socket/RPC server shell (spec §3.2/§3.7). The runnable process around
// the pure DaemonCore: a single-instance unix-socket server (0700 dir / 0600
// sock) enforcing the PID+start-time lock, framing + dispatching versioned RPC
// (rpcEnvelope) into DaemonCore. Node stdlib only — no atch binary, no
// @xterm/headless — so it runs and is testable today; the real master link and
// the @xterm/headless emulator factory drop in at lane-join behind the same
// DaemonCore + EmulatorFactory seams.

import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decideLock, type LockRecord, type PidProbe } from '../../shared/runtime/instanceLock.js';
import { RPC_VERSION, decodeRequest, encodeErr, encodeOk, RpcError } from '../../shared/runtime/rpcEnvelope.js';
import { type DaemonCore } from '../../shared/runtime/daemonCore.js';

/** Read a process start-time (jiffies at boot) from /proc/<pid>/stat field 22. */
export function readProcStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // field 2 is "(comm)" which may contain spaces/parens — split after the last ')'.
    const rparen = stat.lastIndexOf(')');
    const fields = stat.slice(rparen + 2).split(' ');
    // after comm, field 3 is index 0 here; starttime (field 22) is index 22-3 = 19.
    const start = Number(fields[19]);
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

/** Probe whether `pid` is a live process and its start-time (PID-reuse guard). */
export function probePid(pid: number): PidProbe {
  let alive = false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    alive = true;
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
  return { alive, startTime: alive ? readProcStartTime(pid) : null };
}

export interface DaemonServerOptions {
  sockPath: string;
  lockPath: string;
  core: DaemonCore;
}

/** Result of dispatching one RPC method to the core. */
interface Dispatchable {
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export class DaemonServer {
  private readonly sockPath: string;
  private readonly lockPath: string;
  private readonly core: DaemonCore;
  private server: Server | null = null;
  private readonly selfStart: number;

  constructor(opts: DaemonServerOptions) {
    this.sockPath = opts.sockPath;
    this.lockPath = opts.lockPath;
    this.core = opts.core;
    this.selfStart = readProcStartTime(process.pid) ?? 0;
  }

  /**
   * Acquire the single-instance lock and start listening. Throws if a live peer
   * daemon already holds the lock (decideLock → defer); repairs a stale lock
   * (dead pid / PID reuse) and rebinds.
   */
  async start(): Promise<void> {
    const existing = this.readLock();
    const decision = decideLock(existing, { pid: process.pid, startTime: this.selfStart }, existing ? probePid(existing.pid) : { alive: false, startTime: null });
    if (decision.action === 'defer') {
      throw new Error(`daemon already running (pid ${decision.holder.pid} on ${decision.holder.sockPath})`);
    }
    // acquire (or is-self): clear a stale socket and (re)bind.
    if (existsSync(this.sockPath)) rmSync(this.sockPath, { force: true });
    mkdirSync(dirname(this.sockPath), { recursive: true, mode: 0o700 });

    await new Promise<void>((resolve, reject) => {
      const server = createServer((sock) => this.onConnection(sock));
      server.once('error', reject);
      server.listen(this.sockPath, () => {
        server.removeListener('error', reject);
        this.server = server;
        try {
          chmodSync(this.sockPath, 0o600);
        } catch {
          /* best effort */
        }
        this.writeLock();
        resolve();
      });
    });
  }

  /** Stop the daemon (refuses while sessions live unless forced, §11.4). */
  async stop(forced = false): Promise<{ stopped: boolean; liveSessions?: number }> {
    const decision = this.core.canStop(forced);
    if (decision.action === 'refuse') return { stopped: false, liveSessions: decision.liveSessions };
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    rmSync(this.sockPath, { force: true });
    rmSync(this.lockPath, { force: true });
    return { stopped: true };
  }

  // ---- connection + RPC framing (newline-delimited JSON) --------------------
  private onConnection(sock: Socket): void {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) sock.write(this.handleLine(line) + '\n');
      }
    });
    sock.on('error', () => sock.destroy());
  }

  private handleLine(line: string): string {
    let id = 0;
    try {
      const req = decodeRequest(line);
      id = req.id;
      const out = this.dispatch(req.method, req.params);
      return out.ok ? encodeOk(id, out.result) : encodeErr(id, out.errorCode ?? 'error', out.errorMessage ?? '');
    } catch (e) {
      if (e instanceof RpcError) return encodeErr(id, e.code, e.message);
      return encodeErr(id, 'internal', (e as Error).message);
    }
  }

  private dispatch(method: string, params: unknown): Dispatchable {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'ping':
        return { ok: true, result: { pong: true, version: RPC_VERSION } };
      case 'ensure': {
        const r = this.core.ensure(String(p.sessionId), { rows: Number(p.rows) || 24, cols: Number(p.cols) || 80 });
        return r.ok ? { ok: true, result: r } : { ok: false, errorCode: 'cap-exceeded', errorMessage: 'MAX_LIVE_WORKERS reached' };
      }
      case 'retire':
        this.core.retire(String(p.sessionId));
        return { ok: true, result: { retired: true } };
      case 'list':
        return { ok: true, result: this.core.list() };
      case 'state': {
        const s = this.core.state(String(p.sessionId));
        return s ? { ok: true, result: s } : { ok: false, errorCode: 'no-session', errorMessage: 'unknown session' };
      }
      case 'stop':
        // async stop is fire-and-forget from the RPC's perspective for a forced stop.
        return { ok: true, result: this.core.canStop(Boolean(p.forced)) };
      default:
        return { ok: false, errorCode: 'unknown-method', errorMessage: method };
    }
  }

  // ---- lock file (atomic write; §3.7 {pid, start_time, protocol_version}) ----
  private readLock(): LockRecord | null {
    try {
      return JSON.parse(readFileSync(this.lockPath, 'utf8')) as LockRecord;
    } catch {
      return null;
    }
  }

  private writeLock(): void {
    const rec: LockRecord = { pid: process.pid, startTime: this.selfStart, sockPath: this.sockPath, version: String(RPC_VERSION) };
    const tmp = `${this.lockPath}.tmp.${process.pid}`;
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, this.lockPath); // atomic
  }
}
