/**
 * Monaco built-in coexistence: a per-language, per-feature lease controller.
 *
 * Standalone Monaco ships worker-backed providers for TS/JS/JSON/CSS/HTML. When a Desk LSP server
 * for one of those languages reaches READY, the built-in features that OVERLAP the capabilities the
 * server advertises must be disabled so the user does not see duplicate hovers/completions; the
 * non-overlapping built-ins (features the server does not provide) must stay available, and the
 * built-in diagnostics are left untouched in this slice.
 *
 * Monaco *Defaults are GLOBAL per language while sessions come and go, so disablement is reference
 * counted PER FEATURE: each acquire() carries a feature mask; the effective disabled set is the
 * UNION of active leases; a feature is re-enabled only when its own count reaches zero, and the
 * saved snapshot is restored only when the effective set becomes empty. The real
 * setModeConfiguration wiring over Monaco *Defaults lives in monacoBuiltinCoexistence.ts; this
 * controller is headless (drives an injected BuiltinLanguageDefaults) so the lease logic is
 * unit-testable without importing monaco-editor.
 */

import type { ServerCapabilities } from './connection.js';

/** Built-in language features that overlap Desk LSP providers (Monaco modeConfiguration keys). */
export type BuiltinFeature =
  | 'completionItems'
  | 'hovers'
  | 'documentSymbols'
  | 'definitions'
  | 'references'
  | 'documentHighlights'
  | 'rename'
  | 'signatureHelp'
  | 'documentFormattingEdits'
  | 'documentRangeFormattingEdits'
  | 'onTypeFormattingEdits'
  | 'codeActions'
  | 'inlayHints'
  | 'selectionRanges'
  | 'colors'
  | 'foldingRanges'
  | 'links'
  | 'diagnostics';

/** Per-language hooks the controller drives; implemented over Monaco *Defaults in monacoBuiltinCoexistence.ts. */
export interface BuiltinLanguageDefaults {
  /** Capture the current built-in mode configuration for later restore. */
  snapshot(): unknown;
  /** Set the built-in mode configuration to the snapshot with exactly `disabled` features turned off. */
  applyDisabled(snapshot: unknown, disabled: ReadonlySet<BuiltinFeature>): void;
  /** Restore a previously captured configuration verbatim. */
  restore(snapshot: unknown): void;
}

/** Timer seam so the restore debounce is deterministically testable. */
export interface RestoreScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface LspBuiltinCoexistenceControllerOptions {
  /** Delay before restoring built-ins once the effective mask empties; 0 (default) restores synchronously. */
  debounceMs?: number;
  scheduler?: RestoreScheduler;
}

export interface BuiltinCoexistenceLease {
  release(): void;
}

const DEFAULT_SCHEDULER: RestoreScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Maps each LSP capability that registerAdapter registers to its overlapping Monaco built-in feature. */
const CAPABILITY_TO_FEATURE: ReadonlyArray<readonly [string, BuiltinFeature]> = [
  ['hoverProvider', 'hovers'],
  ['completionProvider', 'completionItems'],
  ['definitionProvider', 'definitions'],
  ['referencesProvider', 'references'],
  ['documentHighlightProvider', 'documentHighlights'],
  ['documentSymbolProvider', 'documentSymbols'],
  ['renameProvider', 'rename'],
  ['signatureHelpProvider', 'signatureHelp'],
  // Full-document vs range formatting are DISTINCT Monaco built-in flags; keep them separate.
  ['documentFormattingProvider', 'documentFormattingEdits'],
  ['documentRangeFormattingProvider', 'documentRangeFormattingEdits'],
  ['documentOnTypeFormattingProvider', 'onTypeFormattingEdits'],
  ['codeActionProvider', 'codeActions'],
  ['inlayHintProvider', 'inlayHints'],
  ['selectionRangeProvider', 'selectionRanges'],
  ['colorProvider', 'colors'],
  ['foldingRangeProvider', 'foldingRanges'],
  ['documentLinkProvider', 'links']
];

/**
 * Which built-in features each Monaco language's modeConfiguration actually exposes (derived from
 * monaco-editor 0.55 ModeConfiguration shapes). Used to confine disablement to keys a language has;
 * kept here (monaco-free) so the per-language coverage is unit-testable.
 */
const TS_BUILTIN_FEATURES: ReadonlySet<BuiltinFeature> = new Set<BuiltinFeature>([
  'completionItems', 'hovers', 'documentSymbols', 'definitions', 'references', 'documentHighlights',
  'rename', 'signatureHelp', 'documentRangeFormattingEdits', 'onTypeFormattingEdits', 'codeActions', 'inlayHints',
  'diagnostics'
]);
const CSS_BUILTIN_FEATURES: ReadonlySet<BuiltinFeature> = new Set<BuiltinFeature>([
  'completionItems', 'hovers', 'documentSymbols', 'definitions', 'references', 'documentHighlights',
  'rename', 'colors', 'foldingRanges', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits',
  'diagnostics'
]);
const HTML_BUILTIN_FEATURES: ReadonlySet<BuiltinFeature> = new Set<BuiltinFeature>([
  'completionItems', 'hovers', 'documentSymbols', 'links', 'documentHighlights', 'rename',
  'colors', 'foldingRanges', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits',
  'diagnostics'
]);
const JSON_BUILTIN_FEATURES: ReadonlySet<BuiltinFeature> = new Set<BuiltinFeature>([
  'completionItems', 'hovers', 'documentSymbols', 'colors', 'foldingRanges', 'selectionRanges',
  'documentFormattingEdits', 'documentRangeFormattingEdits', 'diagnostics'
]);
const LANGUAGE_BUILTIN_FEATURES: ReadonlyMap<string, ReadonlySet<BuiltinFeature>> = new Map([
  ['typescript', TS_BUILTIN_FEATURES],
  ['typescriptreact', TS_BUILTIN_FEATURES],
  ['javascript', TS_BUILTIN_FEATURES],
  ['javascriptreact', TS_BUILTIN_FEATURES],
  ['css', CSS_BUILTIN_FEATURES],
  ['scss', CSS_BUILTIN_FEATURES],
  ['less', CSS_BUILTIN_FEATURES],
  ['html', HTML_BUILTIN_FEATURES],
  ['json', JSON_BUILTIN_FEATURES],
  ['jsonc', JSON_BUILTIN_FEATURES]
]);

