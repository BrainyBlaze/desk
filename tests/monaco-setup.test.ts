import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const makeDefaults = () => ({
    modeConfiguration: {},
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn()
  });
  const typescriptDefaults = makeDefaults();
  const javascriptDefaults = makeDefaults();
  return {
    typescriptDefaults,
    javascriptDefaults,
    reset: () => {
      typescriptDefaults.setCompilerOptions.mockClear();
      typescriptDefaults.setDiagnosticsOptions.mockClear();
      typescriptDefaults.setEagerModelSync.mockClear();
      javascriptDefaults.setCompilerOptions.mockClear();
      javascriptDefaults.setDiagnosticsOptions.mockClear();
      javascriptDefaults.setEagerModelSync.mockClear();
    }
  };
});

vi.mock('monaco-editor', () => ({
  typescript: {
    ScriptTarget: { ESNext: 99 },
    ModuleKind: { ESNext: 99 },
    ModuleResolutionKind: { NodeJs: 2 },
    JsxEmit: { ReactJSX: 4 },
    typescriptDefaults: mocks.typescriptDefaults,
    javascriptDefaults: mocks.javascriptDefaults
  },
  languages: {
    getLanguages: () => []
  },
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn()
  }
}));

class FakeWorker {}

vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: FakeWorker }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: FakeWorker }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: FakeWorker }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: FakeWorker }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: FakeWorker }));

describe('initMonaco', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    const target = globalThis as typeof globalThis & { self?: unknown; MonacoEnvironment?: unknown };
    target.self = target;
    delete target.MonacoEnvironment;
  });

  it('disables standalone TS/JS semantic diagnostics so first-open project files do not report missing sibling imports', async () => {
    const { initMonaco } = await import('../src/web/editor/monacoSetup');

    initMonaco();

    expect(mocks.typescriptDefaults.setDiagnosticsOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSuggestionDiagnostics: true
    });
    expect(mocks.javascriptDefaults.setDiagnosticsOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSuggestionDiagnostics: true
    });
  });
});
