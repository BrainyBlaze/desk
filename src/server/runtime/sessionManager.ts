// SessionManager (spec §3.2/§7.1) — the server-side composition that makes the
// daemon a complete session pipe: DaemonCore (pure registry) + a per-session
// MasterClient (the atch-master link) + browser fan-out. Ensures a session,
// attaches to its master socket, and wires master frames → SessionRuntime →
// browser and browser input → master. Node net lives only in MasterClient; the
// DaemonCore stays pure and is driven through its callbacks (no layering break).
//
// Testable against a fake v3 master today; the real atch binary drops in behind
// the same socket path once its master speaks v3.

import { GenerationLedger } from '../../shared/controlPlane/generationLedger.js';
import { WorkerSupervisor } from '../../shared/runtime/workerSupervisor.js';
import { type EmulatorFactory } from '../../shared/runtime/emulatorPort.js';
import { DaemonCore, type EnsureResult, type RestoreResult } from '../../shared/runtime/daemonCore.js';
import { type HookInput } from '../../shared/runtime/sessionRuntime.js';
import { type ControlState, type IntakeResult, type Source } from '../../shared/controlPlane/index.js';
import { type BpFrame } from '../../shared/browserProtocol/index.js';
import { MasterClient } from './masterClient.js';
import { SpawnMasterError, spawnMaster } from './spawnMaster.js';
import { Role } from '../../shared/atchWire/frames.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Run a detached-master kill command to completion, BOUNDED: spawn error,
 * nonzero exit, or a hang past timeoutMs is a failure — an unbounded kill
 * would let retireAwaited hang before it ever reaches its socket poll.
 */
function runKillCommand(kill: { binPath: string; args: string[] }, timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; error?: string }): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(kill.binPath, kill.args, { stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `kill spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      settle({ ok: false, error: `kill command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => settle({ ok: false, error: `kill spawn failed: ${error.message}` }));
    child.on('exit', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `kill command exited ${code ?? 'null'}` }));
  });
}

/** Poll until the master's socket disappears (bounded). */
async function waitForSocketGone(sockPath: string, timeoutMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(sockPath)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

export interface SessionManagerDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  /** Deliver a browser frame to a session's surface (the web-server WS wires this). */
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void;
  /** Attention-relevant emulator events (bell/OSC9) — see DaemonCoreDeps. */
  onSemanticEvent?: (sessionId: string, event: import('../../shared/runtime/emulatorPort.js').EmulatorEvent) => void;
}

export class SessionManager {
  private readonly core: DaemonCore;
  private readonly masters = new Map<string, MasterClient>();
  /** Per-session teardown for a tracked FOREGROUND child (kill it on retire). */
  private readonly cleanups = new Map<string, () => void>();
  /**
   * Per-session stop command for a DETACHED master (+ its socket), so the
   * control-plane retire can AWAIT the kill's completion and the socket's
   * disappearance — a retire that returns before the master is gone lets an
   * immediate re-provision adopt the STALE socket at the old generation.
   */
  private readonly detachedKills = new Map<string, { binPath: string; args: string[]; sockPath: string; mustConfirm?: boolean }>();
  /**
   * Ownership token per session, minted fresh by each spawn/restore operation.
   * Deferred callbacks from an OLD operation (a killed child's late 'exit', a
   * replaced master's close) must compare their token before retiring — a
   * plain sessionId callback would retire the SUCCESSOR session.
   */
  private readonly owners = new Map<string, symbol>();
  /**
   * In-flight provision per session: concurrent calls COALESCE onto one
   * operation (two Boot clicks = one spawn, both get its result). Interleaved
   * provisions would otherwise double-spawn against one socket, overwrite each
   * other's owner/cleanup, or kill the shared master from the loser's rollback.
   */
  private readonly inflight = new Map<string, Promise<EnsureResult | { ok: false; reason: 'spawn-failed' | 'attach-failed' }>>();

  constructor(deps: SessionManagerDeps) {
    this.core = new DaemonCore({
      ledger: deps.ledger,
      supervisor: deps.supervisor,
      emulatorFactory: deps.emulatorFactory,
      now: deps.now,
      sendBrowser: deps.sendBrowser,
      // sendMaster routes to the session's attached master client, if any.
      sendMaster: (sessionId, frame) => this.masters.get(sessionId)?.send(frame),
      ...(deps.onSemanticEvent !== undefined ? { onSemanticEvent: deps.onSemanticEvent } : {})
    });
  }

