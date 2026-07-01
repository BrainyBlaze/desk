import { describe, expect, it, vi } from 'vitest';
import {
  LspBuiltinCoexistenceController,
  capabilitiesToFeatureMask,
  supportedBuiltinFeatures,
  type BuiltinFeature,
  type BuiltinLanguageDefaults,
  type RestoreScheduler
} from '../src/web/editor/lsp/builtinCoexistence';
import { makeCreateLspBinding, type BuiltinCoexistence } from '../src/web/editor/lsp/appLspWiring';
import type { ControllerSession, ProviderRegistration } from '../src/web/editor/lsp/sessionController';
import type { ProviderConnection } from '../src/web/editor/lsp/providers';
import type { ServerCapabilities } from '../src/web/editor/lsp/connection';

function makeScheduler() {
  let pending: { callback: () => void; delayMs: number; id: number } | null = null;
  let nextId = 0;
  const scheduler: RestoreScheduler = {
    schedule: (callback, delayMs) => {
      pending = { callback, delayMs, id: ++nextId };
      return pending.id;
    },
    cancel: (handle) => {
      if (pending && pending.id === handle) {
        pending = null;
      }
    }
  };
  return {
    scheduler,
    pending: () => pending,
    fire: () => {
      const current = pending;
      pending = null;
      current?.callback();
    }
  };
}

/** Fake defaults that records snapshot/apply(effective)/restore. apply records the sorted mask. */
function makeStubDefaults() {
  const events: string[] = [];
  let snapshotId = 0;
  const defaults: BuiltinLanguageDefaults = {
    snapshot: () => {
      events.push('snapshot');
      return `snap-${++snapshotId}`;
    },
    applyDisabled: (_snapshot, disabled) => {
      events.push(`apply:${[...disabled].sort().join(',')}`);
    },
    restore: (snapshot) => {
      events.push(`restore:${String(snapshot)}`);
    }
  };
  return { events, defaults };
}

const mask = (...features: BuiltinFeature[]): Set<BuiltinFeature> => new Set(features);

describe('capabilitiesToFeatureMask', () => {
  it('maps registered capability gates to Monaco built-in features', () => {
    const result = capabilitiesToFeatureMask({
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['.'] },
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      renameProvider: true,
      signatureHelpProvider: {},
      documentHighlightProvider: true
    });
    expect(result).toEqual(
      new Set<BuiltinFeature>([
        'hovers',
        'completionItems',
        'definitions',
        'references',
        'documentSymbols',
        'rename',
        'signatureHelp',
        'documentHighlights'
      ])
    );
  });

  it('never includes diagnostics and ignores absent/unknown capabilities', () => {
    const result = capabilitiesToFeatureMask({ hoverProvider: true, diagnosticProvider: true, somethingElse: true });
    expect(result).toEqual(new Set<BuiltinFeature>(['hovers']));
  });

  it('returns an empty set for no relevant capabilities', () => {
    expect(capabilitiesToFeatureMask({})).toEqual(new Set());
    expect(capabilitiesToFeatureMask({ hoverProvider: false })).toEqual(new Set());
  });

  it('maps full-document vs range formatting to DISTINCT features', () => {
    expect(capabilitiesToFeatureMask({ documentFormattingProvider: true })).toEqual(new Set<BuiltinFeature>(['documentFormattingEdits']));
    expect(capabilitiesToFeatureMask({ documentRangeFormattingProvider: true })).toEqual(new Set<BuiltinFeature>(['documentRangeFormattingEdits']));
    expect(capabilitiesToFeatureMask({ documentFormattingProvider: true, documentRangeFormattingProvider: true })).toEqual(
      new Set<BuiltinFeature>(['documentFormattingEdits', 'documentRangeFormattingEdits'])
    );
  });

  it('maps selectionRange/color/foldingRange/documentLink capabilities', () => {
    expect(
      capabilitiesToFeatureMask({
        selectionRangeProvider: true,
        colorProvider: true,
        foldingRangeProvider: true,
        documentLinkProvider: true
      })
    ).toEqual(new Set<BuiltinFeature>(['selectionRanges', 'colors', 'foldingRanges', 'links']));
  });
});

