// Loss-aware subscription resync (spec §7.4). Pure state machine, one per
// browser subscription (channel). Makes the binary protocol "loss-aware": it
// detects dropped output (offset gaps), a recreated session (generation bump),
// or a geometry change (revision bump), and drives the client back to a clean
// baseline via a fresh snapshot — rather than rendering a corrupted screen from
// partial deltas. Every server data frame carries (generation, revision, offset)
// so this decision is LOCAL and order-independent.

export type ResyncState =
  | 'awaiting-snapshot' // subscribed; waiting for the baseline snapshot
  | 'live' // applying contiguous output deltas
  | 'dirty' // a gap / stale-baseline was detected; a fresh snapshot is needed
  | 'resyncing'; // a fresh snapshot has been requested; awaiting it

/** What the client should do with an incoming data frame. */
export type FrameAction =
  | 'apply' // contiguous + current → render it, advance
  | 'discard' // stale straggler (older generation/revision, or already-seen offset)
  | 'dirty' // a gap or a server-advanced gen/rev → drop to dirty, resync
  | 'ignore'; // received while already dirty/resyncing — nothing to do

export interface FrameMeta {
  generation: number;
  revision: number;
  offset: bigint;
  /** Byte length of this output frame (0 for a snapshot, which sets the baseline). */
  length: number;
}

export class SubscriptionResync {
  private state: ResyncState = 'awaiting-snapshot';
  private generation = 0;
  private revision = 0;
  /** Next contiguous output offset expected while live. */
  private expected = 0n;

  get phase(): ResyncState {
    return this.state;
  }
  get expectedOffset(): bigint {
    return this.expected;
  }

  /**
   * A SNAPSHOT establishes (or re-establishes) the baseline at its generation /
   * revision / offset. A snapshot for an OLDER generation/revision than the
   * current baseline is stale and discarded; otherwise it makes us `live`.
   */
  onSnapshot(m: FrameMeta): FrameAction {
    if (this.state === 'live' && (m.generation < this.generation || (m.generation === this.generation && m.revision < this.revision))) {
      return 'discard'; // stale snapshot behind our current baseline
    }
    this.generation = m.generation;
    this.revision = m.revision;
    this.expected = m.offset;
    this.state = 'live';
    return 'apply';
  }

  /**
   * An OUTPUT delta. Decided locally from (generation, revision, offset):
   *  - older gen, or same-gen older rev  → stale straggler → discard
   *  - newer gen, or same-gen newer rev  → server advanced → dirty (resync)
   *  - current gen+rev:
   *      offset === expected  → apply, advance expected by length
   *      offset  >  expected  → GAP → dirty
   *      offset  <  expected  → already-seen overlap → discard
   * While `dirty`/`resyncing`/`awaiting-snapshot`, deltas are ignored until a
   * fresh snapshot re-baselines us.
   */
  onOutput(m: FrameMeta): FrameAction {
    if (this.state !== 'live') return 'ignore';
    if (m.generation < this.generation) return 'discard';
    if (m.generation > this.generation) return this.toDirty();
    if (m.revision < this.revision) return 'discard';
    if (m.revision > this.revision) return this.toDirty();
    if (m.offset === this.expected) {
      this.expected += BigInt(m.length);
      return 'apply';
    }
    if (m.offset < this.expected) return 'discard'; // overlap / already applied
    return this.toDirty(); // offset > expected → dropped bytes
  }

  /** An explicit GAP frame (server-declared loss) → dirty. */
  onGap(): FrameAction {
    return this.toDirty();
  }

  /** Local WS backpressure / high-water → dirty (we may have dropped frames). */
  onBackpressure(): FrameAction {
    return this.toDirty();
  }

  /** Transition dirty → resyncing once the client has requested a fresh snapshot. */
  requestedSnapshot(): void {
    if (this.state === 'dirty') this.state = 'resyncing';
  }

  /** True while a fresh snapshot is owed (dirty, not yet requested). */
  needsSnapshot(): boolean {
    return this.state === 'dirty';
  }

  private toDirty(): FrameAction {
    if (this.state === 'live') {
      this.state = 'dirty';
      return 'dirty';
    }
    return 'ignore';
  }
}
