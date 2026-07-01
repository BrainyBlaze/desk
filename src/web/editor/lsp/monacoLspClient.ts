/**
 * Real-Monaco binding for the LSP register adapter.
 *
 * This is the ONLY editor-side module that imports the real monaco runtime to wire the headless,
 * structurally-typed registerLspProviders to monaco.languages. Because it passes the real
 * monaco.languages plus real monaco.Uri / monaco.languages.FoldingRangeKind factories into the
 * generic registerLspProviders, `tsc` proves the structural adapter surface matches Monaco's real
 * d.ts -- with no broad cast.
 *
 * Out of scope here: builtinCoexistence defaults, diagnostics application (setModelMarkers),
 * the /ws/lsp transport, config plumbing, and the MonacoHost/EditorSubsystem call-site. The
 * connection and capabilities are injected by the caller.
 */

import type { ServerCapabilities } from './connection.js';
import type { ProviderConnection } from './providers.js';
import { registerLspProviders } from './registerAdapter.js';
import { createProviderScheduler, providerDelayBounds } from './providerScheduler.js';
import { monaco } from '../monacoSetup.js';

export interface InstallLspProvidersOptions {
  connection: ProviderConnection;
  capabilities: ServerCapabilities;
  languageSelector: monaco.languages.LanguageSelector;
}

/**
 * Register all capability-advertised LSP providers against the real monaco.languages registry.
 *
 * monaco.languages is passed DIRECTLY (no cast): tsc checks it against MonacoLanguagesLike with the
 * generics inferred from the real factories below (TUri = monaco.Uri, TFoldingKind =
 * monaco.languages.FoldingRangeKind, TSelector = monaco.languages.LanguageSelector), which is the
 * whole point of this slice -- it proves the structural adapter surface matches Monaco's real d.ts.
 */
export function installLspProviders(options: InstallLspProvidersOptions): monaco.IDisposable {
  return registerLspProviders(
    monaco.languages,
    options.connection,
    options.capabilities,
    options.languageSelector,
    (value: string) => monaco.Uri.parse(value),
    (value: string) => monaco.languages.FoldingRangeKind.fromValue(value),
    // provider scheduling: production coalesces the on-open burst providers with an ADAPTIVE per-method trailing window
    // (latency-history clamped to per-feature [min,max]); leading-edge stays immediate so first-paint
    // never regresses. Tests omit this and get the no-op scheduler, preserving synchronous behavior.
    createProviderScheduler({ boundsFor: providerDelayBounds })
  );
}
