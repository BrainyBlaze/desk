import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { fetchPulse, type AgentEvent } from './api.js';
import { patchViewLiveness } from './pulse.js';
import { emitBridgeRetry } from './terminalHeartbeat.js';
import { pushSparkSample } from './systemFormat.js';
import type { DeskSnapshot, SystemSnapshot } from './types.js';

type AttentionMap = Record<string, { attention: true; since: string }>;

interface UsePulseParams {
  setSnapshot: Dispatch<SetStateAction<DeskSnapshot | null>>;
  setAttention: Dispatch<SetStateAction<AttentionMap>>;
  setAgentEvents: Dispatch<SetStateAction<AgentEvent[]>>;
  setUnreadEvents: Dispatch<SetStateAction<number>>;
}

interface UsePulseResult {
  systemSnapshot: SystemSnapshot | null;
  systemError: string | null;
  telemetryHistoryRef: MutableRefObject<{
    cpu: number[];
    ram: number[];
    gpu: number[];
    net: number[];
    disk: number[];
  }>;
  /** Last server payloads (serialized) for the pulse diff-and-bail. Optimistic
   *  local mutations clear these so the next pulse re-syncs unconditionally. */
  pulseCacheRef: MutableRefObject<{ attention: string; events: string }>;
}

/**
 * Owns the 2s pulse loop: fetches system telemetry + attention/events and folds
 * live tmux run-states into the snapshot. Attention/events/snapshot state stays
 * owned by App; this hook receives their setters so the coupling is preserved
 * exactly (the pulse writes them, App's own callbacks reset pulseCacheRef).
 */
export function usePulse({
  setSnapshot,
  setAttention,
  setAgentEvents,
  setUnreadEvents
}: UsePulseParams): UsePulseResult {
  const [systemSnapshot, setSystemSnapshot] = useState<SystemSnapshot | null>(null);
  // Telemetry sparkline rings (one sample per poll tick); the snapshot state
  // change is what re-renders the header, so a ref avoids double renders.
  const telemetryHistoryRef = useRef({
    cpu: [] as number[],
    ram: [] as number[],
    gpu: [] as number[],
    net: [] as number[],
    disk: [] as number[]
  });
  const [systemError, setSystemError] = useState<string | null>(null);
  // Last server payloads (serialized) for the pulse diff-and-bail. Optimistic
  // local mutations clear these so the next pulse re-syncs unconditionally.
  const pulseCacheRef = useRef({ attention: '', events: '' });
  // Tracks whether the previous pulse failed, so a success transition can wake
  // any terminal cells stranded on the manual Reconnect overlay (self-healing).
  const pulseFailingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    async function pulseTick(): Promise<void> {
      try {
        const pulse = await fetchPulse();
        if (!alive) {
          return;
        }
        const system = pulse.system;
        const history = telemetryHistoryRef.current;
        pushSparkSample(history.cpu, system.cpu.usagePercent ?? 0);
        pushSparkSample(history.ram, system.memory.usedPercent);
        pushSparkSample(history.gpu, system.gpu.nvidia.utilizationGpuPercent ?? 0);
        pushSparkSample(history.net, system.network.rxBytesPerSecond ?? 0);
        pushSparkSample(history.disk, (system.disk?.readBytesPerSecond ?? 0) + (system.disk?.writeBytesPerSecond ?? 0));
        setSystemSnapshot(system);
        setSystemError(null);
        // A pulse that succeeds after a run of failures proves the bridge is
        // reachable again — wake any cells stranded behind the Reconnect button.
        if (pulseFailingRef.current) {
          pulseFailingRef.current = false;
          emitBridgeRetry();
        }
        // Diff-and-bail: attention/events keep their object identity when the
        // payload didn't change, so the memoized sidebar/multiplexer trees
        // skip reconciliation entirely on a calm tick.
        const attentionJson = JSON.stringify(pulse.attention.sessions);
        if (attentionJson !== pulseCacheRef.current.attention) {
          pulseCacheRef.current.attention = attentionJson;
          setAttention(pulse.attention.sessions);
        }
        const eventsJson = JSON.stringify(pulse.attention.events);
        if (eventsJson !== pulseCacheRef.current.events) {
          pulseCacheRef.current.events = eventsJson;
          setAgentEvents(pulse.attention.events ?? []);
        }
        setUnreadEvents(pulse.attention.unread ?? 0);
        // Liveness self-heal: fold the live tmux set into the snapshot.
        // patchViewLiveness preserves identity of untouched sessions so
        // terminal sockets never churn on a state-only patch.
        // Known constraint: pulse patches RUN STATES only. Manifest edits made
        // out-of-band (another client, curl, hand-edit) — including uiMode
        // switches — don't reach an open tab until a mutation response or a
        // manual Refresh replaces the snapshot. Tracked separately as a
        // manifest-fingerprint-in-pulse improvement.
        const running = new Set(pulse.running);
        setSnapshot((current) => {
          if (!current) {
            return current;
          }
          const view = patchViewLiveness(current.view, running);
          return view === current.view ? current : { ...current, view };
        });
      } catch (err) {
        if (alive) {
          pulseFailingRef.current = true;
          setSystemError(err instanceof Error ? err.message : String(err));
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

  return { systemSnapshot, systemError, telemetryHistoryRef, pulseCacheRef };
}
