// desk#68 — one size per session. The runtime keeps a size per subscriber but
// drives ONE child pty. With "last writer wins", two surfaces of one session at
// different sizes overwrite each other forever: each observes the terminal
// change underneath it, re-fits, re-reports. That is the mesh.
//
// The rule under test: exactly one subscriber OWNS the size (§7.5 "only the
// owning surface may resize"); the rest are observers whose geometry is
// remembered but never commanded. Ownership hands off deterministically when
// the owner hides or leaves.
//
// "Commanded" throughout: these tests observe what Desk selected and sent, not
// the child's pty — the holder is the authority on that.
//
// These tests assert the SEQUENCE of sizes sent to the master, not the final
// state: the defect is the repetition, and a final-state assertion cannot see it.

import { describe, expect, it } from 'vitest';
import { BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
import { InMemoryCmdCache } from '../src/shared/delivery/index.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  DaemonCore,
  SessionRuntime,
  WorkerSupervisor,
  type EmulatorEvent,
  type EmulatorPort,
  type SessionGeometryStore
} from '../src/shared/runtime/index.js';

class FakeEmu implements EmulatorPort {
  readonly resizes: [number, number][] = [];
  write(): void {}
  resize(rows: number, cols: number): void {
    this.resizes.push([rows, cols]);
  }
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    // Like the real SerializeAddon, the serialized display reflects the
    // emulator's CURRENT geometry — which is what lets a test see whether a
    // snapshot was taken before or after a resize was applied.
    const last = this.resizes.at(-1);
    return last === undefined ? 'SCREEN unsized' : `SCREEN ${last[0]}x${last[1]}`;
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeRuntime() {
  const emu = new FakeEmu();
  /** Every size actually put on the wire to the child's pty, in order. */
  const sent: [number, number, number][] = [];
  /** Every frame pushed to a browser channel, in order. */
  const browser: { channelId: number; frame: BpFrame }[] = [];
  const runtime = new SessionRuntime({
    sessionId: 's1',
    generation: 1,
    emulator: emu,
    cmdCache: new InMemoryCmdCache(),
    now: () => 1_000,
    sendBrowser: (channelId, frame) => {
      browser.push({ channelId, frame });
    },
    sendMasterInput: () => true,
    sendMasterResize: (rows, cols, surfaceId) => {
      sent.push([rows, cols, surfaceId]);
    }
  });
  const sizes = (): [number, number][] => sent.map(([rows, cols]) => [rows, cols]);
  return { runtime, emu, sent, sizes, browser };
}

// THE RULE these tests derive their expected values from:
//   1. The first surface to subscribe owns the session's size, and ACQUIRING
//      ownership commands the acquirer's geometry — the SUBSCRIBE frame is the
//      only carrier of it the runtime is guaranteed to see (the client's reveal
//      path suppresses a RESIZE whose size is unchanged).
//   2. Only the owner's resizes are commanded; every other subscriber is an
//      observer whose geometry is recorded against it and goes no further.
//   3. When the owner hides or unsubscribes, ownership passes to the VISIBLE
//      subscriber with the lowest channelId — channelIds are allocated
//      monotonically, so that is the longest-standing visible surface — and
//      that surface's stored geometry is commanded exactly once.
//   4. With no visible subscriber there is no owner and the size is left alone;
//      the next surface to subscribe or become visible acquires per rule 1.
//   5. A whole connection's channels leave in one bulk removal before any
//      election runs — a dying sibling is never transiently promoted.
//
// The two sizes below are the ones observed flipping on a real child's pty:
// 48x95 and 41x137. They are deliberately un-orderable — neither dominates the
// other — so a wrong rule cannot accidentally produce the right number:
//   min over visible  → 41x95, a size NEITHER surface ever reported;
//   max over visible  → 48x137, likewise;
//   last writer wins  → alternation, which the sequence assertions catch.
const OWNER_SIZE: [number, number] = [48, 95];
const OBSERVER_SIZE: [number, number] = [41, 137];

describe('desk#68 — one owner of the session size', () => {
  it('an observer cannot oscillate the owner: only the owner reaches the master', () => {
    const { runtime, emu, sizes } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const observer = runtime.subscribe('surf-observer', ...OBSERVER_SIZE).channelId;

    // The exact shape of the live evidence: two sizes, each surface
    // re-reporting round after round while the child's pty flipped.
    for (let round = 0; round < 4; round += 1) {
      runtime.onBrowserResize(owner, ...OWNER_SIZE);
      runtime.onBrowserResize(observer, ...OBSERVER_SIZE);
    }

    // Rule 1 + 2: the FIRST subscriber owns — its acquisition commands once and
    // each of its re-reports commands again. 48x95 five times, no other value.
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OWNER_SIZE, OWNER_SIZE, OWNER_SIZE]);
    expect(emu.resizes).toEqual([OWNER_SIZE, OWNER_SIZE, OWNER_SIZE, OWNER_SIZE, OWNER_SIZE]);
    expect(runtime.resizeOwnerChannel).toBe(owner);
  });

