import { createHash } from 'node:crypto';

const FOOTER_REGION_LINES = 6;
const RECENT_ACTIVITY_LINES = 14;
const WORKING_AFFORDANCE = /\besc\s+(?:to\s+)?interrupt\b/i;
const SPINNER_RUN = /[\u25a0\u25aa\u25ab\u25fb\u25fc\u2b1c\u2b1d]{2,}|[\u2800-\u28ff]{2,}/u;
const CLAUDE_WORKING_STATUS =
  /^\s*(?:[✻✶✽*·]\s*)?[A-Z][A-Za-z-]+[.…]*\s*\([^)\n]*(?:\d+s|\d+m)\b[^)\n]*(?:tokens?|up|running stop hooks)[^)\n]*\)\s*$/im;

export type ProbePaneState =
  | 'ready'
  | 'working'
  | 'blocked'
  | 'booting'
  | 'empty-capture'
  | 'offline'
  | 'unobservable';

export type ProbeBlockedReason =
  | 'approval'
  | 'input-requested'
  | 'trust-menu'
  | 'selection-menu'
  | 'unknown-menu'
  | 'capture-failed'
  | 'unrecognized-shape';

export type ProbeSource = 'drain' | 'verify' | 'signal' | 'inspect' | 'test';

export interface SessionProbeSnapshot {
  sessionId: string;
  agentKind?: string;
  source: ProbeSource;
  observedAt: string;
  paneState: ProbePaneState;
  ready: boolean;
  working: boolean;
  blockedReason?: ProbeBlockedReason;
  footerRegion: string;
  footerHash: string;
  tailPreview: string;
}

export interface ClassifyPaneOptions {
  sessionId?: string;
  agentKind?: string;
  source?: ProbeSource;
  observedAt?: string;
}

export interface SessionProbeOptions {
  sessionRunning: (sessionId: string) => boolean | Promise<boolean>;
  sessionCreatedAt: (sessionId: string) => number | null | Promise<number | null>;
  capturePane: (sessionId: string) => string | null | Promise<string | null>;
  bootGraceMs?: number;
  ttlMs?: number;
  now?: () => number;
  resolveAgentKind?: (sessionId: string) => string | undefined;
}

export interface ProbeOptions {
  source?: ProbeSource;
  forceFresh?: boolean;
  agentKind?: string;
}

export interface SessionProbe {
  probe(sessionId: string, options?: ProbeOptions): Promise<SessionProbeSnapshot>;
  clear(sessionId?: string): void;
}

/** Last ~30 meaningful pane lines, matching the engine's capture normalization. */
export function tailPaneCapture(output: string): string {
  const lines = output.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - 30)).join('\n');
}

export function paneFooterRegion(paneTail: string): string {
  return paneTail
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-FOOTER_REGION_LINES)
    .join('\n');
}

function recentActivityRegion(paneTail: string): string {
  return paneTail
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-RECENT_ACTIVITY_LINES)
    .join('\n');
}

export function footerHash(footerRegion: string): string {
  return createHash('sha256').update(footerRegion).digest('hex');
}

export function isPaneBusy(paneTail: string): boolean {
  const footer = paneFooterRegion(paneTail);
  const recent = recentActivityRegion(paneTail);
  return WORKING_AFFORDANCE.test(footer) || SPINNER_RUN.test(footer) || CLAUDE_WORKING_STATUS.test(recent);
}

function hasOpencodeComposerFrame(paneTail: string): boolean {
  const lines = paneTail.split('\n');
  const railLines = lines.filter((line) => /^\s*[┃│]/.test(line)).length;
  const hasBottomRail = lines.some((line) => /^\s*[╹╵]?▀{3,}/.test(line));
  return railLines >= 2 && hasBottomRail;
}

function hasPromptMarker(paneTail: string): boolean {
  const lines = paneTail
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-8);
  return lines.some((line) => /^\s*[❯›]/.test(line) || /[$%#]\s*$/.test(line)) || hasOpencodeComposerFrame(paneTail);
}

function structuralBlockReason(paneTail: string): ProbeBlockedReason | undefined {
  const text = paneTail.toLowerCase();
  const nonBlank = paneTail.split('\n').filter((line) => line.trim() !== '');
  const hasPromptChoice = nonBlank.some((line) => /^\s*[❯›]\s+\S+/.test(line));
  const hasSiblingChoice = nonBlank.some((line) =>
    /^\s{2,}(?:yes|no|cancel|allow|deny|reject|continue|[0-9]+[:.)])\b/i.test(line)
  );
  const hasInlineNumericChoices = nonBlank.some((line) => /\b[0-9]+[:.)]\s+\S+(?:\s+[0-9]+[:.)]\s+\S+)+/i.test(line));
  const hasMenuShape = (hasPromptChoice && hasSiblingChoice) || hasInlineNumericChoices;

  if (/\b(approval|approve|permission|allow command|allow this|allow)\b/.test(text)) {
    return 'approval';
  }
  if (/\b(needs input|input requested|question(?:\.asked)?|provide answer|answer required)\b/.test(text)) {
    return 'input-requested';
  }
  if (/\b(trust|trusted workspace|do you trust)\b/.test(text)) {
    return 'trust-menu';
  }
  if (/\b(select|choose|pick|how is .* doing this session)\b/.test(text) && (hasPromptChoice || hasMenuShape)) {
    return 'selection-menu';
  }
  if (hasMenuShape) {
    return 'unknown-menu';
  }
  return undefined;
}

