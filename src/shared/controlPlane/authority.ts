import {
  AGENT_PRODUCER_BINDINGS,
  AGENT_STATE_SCHEMA_VERSION,
  type AcceptedAgentStateEvent,
  type AgentProducer,
  type AgentHealthInput,
  type AgentProvider,
  type AgentMode,
  type AgentStateTransport,
  type AgentStateEnvelope,
  type SessionExit,
  type SessionStateSnapshot,
  type SessionStateTransition,
  type SessionStateTransitionCause,
  parseAgentStateEnvelope
} from './contract.js';

/**
 * §10: the dedicated health reason for a holder whose verified-live heartbeat
 * evidence lapsed. Only THIS reason is cleared back to healthy on restoration.
 */
export const MOOR_LIVENESS_REASON = 'moor-holder-liveness';

/**
 * desk#64: the dedicated health reason for a session Desk holds NO link to
 * because an attach failed — most often a restart re-adoption that the holder
 * refused or never answered. It is a statement about Desk's link, not about
 * the child: the holder may be perfectly alive, which is exactly why the
 * session must not be recorded as ended. A separate reason from the liveness
 * one because it is what the operator reads: every surface renders
 * `health.reason` verbatim, and "we never adopted it" and "its heartbeat
 * lapsed" send an operator to different places. Cleared by the same
 * restoration as the liveness reason — an adoption ends both.
 */
export const MOOR_UNADOPTED_REASON = 'moor-holder-unadopted';

/** The health degradations THIS module owns, and may therefore clear. */
const MOOR_HOLDER_REASONS: readonly string[] = [MOOR_LIVENESS_REASON, MOOR_UNADOPTED_REASON];

export type SessionRegistration =
  | {
      sessionId: string;
      generation: number;
      lifecycle: 'starting' | 'running';
      subject: { kind: 'terminal' };
    }
  | {
      sessionId: string;
      generation: number;
      lifecycle: 'starting' | 'running';
      subject: {
        kind: 'agent';
        provider: AgentProvider;
        mode: AgentMode;
        producer: AgentProducer;
        producerInstanceId?: string;
      };
    };

export type AuthorityRejectionReason =
  | 'invalid-envelope'
  | 'session-not-found'
  | 'not-agent'
  | 'generation-mismatch'
  | 'producer-mismatch'
  | 'producer-instance-mismatch'
  | 'producer-order'
  | 'invalid-observation'
  | 'lifecycle-exited';

export type AuthorityMutationResult =
  | {
      kind: 'applied';
      snapshot: SessionStateSnapshot;
      transition: SessionStateTransition;
    }
  | {
      kind: 'noop';
      snapshot: SessionStateSnapshot;
    }
  | {
      kind: 'rejected';
      reason: AuthorityRejectionReason;
      snapshot?: SessionStateSnapshot;
    };

interface SessionRecord {
  snapshot: SessionStateSnapshot;
  producerInstanceId?: string;
  lastProducerSeq: Record<AgentStateTransport, number>;
  workingLeaseExpiresAt?: number;
  openToolLeaseExpiresAt: Map<string, number>;
  titleFallback?: { activity: 'working' | 'idle'; observedAt: number };
  titleProjectionActive: boolean;
  /**
   * §10: the exact health the Moor liveness degradation OVERLAID — restored
   * verbatim when the liveness episode resolves live, so a producer's own
   * degradation is never collapsed to healthy by a liveness round-trip. Any
   * newer health statement from its own source discards this saved state.
   */
  priorMoorHealth?: SessionStateSnapshot['health'];
}