  it('the sequence reaches a fixed point and stays there through observer churn', () => {
    const { runtime, sizes } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const observer = runtime.subscribe('surf-observer', ...OBSERVER_SIZE).channelId;

    runtime.onBrowserResize(owner, ...OWNER_SIZE);
    const afterOwner = sizes().length;

    // Everything an observer can do: resize, hide, show, resize again.
    runtime.onBrowserResize(observer, ...OBSERVER_SIZE);
    runtime.onBrowserVisibility(observer, false);
    runtime.onBrowserResize(observer, 30, 90);
    runtime.onBrowserVisibility(observer, true);
    runtime.onBrowserResize(observer, ...OBSERVER_SIZE);

    expect(sizes().length).toBe(afterOwner);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]); // acquisition + the owner's report
  });

  it('order independence: which surface reports first does not change the result', () => {
    const forward = makeRuntime();
    const fOwner = forward.runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const fObserver = forward.runtime.subscribe('surf-observer', ...OBSERVER_SIZE).channelId;
    for (let round = 0; round < 3; round += 1) {
      forward.runtime.onBrowserResize(fOwner, ...OWNER_SIZE);
      forward.runtime.onBrowserResize(fObserver, ...OBSERVER_SIZE);
    }

    const reverse = makeRuntime();
    const rOwner = reverse.runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const rObserver = reverse.runtime.subscribe('surf-observer', ...OBSERVER_SIZE).channelId;
    for (let round = 0; round < 3; round += 1) {
      reverse.runtime.onBrowserResize(rObserver, ...OBSERVER_SIZE);
      reverse.runtime.onBrowserResize(rOwner, ...OWNER_SIZE);
    }

    expect(reverse.sizes()).toEqual(forward.sizes());
    // Rule 1: the owner's size, not 41x95 (min) and not 48x137 (max).
    expect(forward.sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OWNER_SIZE, OWNER_SIZE]);
  });

  // The survivor's size ending up on the pty is NOT by itself evidence of a
  // handoff: pre-fix, the survivor often happened to write last. Both tests
  // below make the survivor report BEFORE the owner leaves and then report
  // nothing after, so the only thing that can produce its size at the end is
  // promotion applying its STORED geometry.
  it('owner HIDES: the visible subscriber is promoted and its stored geometry commanded exactly once', () => {
    const { runtime, sizes, sent } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const next = runtime.subscribe('surf-next', 24, 80).channelId;
    runtime.onBrowserResize(owner, ...OWNER_SIZE);
    runtime.onBrowserResize(next, 24, 80);
    runtime.onBrowserResize(next, ...OBSERVER_SIZE); // re-fits again; still silent
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);

    runtime.onBrowserVisibility(owner, false);

    // Rule 3: exactly one entry, carrying the successor's LATEST stored
    // geometry — 41x137, not 24x80 (its subscribe size), not 41x95 (a min) —
    // sent under the successor's channel. It never had to re-report.
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OBSERVER_SIZE]);
    expect(sent.length).toBe(3);
    expect(sent[2]).toEqual([...OBSERVER_SIZE, next]);
    expect(runtime.resizeOwnerChannel).toBe(next);
  });

  it('owner UNSUBSCRIBES: the visible subscriber is promoted and its stored geometry commanded exactly once', () => {
    const { runtime, sizes, sent } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const next = runtime.subscribe('surf-next', 24, 80).channelId;
    runtime.onBrowserResize(owner, ...OWNER_SIZE);
    runtime.onBrowserResize(next, 24, 80);
    runtime.onBrowserResize(next, ...OBSERVER_SIZE);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);

    runtime.unsubscribe(owner);

    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OBSERVER_SIZE]);
    expect(sent.length).toBe(3);
    expect(sent[2]).toEqual([...OBSERVER_SIZE, next]);
    expect(runtime.resizeOwnerChannel).toBe(next);
    expect(runtime.subscriberCount).toBe(1);
  });

  it('promotion tie-break: the longest-standing VISIBLE surface wins, not a Map accident', () => {
    const { runtime, sizes } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const older = runtime.subscribe('surf-older', ...OBSERVER_SIZE).channelId;
    const newer = runtime.subscribe('surf-newer', 30, 90).channelId;
    runtime.onBrowserResize(owner, ...OWNER_SIZE);

    runtime.unsubscribe(owner);

    // Rule 3, both candidates legitimately VISIBLE: the lower channelId — the
    // surface attached longest — takes it, so the size is 41x137 and not 30x90.
    expect(runtime.resizeOwnerChannel).toBe(older);
    expect(newer).toBeGreaterThan(older);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OBSERVER_SIZE]);
  });

  it('promotion skips hidden candidates even when they are longer-standing', () => {
    const { runtime, sizes } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const older = runtime.subscribe('surf-older', ...OBSERVER_SIZE).channelId;
    const newer = runtime.subscribe('surf-newer', 30, 90).channelId;
    runtime.onBrowserResize(owner, ...OWNER_SIZE);
    // The older candidate is hidden, so the newer one must win — proving the
    // rule is "lowest channelId AMONG VISIBLE", not merely "lowest channelId".
    runtime.onBrowserVisibility(older, false);

    runtime.unsubscribe(owner);

    expect(runtime.resizeOwnerChannel).toBe(newer);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, [30, 90]]);
  });

  // Isolates the "owner is still visible" guard in the handoff. Every other
  // handoff test is absorbed by the "was it the OWNER's event" guard next to
  // it — those two conditions are correlated in practice but not by contract,
  // so this drives the one path where only the second one can answer.
  it('a visibility announcement about an ALREADY-visible surface changes nothing', () => {
    const { runtime, sizes } = makeRuntime();
    const first = runtime.subscribe('surf-first', ...OWNER_SIZE).channelId;
    const second = runtime.subscribe('surf-second', ...OBSERVER_SIZE).channelId;
    runtime.onBrowserResize(first, ...OWNER_SIZE);
    runtime.onBrowserResize(second, ...OBSERVER_SIZE);

    // Clients re-announce visibility on mount and on refocus. The owner saying
    // "still visible" is not a handoff trigger and must not re-apply anything.
    runtime.onBrowserVisibility(first, true);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);
    expect(runtime.resizeOwnerChannel).toBe(first);

    // And a surface COMING BACK does not steal the size from the live owner,
    // even though it is longer-standing and would win a fresh election.
    runtime.onBrowserVisibility(first, false);
    expect(runtime.resizeOwnerChannel).toBe(second);
    runtime.onBrowserVisibility(first, true);
    expect(runtime.resizeOwnerChannel).toBe(second);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OBSERVER_SIZE]);
  });

  it('a late resize from the DEMOTED owner after promotion is ignored', () => {
    const { runtime, emu, sizes } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const next = runtime.subscribe('surf-next', ...OBSERVER_SIZE).channelId;
    runtime.onBrowserResize(owner, ...OWNER_SIZE);
    runtime.onBrowserVisibility(owner, false);

    // In flight when the handoff happened, and it must not move the pty back.
    expect(runtime.onBrowserResize(owner, ...OWNER_SIZE)).toBeUndefined();
    expect(runtime.onBrowserResize(owner, 60, 200)).toBeUndefined();

    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, OBSERVER_SIZE]);
    expect(emu.resizes).toEqual([OWNER_SIZE, OWNER_SIZE, OBSERVER_SIZE]);
    expect(runtime.commandedSize()).toEqual({ rows: 41, cols: 137 });
    expect(runtime.resizeOwnerChannel).toBe(next);
  });

  it('no visible subscriber leaves the size ALONE — never zero, never a default', () => {
    const { runtime, emu, sizes } = makeRuntime();
    const only = runtime.subscribe('surf-only', ...OWNER_SIZE).channelId;
    runtime.onBrowserResize(only, ...OWNER_SIZE);

    runtime.onBrowserVisibility(only, false);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);
    expect(runtime.resizeOwnerChannel).toBeUndefined();

    // A hidden keep-alive mount keeps reporting; nothing may reach the child.
    expect(runtime.onBrowserResize(only, 24, 80)).toBeUndefined();
    runtime.unsubscribe(only);

    // Rule 4: still 48x95 — not 24x80, not 0x0, not a default.
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);
    expect(emu.resizes).toEqual([OWNER_SIZE, OWNER_SIZE]);
    expect(runtime.commandedSize()).toEqual({ rows: 48, cols: 95 });
    expect(runtime.subscriberCount).toBe(0);
  });

  it('the first surface to become visible again takes ownership and commands its size', () => {
    const { runtime, sizes } = makeRuntime();
    const only = runtime.subscribe('surf-only', ...OWNER_SIZE).channelId;
    runtime.onBrowserResize(only, ...OWNER_SIZE);
    runtime.onBrowserVisibility(only, false);
    runtime.onBrowserResize(only, 24, 80); // measured while hidden — recorded, not commanded
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);

    runtime.onBrowserVisibility(only, true);

    expect(runtime.resizeOwnerChannel).toBe(only);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE, [24, 80]]);
  });

  it('an observer leaving changes nothing: no re-election, no re-command', () => {
    const { runtime, sizes } = makeRuntime();
    const owner = runtime.subscribe('surf-owner', ...OWNER_SIZE).channelId;
    const observer = runtime.subscribe('surf-observer', ...OBSERVER_SIZE).channelId;
    runtime.onBrowserResize(owner, ...OWNER_SIZE);

    // Rule 3 is about the OWNER leaving. An observer leaving must not trigger
    // an election — not even one that would re-elect the same owner, because
    // its re-command would put a spurious resize on the wire.
    expect(runtime.unsubscribe(observer)).toBeUndefined();

    expect(runtime.resizeOwnerChannel).toBe(owner);
    expect(sizes()).toEqual([OWNER_SIZE, OWNER_SIZE]);
    expect(runtime.subscriberCount).toBe(1);
  });

  it('reports the size COMMANDED, not the size the surface asked for', () => {
    const { runtime } = makeRuntime();
    const acquiring = runtime.subscribe('surf-owner', ...OWNER_SIZE);
    const owner = acquiring.channelId;
    // Rule 1: the acquiring subscribe reports what it commanded; a joining
    // observer's subscribe commands nothing and says so.
    expect(acquiring.commanded).toEqual({ rows: 48, cols: 95, surfaceId: owner });
    const joining = runtime.subscribe('surf-observer', ...OBSERVER_SIZE);
    const observer = joining.channelId;
    expect(joining.commanded).toBeUndefined();

    expect(runtime.onBrowserResize(owner, ...OWNER_SIZE)).toEqual({ rows: 48, cols: 95, surfaceId: owner });
    expect(runtime.onBrowserResize(observer, ...OBSERVER_SIZE)).toBeUndefined();
    expect(runtime.onBrowserResize(999, 10, 10)).toBeUndefined();
    expect(runtime.commandedSize()).toEqual({ rows: 48, cols: 95 });
  });
});

