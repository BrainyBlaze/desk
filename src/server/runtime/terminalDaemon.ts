// Terminal daemon assembly (cutover Phase 2 Step 3, core). Composes the durable
// terminal daemon the web server mounts at cutover: a TerminalWsRouter backed by
// a fsync'd generation ledger and the real @xterm/headless emulator, the binary
// WS bridge on /ws/terminal, and atch session provisioning via @codex's verified
// contract (CREATE = `atch start ABSOLUTE_SOCKET_PATH cmd`, KILL = `atch kill -f
// ABSOLUTE_SOCKET_PATH`; a slash-bearing name is the socket path, which isolates
// the canary under a dedicated socket root).
//
// This IS the product's terminal transport: the daemon supervisor spawns it
// and the web server proxies /ws/terminal to it. Instantiating it directly is
// how tests and a hand-run daemon (DESK_DAEMON_EXTERNAL) compose the pieces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { ensurePrivateSocketRoot } from '../../shared/atchPaths.js';
import { GenerationLedger } from '../../shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../../shared/runtime/index.js';
import { TerminalWsRouter } from './terminalWsRouter.js';
import { XtermEmulatorFactory } from './xtermEmulator.js';
import { FileGenerationLedgerStore } from './fileGenerationLedger.js';
import { installTerminalWsBridge } from '../terminalWsBridge.js';
import { HttpBodyError, readJsonBody, sendJson } from '../httpUtil.js';
import type { EnsureResult } from '../../shared/runtime/daemonCore.js';

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off?(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface TerminalDaemonOptions {
  /** Durable state root (the generation ledger lives under <root>/_engine). */
  homeRoot: string;
  /** Path to the atch binary. */
  atchBinPath: string;
  /** Dedicated ABSOLUTE socket root; a session's socket is <root>/<sessionId>.sock. */
  atchSocketRoot: string;
  httpServer: UpgradeServer;
  /** WS path (default /ws/terminal). */
  wsPath?: string;
  /**
   * Per-launch identity echoed by /control/health (from DESK_DAEMON_NONCE).
   * The supervisor requires an exact match before marking a child ready — on
   * a shared port an OLD daemon still draining its SIGTERM answers the same
   * URL, and a nonce-less 200 would mark the NEW child ready from it.
   */
  healthNonce?: string;
}

/** A provisionable session: the command to run and its initial geometry. */
export interface TerminalDaemonSessionSpec {
  command: string[];
  geometry: { rows: number; cols: number };
}

/** A buffered attention event (bell/OSC9) from a session's emulator. */
export interface DaemonAttentionEvent {
  seq: number;
  sessionId: string;
  kind: 'bell' | 'osc9';
  /** OSC9 notification body, when present. */
  data?: string;
}

/** Provision outcome: ensure result, or the spawn/attach failure that rolled back. */
export type ProvisionResult = EnsureResult | { ok: false; reason: 'spawn-failed' | 'attach-failed' };

export interface TerminalDaemon {
  readonly router: TerminalWsRouter;
  /** Spawn + attach the atch master for a session (CREATE contract). */
  provision(sessionId: string, spec: TerminalDaemonSessionSpec): Promise<ProvisionResult>;
  /**
   * Retire a session (KILL contract), resolving only after the kill command
   * completed AND the master's socket disappeared — the restart flow provisions
   * immediately after, and a stale socket would be adopted at the old
   * generation. A failed kill is a failure, never a silent 200.
   */
  retire(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  /** Control-plane input injection (channels delivery). False if unknown. */
  input(sessionId: string, bytes: Uint8Array, paste?: boolean): boolean;
  /**
   * Ranged plain-text window into the session's screen + scrollback. `offset`
   * counts lines back from the live edge (0/absent = the live tail); reads at
   * or beyond the top yield empty lines with totalAvailable telling the
   * caller where the top is. Undefined when the session is unknown.
   */
  tail(sessionId: string, rows: number, offset?: number): { lines: string[]; totalAvailable: number } | undefined;
  /**
   * Buffered bell/OSC9 events with seq > since (the web's attention poller
   * drains these — the atch-native replacement for legacy bell flags). A `since`
   * ahead of the head is a stale cursor from a previous daemon incarnation and
   * reads as 0 (deliver everything buffered) rather than silently nothing.
   */
  attentionEventsSince(since: number): { events: DaemonAttentionEvent[]; lastSeq: number };
  /**
   * Startup completeness: /control/health answers 503 until markReady, so the
   * supervisor's probe cannot report a daemon ready while its startup
   * reconcile is still pending or failed — readiness must not lie.
   */
  isReady(): boolean;
  markReady(): void;
  /** Tear down the WS bridge + its timers. */
  dispose(): void;
}

/** Bounded attention ring — plenty for a 2s poll cadence; oldest events drop first. */
const ATTENTION_RING_MAX = 512;

/** Assemble the durable terminal daemon + mount its binary WS bridge (additive). */
export function createTerminalDaemon(options: TerminalDaemonOptions): TerminalDaemon {
  const ledger = new GenerationLedger(new FileGenerationLedgerStore(join(options.homeRoot, '_engine', 'generation-ledger.json')));
  const attentionRing: DaemonAttentionEvent[] = [];
  let attentionSeq = 0;
  let ready = false;
  const router = new TerminalWsRouter({
    ledger,
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: new XtermEmulatorFactory(),
    now: Date.now,
    onSemanticEvent: (sessionId, event) => {
      attentionSeq += 1;
      attentionRing.push({
        seq: attentionSeq,
        sessionId,
        kind: event.kind === 'bell' ? 'bell' : 'osc9',
        ...(typeof event.data === 'string' && event.data.length > 0 ? { data: event.data.slice(0, 300) } : {})
      });
      if (attentionRing.length > ATTENTION_RING_MAX) {
        attentionRing.splice(0, attentionRing.length - ATTENTION_RING_MAX);
      }
    }
  });
  const disposeBridge = installTerminalWsBridge(options.httpServer, router, options.wsPath !== undefined ? { path: options.wsPath } : {});

  const socketPath = (sessionId: string): string => join(options.atchSocketRoot, `${sessionId}.sock`);

  return {
    router,
    provision(sessionId, spec) {
      const sockPath = socketPath(sessionId);
      return router.sessions.spawnAndAttach(sessionId, {
        binPath: options.atchBinPath,
        args: ['start', sockPath, ...spec.command], // CREATE: atch start ABSOLUTE_SOCKET_PATH cmd
        sockPath,
        geometry: spec.geometry,
        detached: true,
        killSpec: { binPath: options.atchBinPath, args: ['kill', '-f', sockPath] } // KILL contract
      });
    },
    retire(sessionId) {
      return router.sessions.retireAwaited(sessionId);
    },
    input(sessionId, bytes, paste = false) {
      return router.sessions.injectInput(sessionId, bytes, paste);
    },
    tail(sessionId, rows, offset = 0) {
      return router.sessions.historyText(sessionId, rows, offset);
    },
    attentionEventsSince(since) {
      const cursor = since > attentionSeq ? 0 : since; // stale cursor from a prior daemon incarnation
      return { events: attentionRing.filter((event) => event.seq > cursor), lastSeq: attentionSeq };
    },
    isReady() {
      return ready;
    },
    markReady() {
      ready = true;
    },
    dispose() {
      disposeBridge();
    }
  };
}

/**
 * A sessionId that is safe to use as a socket filename under the socket root:
 * no path separators, NUL, or traversal. Minted session ids (lowercase +
 * digits + hyphen) and §10 sessionIds both satisfy this. The daemon rejects
 * anything else rather than letting a caller escape the socket root.
 */
export function isSafeDaemonSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/.test(value);
}

/** Control payloads are tiny (a session id + a short command array). */
const CONTROL_BODY_MAX_BYTES = 64 * 1024;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

/** Clamp a client-supplied geometry so it can neither zero nor blow up the grid allocation (R4.3). */
function readProvisionGeometry(value: unknown): { rows: number; cols: number } {
  const geometry = (value ?? {}) as { rows?: unknown; cols?: unknown };
  const rows = Number(geometry.rows);
  const cols = Number(geometry.cols);
  return {
    rows: Number.isFinite(rows) && rows > 0 ? Math.min(Math.floor(rows), 1000) : 24,
    cols: Number.isFinite(cols) && cols > 0 ? Math.min(Math.floor(cols), 1000) : 80
  };
}

/**
 * The daemon's HTTP control plane: the web server posts here to provision/retire
 * a session's atch master on demand (the spawn/boot/restart cutover path). It is
 * an ordinary `request` listener; the binary terminal transport rides the
 * separate `upgrade` event, so the two never collide. Bodies read through the
 * shared bounded `readJsonBody`; responses through the shared `sendJson`.
 */
export function createDaemonControlHandler(
  daemon: Pick<TerminalDaemon, 'provision' | 'retire' | 'input' | 'tail' | 'attentionEventsSince' | 'isReady'>,
  handlerOptions: { healthNonce?: string } = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://daemon.local');
        if (!daemon.isReady()) {
          // Startup reconciliation has not reached a terminal state. EVERY
          // control route (health included) answers 503: a provision accepted
          // now could ensure() at N+1 over a surviving master that reconcile
          // was about to adopt at N, and the ACK-mismatch cleanup would then
          // DESTROY that master. Callers retry; the supervisor probe reads
          // not-ready.
          sendJson(res, 503, { ok: false, error: 'starting' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/provision') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          if (!isStringArray(body.command)) {
            sendJson(res, 400, { ok: false, error: 'command must be a non-empty string[]' });
            return;
          }
          const ens = await daemon.provision(body.sessionId, {
            command: body.command,
            geometry: readProvisionGeometry(body.geometry)
          });
          if (ens.ok) {
            sendJson(res, 200, { ok: true });
          } else {
            sendJson(res, 503, { ok: false, error: `atch provision refused: ${ens.reason}` });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/retire') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          const retired = await daemon.retire(body.sessionId);
          if (!retired.ok) {
            sendJson(res, 502, { ok: false, error: retired.error ?? 'retire failed' });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/input') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          if (typeof body.text !== 'string' || body.text.length === 0) {
            sendJson(res, 400, { ok: false, error: 'text must be a non-empty string' });
            return;
          }
          const accepted = daemon.input(body.sessionId, new TextEncoder().encode(body.text), body.paste === true);
          if (!accepted) {
            // An unknown session is a concrete failure the channels engine must
            // see (it reverts the delivery), never a silent ok.
            sendJson(res, 404, { ok: false, error: `no such session: ${body.sessionId}` });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/tail') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          const rows = Number(body.rows);
          const bounded = Number.isFinite(rows) && rows > 0 ? Math.min(Math.floor(rows), 2000) : 200;
          // offset counts lines back from the live edge; absent/invalid = 0
          // (the live tail — the pre-range contract unchanged).
          const offsetRaw = Number(body.offset);
          const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), 5000) : 0;
          const window = daemon.tail(body.sessionId, bounded, offset);
          if (window === undefined) {
            sendJson(res, 404, { ok: false, error: `no such session: ${body.sessionId}` });
            return;
          }
          sendJson(res, 200, { ok: true, lines: window.lines, totalAvailable: window.totalAvailable });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/attention') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          const since = Number(body.since);
          const drained = daemon.attentionEventsSince(Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0);
          sendJson(res, 200, { ok: true, ...drained });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/health') {
          sendJson(res, 200, {
            ok: true,
            ...(handlerOptions.healthNonce !== undefined ? { nonce: handlerOptions.healthNonce } : {})
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        if (error instanceof HttpBodyError) {
          sendJson(res, error.statusCode, { ok: false, error: error.message });
          return;
        }
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
}

export interface ProvisionRequest {
  sessionId: string;
  spec: TerminalDaemonSessionSpec;
}

/**
 * Provision atch masters for a set of sessions (the daemon process's startup
 * loop). Sequential so a burst of spawns does not thundering-herd the host; each
 * failure is isolated and reported, never aborting the rest.
 */
export async function provisionSessions(
  daemon: Pick<TerminalDaemon, 'provision'>,
  requests: readonly ProvisionRequest[]
): Promise<{ sessionId: string; ok: boolean; error?: string }[]> {
  const results: { sessionId: string; ok: boolean; error?: string }[] = [];
  for (const { sessionId, spec } of requests) {
    try {
      const ens = await daemon.provision(sessionId, spec);
      results.push({ sessionId, ok: ens.ok });
    } catch (error) {
      results.push({ sessionId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export interface RunTerminalDaemonOptions extends Omit<TerminalDaemonOptions, 'httpServer'> {
  host?: string;
  port: number;
  sessions: readonly ProvisionRequest[];
  /**
   * Leave the daemon NOT-ready after provisioning (every control route 503s)
   * so the caller can finish its own startup work — the process entry defers
   * until its reconcile pass reaches a terminal state, closing the window
   * where a provision could destroy a surviving master mid-adoption.
   */
  deferReady?: boolean;
}

export interface RunningTerminalDaemon {
  daemon: TerminalDaemon;
  server: import('node:http').Server;
  port: number;
  provisioned: { sessionId: string; ok: boolean; error?: string }[];
  close(): Promise<void>;
}

/**
 * The daemon-process main: start the standalone terminal daemon server, then
 * provision the atch master for each running session. Returns a handle with the
 * bound port and per-session provisioning results; a process entry adds the
 * signal handling around it.
 */
export async function runTerminalDaemon(options: RunTerminalDaemonOptions): Promise<RunningTerminalDaemon> {
  const server = await startTerminalDaemonServer(options);
  // provisionSessions drives the daemon directly (not over HTTP), so the
  // not-ready gate does not block this startup provisioning.
  const provisioned = await provisionSessions(server.daemon, options.sessions);
  if (options.deferReady !== true) {
    server.daemon.markReady();
  }
  return { daemon: server.daemon, server: server.server, port: server.port, provisioned, close: server.close };
}

export interface TerminalDaemonServer {
  daemon: TerminalDaemon;
  server: Server;
  /** The bound port (0 in options → an OS-assigned port). */
  port: number;
  close(): Promise<void>;
}

/**
 * Start the terminal daemon in its OWN http server (the separate-process entry).
 * This is the whole point of the three-tier split: the @xterm/headless emulator
 * and the master links live in the daemon process, NEVER in the web-server
 * process (embedding them there regressed serve startup timing). The web server
 * connects out to this via daemonClient / a WS proxy.
 */
export async function startTerminalDaemonServer(
  options: Omit<TerminalDaemonOptions, 'httpServer'> & { host?: string; port: number }
): Promise<TerminalDaemonServer> {
  const server = createServer();
  // The socket root must exist (0700, this user) BEFORE anything can bind
  // <root>/<sessionId>.sock — atch skips its own mkdir for slash-bearing names
  // and the master's bind() fails ENOENT on an absent parent.
  ensurePrivateSocketRoot(options.atchSocketRoot);
  const daemon = createTerminalDaemon({ ...options, httpServer: server });
  server.on(
    'request',
    createDaemonControlHandler(daemon, options.healthNonce !== undefined ? { healthNonce: options.healthNonce } : {})
  );
  // Reject cleanly on a bind failure (EADDRINUSE during an HMR/serve overlap)
  // instead of emitting an unhandled server 'error'.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      daemon.dispose();
      reject(error);
    };
    server.once('error', onError);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    daemon,
    server,
    port,
    close() {
      daemon.dispose();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
