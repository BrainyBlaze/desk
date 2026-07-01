import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { DeskBuiltTheme } from '../arwes/theme.js';
import { hslStringToHex } from './colorUtil.js';

export { monaco };

let initialized = false;

/** One-time global Monaco environment: local workers (no CDN) + TS defaults. */
export function initMonaco(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'json') {
        return new jsonWorker();
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    }
  };
  // monaco 0.55: `monaco.languages.typescript` is a deprecated stub; the API
  // lives in the top-level `typescript` namespace on the main module.
  monaco.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true
  });
  // Standalone Monaco's TS worker cannot see Desk's project filesystem or tsconfig graph on first
  // open, so semantic diagnostics report false missing imports until the real LSP/compiler path wins.
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSuggestionDiagnostics: true
  });
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSuggestionDiagnostics: true
  });
  monaco.typescript.typescriptDefaults.setEagerModelSync(true);
}

/** Retint Monaco from the active Desk theme (terminal palette + mode). */
export function applyDeskMonacoTheme(theme: DeskBuiltTheme): void {
  const t = theme.terminal;
  const hex = (value: string): string => hslStringToHex(value);
  const token = (value: string): string => hex(value).replace('#', '');
  monaco.editor.defineTheme('desk', {
    base: theme.mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: token(t.brightBlack), fontStyle: 'italic' },
      { token: 'string', foreground: token(t.green) },
      { token: 'number', foreground: token(t.yellow) },
      { token: 'keyword', foreground: token(t.cyan) },
      { token: 'type', foreground: token(t.blue) },
      { token: 'function', foreground: token(t.magenta) },
      { token: 'variable', foreground: token(t.foreground) },
      { token: 'tag', foreground: token(t.cyan) },
      { token: 'attribute.name', foreground: token(t.yellow) }
    ],
    colors: {
      'editor.background': hex(t.background),
      'editor.foreground': hex(t.foreground),
      'editorCursor.foreground': hex(t.cursor),
      'editor.selectionBackground': hex(t.selectionBackground),
      'editor.inactiveSelectionBackground': hex(t.selectionInactiveBackground),
      'editorLineNumber.foreground': hex(t.brightBlack),
      'editorLineNumber.activeForeground': hex(t.foreground),
      'editorWidget.background': hex(t.background),
      'editorGutter.background': hex(t.background),
      'minimap.background': hex(t.background)
    }
  });
  monaco.editor.setTheme('desk');
}

let extensionMap: Map<string, string> | null = null;

/** Resolve a Monaco language id from a path using Monaco's own registry. */
export function languageForPath(path: string): string {
  if (!extensionMap) {
    extensionMap = new Map();
    for (const language of monaco.languages.getLanguages()) {
      for (const extension of language.extensions ?? []) {
        if (!extensionMap.has(extension)) {
          extensionMap.set(extension, language.id);
        }
      }
      for (const filename of language.filenames ?? []) {
        extensionMap.set(`name:${filename.toLowerCase()}`, language.id);
      }
    }
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  const byName = extensionMap.get(`name:${name.toLowerCase()}`);
  if (byName) {
    return byName;
  }
  const dot = name.lastIndexOf('.');
  if (dot === -1) {
    return 'plaintext';
  }
  return extensionMap.get(name.slice(dot)) ?? 'plaintext';
}