export function classifyPaneTail(paneTail: string, options: ClassifyPaneOptions = {}): SessionProbeSnapshot {
  const footerRegion = paneFooterRegion(paneTail);
  const base = {
    sessionId: options.sessionId ?? '',
    agentKind: options.agentKind,
    source: options.source ?? 'test',
    observedAt: options.observedAt ?? new Date().toISOString(),
    footerRegion,
    footerHash: footerHash(footerRegion),
    tailPreview: paneTail
  };

  if (paneTail.trim() === '') {
    return { ...base, paneState: 'empty-capture', ready: false, working: false };
  }
  if (isPaneBusy(paneTail)) {
    return { ...base, paneState: 'working', ready: false, working: true };
  }
  const blockedReason = structuralBlockReason(paneTail);
  if (blockedReason) {
    return { ...base, paneState: 'blocked', blockedReason, ready: false, working: false };
  }
  if (hasPromptMarker(paneTail)) {
    return { ...base, paneState: 'ready', ready: true, working: false };
  }
  return { ...base, paneState: 'blocked', blockedReason: 'unrecognized-shape', ready: false, working: false };
}

export function isPaneReadyForInput(paneTail: string): boolean {
  return classifyPaneTail(paneTail).paneState === 'ready';
}

function stateSnapshot(
  sessionId: string,
  paneState: ProbePaneState,
  options: Required<Pick<ClassifyPaneOptions, 'source' | 'observedAt'>> & Pick<ClassifyPaneOptions, 'agentKind'>,
  blockedReason?: ProbeBlockedReason
): SessionProbeSnapshot {
  return {
    sessionId,
    agentKind: options.agentKind,
    source: options.source,
    observedAt: options.observedAt,
    paneState,
    ready: false,
    working: false,
    blockedReason,
    footerRegion: '',
    footerHash: footerHash(''),
    tailPreview: ''
  };
}

export function createSessionProbe(options: SessionProbeOptions): SessionProbe {
  const ttlMs = options.ttlMs ?? 750;
  const bootGraceMs = options.bootGraceMs ?? 0;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; snapshot: SessionProbeSnapshot }>();
  const inFlight = new Map<string, Promise<SessionProbeSnapshot>>();

  const readFresh = async (sessionId: string, probeOptions: ProbeOptions): Promise<SessionProbeSnapshot> => {
    const observedAt = new Date(now()).toISOString();
    const source = probeOptions.source ?? 'inspect';
    const agentKind = probeOptions.agentKind ?? options.resolveAgentKind?.(sessionId);
    if (!(await options.sessionRunning(sessionId))) {
      return stateSnapshot(sessionId, 'offline', { source, observedAt, agentKind });
    }
    const createdAt = await options.sessionCreatedAt(sessionId);
    if (createdAt !== null && now() - createdAt * 1000 < bootGraceMs) {
      return stateSnapshot(sessionId, 'booting', { source, observedAt, agentKind });
    }
    const pane = await options.capturePane(sessionId);
    if (pane === null) {
      return stateSnapshot(sessionId, 'unobservable', { source, observedAt, agentKind }, 'capture-failed');
    }
    return classifyPaneTail(tailPaneCapture(pane), { sessionId, source, observedAt, agentKind });
  };

  return {
    async probe(sessionId, probeOptions = {}) {
      const cached = cache.get(sessionId);
      if (!probeOptions.forceFresh && cached && now() - cached.at < ttlMs) {
        return cached.snapshot;
      }
      if (!probeOptions.forceFresh) {
        const existing = inFlight.get(sessionId);
        if (existing) {
          return existing;
        }
      }
      const startedAt = now();
      const pending = readFresh(sessionId, probeOptions)
        .then((snapshot) => {
          const current = cache.get(sessionId);
          if (!current || startedAt >= current.at) {
            cache.set(sessionId, { at: startedAt, snapshot });
          }
          return snapshot;
        })
        .finally(() => {
          if (inFlight.get(sessionId) === pending) {
            inFlight.delete(sessionId);
          }
        });
      if (!probeOptions.forceFresh) {
        inFlight.set(sessionId, pending);
      }
      return pending;
    },
    clear(sessionId) {
      if (sessionId) {
        cache.delete(sessionId);
        inFlight.delete(sessionId);
        return;
      }
      cache.clear();
      inFlight.clear();
    }
  };
}