// ---- the durable record (desk#62 × desk#68) ---------------------------------
// The live evidence for this bug is 55 records in 15 minutes, two alternating
// sizes per session, written to ~/.config/desk/_engine/session-geometry.ndjson.
// A fix that still persisted an observer's resize would keep writing the war
// into a durable file — and the next incarnation would restore from whichever
// side of it happened to be last.
function makeCore(
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void = () => {}
) {
  const recorded: { sessionId: string; rows: number; cols: number }[] = [];
  const masterOut: [number, number, number][] = [];
  const store: SessionGeometryStore = {
    get: () => undefined,
    record: (sessionId, geometry) => {
      recorded.push({ sessionId, rows: geometry.rows, cols: geometry.cols });
    },
    forget: () => {}
  };
  const deps = {
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1_000,
    sendBrowser,
    sendMasterInput: () => true,
    sendMasterResize: (_sessionId, rows, cols, surfaceId) => {
      masterOut.push([rows, cols, surfaceId]);
    },
    sessionGeometry: store
  };
  const core = new DaemonCore(deps);
  core.ensure('s1', { rows: 24, cols: 80 });
  // ensure() records the creation geometry (desk#62); start counting after it.
  recorded.length = 0;
  return { core, recorded, masterOut };
}


describe('desk#68 — DaemonCore records geometry only for a COMMANDED resize', () => {

  it('an observer resize writes NO record; the owner resize writes exactly one', () => {
    const { core, recorded } = makeCore();
    const owner = core.subscribe('s1', 'surf-owner', ...OWNER_SIZE)!.channelId;
    const observer = core.subscribe('s1', 'surf-observer', ...OBSERVER_SIZE)!.channelId;

    core.onBrowserResizeByChannel(owner, ...OWNER_SIZE);
    for (let round = 0; round < 4; round += 1) {
      core.onBrowserResizeByChannel(observer, ...OBSERVER_SIZE);
    }

    // Two records for two subscribes and five resizes — the owner's acquisition
    // and the owner's report, both at the owner's exact size. 41x137 never
    // appears, and neither does any size no surface reported.
    expect(recorded).toEqual([
      { sessionId: 's1', rows: 48, cols: 95 },
      { sessionId: 's1', rows: 48, cols: 95 }
    ]);
    expect(core.onBrowserResizeByChannel(owner, ...OWNER_SIZE)).toEqual({
      routed: true,
      commanded: { rows: 48, cols: 95, surfaceId: owner }
    });
    expect(core.onBrowserResizeByChannel(observer, ...OBSERVER_SIZE)).toEqual({ routed: true });
  });

  it('a handoff records the promoted geometry — the record tracks what was COMMANDED', () => {
    const { core, recorded } = makeCore();
    const owner = core.subscribe('s1', 'surf-owner', ...OWNER_SIZE)!.channelId;
    const next = core.subscribe('s1', 'surf-next', ...OBSERVER_SIZE)!.channelId;
    // The survivor reports FIRST and the owner reports LAST, so a record ending
    // at the survivor's size cannot be "whoever wrote last won" — only a
    // promotion applying the survivor's stored geometry can produce it.
    core.onBrowserResizeByChannel(next, ...OBSERVER_SIZE);
    core.onBrowserResizeByChannel(owner, ...OWNER_SIZE);

    core.unsubscribeChannel(owner);

    expect(recorded).toEqual([
      { sessionId: 's1', rows: 48, cols: 95 }, // the owner's acquisition
      { sessionId: 's1', rows: 48, cols: 95 }, // the owner's report
      { sessionId: 's1', rows: 41, cols: 137 } // the handoff to the survivor
    ]);
  });

  it('a browser delivery failure removes the owner, promotes one successor, and records the handoff', async () => {
    let failedChannel: number | undefined;
    const { core, recorded, masterOut } = makeCore((_sessionId, channelId, frame) => {
      if (channelId === failedChannel && frame.type === BpFrameType.OUTPUT) {
        throw new Error('browser channel closed');
      }
    });
    const owner = core.subscribe('s1', 'surf-owner', ...OWNER_SIZE)!.channelId;
    const next = core.subscribe('s1', 'surf-next', ...OBSERVER_SIZE)!.channelId;
    failedChannel = owner;

    await expect(
      Promise.resolve().then(() =>
        core.onMoorOutput('s1', new TextEncoder().encode('x'), 0n)
      )
    ).resolves.toBeUndefined();

    expect(core.onBrowserResizeByChannel(owner, ...OWNER_SIZE)).toEqual({ routed: false });
    expect(core.onBrowserResizeByChannel(next, ...OBSERVER_SIZE)).toEqual({
      routed: true,
      commanded: { rows: 41, cols: 137, surfaceId: next }
    });
    expect(masterOut).toEqual([
      [48, 95, owner],
      [41, 137, next],
      [41, 137, next]
    ]);
    expect(recorded).toEqual([
      { sessionId: 's1', rows: 48, cols: 95 },
      { sessionId: 's1', rows: 41, cols: 137 },
      { sessionId: 's1', rows: 41, cols: 137 }
    ]);
  });

  it('an unknown channel is routed:false and writes nothing', () => {
    const { core, recorded } = makeCore();
    expect(core.onBrowserResizeByChannel(9_999, ...OWNER_SIZE)).toEqual({ routed: false });
    expect(recorded).toEqual([]);
  });
});