export interface AgentStateAuthorityOptions {
  workingLeaseMs: number;
  openToolLeaseMs: number;
  now: () => number;
  onTransition?: (transition: SessionStateTransition) => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export class AgentStateAuthority {
  private readonly sessions = new Map<string, SessionRecord>();
  private revision = 0;

  constructor(private readonly options: AgentStateAuthorityOptions) {
    if (!Number.isSafeInteger(options.workingLeaseMs) || options.workingLeaseMs <= 0) {
      throw new Error('workingLeaseMs must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(options.openToolLeaseMs) ||
      options.openToolLeaseMs <= options.workingLeaseMs
    ) {
      throw new Error('openToolLeaseMs must be a safe integer greater than workingLeaseMs');
    }
  }

  registerSession(registration: SessionRegistration): SessionStateSnapshot {
    if (!isNonEmpty(registration.sessionId) || !isPositiveSafeInteger(registration.generation)) {
      throw new Error('invalid session registration');
    }
    if (registration.subject.kind === 'agent') {
      const binding = AGENT_PRODUCER_BINDINGS[registration.subject.producer];
      if (binding.provider !== registration.subject.provider || binding.mode !== registration.subject.mode) {
        throw new Error('producer registration does not match provider and mode');
      }
      if (
        registration.subject.producerInstanceId !== undefined &&
        !isNonEmpty(registration.subject.producerInstanceId)
      ) {
        throw new Error('producerInstanceId must be non-empty');
      }
    }

    const current = this.sessions.get(registration.sessionId);
    if (current !== undefined) {
      if (current.snapshot.generation > registration.generation) {
        throw new Error('cannot register an older generation');
      }
      if (current.snapshot.generation === registration.generation) {
        this.assertCompatibleRegistration(current, registration);
        return clone(current.snapshot);
      }
    }

    const at = this.safeNow();
    const subject =
      registration.subject.kind === 'terminal'
        ? ({ kind: 'terminal' } as const)
        : ({
            kind: 'agent',
            provider: registration.subject.provider,
            mode: registration.subject.mode,
            producer: registration.subject.producer,
            activity: 'unknown',
            activitySince: at,
            wait: null,
            evidence: null
          } as const);
    const snapshot: SessionStateSnapshot = {
      schemaVersion: AGENT_STATE_SCHEMA_VERSION,
      revision: this.nextRevision(),
      sessionId: registration.sessionId,
      generation: registration.generation,
      lifecycle: registration.lifecycle,
      lifecycleSince: at,
      exit: null,
      health:
        registration.subject.kind === 'agent'
          ? { status: 'degraded', reason: 'awaiting-reconciliation', since: at }
          : { status: 'healthy', since: at },
      delivery: null,
      policy: { paused: false, since: at },
      subject,
      updatedAt: at
    };
    const record: SessionRecord = {
      snapshot,
      producerInstanceId:
        registration.subject.kind === 'agent' ? registration.subject.producerInstanceId : undefined,
      lastProducerSeq: { push: 0, poll: 0 },
      openToolLeaseExpiresAt: new Map(),
      titleProjectionActive: false
    };
    this.sessions.set(registration.sessionId, record);
    this.emitTransition(null, record, 'registered', at);
    return clone(snapshot);
  }

  reconcileProducer(sessionId: string, generation: number, producerInstanceId: string): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    if (record!.snapshot.subject.kind !== 'agent') {
      return { kind: 'rejected', reason: 'not-agent', snapshot: clone(record!.snapshot) };
    }
    if (!isNonEmpty(producerInstanceId)) {
      return { kind: 'rejected', reason: 'producer-instance-mismatch', snapshot: clone(record!.snapshot) };
    }
    if (record!.producerInstanceId === producerInstanceId) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }

    const at = this.safeNow();
    const from = clone(record!.snapshot);
    record!.producerInstanceId = producerInstanceId;
    record!.lastProducerSeq = { push: 0, poll: 0 };
    record!.workingLeaseExpiresAt = undefined;
    record!.openToolLeaseExpiresAt.clear();
    record!.snapshot.subject.activity = 'unknown';
    record!.snapshot.subject.activitySince = at;
    record!.snapshot.subject.wait = null;
    record!.snapshot.subject.evidence = null;
    record!.snapshot.health = { status: 'degraded', reason: 'awaiting-reconciliation', since: at };
    record!.priorMoorHealth = undefined; // reconciliation resets the health axis
    return this.commit(record!, from, 'producer-reconciled', at);
  }

