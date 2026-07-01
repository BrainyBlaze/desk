import { useEffect, useRef } from 'react';
import type { GitLineDiffResult } from '../../shared/git.js';
import { useDeskTheme } from '../arwes/primitives.js';
import { applyDeskMonacoTheme, initMonaco, monaco } from './monacoSetup.js';

export interface RevealTarget {
  line: number;
  column: number;
}

export interface MonacoHostProps {
  /** model of the active tab; null shows nothing (parent renders placeholders) */
  model: monaco.editor.ITextModel | null;
  activePath: string | null;
  reveal: RevealTarget | null;
  onRevealConsumed: () => void;
  onSave: () => void;
  /** cursor moves, for the status bar Ln/Col cell */
  onCursor?: (position: { line: number; column: number }) => void;
  /** git gutter hunks for the active model; null clears the decorations */
  gutter?: GitLineDiffResult | null;
}

export function MonacoHost({ model, activePath, reveal, onRevealConsumed, onSave, onCursor, gutter }: MonacoHostProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const previousPathRef = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const theme = useDeskTheme();

  // Create the single editor instance once.
  useEffect(() => {
    if (!containerRef.current || editorRef.current) {
      return;
    }
    initMonaco();
    applyDeskMonacoTheme(theme);
    const editor = monaco.editor.create(containerRef.current, {
      model: null,
      theme: 'desk',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      fontLigatures: true,
      minimap: { enabled: true },
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      linkedEditing: true,
      formatOnPaste: true,
      mouseWheelZoom: true,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'phase',
      cursorSmoothCaretAnimation: 'on',
      occurrencesHighlight: 'singleFile',
      suggest: { preview: true },
      inlayHints: { enabled: 'on' },
      // Activate LSP semantic tokens (default 'configuredByTheme' would stay dormant: the 'desk'
      // theme opts out), so the semantic-token full/delta provider is actually requested.
      'semanticHighlighting.enabled': true,
      scrollBeyondLastLine: false,
      padding: { top: 8 }
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    editor.onDidChangeCursorPosition((event) => {
      onCursorRef.current?.({ line: event.position.lineNumber, column: event.position.column });
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retint on theme change.
  useEffect(() => {
    if (editorRef.current) {
      applyDeskMonacoTheme(theme);
    }
  }, [theme]);

  // Swap models on tab change, preserving per-tab view state.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (previousPathRef.current && previousPathRef.current !== activePath) {
      viewStatesRef.current.set(previousPathRef.current, editor.saveViewState());
    }
    editor.setModel(model);
    if (activePath && model) {
      const viewState = viewStatesRef.current.get(activePath);
      if (viewState) {
        editor.restoreViewState(viewState);
      }
      editor.focus();
    }
    previousPathRef.current = activePath;
  }, [model, activePath]);

  // Reveal a search result position once the model is in place.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || !model) {
      return;
    }
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editor.revealLineInCenter(reveal.line);
    editor.focus();
    onRevealConsumed();
  }, [reveal, model, onRevealConsumed]);

  // Git gutter decorations. The collection follows the editor's current
  // model, so this effect runs AFTER the model-swap effect above (hook
  // order) and always paints against the fresh model.
  const gutterDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    gutterDecorationsRef.current ??= editor.createDecorationsCollection();
    if (!model || !gutter) {
      gutterDecorationsRef.current.clear();
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();
    const wholeLine = (start: number, end: number, className: string): void => {
      decorations.push({
        range: new monaco.Range(Math.min(start, lineCount), 1, Math.min(end, lineCount), 1),
        options: { isWholeLine: true, linesDecorationsClassName: className }
      });
    };
    if (gutter.untracked) {
      wholeLine(1, lineCount, 'gitGutterAdded');
    } else {
      for (const hunk of gutter.hunks) {
        if (hunk.kind === 'deleted') {
          // start = line AFTER which content was removed; 0 = above line 1.
          wholeLine(
            Math.max(1, hunk.start),
            Math.max(1, hunk.start),
            hunk.start === 0 ? 'gitGutterDeleted gitGutterDeletedTop' : 'gitGutterDeleted'
          );
        } else {
          wholeLine(hunk.start, hunk.start + hunk.count - 1, hunk.kind === 'added' ? 'gitGutterAdded' : 'gitGutterModified');
        }
      }
    }
    gutterDecorationsRef.current.set(decorations);
  }, [gutter, model]);

  return <div ref={containerRef} className="monacoHost" />;
}