// ---- ownership acquisition commands (desk#68 review blocker 1) --------------
// The client implements hide/reveal as UNSUBSCRIBE + fresh SUBSCRIBE
// (binaryTerminalBrokerClient.setVisibility), and the reveal path suppresses a
// RESIZE whose size is unchanged (TerminalSurface's lastResizeRef dedupe, twice
// over). So after "A hides, B hides, A reveals", the ONLY carrier of A's
// geometry the runtime will ever see is the SUBSCRIBE frame itself. Acquiring
// ownership must therefore command the acquirer's geometry transactionally —
// otherwise the owner renders 48x95 while the child stays at 41x137 forever.
describe('desk#68 — acquiring ownership on subscribe commands the acquirer geometry', () => {
  it('reveal after hide-all: the re-subscriber owns and its geometry is commanded with NO resize frame', () => {
    const { runtime, emu, sent, sizes } = makeRuntime();
    const a = runtime.subscribe('surf-a', ...OWNER_SIZE).channelId;
    const b = runtime.subscribe('surf-b', ...OBSERVER_SIZE).channelId;

    runtime.unsubscribe(a); // A hides → handoff commands B's 41x137
    runtime.unsubscribe(b); // B hides → no owner, size left alone at 41x137
    const a2 = runtime.subscribe('surf-a', ...OWNER_SIZE).channelId; // A reveals — and no RESIZE follows

    expect(runtime.resizeOwnerChannel).toBe(a2);
    expect(sizes()).toEqual([OWNER_SIZE, OBSERVER_SIZE, OWNER_SIZE]);
    expect(emu.resizes).toEqual([OWNER_SIZE, OBSERVER_SIZE, OWNER_SIZE]);
    expect(sent.at(-1)).toEqual([...OWNER_SIZE, a2]);
    expect(runtime.commandedSize()).toEqual({ rows: 48, cols: 95 });
  });

  // Pins the ordering the acquisition comment promises: the command runs
  // BEFORE the ACK and SNAPSHOT are emitted. With the order broken, the ACK
  // carries the pre-command revision and the snapshot is serialized at the
  // PREVIOUS owner's geometry — the browser renders a stale-geometry snapshot
  // and then reflows when the resize lands, on exactly the reveal path this
  // acquisition exists to fix.
  it('reveal after hide-all: the ACK carries the post-command revision and the snapshot is serialized at the commanded geometry', () => {
    const { runtime, browser } = makeRuntime();
    const a = runtime.subscribe('surf-a', ...OWNER_SIZE).channelId; // revision 0 → 1
    const b = runtime.subscribe('surf-b', ...OBSERVER_SIZE).channelId;
    runtime.unsubscribe(a); // handoff commands B's 41x137 — revision 1 → 2
    runtime.unsubscribe(b);
    browser.length = 0;

    const a2 = runtime.subscribe('surf-a', ...OWNER_SIZE).channelId; // revision 2 → 3

    expect(browser).toEqual([
      {
        channelId: a2,
        frame: {
          type: BpFrameType.SUBSCRIBE_ACK,
          channelId: a2,
          generation: 1,
          revision: 3 // the post-command revision, not 2
        }
      },
      {
        channelId: a2,
        frame: {
          type: BpFrameType.SNAPSHOT,
          channelId: a2,
          generation: 1,
          revision: 3,
          offset: 0n,
          text: 'SCREEN 48x95' // serialized at the commanded geometry, not at B's 41x137
        }
      }
    ]);
  });

  it('reveal after hide-all: the journal and the master both record the re-acquirer geometry', () => {
    const { core, recorded, masterOut } = makeCore();
    const a = core.subscribe('s1', 'surf-a', ...OWNER_SIZE)!.channelId;
    const b = core.subscribe('s1', 'surf-b', ...OBSERVER_SIZE)!.channelId;
    core.unsubscribeChannel(a);
    core.unsubscribeChannel(b);
    const a2 = core.subscribe('s1', 'surf-a', ...OWNER_SIZE)!.channelId;

    expect(recorded).toEqual([
      { sessionId: 's1', rows: 48, cols: 95 },
      { sessionId: 's1', rows: 41, cols: 137 },
      { sessionId: 's1', rows: 48, cols: 95 }
    ]);
    expect(masterOut).toEqual([
      [...OWNER_SIZE, a],
      [...OBSERVER_SIZE, b],
      [...OWNER_SIZE, a2]
    ]);
  });
});