describe('supportedBuiltinFeatures (per-language modeConfiguration coverage)', () => {
  it('typescript exposes definitions/signatureHelp/codeActions but not colors/foldingRanges/links/documentFormattingEdits', () => {
    const ts = supportedBuiltinFeatures('typescript');
    for (const f of ['hovers', 'completionItems', 'definitions', 'signatureHelp', 'documentRangeFormattingEdits', 'codeActions', 'inlayHints'] as BuiltinFeature[]) {
      expect(ts.has(f)).toBe(true);
    }
    for (const f of ['colors', 'foldingRanges', 'links', 'documentFormattingEdits', 'selectionRanges'] as BuiltinFeature[]) {
      expect(ts.has(f)).toBe(false);
    }
    expect(supportedBuiltinFeatures('javascript')).toEqual(ts);
  });

  it('css exposes colors/foldingRanges/selectionRanges/documentFormattingEdits/definitions but not links/signatureHelp', () => {
    const css = supportedBuiltinFeatures('css');
    for (const f of ['colors', 'foldingRanges', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits', 'definitions', 'rename'] as BuiltinFeature[]) {
      expect(css.has(f)).toBe(true);
    }
    for (const f of ['links', 'signatureHelp', 'codeActions', 'inlayHints'] as BuiltinFeature[]) {
      expect(css.has(f)).toBe(false);
    }
    expect(supportedBuiltinFeatures('scss')).toEqual(css);
  });

  it('html exposes links/colors/foldingRanges but not definitions/references', () => {
    const html = supportedBuiltinFeatures('html');
    for (const f of ['links', 'colors', 'foldingRanges', 'selectionRanges', 'documentFormattingEdits', 'rename'] as BuiltinFeature[]) {
      expect(html.has(f)).toBe(true);
    }
    for (const f of ['definitions', 'references', 'signatureHelp'] as BuiltinFeature[]) {
      expect(html.has(f)).toBe(false);
    }
  });

  it('json exposes formatting/colors/foldingRanges but not definitions/rename/links', () => {
    const json = supportedBuiltinFeatures('json');
    for (const f of ['completionItems', 'hovers', 'documentSymbols', 'colors', 'foldingRanges', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits'] as BuiltinFeature[]) {
      expect(json.has(f)).toBe(true);
    }
    for (const f of ['definitions', 'references', 'rename', 'documentHighlights', 'links', 'signatureHelp'] as BuiltinFeature[]) {
      expect(json.has(f)).toBe(false);
    }
  });

  it('unknown languages support no built-in features', () => {
    expect(supportedBuiltinFeatures('plaintext')).toEqual(new Set());
  });
});

describe('LspBuiltinCoexistenceController feature-level leasing', () => {
  it('same-capability two sessions: snapshot+disable once, restore only after the second release', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    const a = controller.acquire('typescript', mask('hovers', 'completionItems'));
    const b = controller.acquire('typescript', mask('hovers', 'completionItems'));
    expect(events).toEqual(['snapshot', 'apply:completionItems,hovers']); // disabled once, no re-apply
    a.release();
    expect(events).toEqual(['snapshot', 'apply:completionItems,hovers']); // still disabled, no restore
    b.release();
    expect(events).toEqual(['snapshot', 'apply:completionItems,hovers', 'restore:snap-1']);
  });

  it('hover-only + completion-only sessions union, and release selectively re-enables', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    const a = controller.acquire('typescript', mask('hovers'));
    const b = controller.acquire('typescript', mask('completionItems'));
    expect(events).toEqual(['snapshot', 'apply:hovers', 'apply:completionItems,hovers']);
    a.release(); // hover count 0 -> re-enable hover, keep completion
    expect(events).toEqual(['snapshot', 'apply:hovers', 'apply:completionItems,hovers', 'apply:completionItems']);
    b.release();
    expect(events.at(-1)).toBe('restore:snap-1');
  });

  it('hover+completion then hover-only: releasing the first restores completion while keeping hover', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    const a = controller.acquire('typescript', mask('hovers', 'completionItems'));
    const b = controller.acquire('typescript', mask('hovers'));
    expect(events).toEqual(['snapshot', 'apply:completionItems,hovers']); // b adds nothing new
    a.release(); // completion count 0 -> re-enable completion, hover stays (count 1)
    expect(events).toEqual(['snapshot', 'apply:completionItems,hovers', 'apply:hovers']);
    b.release();
    expect(events.at(-1)).toBe('restore:snap-1');
  });

  it('release is idempotent (double release does not under-count or double-restore)', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    const a = controller.acquire('typescript', mask('hovers'));
    const b = controller.acquire('typescript', mask('hovers'));
    a.release();
    a.release(); // no-op
    expect(events).toEqual(['snapshot', 'apply:hovers']); // still disabled (b holds it)
    b.release();
    expect(events).toEqual(['snapshot', 'apply:hovers', 'restore:snap-1']);
  });

  it('an empty-capability lease is a no-op (no snapshot/apply/restore)', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    const lease = controller.acquire('typescript', mask());
    lease.release();
    expect(events).toEqual([]);
  });

  it('re-disabling after a full restore re-snapshots', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    controller.acquire('typescript', mask('hovers')).release();
    controller.acquire('typescript', mask('hovers'));
    expect(events).toEqual(['snapshot', 'apply:hovers', 'restore:snap-1', 'snapshot', 'apply:hovers']);
  });
});

