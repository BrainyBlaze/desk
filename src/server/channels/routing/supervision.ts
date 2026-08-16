// Who owes this channel an answer.
//
// Supervision watches ONE thing: work this channel handed out that has not been
// reported back. A worker has an open task when the channel prompted them more
// recently than they posted to it; they are stuck when that task has been
// silent past the supervisor's threshold and the worker is not currently
// working. Work an agent picked up outside the channel is invisible here —
// roles live per-channel, so supervision does too.
//
// The module is a pure read model over two timestamps per worker. It performs
// no I/O, reads no clock of its own, and never sends anything: the caller
// supplies the roster, the clock, and an activity probe, and decides what to do
// with the names that come back.

import type { ChannelMember } from '../protocol/format.js';

/** Default max-idle when a supervisor does not set one. */
export const DEFAULT_MAX_IDLE_MINUTES = 3;

export interface StuckWorker {
  name: string;
  stoppedForMinutes: number;
}

interface WorkerActivity {
  lastPromptAt: number;
  lastPostAt: number;
}

interface ChannelActivity {
  workers: Map<string, WorkerActivity>;
  /** epoch ms of the last check-in fired for the current open work window; 0 = none */
  lastCheckInAt: number;
}

export class ChannelSupervision {
  private readonly channels = new Map<string, ChannelActivity>();

  /** Channels with at least one recorded prompt or post. */
  watched(): string[] {
    return [...this.channels.keys()].filter((channel) => (this.channels.get(channel)?.workers.size ?? 0) > 0);
  }

  /**
   * This channel handed `member` a prompt. A new task closes the previous
   * check-in window, so the next one can fire once THIS prompt goes unanswered.
   */
  recordPrompt(channel: string, member: string, now: number): void {
    const entry = this.ensure(channel);
    const prior = entry.workers.get(member) ?? { lastPromptAt: 0, lastPostAt: 0 };
    entry.workers.set(member, { lastPromptAt: now, lastPostAt: prior.lastPostAt });
    entry.lastCheckInAt = 0;
  }

  /** `member` posted to this channel — they reported back on any open task. */
  recordPost(channel: string, member: string, now: number): void {
    const entry = this.ensure(channel);
    const prior = entry.workers.get(member) ?? { lastPromptAt: 0, lastPostAt: 0 };
    entry.workers.set(member, { lastPromptAt: prior.lastPromptAt, lastPostAt: now });
    entry.lastCheckInAt = 0;
  }

  /**
   * True when `member` owes this channel an answer: it prompted them more
   * recently than they posted back. The single question supervision is built
   * on — `findStuck` is this plus a threshold and an activity probe.
   */
  hasOpenTask(channel: string, member: string): boolean {
    const worker = this.channels.get(channel)?.workers.get(member);
    return worker !== undefined && worker.lastPromptAt > worker.lastPostAt;
  }

  /** Supervisors of a channel that this engine can actually deliver to. */
  supervisorsOf(members: ChannelMember[]): ChannelMember[] {
    return members.filter((member) => member.supervisor === true && member.sessionId && member.type !== 'human');
  }

  /** Shortest max-idle among a channel's supervisors, in ms. */
  thresholdMs(supervisors: ChannelMember[]): number {
    const minutes = Math.min(
      ...supervisors.map((sup) =>
        sup.supervisorMaxIdleMinutes && sup.supervisorMaxIdleMinutes > 0
          ? sup.supervisorMaxIdleMinutes
          : DEFAULT_MAX_IDLE_MINUTES
      )
    );
    return minutes * 60_000;
  }

  /**
   * Workers with an open task from this channel that has been silent past
   * `thresholdMs`. `isWorking` answers whether a session is demonstrably
   * working right now; a worker that is cannot be stuck.
   */
  findStuck(
    channel: string,
    members: ChannelMember[],
    options: { thresholdMs: number; now: number; isWorking: (sessionId: string) => boolean }
  ): StuckWorker[] {
    const entry = this.channels.get(channel);
    if (!entry) {
      return [];
    }
    const stuck: StuckWorker[] = [];
    for (const member of members) {
      if (member.type === 'human') continue;
      if (member.supervisor === true) continue;
      if (!member.sessionId) continue;
      const worker = entry.workers.get(member.name);
      if (!worker) continue;
      if (!this.hasOpenTask(channel, member.name)) continue;
      const silentForMs = options.now - worker.lastPromptAt;
      if (silentForMs < options.thresholdMs) continue;
      if (options.isWorking(member.sessionId)) continue;
      stuck.push({ name: member.name, stoppedForMinutes: Math.round(silentForMs / 60_000) });
    }
    return stuck;
  }

  /** True once a check-in has already fired for the current open work window. */
  checkedIn(channel: string): boolean {
    return (this.channels.get(channel)?.lastCheckInAt ?? 0) > 0;
  }

  /** Spam guard: one check-in per open work window, until a prompt or post resets it. */
  markCheckedIn(channel: string, now: number): void {
    this.ensure(channel).lastCheckInAt = now;
  }

  private ensure(channel: string): ChannelActivity {
    let entry = this.channels.get(channel);
    if (!entry) {
      entry = { workers: new Map(), lastCheckInAt: 0 };
      this.channels.set(channel, entry);
    }
    return entry;
  }
}
