// Loss-aware subscription resync (spec §7.4). Pure state machine, one per
// browser subscription (channel). Makes the binary protocol "loss-aware": it
// detects dropped output (offset gaps) or a recreated session (generation bump)
// and drives the client to detach and subscribe again. A bounded current-screen
// snapshot establishes the replacement channel; no retained Moor output is
// requested or replayed. Every data frame carries (generation, revision, offset).

export type ResyncState =
  | 'awaiting-baseline' // ACKed; waiting for the current-screen snapshot
  | 'live' // applying contiguous output deltas
  | 'dirty'; // this channel must be detached and replaced

/** What the client should do with an incoming data frame. */
export type FrameAction =
  | 'apply' // contiguous + current → render it, advance
  | 'discard' // stale straggler (older generation/revision, or already-seen offset)
  | 'dirty' // a gap or server-advanced generation → detach and re-subscribe
  | 'ignore'; // received before ACK or after dirty — nothing to do

export interface FrameMeta {
  generation: number;
  revision: number;
  offset: bigint;
  /** Byte length of this output frame (0 for a snapshot baseline). */
  length: number;
}

export class SubscriptionResync {
  private state: ResyncState = 'awaiting-baseline';
  private generation = 0;
  private revision = 0;
  /** Next contiguous output offset expected while live. */
  private expected = 0n;
  private hasBaseline = false;

  get phase(): ResyncState {
    return this.state;
  }
  get expectedOffset(): bigint {
    return this.expected;
  }

  /** A current-screen SNAPSHOT establishes the contiguous live-output baseline. */
  onSnapshot(m: FrameMeta): FrameAction {
    if (
      this.hasBaseline &&
      (m.generation < this.generation ||
        (m.generation === this.generation && m.revision < this.revision))
    ) {
      return 'discard';
    }
    this.generation = m.generation;
    this.revision = m.revision;
    this.expected = m.offset;
    this.state = 'live';
    this.hasBaseline = true;
    return 'apply';
  }

  /**
   * An OUTPUT delta. Decided locally from (generation, revision, offset):
   *  - older gen, or same-gen older rev  → stale straggler → discard
   *  - newer generation → replacement channel required
   *  - same-generation newer revision + exact offset → accept resize boundary
   *  - current gen+rev:
   *      offset === expected  → apply, advance expected by length
   *      offset  >  expected  → GAP → dirty
   *      offset  <  expected  → already-seen overlap → discard
   * Before SNAPSHOT or after `dirty`, deltas are ignored. The owner replaces the
   * channel; its next bounded screen snapshot establishes a new live baseline.
   */
  onOutput(m: FrameMeta): FrameAction {
    if (this.state !== 'live') return 'ignore';
    if (m.generation < this.generation) return 'discard';
    if (m.generation > this.generation) return this.toDirty();
    if (m.revision < this.revision) return 'discard';
    if (m.revision > this.revision) {
      if (m.offset !== this.expected) return this.toDirty();
      this.revision = m.revision;
    }
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

  private toDirty(): FrameAction {
    if (this.state === 'live') {
      this.state = 'dirty';
      return 'dirty';
    }
    return 'ignore';
  }
}