/** The built-in modeConfiguration features a Monaco language supports (empty for unknown languages). */
export function supportedBuiltinFeatures(monacoLanguageId: string): ReadonlySet<BuiltinFeature> {
  return LANGUAGE_BUILTIN_FEATURES.get(monacoLanguageId) ?? new Set<BuiltinFeature>();
}

/**
 * Derive the built-in features to disable from a server's capabilities. Mirrors registerAdapter's
 * capability gates intersected with the Monaco modeConfiguration flags that exist. Diagnostics are
 * never included (built-in diagnostics stay enabled until the LSP-diagnostics slice lands).
 */
export function capabilitiesToFeatureMask(capabilities: ServerCapabilities): Set<BuiltinFeature> {
  const mask = new Set<BuiltinFeature>();
  for (const [capability, feature] of CAPABILITY_TO_FEATURE) {
    if (capabilities[capability]) {
      mask.add(feature);
    }
  }
  return mask;
}

interface LanguageState {
  snapshot: unknown;
  /** feature -> number of active leases requiring it disabled. */
  readonly counts: Map<BuiltinFeature, number>;
  /** sorted key of the currently-applied effective mask ('' when nothing is applied). */
  appliedKey: string;
  pendingRestore: unknown;
}

function effectiveKey(features: Iterable<BuiltinFeature>): string {
  return [...features].sort().join(',');
}

export class LspBuiltinCoexistenceController {
  private readonly defaultsFor: (monacoLanguageId: string) => BuiltinLanguageDefaults;
  private readonly debounceMs: number;
  private readonly scheduler: RestoreScheduler;
  private readonly states = new Map<string, LanguageState>();

  constructor(
    defaultsFor: (monacoLanguageId: string) => BuiltinLanguageDefaults,
    options: LspBuiltinCoexistenceControllerOptions = {}
  ) {
    this.defaultsFor = defaultsFor;
    this.debounceMs = options.debounceMs ?? 0;
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** A Desk LSP server reached READY for this language with the given feature mask. */
  acquire(monacoLanguageId: string, features: ReadonlySet<BuiltinFeature>): BuiltinCoexistenceLease {
    let state = this.states.get(monacoLanguageId);
    if (!state) {
      state = { snapshot: undefined, counts: new Map(), appliedKey: '', pendingRestore: undefined };
      this.states.set(monacoLanguageId, state);
    }
    // A restore was pending from a brief outage: cancel it and stay disabled (no flicker, no re-snapshot).
    if (state.pendingRestore !== undefined) {
      this.scheduler.cancel(state.pendingRestore);
      state.pendingRestore = undefined;
    }
    for (const feature of features) {
      state.counts.set(feature, (state.counts.get(feature) ?? 0) + 1);
    }
    this.reconcile(monacoLanguageId, state);

    const leaseFeatures = new Set(features);
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        const current = this.states.get(monacoLanguageId);
        if (!current) {
          return;
        }
        for (const feature of leaseFeatures) {
          const next = (current.counts.get(feature) ?? 0) - 1;
          if (next <= 0) {
            current.counts.delete(feature);
          } else {
            current.counts.set(feature, next);
          }
        }
        this.reconcile(monacoLanguageId, current);
      }
    };
  }

  /** Recompute the effective disabled mask and apply/restore only when it actually changes. */
  private reconcile(monacoLanguageId: string, state: LanguageState): void {
    const effective = new Set<BuiltinFeature>(
      [...state.counts.entries()].filter(([, count]) => count > 0).map(([feature]) => feature)
    );
    const key = effectiveKey(effective);
    if (key === state.appliedKey) {
      return; // no change
    }
    if (effective.size > 0) {
      if (state.snapshot === undefined) {
        state.snapshot = this.defaultsFor(monacoLanguageId).snapshot();
      }
      this.defaultsFor(monacoLanguageId).applyDisabled(state.snapshot, effective);
      state.appliedKey = key;
      return;
    }
    // Effective mask is now empty: restore (debounced when configured). Keep appliedKey reflecting
    // the still-disabled config during the debounce window so a same-mask re-acquire is a no-op
    // (no flicker); performRestore clears the state when it actually fires.
    if (this.debounceMs > 0) {
      state.pendingRestore = this.scheduler.schedule(() => this.performRestore(monacoLanguageId), this.debounceMs);
      return;
    }
    this.performRestore(monacoLanguageId);
  }

  private performRestore(monacoLanguageId: string): void {
    const state = this.states.get(monacoLanguageId);
    if (!state) {
      return;
    }
    const snapshot = state.snapshot;
    this.states.delete(monacoLanguageId);
    this.defaultsFor(monacoLanguageId).restore(snapshot);
  }
}
