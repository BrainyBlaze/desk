import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { fetchPulse } from './api.js';
import { UNKNOWN_AGENT, sessionStatusView, type SessionStatusView } from './agentStatusModel.js';
import { patchViewLiveness } from './pulse.js';
import { emitBridgeRetry } from './terminalHeartbeat.js';
import { pushSparkSample, type SparkSample } from './systemFormat.js';
import type { DeskSnapshot, SystemSnapshot } from './types.js';

export type SessionStatusMap = Record<string, SessionStatusView>;

export interface TelemetryHistory {
  cpu: SparkSample[];
  ram: SparkSample[];
  gpu: SparkSample[];
  net: SparkSample[];
  disk: SparkSample[];
}

/** Carry an unmeasured tick into every ring so the sparklines break at a
 * failed pulse instead of freezing on the last drawn line. */
export function markTelemetryGap(history: TelemetryHistory): void {
  for (const ring of [history.cpu, history.ram, history.gpu, history.net, history.disk]) {
    pushSparkSample(ring, undefined);
  }
}

interface UsePulseParams {
  setSnapshot: Dispatch<SetStateAction<DeskSnapshot | null>>;
  setStatusViews: Dispatch<SetStateAction<SessionStatusMap>>;
}

interface UsePulseResult {
  systemSnapshot: SystemSnapshot | null;
  systemError: string | null;
  telemetryHistoryRef: MutableRefObject<TelemetryHistory>;
  /** Forces the next pulse to reconcile against the server payload. */
  invalidateAttentionPulse: () => void;
}

/**
 * Owns the 2s pulse loop: system telemetry plus the authority's canonical
 * session state, folded into the presentation views every surface reads.
 *
 * The state half can be absent — the daemon may be unreachable while telemetry
 * still flows. That case yields NO views rather than empty ones, so a session
 * Desk cannot currently read renders as `unknown` instead of as a confidently
 * resting agent. Keeping the last known views instead would show a turn that
 * may have ended minutes ago as if it were current.
 */