describe('LspBuiltinCoexistenceController restore debounce', () => {
  it('debounces the empty-restore and a re-acquire before the window cancels it (no flicker, no re-snapshot)', () => {
    const { events, defaults } = makeStubDefaults();
    const sched = makeScheduler();
    const controller = new LspBuiltinCoexistenceController(() => defaults, { debounceMs: 1000, scheduler: sched.scheduler });
    const a = controller.acquire('typescript', mask('hovers'));
    a.release();
    expect(events).toEqual(['snapshot', 'apply:hovers']); // not restored yet
    expect(sched.pending()?.delayMs).toBe(1000);
    controller.acquire('typescript', mask('hovers')); // cancels pending restore, stays disabled
    sched.fire(); // nothing pending
    expect(events).toEqual(['snapshot', 'apply:hovers']);
    expect(sched.pending()).toBeNull();
  });

  it('restore fires after the window elapses with no re-acquire', () => {
    const { events, defaults } = makeStubDefaults();
    const sched = makeScheduler();
    const controller = new LspBuiltinCoexistenceController(() => defaults, { debounceMs: 1000, scheduler: sched.scheduler });
    controller.acquire('typescript', mask('hovers')).release();
    sched.fire();
    expect(events).toEqual(['snapshot', 'apply:hovers', 'restore:snap-1']);
  });
});

// ---- appLspWiring composition: coexistence acquire-on-register / release-on-dispose / fail-closed ----

function readySession(capabilities: ServerCapabilities): ControllerSession {
  return {
    connection: { request: () => Promise.resolve(null) } as ProviderConnection,
    whenReady: () => Promise.resolve(capabilities),
    onExit: () => () => {},
    close: () => {},
    closeInfo: () => null
  };
}
function pendingSession(): ControllerSession {
  return {
    connection: { request: () => Promise.resolve(null) } as ProviderConnection,
    whenReady: () => new Promise<ServerCapabilities>(() => {}), // never resolves (close-before-ready)
    onExit: () => () => {},
    close: () => {},
    closeInfo: () => null
  };
}
function makeCoexistenceSpy() {
  const acquired: Array<{ languageId: string; capabilities: ServerCapabilities; release: ReturnType<typeof vi.fn> }> = [];
  const diagnosticsAcquired: Array<{ languageId: string; release: ReturnType<typeof vi.fn> }> = [];
  const coexistence: BuiltinCoexistence = {
    acquire: (languageId, capabilities) => {
      const release = vi.fn();
      acquired.push({ languageId, capabilities, release });
      return { release };
    },
    acquireDiagnostics: (languageId) => {
      const release = vi.fn();
      diagnosticsAcquired.push({ languageId, release });
      return { release };
    }
  };
  return { coexistence, acquired, diagnosticsAcquired };
}

