import { useEffect, useRef } from 'react';
import { useDeskTheme } from '../arwes/primitives.js';
import { applyDeskMonacoTheme, initMonaco, monaco } from '../editor/monacoSetup.js';

export interface DiffModels {
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
}

/**
 * Single Monaco diff editor instance for the git stage — same lifecycle
 * pattern as MonacoHost (create once, swap models per tab, per-tab view
 * state, retint on theme change).
 */
export function DiffHost({
  models,
  activeKey,
  sideBySide
}: {
  models: DiffModels | null;
  activeKey: string | null;
  sideBySide: boolean;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const viewStatesRef = useRef(new Map<string, monaco.editor.IDiffEditorViewState | null>());
  const previousKeyRef = useRef<string | null>(null);
  const theme = useDeskTheme();

  useEffect(() => {
    if (!containerRef.current || editorRef.current) {
      return;
    }
    initMonaco();
    applyDeskMonacoTheme(theme);
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: 'desk',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      renderOverviewRuler: true,
      diffWordWrap: 'off',
      fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      fontLigatures: true,
      minimap: { enabled: false },
      smoothScrolling: true,
      mouseWheelZoom: true,
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      hideUnchangedRegions: { enabled: true }
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (editorRef.current) {
      applyDeskMonacoTheme(theme);
    }
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (previousKeyRef.current && previousKeyRef.current !== activeKey) {
      viewStatesRef.current.set(previousKeyRef.current, editor.saveViewState());
    }
    if (models) {
      editor.setModel({ original: models.original, modified: models.modified });
      if (activeKey) {
        const viewState = viewStatesRef.current.get(activeKey);
        if (viewState) {
          editor.restoreViewState(viewState);
        }
      }
    } else {
      editor.setModel(null);
    }
    previousKeyRef.current = activeKey;
  }, [models, activeKey]);

  return <div ref={containerRef} className="monacoHost" />;
}