export function usePulse({ setSnapshot, setStatusViews }: UsePulseParams): UsePulseResult {
  const [systemSnapshot, setSystemSnapshot] = useState<SystemSnapshot | null>(null);
  // Telemetry sparkline rings (one sample per poll tick); the snapshot state
  // change is what re-renders the header, so a ref avoids double renders.
  const telemetryHistoryRef = useRef<TelemetryHistory>({
    cpu: [],
    ram: [],
    gpu: [],
    net: [],
    disk: []
  });
  const [systemError, setSystemError] = useState<string | null>(null);
  // Last server payload (serialized) for the pulse diff-and-bail. Optimistic
  // local mutations clear it so the next pulse re-syncs unconditionally.
  const pulseCacheRef = useRef({ states: '' });
  // Each request captures this generation before fetchPulse(). Optimistic
  // local mutations advance it so an older payload cannot undo local state
  // after its await resolves.
  const attentionGenerationRef = useRef(0);
  // Tracks whether the previous pulse failed, so a success transition can wake
  // any terminal cells stranded on the manual Reconnect overlay (self-healing).
  const pulseFailingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    async function pulseTick(): Promise<void> {
      const attentionGeneration = attentionGenerationRef.current;
      try {
        const pulse = await fetchPulse();
        if (!alive) {
          return;
        }
        const system = pulse.system;
        const history = telemetryHistoryRef.current;
        // Unmeasured ticks stay gaps in the history — a sparkline must not
        // draw a confident zero next to a tile that honestly says 'init'.
        pushSparkSample(history.cpu, system.cpu.usagePercent);
        pushSparkSample(history.ram, system.memory?.usedPercent);
        pushSparkSample(history.gpu, system.gpu.nvidia.utilizationGpuPercent);
        pushSparkSample(history.net, system.network.rxBytesPerSecond);
        pushSparkSample(
          history.disk,
          system.disk?.readBytesPerSecond !== undefined && system.disk.writeBytesPerSecond !== undefined
            ? system.disk.readBytesPerSecond + system.disk.writeBytesPerSecond
            : undefined
        );
        setSystemSnapshot(system);
        setSystemError(null);
        // A pulse that succeeds after a run of failures proves the bridge is
        // reachable again — wake any cells stranded behind the Reconnect button.
        if (pulseFailingRef.current) {
          pulseFailingRef.current = false;
          emitBridgeRetry();
        }
        // Diff-and-bail: the view map keeps its object identity when the
        // payload did not change, so the memoized sidebar/multiplexer trees
        // skip reconciliation entirely on a calm tick.
        if (attentionGeneration === attentionGenerationRef.current) {
          const statesJson = JSON.stringify(pulse.agentStates ?? null);
          if (statesJson !== pulseCacheRef.current.states) {
            pulseCacheRef.current.states = statesJson;
            setStatusViews(viewsFromPulse(pulse.agentStates?.snapshots));
          }
        }
        // Liveness self-heal: fold the live session-id set into the snapshot.
        // patchViewLiveness preserves identity of untouched sessions so
        // terminal sockets never churn on a state-only patch. An absent
        // `running` means the authority could not be read — leave the last
        // known liveness alone rather than declaring every session dead.
        // Known constraint: pulse patches RUN STATES only. Manifest edits made
        // out-of-band (another client, curl, hand-edit) — including uiMode
        // switches — don't reach an open tab until a mutation response or a
        // manual Refresh replaces the snapshot.
        if (pulse.running) {
          const running = new Set(pulse.running);
          setSnapshot((current) => {
            if (!current) {
              return current;
            }
            const view = patchViewLiveness(current.view, running);
            return view === current.view ? current : { ...current, view };
          });
        }
      } catch (err) {
        if (alive) {
          pulseFailingRef.current = true;
          setSystemError(err instanceof Error ? err.message : String(err));
          markTelemetryGap(telemetryHistoryRef.current);
          // We could not read the authority, so we no longer know what any
          // agent is doing. Say so instead of holding the last answer.
          pulseCacheRef.current.states = '';
          setStatusViews((current) => viewsWithoutAgentEvidence(current));
        }
      }
    }
    void pulseTick();
    const timer = window.setInterval(() => {
      // Hidden tabs stop polling; the visibilitychange handler below catches
      // the tab back up the moment it returns.
      if (document.hidden) {
        return;
      }
      void pulseTick();
    }, 2000);
    const onVisibilityChange = (): void => {
      if (!document.hidden) {
        void pulseTick();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // Setters are stable; imported helpers and refs are stable. Mount-once loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function invalidateAttentionPulse(): void {
    attentionGenerationRef.current += 1;
    pulseCacheRef.current = { states: '' };
  }

  return { systemSnapshot, systemError, telemetryHistoryRef, invalidateAttentionPulse };
}

/**
 * Drop the agent evidence from every view while KEEPING lifecycle.
 *
 * Used when the pulse cannot be read: we no longer know what any agent is
 * doing, and holding the last answer keeps the sidebar confidently claiming
 * "working" or "needs approval" for as long as the bridge is down — the
 * confident wrong answer this whole state model exists to avoid. Liveness is
 * deliberately preserved: an unreadable authority is not evidence a session
 * died, and blanking it too would flip every row to `starting`. Non-agent
 * sessions have no activity axis and are returned untouched.
 */
export function viewsWithoutAgentEvidence(views: SessionStatusMap): SessionStatusMap {
  const next: SessionStatusMap = {};
  for (const [sessionId, view] of Object.entries(views)) {
    next[sessionId] = view.agent === null ? view : { ...view, agent: UNKNOWN_AGENT };
  }
  return next;
}

/**
 * Snapshots to views, keyed by sessionId. A session absent from the payload is
 * absent from the map, and the consumer renders it `unknown` — the map never
 * carries a fabricated entry for a session the authority did not report.
 */
export function viewsFromPulse(snapshots: readonly unknown[] | undefined): SessionStatusMap {
  if (!snapshots) {
    return {};
  }
  const views: SessionStatusMap = {};
  for (const snapshot of snapshots) {
    const typed = snapshot as { sessionId?: unknown };
    if (typeof typed.sessionId === 'string' && typed.sessionId.length > 0) {
      views[typed.sessionId] = sessionStatusView(snapshot as Parameters<typeof sessionStatusView>[0]);
    }
  }
  return views;
}