  ensure(sessionId: string, geometry: { rows: number; cols: number }): EnsureResult {
    return this.core.ensure(sessionId, geometry);
  }

  /**
   * Re-adopt a SURVIVING atch master after a daemon restart: restore the
   * session at its durable ledger generation (never allocate — the master owns
   * exactly that generation), attach over its socket, and register the
   * detached-master kill command so a later retire kills the master instead of
   * orphaning it. Fails closed (and rolls the restore back) when the attach
   * fails or the ledger has no generation for the sessionId.
   */
  async restoreAndAttach(
    sessionId: string,
    opts: {
      sockPath: string;
      geometry: { rows: number; cols: number };
      /** The detached-master stop command (e.g. `atch kill -f SOCK`). */
      killSpec: { binPath: string; args: string[] };
      ackTimeoutMs?: number;
    }
  ): Promise<RestoreResult | { ok: false; reason: 'attach-failed' }> {
    const restored = this.core.restore(sessionId, opts.geometry);
    if (!restored.ok) return restored;
    const token = Symbol('restore-op');
    this.owners.set(sessionId, token); // stale prior-op callbacks go inert
    // Register the kill command BEFORE the attach so a close that races the
    // attach's success can never leave an attached-but-unkillable master; the
    // attach itself only validates (it never closes a healthy master).
    this.detachedKills.set(sessionId, { ...opts.killSpec, sockPath: opts.sockPath });
    let attached = false;
    try {
      // The ACK generation MUST equal the restored ledger generation — the
      // runtime stamps frames with it; any other ACK would split the fence.
      attached = await this.attachMaster(sessionId, opts.sockPath, opts.geometry, {
        expectGeneration: restored.generation,
        stillValid: () => this.owners.get(sessionId) === token,
        ...(opts.ackTimeoutMs !== undefined ? { ackTimeoutMs: opts.ackTimeoutMs } : {})
      });
    } catch {
      attached = false;
    }
    if (!attached) {
      // Roll back WITHOUT running the kill: a failed attach means we could not
      // adopt the master, not license to destroy it (it may be healthy and
      // rejecting us). Idempotent against a racing close-retire.
      this.detachedKills.delete(sessionId);
      this.core.retire(sessionId);
      return { ok: false, reason: 'attach-failed' };
    }
    return restored;
  }

  /**
   * Attach to a session's atch master over its socket: connect, do the v3
   * controller handshake, and resolve ONLY on a validated ATTACH_ACK — a
   * written handshake is not an accepted one (the master may reject, error,
   * or close). With `expectGeneration`, an ACK carrying any other generation
   * fails the attach: the core runtime stamps frames with the restored ledger
   * generation, so adopting a different ACK generation would split the fence
   * (core INPUT at N, MasterClient RESIZE at M). A socket close AFTER a
   * successful attach retires the session; a close DURING the attach only
   * fails the attach — the master may be healthy and merely rejecting us, so
   * it must not be retired/killed.
   */
  async attachMaster(
    sessionId: string,
    sockPath: string,
    geometry: { rows: number; cols: number },
    opts: { expectGeneration?: number; ackTimeoutMs?: number; stillValid?: () => boolean } = {}
  ): Promise<boolean> {
    if (this.core.state(sessionId) === undefined) return false;
    let attached = false;
    let settle: (ok: boolean) => void = () => undefined;
    const acked = new Promise<boolean>((resolve) => {
      let settled = false;
      settle = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
    });
    const client = new MasterClient(sockPath, {
      onRecord: (rec) => this.core.onMasterRecord(sessionId, rec),
      onAttachAck: (ack) => {
        const generation = (ack as { generation: number }).generation;
        settle(opts.expectGeneration === undefined || generation === opts.expectGeneration);
      },
      onError: () => settle(false),
      onClose: () => {
        settle(false);
        // Identity-bound: only the CURRENTLY-installed client's close retires;
        // a replaced client's late close must not tear down its successor.
        if (attached && this.masters.get(sessionId) === client) {
          this.retire(sessionId);
        }
      }
    });
    try {
      await client.connect();
    } catch {
      return false;
    }
    client.handshake({ role: Role.CONTROLLER, sessionId, rows: geometry.rows, cols: geometry.cols });
    const timeoutMs = opts.ackTimeoutMs ?? 5_000;
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    const ok = await acked;
    clearTimeout(timer);
    // Re-check AFTER the await: a concurrent retire may have torn the session
    // down while the ACK was in flight — installing the client then would
    // resurrect a retired session with its teardown already consumed.
    if (!ok || (opts.stillValid !== undefined && !opts.stillValid()) || this.core.state(sessionId) === undefined) {
      client.close();
      return false;
    }
    attached = true;
    this.masters.set(sessionId, client);
    return true;
  }