describe('appLspWiring coexistence composition', () => {
  it('acquires a lease when providers register, releasing it when the registration disposes', async () => {
    const caps = { hoverProvider: true, completionProvider: {} };
    const registration: ProviderRegistration = { dispose: vi.fn() };
    const registerProviders = vi.fn(() => registration);
    const { coexistence, acquired } = makeCoexistenceSpy();
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'] },
      { connectSession: () => readySession(caps), registerProviders, coexistence }
    );
    const binding = create!({ workspaceRoot: '/w' });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(acquired).toHaveLength(1));
    expect(acquired[0]!.languageId).toBe('typescript');
    expect(acquired[0]!.capabilities).toEqual(caps);
    expect(acquired[0]!.release).not.toHaveBeenCalled();

    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(registration.dispose).toHaveBeenCalledTimes(1);
    expect(acquired[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('fail-closed: no lease is acquired when the session never reaches ready', async () => {
    const registerProviders = vi.fn(() => ({ dispose: vi.fn() }));
    const { coexistence, acquired } = makeCoexistenceSpy();
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'] },
      { connectSession: () => pendingSession(), registerProviders, coexistence }
    );
    const binding = create!({ workspaceRoot: '/w' });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(registerProviders).not.toHaveBeenCalled();
    expect(acquired).toHaveLength(0);
  });
});

// ---- diagnostics coexistence + wiring (this slice) ----

import { createWebSocketControllerSession } from '../src/web/editor/lsp/appLspWiring';
import { type WebSocketLike } from '../src/web/editor/lsp/webSocketTransport';

describe('diagnostics built-in coexistence', () => {
  it('every language supports the diagnostics flag', () => {
    for (const lang of ['typescript', 'css', 'html', 'json']) {
      expect(supportedBuiltinFeatures(lang).has('diagnostics')).toBe(true);
    }
  });

  it('leasing the diagnostics feature disables then restores it (per-feature lease)', () => {
    const { events, defaults } = makeStubDefaults();
    const controller = new LspBuiltinCoexistenceController(() => defaults);
    const lease = controller.acquire('typescript', mask('diagnostics'));
    expect(events).toEqual(['snapshot', 'apply:diagnostics']);
    lease.release();
    expect(events).toEqual(['snapshot', 'apply:diagnostics', 'restore:snap-1']);
  });
});

describe('appLspWiring diagnostics lease gating', () => {
  it('leases acquireDiagnostics on ready ONLY when attachDiagnostics is wired, releasing on dispose', async () => {
    const caps = { hoverProvider: true };
    const registration: ProviderRegistration = { dispose: vi.fn() };
    const { coexistence, diagnosticsAcquired } = makeCoexistenceSpy();
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'] },
      { connectSession: () => readySession(caps), registerProviders: () => registration, coexistence, attachDiagnostics: () => ({ dispose: vi.fn() }) }
    );
    const binding = create!({ workspaceRoot: '/w' });
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(diagnosticsAcquired).toHaveLength(1));
    expect(diagnosticsAcquired[0]!.languageId).toBe('typescript');
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(diagnosticsAcquired[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('does NOT lease diagnostics when attachDiagnostics is absent', async () => {
    const caps = { hoverProvider: true };
    const { coexistence, acquired, diagnosticsAcquired } = makeCoexistenceSpy();
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'] },
      { connectSession: () => readySession(caps), registerProviders: () => ({ dispose: vi.fn() }), coexistence }
    );
    create!({ workspaceRoot: '/w' }).openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(acquired).toHaveLength(1));
    expect(diagnosticsAcquired).toHaveLength(0);
  });

  it('fail-closed: no diagnostics lease when the session never reaches ready', async () => {
    const { coexistence, diagnosticsAcquired } = makeCoexistenceSpy();
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'] },
      { connectSession: () => pendingSession(), registerProviders: () => ({ dispose: vi.fn() }), coexistence, attachDiagnostics: () => ({ dispose: vi.fn() }) }
    );
    create!({ workspaceRoot: '/w' }).openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(diagnosticsAcquired).toHaveLength(0);
  });
});

describe('createWebSocketControllerSession diagnostics attach', () => {
  function fakeWebSocket(): WebSocketLike {
    return {
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined
    } as unknown as WebSocketLike;
  }

  it('attaches diagnostics at connect with the connection + languageId, and disposes on close', () => {
    const disposed = vi.fn();
    const attachDiagnostics = vi.fn((connection: { onNotification: unknown }, languageId: string) => {
      expect(typeof connection.onNotification).toBe('function');
      expect(languageId).toBe('typescript');
      return { dispose: disposed };
    });
    const session = createWebSocketControllerSession(
      { workspaceRoot: '/w', languageId: 'typescript' },
      { baseUrl: 'ws://host', webSocketFactory: () => fakeWebSocket(), attachDiagnostics }
    );
    expect(attachDiagnostics).toHaveBeenCalledTimes(1);
    session.close();
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