  /**
   * §10 holder-liveness observation (ANY subject kind — a terminal's holder
   * heartbeats the same way an agent's does). Losing the 15 s verified-live
   * window never proves the holder is gone, so the session state becomes
   * INDETERMINATE: health degrades with the dedicated liveness reason (the
   * bounded identity probe's outcome rides in `detail`). Restoration clears
   * ONLY that liveness degradation — a producer's own degraded health is a
   * different source and is never overwritten back to healthy here.
   *
   * desk#64: `reason` selects WHICH holder-link degradation this is — the
   * lapsed heartbeat (default) or an attach that never adopted. Both are
   * "Desk has no verified link", both are cleared by the same restoration,
   * and both keep the session non-terminal; they differ only in what the
   * operator is told, which is the whole reason the vocabulary is split.
   */
  observeHolderLiveness(
    sessionId: string,
    generation: number,
    live: boolean,
    detail?: string,
    reason: string = MOOR_LIVENESS_REASON
  ): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    if (record!.snapshot.lifecycle === 'exited') {
      return { kind: 'rejected', reason: 'lifecycle-exited', snapshot: clone(record!.snapshot) };
    }
    const current = record!.snapshot.health;
    const ourDegradation =
      current.status === 'degraded' && MOOR_HOLDER_REASONS.includes(current.reason);
    if (live) {
      if (!ourDegradation) {
        // Another source spoke while (or before) the episode — its statement
        // is newer than anything we saved, so the saved overlay is stale.
        record!.priorMoorHealth = undefined;
        return { kind: 'noop', snapshot: clone(record!.snapshot) };
      }
      const at = this.safeNow();
      const from = clone(record!.snapshot);
      // Restore the EXACT health the degradation overlaid (a producer's own
      // degraded state survives the liveness round-trip verbatim); healthy
      // only when nothing was overlaid.
      record!.snapshot.health =
        record!.priorMoorHealth === undefined
          ? { status: 'healthy', since: at }
          : clone(record!.priorMoorHealth);
      record!.priorMoorHealth = undefined;
      return this.commit(record!, from, 'source-health', at);
    }
    if (ourDegradation && current.reason === reason && current.detail === detail) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }
    const at = this.safeNow();
    const from = clone(record!.snapshot);
    if (!ourDegradation) {
      // First loss of this episode: save what the overlay covers. Moving
      // BETWEEN our own two reasons keeps the original overlay — it is the
      // same episode of link loss, told differently.
      record!.priorMoorHealth = clone(current);
    }
    record!.snapshot.health = {
      status: 'degraded',
      reason,
      since: at,
      ...(detail === undefined ? {} : { detail })
    };
    return this.commit(record!, from, 'source-health', at);
  }

  assessAgentHealth(
    sessionId: string,
    generation: number,
    health: AgentHealthInput
  ): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    if (record!.snapshot.lifecycle === 'exited') {
      return { kind: 'rejected', reason: 'lifecycle-exited', snapshot: clone(record!.snapshot) };
    }
    if (record!.snapshot.subject.kind !== 'agent') {
      return { kind: 'rejected', reason: 'not-agent', snapshot: clone(record!.snapshot) };
    }
    const current = record!.snapshot.health;
    const unchanged =
      current.status === health.status &&
      (health.status === 'healthy' ||
        (current.status === 'degraded' &&
          current.reason === health.reason &&
          current.detail === health.detail));
    if (unchanged) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }

    const at = this.safeNow();
    const from = clone(record!.snapshot);
    // The source's own statement supersedes anything a liveness overlay saved.
    record!.priorMoorHealth = undefined;
    record!.snapshot.health =
      health.status === 'healthy'
        ? { status: 'healthy', since: at }
        : {
            status: 'degraded',
            reason: health.reason,
            since: at,
            ...(health.detail === undefined ? {} : { detail: health.detail })
          };
    return this.commit(record!, from, 'source-health', at);
  }

  markRunning(sessionId: string, generation: number): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    if (record!.snapshot.lifecycle === 'exited') {
      return { kind: 'rejected', reason: 'lifecycle-exited', snapshot: clone(record!.snapshot) };
    }
    if (record!.snapshot.lifecycle === 'running') {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }
    const at = this.safeNow();
    const from = clone(record!.snapshot);
    record!.snapshot.lifecycle = 'running';
    record!.snapshot.lifecycleSince = at;
    return this.commit(record!, from, 'lifecycle-running', at);
  }

  observeTitleActivity(
    sessionId: string,
    generation: number,
    activity: 'working' | 'idle',
    observedAt: number
  ): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    if (
      (activity !== 'working' && activity !== 'idle') ||
      !Number.isFinite(observedAt) ||
      observedAt < 0
    ) {
      return {
        kind: 'rejected',
        reason: 'invalid-observation',
        snapshot: clone(record!.snapshot)
      };
    }
    if (record!.snapshot.lifecycle === 'exited') {
      return { kind: 'rejected', reason: 'lifecycle-exited', snapshot: clone(record!.snapshot) };
    }
    if (record!.snapshot.subject.kind !== 'agent') {
      return { kind: 'rejected', reason: 'not-agent', snapshot: clone(record!.snapshot) };
    }

    const normalizedObservedAt = Math.floor(observedAt);
    if (
      record!.titleFallback !== undefined &&
      normalizedObservedAt < record!.titleFallback.observedAt
    ) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }
    record!.titleFallback = { activity, observedAt: normalizedObservedAt };
    if (!this.canProjectTitle(record!)) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }
    if (
      record!.titleProjectionActive &&
      record!.snapshot.subject.activity === activity
    ) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }

    const at = Math.max(normalizedObservedAt, record!.snapshot.updatedAt);
    const from = clone(record!.snapshot);
    this.applyTitleFallback(record!, record!.titleFallback, at);
    return this.commit(record!, from, 'title-fallback', at);
  }

  markExited(
    sessionId: string,
    generation: number,
    exit: Required<Pick<SessionExit, 'code' | 'signal' | 'origin' | 'reason' | 'outcome' | 'diagnostic'>>,
    observedAt?: number
  ): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    if (
      observedAt !== undefined &&
      (!Number.isFinite(observedAt) || observedAt < 0)
    ) {
      return { kind: 'rejected', reason: 'invalid-observation' };
    }
    if (record!.snapshot.lifecycle === 'exited') {
      // desk#59: a `retired` exit is a PLACEHOLDER written by Desk's own
      // teardown, which knows nothing about how the child died. The holder's
      // real exit routinely lands milliseconds later; it must be allowed to
      // replace the placeholder, or the cause of death is lost forever. An
      // already `observed` exit is the truth and is never downgraded.
      if (record!.snapshot.exit?.origin !== 'retired' || exit.origin !== 'observed') {
        return { kind: 'noop', snapshot: clone(record!.snapshot) };
      }
      const correctedAt = Math.max(
        observedAt === undefined ? this.safeNow() : Math.floor(observedAt),
        record!.snapshot.updatedAt
      );
      const before = clone(record!.snapshot);
      record!.snapshot.exit = { ...exit, at: correctedAt };
      return this.commit(record!, before, 'lifecycle-exited', correctedAt);
    }
    const at =
      observedAt === undefined
        ? this.safeNow()
        : Math.max(Math.floor(observedAt), record!.snapshot.updatedAt);
    const from = clone(record!.snapshot);
    record!.snapshot.lifecycle = 'exited';
    record!.snapshot.lifecycleSince = at;
    record!.snapshot.exit = { ...exit, at };
    record!.workingLeaseExpiresAt = undefined;
    record!.openToolLeaseExpiresAt.clear();
    record!.titleFallback = undefined;
    record!.priorMoorHealth = undefined; // no liveness overlay survives an exit
    record!.titleProjectionActive = false;
    if (record!.snapshot.subject.kind === 'agent') {
      record!.snapshot.subject.activity = 'unknown';
      record!.snapshot.subject.activitySince = at;
      record!.snapshot.subject.wait = null;
      record!.snapshot.subject.evidence = null;
    }
    return this.commit(record!, from, 'lifecycle-exited', at);
  }

  /**
   * desk#59 — record what OBSERVATION failed to establish, without touching why
   * the session was retired.
   *
   * The initiating reason and a failed final drain are independent facts: a
   * session retired because its link closed, whose store then could not be
   * read, is BOTH of those things. Overwriting one with the other would trade a
   * known cause for a known blindness. So this refines exactly one field, once:
   * `diagnostic` may go from absent/null to an exact code and never back, and
   * origin, reason and outcome are left untouched. Observed child-exit truth
   * may only be annotated when its authenticated final output could not be
   * delivered; the generation fence keeps a successor out.
   */
  refineExitDiagnostic(
    sessionId: string,
    generation: number,
    diagnostic: NonNullable<SessionExit['diagnostic']>,
    observedAt?: number
  ): AuthorityMutationResult {
    const record = this.sessions.get(sessionId);
    const rejected = this.guardSession(record, generation);
    if (rejected !== undefined) return rejected;
    const exit = record!.snapshot.exit;
    const observedOutputTruncation =
      exit?.origin === 'observed' && diagnostic.code === 'moor-final-output-truncated';
    if (
      exit === null ||
      record!.snapshot.lifecycle !== 'exited' ||
      (exit.origin !== 'retired' && !observedOutputTruncation) ||
      // Monotonic: an existing diagnostic is never downgraded or replaced.
      (exit.diagnostic !== null && exit.diagnostic !== undefined)
    ) {
      return { kind: 'noop', snapshot: clone(record!.snapshot) };
    }
    const at = Math.max(
      observedAt === undefined ? this.safeNow() : Math.floor(observedAt),
      record!.snapshot.updatedAt
    );
    const from = clone(record!.snapshot);
    record!.snapshot.exit = { ...exit, diagnostic };
    return this.commit(record!, from, 'lifecycle-exited', at);
  }

  ingest(event: AcceptedAgentStateEvent): AuthorityMutationResult {
    let envelope: AgentStateEnvelope;
    try {
      envelope = parseAgentStateEnvelope(event.envelope);
    } catch {
      return { kind: 'rejected', reason: 'invalid-envelope' };
    }
    if (
      !isPositiveSafeInteger(event.acceptedSeq) ||
      !Number.isSafeInteger(event.acceptedAt) ||
      event.acceptedAt < 0 ||
      !isNonEmpty(event.acceptanceId)
    ) {
      return { kind: 'rejected', reason: 'invalid-envelope' };
    }

    const record = this.sessions.get(envelope.sessionId);
    const rejected = this.guardSession(record, envelope.generation);
    if (rejected !== undefined) return rejected;
    if (record!.snapshot.lifecycle === 'exited') {
      return { kind: 'rejected', reason: 'lifecycle-exited', snapshot: clone(record!.snapshot) };
    }
    if (record!.snapshot.subject.kind !== 'agent') {
      return { kind: 'rejected', reason: 'not-agent', snapshot: clone(record!.snapshot) };
    }
    if (
      record!.snapshot.subject.provider !== envelope.provider ||
      record!.snapshot.subject.mode !== envelope.mode ||
      record!.snapshot.subject.producer !== envelope.producer
    ) {
      return { kind: 'rejected', reason: 'producer-mismatch', snapshot: clone(record!.snapshot) };
    }
    if (
      record!.producerInstanceId !== undefined &&
      record!.producerInstanceId !== envelope.producerInstanceId
    ) {
      return {
        kind: 'rejected',
        reason: 'producer-instance-mismatch',
        snapshot: clone(record!.snapshot)
      };
    }
    const transport = envelope.transport ?? 'push';
    if (envelope.producerSeq <= record!.lastProducerSeq[transport]) {
      return { kind: 'rejected', reason: 'producer-order', snapshot: clone(record!.snapshot) };
    }

    const at = Math.max(event.acceptedAt, record!.snapshot.updatedAt);
    this.expireWorking(record!, at);
    const from = clone(record!.snapshot);
    record!.producerInstanceId = envelope.producerInstanceId;
    record!.lastProducerSeq[transport] = envelope.producerSeq;
    const supersedesTitleProjection = envelope.facts.some(
      (fact) =>
        fact.kind === 'activity' ||
        fact.kind === 'blocked' ||
        fact.kind === 'unblocked' ||
        fact.kind === 'tool'
    );
    if (record!.titleProjectionActive && supersedesTitleProjection) {
      record!.snapshot.subject.activity = 'unknown';
      record!.snapshot.subject.activitySince = at;
      record!.snapshot.subject.wait = null;
      record!.snapshot.subject.evidence = null;
      record!.workingLeaseExpiresAt = undefined;
      record!.openToolLeaseExpiresAt.clear();
      record!.titleProjectionActive = false;
    }

    for (const fact of envelope.facts) {
      if (fact.kind === 'health') continue;
      switch (fact.kind) {
        case 'activity':
          record!.snapshot.subject.activity = fact.activity;
          record!.snapshot.subject.activitySince = at;
          record!.snapshot.subject.wait = null;
          if (fact.activity === 'working') {
            record!.workingLeaseExpiresAt = at + this.options.workingLeaseMs;
            record!.snapshot.health = { status: 'healthy', since: at };
          } else {
            record!.workingLeaseExpiresAt = undefined;
            record!.openToolLeaseExpiresAt.clear();
            record!.snapshot.health =
              fact.activity === 'unknown'
                ? { status: 'degraded', reason: 'producer-reported-unknown', since: at }
                : { status: 'healthy', since: at };
          }
          break;
        case 'blocked':
          record!.snapshot.subject.activity = 'blocked';
          record!.snapshot.subject.activitySince = at;
          record!.snapshot.subject.wait = { ...fact.wait, since: at };
          record!.snapshot.health = { status: 'healthy', since: at };
          record!.workingLeaseExpiresAt = undefined;
          record!.openToolLeaseExpiresAt.clear();
          break;
        case 'unblocked':
          record!.snapshot.subject.activity = 'unknown';
          record!.snapshot.subject.activitySince = at;
          record!.snapshot.subject.wait = null;
          record!.snapshot.health = { status: 'healthy', since: at };
          record!.workingLeaseExpiresAt = undefined;
          record!.openToolLeaseExpiresAt.clear();
          break;
        case 'heartbeat':
          if (record!.titleProjectionActive) break;
          if (record!.snapshot.subject.activity === 'working') {
            record!.workingLeaseExpiresAt = at + this.options.workingLeaseMs;
          }
          record!.snapshot.health = { status: 'healthy', since: at };
          break;
        case 'tool': {
          const toolUseId = envelope.correlation!.toolUseId!;
          if (fact.phase === 'start') {
            record!.openToolLeaseExpiresAt.set(toolUseId, at + this.options.openToolLeaseMs);
            record!.snapshot.subject.activity = 'working';
            record!.snapshot.subject.activitySince = at;
            record!.snapshot.subject.wait = null;
            record!.workingLeaseExpiresAt = at + this.options.workingLeaseMs;
          } else if (
            record!.openToolLeaseExpiresAt.delete(toolUseId) &&
            record!.snapshot.subject.activity === 'working'
          ) {
            record!.workingLeaseExpiresAt = at + this.options.workingLeaseMs;
          }
          record!.snapshot.health = { status: 'healthy', since: at };
          break;
        }
      }
    }

    for (const fact of envelope.facts) {
      if (fact.kind !== 'health') continue;
      if (record!.titleProjectionActive) continue;
      record!.snapshot.health =
        fact.health.status === 'healthy'
          ? { status: 'healthy', since: at }
          : {
              status: 'degraded',
              reason: fact.health.reason,
              since: at,
              ...(fact.health.detail === undefined ? {} : { detail: fact.health.detail })
            };
    }

    const leaseExpiresAt = this.effectiveWorkingLeaseExpiresAt(record!);
    if (!record!.titleProjectionActive) {
      record!.snapshot.subject.evidence = {
        acceptanceId: event.acceptanceId,
        acceptedSeq: event.acceptedSeq,
        acceptedAt: event.acceptedAt,
        producerInstanceId: envelope.producerInstanceId,
        transport,
        producerSeq: envelope.producerSeq,
        eventId: envelope.eventId,
        invocationId: envelope.invocationId,
        factKinds: envelope.facts.map((fact) => fact.kind),
        occurredAt: envelope.occurredAt,
        observedAt: envelope.observedAt,
        ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt })
      };
    }
    return this.commit(record!, from, 'agent-event', at, event.acceptanceId);
  }

  refresh(sessionId: string): SessionStateSnapshot | undefined {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return undefined;
    this.expireWorking(record, this.safeNow());
    return clone(record.snapshot);
  }

  snapshot(sessionId: string): SessionStateSnapshot | undefined {
    return this.refresh(sessionId);
  }

  list(): SessionStateSnapshot[] {
    return this.snapshotView().snapshots;
  }

  snapshotView(): { revision: number; snapshots: SessionStateSnapshot[] } {
    const at = this.safeNow();
    for (const record of this.sessions.values()) {
      this.expireWorking(record, at);
    }
    return {
      revision: this.revision,
      snapshots: [...this.sessions.values()].map((record) => clone(record.snapshot))
    };
  }

  private guardSession(
    record: SessionRecord | undefined,
    generation: number
  ): Extract<AuthorityMutationResult, { kind: 'rejected' }> | undefined {
    if (record === undefined) return { kind: 'rejected', reason: 'session-not-found' };
    if (record.snapshot.generation !== generation) {
      return { kind: 'rejected', reason: 'generation-mismatch', snapshot: clone(record.snapshot) };
    }
    return undefined;
  }

  private assertCompatibleRegistration(record: SessionRecord, registration: SessionRegistration): void {
    if (record.snapshot.subject.kind !== registration.subject.kind) {
      throw new Error('conflicting registration subject');
    }
    if (record.snapshot.subject.kind === 'agent' && registration.subject.kind === 'agent') {
      if (
        record.snapshot.subject.provider !== registration.subject.provider ||
        record.snapshot.subject.mode !== registration.subject.mode ||
        record.snapshot.subject.producer !== registration.subject.producer
      ) {
        throw new Error('conflicting agent registration');
      }
      if (
        registration.subject.producerInstanceId !== undefined &&
        record.producerInstanceId !== undefined &&
        registration.subject.producerInstanceId !== record.producerInstanceId
      ) {
        throw new Error('producer instance replacement requires reconciliation');
      }
    }
  }

  private expireWorking(record: SessionRecord, at: number): void {
    for (const [toolUseId, expiresAt] of record.openToolLeaseExpiresAt) {
      if (at >= expiresAt) record.openToolLeaseExpiresAt.delete(toolUseId);
    }
    const leaseExpiresAt = this.effectiveWorkingLeaseExpiresAt(record);
    if (
      record.snapshot.lifecycle === 'exited' ||
      record.snapshot.subject.kind !== 'agent' ||
      record.snapshot.subject.activity !== 'working' ||
      record.titleProjectionActive ||
      (leaseExpiresAt !== undefined && at < leaseExpiresAt)
    ) {
      return;
    }
    const from = clone(record.snapshot);
    record.snapshot.subject.activity = 'unknown';
    record.snapshot.subject.activitySince = at;
    record.snapshot.subject.wait = null;
    record.snapshot.health = { status: 'degraded', reason: 'source-stale', since: at };
    record.workingLeaseExpiresAt = undefined;
    record.openToolLeaseExpiresAt.clear();
    if (record.titleFallback !== undefined) {
      this.applyTitleFallback(record, record.titleFallback, at);
    }
    this.commit(record, from, 'working-lease-expired', at);
  }

  private canProjectTitle(record: SessionRecord): boolean {
    if (record.titleProjectionActive) return true;
    if (
      record.snapshot.subject.kind !== 'agent' ||
      record.snapshot.subject.activity !== 'unknown'
    ) {
      return false;
    }
    if (record.snapshot.subject.evidence === null) return true;
    return (
      record.snapshot.health.status === 'degraded' &&
      record.snapshot.health.reason === 'source-stale'
    );
  }

  private applyTitleFallback(
    record: SessionRecord,
    fallback: NonNullable<SessionRecord['titleFallback']>,
    at: number
  ): void {
    if (record.snapshot.subject.kind !== 'agent') return;
    record.snapshot.subject.activity = fallback.activity;
    record.snapshot.subject.activitySince = at;
    record.snapshot.subject.wait = null;
    record.snapshot.subject.evidence = {
      source: 'terminal-title',
      observedAt: fallback.observedAt
    };
    record.snapshot.health = { status: 'degraded', reason: 'title-fallback', since: at };
    record.workingLeaseExpiresAt = undefined;
    record.openToolLeaseExpiresAt.clear();
    record.titleProjectionActive = true;
  }

  private effectiveWorkingLeaseExpiresAt(record: SessionRecord): number | undefined {
    let expiresAt = record.workingLeaseExpiresAt;
    for (const toolExpiresAt of record.openToolLeaseExpiresAt.values()) {
      expiresAt = expiresAt === undefined ? toolExpiresAt : Math.max(expiresAt, toolExpiresAt);
    }
    return expiresAt;
  }

  private commit(
    record: SessionRecord,
    from: SessionStateSnapshot,
    cause: SessionStateTransitionCause,
    at: number,
    acceptedEventId?: string
  ): Extract<AuthorityMutationResult, { kind: 'applied' }> {
    record.snapshot.revision = this.nextRevision();
    record.snapshot.updatedAt = at;
    const transition = this.emitTransition(from, record, cause, at, acceptedEventId);
    return { kind: 'applied', snapshot: clone(record.snapshot), transition };
  }

  private emitTransition(
    from: SessionStateSnapshot | null,
    record: SessionRecord,
    cause: SessionStateTransitionCause,
    at: number,
    acceptedEventId?: string
  ): SessionStateTransition {
    const to = clone(record.snapshot);
    const wasOperatorBlocked =
      from?.subject.kind === 'agent' &&
      from.subject.activity === 'blocked' &&
      from.subject.wait?.owner === 'operator';
    const isOperatorBlocked =
      to.subject.kind === 'agent' &&
      to.subject.activity === 'blocked' &&
      to.subject.wait?.owner === 'operator';
    const transition: SessionStateTransition = {
      schemaVersion: AGENT_STATE_SCHEMA_VERSION,
      revision: to.revision,
      sessionId: to.sessionId,
      generation: to.generation,
      at,
      cause,
      ...(acceptedEventId === undefined ? {} : { acceptedEventId }),
      actionable: isOperatorBlocked && !wasOperatorBlocked,
      from: from === null ? null : clone(from),
      to
    };
    this.options.onTransition?.(clone(transition));
    return transition;
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  private safeNow(): number {
    const now = this.options.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('now() must return a non-negative safe integer');
    }
    return now;
  }
}