  /**
   * Ensure a session, SPAWN its atch master with the ledger generation injected
   * as ATCH_GENERATION (§4.8.1 spawn contract), then attach. The generation the
   * master will own is exactly the durable-ledger value the daemon allocated, so
   * the fence is consistent across the join. Returns the ensure result.
   */
  async spawnAndAttach(
    sessionId: string,
    opts: {
      binPath: string;
      args: string[];
      sockPath: string;
      geometry: { rows: number; cols: number };
      readyTimeoutMs?: number;
      /** The launcher forks a detached master and exits (e.g. `atch start`). */
      detached?: boolean;
      /** For a detached master, the command to stop the session on retire (e.g. `atch kill -f NAME`). */
      killSpec?: { binPath: string; args: string[] };
    }
  ): Promise<EnsureResult | { ok: false; reason: 'spawn-failed' | 'attach-failed' }> {
    const pending = this.inflight.get(sessionId);
    if (pending !== undefined) {
      return pending;
    }
    const operation = this.doSpawnAndAttach(sessionId, opts).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, operation);
    return operation;
  }

  private async doSpawnAndAttach(
    sessionId: string,
    opts: {
      binPath: string;
      args: string[];
      sockPath: string;
      geometry: { rows: number; cols: number };
      readyTimeoutMs?: number;
      detached?: boolean;
      killSpec?: { binPath: string; args: string[] };
    }
  ): Promise<EnsureResult | { ok: false; reason: 'spawn-failed' | 'attach-failed' }> {
    if (this.core.state(sessionId) !== undefined && this.masters.has(sessionId)) {
      return this.ensure(sessionId, opts.geometry); // already provisioned AND attached — idempotent no-op
    }
    // Foreign-socket preflight BEFORE any durable allocation: ensure() would
    // advance the ledger to N+1 over a surviving generation-N master, fencing
    // it out of every future reconcile even though we never touch it.
    // spawnMaster repeats this check as the race-closing second gate.
    if (opts.detached === true && existsSync(opts.sockPath)) {
      return { ok: false, reason: 'spawn-failed' };
    }
    const ens = this.ensure(sessionId, opts.geometry);
    if (!ens.ok) return ens;
    const token = Symbol('spawn-op');
    this.owners.set(sessionId, token);
    let child: Awaited<ReturnType<typeof spawnMaster>>['child'];
    try {
      ({ child } = await spawnMaster({
        binPath: opts.binPath,
        args: opts.args,
        sockPath: opts.sockPath,
        generation: ens.generation,
        readyTimeoutMs: opts.readyTimeoutMs,
        detached: opts.detached
      }));
    } catch (error) {
      // The master never came up. Run the kill ONLY when this operation could
      // have created one (SpawnMasterError.ownershipPossible): a clean-exit
      // timeout may have half-forked a master, but a pre-existing socket or a
      // nonzero launcher exit is a FOREIGN or never-forked master — killing
      // there would destroy someone else's session. Then free the slot THIS
      // call allocated so provision never leaks capacity.
      const ownershipPossible = error instanceof SpawnMasterError ? error.ownershipPossible : true;
      if (opts.detached === true && opts.killSpec !== undefined && ownershipPossible) {
        // Register FIRST, then attempt to confirmed completion: a failed or
        // unconfirmed cleanup RETAINS the record so a later control retire can
        // finish the job (a half-forked master may surface its socket late).
        const record = { ...opts.killSpec, sockPath: opts.sockPath, mustConfirm: true };
        this.detachedKills.set(sessionId, record);
        await this.confirmKill(sessionId, record, 5_000);
      }
      if (ens.created) this.core.retire(sessionId);
      return { ok: false, reason: 'spawn-failed' };
    }
    if (opts.detached) {
      // A detached master: the launcher exits normally (do NOT retire on that);
      // teardown is the kill command, if provided.
      if (opts.killSpec !== undefined) {
        this.detachedKills.set(sessionId, { ...opts.killSpec, sockPath: opts.sockPath });
      }
    } else {
      // A tracked foreground child: retire when it exits, kill it on retire.
      // Token-bound: after retire + immediate respawn, the OLD child's late
      // exit must not retire the successor session.
      this.cleanups.set(sessionId, () => {
        if (child.exitCode === null) child.kill();
      });
      child.once('exit', () => {
        if (this.owners.get(sessionId) === token) {
          this.retire(sessionId);
        }
      });
    }
    // The ACK must carry exactly the generation this daemon injected at spawn
    // (§4.8.1) — anything else is a fenced/foreign master, not a success.
    const attached = await this.attachMaster(sessionId, opts.sockPath, opts.geometry, {
      expectGeneration: ens.generation,
      stillValid: () => this.owners.get(sessionId) === token
    });
    if (!attached) {
      // Kill ONLY the master this operation spawned — foreground child OR the
      // detached master it registered — wait for its socket to vanish, clear
      // every teardown entry this op made (no stale detachedKills), and free
      // the slot if this call allocated it. Never report ok for an unattached
      // session.
      await this.teardownFailedSpawn(sessionId, ens.created);
      return { ok: false, reason: 'attach-failed' };
    }
    return ens;
  }

  /**
   * Ownership-complete cleanup after a post-spawn failure: kill what THIS op
   * created. The kill record is deleted only on a CONFIRMED kill + socket
   * disappearance — a failed teardown keeps it registered so a later control
   * retire can retry, instead of stranding a detached master with no
   * teardown path at all (fail closed on the record, not just the verdict).
   */
  private async teardownFailedSpawn(sessionId: string, createdSlot: boolean): Promise<void> {
    const cleanup = this.cleanups.get(sessionId);
    this.cleanups.delete(sessionId);
    cleanup?.(); // foreground child kill (sync)
    const kill = this.detachedKills.get(sessionId);
    if (kill !== undefined) {
      // This op's master fate is uncertain — attempt to confirmed completion;
      // failure retains the record so a later control retire can retry it.
      kill.mustConfirm = true;
      await this.confirmKill(sessionId, kill, 5_000);
    }
    if (createdSlot) this.core.retire(sessionId);
  }

  subscribe(sessionId: string, surfaceId: string, rows: number, cols: number): number | undefined {
    return this.core.subscribe(sessionId, surfaceId, rows, cols);
  }

  onBrowserInput(sessionId: string, channelId: number, binary: boolean, bytes: Uint8Array): void {
    // Route through the runtime (keeps it in the loop for lease enforcement); its
    // sendMaster callback forwards the built INPUT frame to the attached master.
    this.core.onBrowserInput(sessionId, channelId, binary, bytes);
  }

  /** Route INPUT by channelId alone (the router validated WS ownership, §7.4). */
  onBrowserInputByChannel(channelId: number, binary: boolean, bytes: Uint8Array): boolean {
    return this.core.onBrowserInputByChannel(channelId, binary, bytes);
  }

  /** Unsubscribe a channel (surface + channel→session mapping). */
  unsubscribeChannel(channelId: number): void {
    this.core.unsubscribeChannel(channelId);
  }

  /** Route a browser RESIZE by channelId (ownership validated by the router). */
  onBrowserResizeByChannel(channelId: number, rows: number, cols: number): boolean {
    return this.core.onBrowserResizeByChannel(channelId, rows, cols);
  }

  /** Route a browser VISIBILITY by channelId. */
  onBrowserVisibilityByChannel(channelId: number, visible: boolean): boolean {
    return this.core.onBrowserVisibilityByChannel(channelId, visible);
  }

  /** Route a browser QUERY_REPLY by channelId (§7.7). */
  onBrowserQueryReplyByChannel(channelId: number, queryOffset: bigint, leaseEpoch: number, bytes: Uint8Array): boolean {
    return this.core.onBrowserQueryReplyByChannel(channelId, queryOffset, leaseEpoch, bytes);
  }

  /** The session that owns a channelId, or undefined if unknown/stale. */
  sessionOfChannel(channelId: number): string | undefined {
    return this.core.sessionOfChannel(channelId);
  }

  ingestHook(sessionId: string, hook: HookInput): IntakeResult | undefined {
    return this.core.ingestHook(sessionId, hook);
  }

  /** Control-plane input injection (channels delivery). False if the session is unknown. */
  injectInput(sessionId: string, bytes: Uint8Array, paste = false): boolean {
    return this.core.injectInput(sessionId, bytes, paste);
  }

  /** The session's on-screen tail as plain text (capture-pane equivalent), or undefined. */
  tailText(sessionId: string, rows: number): string[] | undefined {
    return this.core.tailText(sessionId, rows);
  }

  state(sessionId: string): { state: ControlState; source: Source; generation: number } | undefined {
    return this.core.state(sessionId);
  }

  list(): { sessionId: string; generation: number; state: ControlState; source: Source }[] {
    return this.core.list();
  }

  /**
   * Internal/synchronous teardown (socket-close, child-exit, dispose paths):
   * fire-and-forget the detached kill. The kill RECORD is retained — only a
   * CONFIRMED kill (retireAwaited) may consume it, so an unconfirmed teardown
   * never strands a master without a retriable teardown path. A retained
   * record after a successful fire-and-forget kill is harmless: the next
   * control retire sees the socket already gone and reads clean.
   */
  retire(sessionId: string): void {
    const kill = this.beginRetire(sessionId);
    if (kill !== undefined) {
      void runKillCommand(kill); // best effort — no caller to report to
    }
  }

  /**
   * Control-plane retire: AWAIT the kill command's completion AND the socket's
   * disappearance before reporting success — and consume the kill record ONLY
   * on that confirmation. Returning earlier lets an immediate re-provision see
   * the STALE socket as ready; deleting the record earlier means one failed
   * retire loses the ONLY teardown and the next retire reads falsely clean.
   */
  async retireAwaited(sessionId: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    // Order behind an in-flight provision: tearing down mid-operation would
    // consume the killSpec while the ACK continuation later installs a client
    // against a retired core. The provision settles deterministically first.
    const pending = this.inflight.get(sessionId);
    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }
    const kill = this.beginRetire(sessionId);
    if (kill === undefined) {
      return { ok: true };
    }
    return this.confirmKill(sessionId, kill, timeoutMs);
  }

  /**
   * Run a retained kill to CONFIRMATION: socket already gone reads clean; a
   * confirmed kill + disappearance consumes the record; any failure keeps it
   * for the next retry.
   */
  private async confirmKill(
    sessionId: string,
    kill: { binPath: string; args: string[]; sockPath: string; mustConfirm?: boolean },
    timeoutMs: number
  ): Promise<{ ok: boolean; error?: string }> {
    // The socket-absent shortcut applies ONLY to records whose master's fate
    // is certain. A mustConfirm record (an uncertain half-forked master, or a
    // record whose prior kill attempt failed) may see the socket ABSENT merely
    // because the master has not surfaced yet — reading that as clean would
    // delete the only teardown record and strand the late master.
    if (kill.mustConfirm !== true && !existsSync(kill.sockPath)) {
      this.detachedKills.delete(sessionId); // nothing addressable remains — clean
      return { ok: true };
    }
    const killed = await runKillCommand(kill, timeoutMs); // bounded: a hung kill fails, never blocks forever
    if (!killed.ok) {
      kill.mustConfirm = true; // fate now uncertain — no shortcut on later retries
      return killed; // record retained for retry
    }
    const gone = await waitForSocketGone(kill.sockPath, timeoutMs);
    if (!gone) {
      kill.mustConfirm = true;
      return { ok: false, error: `atch socket still present after kill: ${kill.sockPath}` }; // record retained
    }
    this.detachedKills.delete(sessionId); // confirmed — consume
    return { ok: true };
  }

  /**
   * Shared teardown core: detach state, run the foreground cleanup, free the
   * slot. PEEKS the kill record without consuming it — consumption is the
   * confirming caller's decision.
   */
  private beginRetire(sessionId: string): { binPath: string; args: string[]; sockPath: string } | undefined {
    this.owners.delete(sessionId); // any deferred old-operation callback goes stale
    this.masters.get(sessionId)?.close();
    this.masters.delete(sessionId);
    const cleanup = this.cleanups.get(sessionId);
    if (cleanup !== undefined) cleanup();
    this.cleanups.delete(sessionId);
    this.core.retire(sessionId);
    return this.detachedKills.get(sessionId);
  }

  get sessionCount(): number {
    return this.core.sessionCount;
  }
}