// ---- shared-connection close (desk#68 review blocker 2) ---------------------
// One browser WebSocket carries many channels. When it closes, ALL of its
// channels must leave before any handoff election runs: removing them one at a
// time transiently promotes a dying sibling and commands the child through a
// surface that is already gone.
describe('desk#68 — a closing connection removes its channels in bulk', () => {
  it('elects the true survivor exactly once, never a dying sibling', () => {
    const { core, masterOut } = makeCore();
    const c1 = core.subscribe('s1', 'cell-one', ...OWNER_SIZE)!.channelId;
    const c2 = core.subscribe('s1', 'cell-two', ...OBSERVER_SIZE)!.channelId;
    const c3 = core.subscribe('s1', 'cell-other-conn', 30, 90)!.channelId;
    masterOut.length = 0;

    core.unsubscribeChannels([c1, c2]);

    expect(masterOut).toEqual([[30, 90, c3]]);
    expect(core.sessionOfChannel(c1)).toBeUndefined();
    expect(core.sessionOfChannel(c2)).toBeUndefined();
    expect(core.sessionOfChannel(c3)).toBe('s1');
  });

  it('a connection holding ALL channels closes: zero commands, size left alone', () => {
    const { core, recorded, masterOut } = makeCore();
    const c1 = core.subscribe('s1', 'cell-one', ...OWNER_SIZE)!.channelId;
    const c2 = core.subscribe('s1', 'cell-two', ...OBSERVER_SIZE)!.channelId;
    masterOut.length = 0;
    recorded.length = 0;

    core.unsubscribeChannels([c1, c2]);

    expect(masterOut).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('channels spanning two sessions are grouped: each session elects independently', () => {
    const { core, masterOut } = makeCore();
    core.ensure('s2', { rows: 24, cols: 80 });
    const s1Owner = core.subscribe('s1', 'one', ...OWNER_SIZE)!.channelId;
    const s2Owner = core.subscribe('s2', 'two', ...OBSERVER_SIZE)!.channelId;
    const s1Other = core.subscribe('s1', 'other', 30, 90)!.channelId;
    masterOut.length = 0;

    core.unsubscribeChannels([s1Owner, s2Owner]);

    // s1 hands off to its survivor; s2 has none and its size is left alone.
    expect(masterOut).toEqual([[30, 90, s1Other]]);
  });
});
