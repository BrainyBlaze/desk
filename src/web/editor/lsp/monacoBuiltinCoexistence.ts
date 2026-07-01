/**
 * Real-Monaco binding for built-in coexistence. The ONLY module here that imports monaco: it maps a
 * languageId to the live Monaco *Defaults (typescript/javascript/json/css/html) and implements
 * BuiltinLanguageDefaults over their modeConfiguration, then wires the headless per-feature lease
 * controller (builtinCoexistence.ts) and exposes acquire(languageId, capabilities).
 *
 * Monaco 0.55 GOTCHA: the real API is the TOP-LEVEL monaco.{typescript,json,css,html} namespaces;
 * monaco.languages.{typescript,...} is a deprecated stub (see monacoSetup.ts).
 */

import { monaco } from '../monacoSetup.js';
import type { ServerCapabilities } from './connection.js';
import {
  LspBuiltinCoexistenceController,
  capabilitiesToFeatureMask,
  supportedBuiltinFeatures,
  type BuiltinFeature,
  type BuiltinLanguageDefaults
} from './builtinCoexistence.js';

/** The slice of a Monaco LanguageServiceDefaults this binding needs (modeConfiguration get/set). */
interface ModeConfigurableDefaults<T> {
  readonly modeConfiguration: T;
  setModeConfiguration(modeConfiguration: T): void;
}

/**
 * Build a BuiltinLanguageDefaults over a Monaco *Defaults object. snapshot clones the current
 * modeConfiguration; applyDisabled re-applies the snapshot with exactly the `disabled` features
 * (that this language supports) turned off; restore reapplies the snapshot verbatim. `supported`
 * confines writes to keys valid for this language's modeConfiguration.
 */
function makeBuiltinLanguageDefaults<T extends object>(
  defaults: ModeConfigurableDefaults<T>,
  supported: ReadonlySet<BuiltinFeature>
): BuiltinLanguageDefaults {
  return {
    snapshot: () => ({ ...defaults.modeConfiguration }),
    applyDisabled: (snapshot, disabled) => {
      const next = { ...(snapshot as T) };
      // The mode configuration is a flat record of boolean feature flags; the cast lets us write the
      // (validated) disabled keys dynamically without widening the monaco binding above.
      const writable = next as Record<string, boolean | undefined>;
      for (const feature of disabled) {
        if (supported.has(feature)) {
          writable[feature] = false;
        }
      }
      defaults.setModeConfiguration(next);
    },
    restore: (snapshot) => {
      defaults.setModeConfiguration(snapshot as T);
    }
  };
}

const NOOP_DEFAULTS: BuiltinLanguageDefaults = {
  snapshot: () => undefined,
  applyDisabled: () => undefined,
  restore: () => undefined
};

function clearBuiltInMarkers(monacoLanguageId: string): { release(): void } {
  const shouldClear = (model: monaco.editor.ITextModel): boolean =>
    model.getLanguageId() === monacoLanguageId &&
    monaco.editor.getModelMarkers({ owner: model.getLanguageId(), resource: model.uri }).length > 0;
  const clear = () => {
    for (const model of monaco.editor.getModels()) {
      if (shouldClear(model)) {
        monaco.editor.setModelMarkers(model, model.getLanguageId(), []);
      }
    }
  };
  const handles = new Set<number>();
  const markerListener = monaco.editor.onDidChangeMarkers((resources) => {
    for (const resource of resources) {
      const model = monaco.editor.getModel(resource);
      if (model && shouldClear(model)) {
        clear();
        break;
      }
    }
  });
  clear();
  for (const delayMs of [0, 250, 1000]) {
    const handle = window.setTimeout(() => {
      handles.delete(handle);
      clear();
    }, delayMs);
    handles.add(handle);
  }
  return {
    release: () => {
      markerListener.dispose();
      for (const handle of handles) {
        window.clearTimeout(handle);
      }
      handles.clear();
    }
  };
}

function defaultsFor(monacoLanguageId: string): BuiltinLanguageDefaults {
  // supportedBuiltinFeatures(languageId) confines disablement to keys this language's
  // modeConfiguration actually exposes (TS has no colors/foldingRanges/links; css/html/json do).
  const supported = supportedBuiltinFeatures(monacoLanguageId);
  switch (monacoLanguageId) {
    case 'typescript':
    case 'typescriptreact':
      return makeBuiltinLanguageDefaults(monaco.typescript.typescriptDefaults, supported);
    case 'javascript':
    case 'javascriptreact':
      return makeBuiltinLanguageDefaults(monaco.typescript.javascriptDefaults, supported);
    case 'json':
    case 'jsonc':
      return makeBuiltinLanguageDefaults(monaco.json.jsonDefaults, supported);
    case 'css':
      return makeBuiltinLanguageDefaults(monaco.css.cssDefaults, supported);
    case 'scss':
      return makeBuiltinLanguageDefaults(monaco.css.scssDefaults, supported);
    case 'less':
      return makeBuiltinLanguageDefaults(monaco.css.lessDefaults, supported);
    case 'html':
      return makeBuiltinLanguageDefaults(monaco.html.htmlDefaults, supported);
    default:
      return NOOP_DEFAULTS;
  }
}

/** The App-facing coexistence seam: lease per-feature built-in disablement for a ready LSP language. */
export interface BuiltinCoexistenceController {
  acquire(monacoLanguageId: string, capabilities: ServerCapabilities): { release(): void };
  /** Lease ONLY the built-in diagnostics flag (gated on the live LSP diagnostics path). */
  acquireDiagnostics(monacoLanguageId: string): { release(): void };
}

/**
 * Create the shared, App-level coexistence controller. One instance is passed (via App.tsx DI) to
 * makeCreateLspBinding so all ready sessions across both EditorSubsystem mounts share one
 * per-language/per-feature refcount over the global Monaco defaults.
 */
export function createBuiltinCoexistenceController(): BuiltinCoexistenceController {
  const controller = new LspBuiltinCoexistenceController(defaultsFor);
  return {
    acquire: (monacoLanguageId, capabilities) =>
      controller.acquire(monacoLanguageId, capabilitiesToFeatureMask(capabilities)),
    acquireDiagnostics: (monacoLanguageId) => {
      const lease = controller.acquire(monacoLanguageId, new Set<BuiltinFeature>(['diagnostics']));
      const markerClear = clearBuiltInMarkers(monacoLanguageId);
      return {
        release: () => {
          markerClear.release();
          lease.release();
        }
      };
    }
  };
}
