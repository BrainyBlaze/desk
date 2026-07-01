import { AlertTriangle, ChevronDown, CircleAlert, Info, X } from 'lucide-react';
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ProblemSeverity, ProblemsModel } from './problemsModel.js';

/**
 * Presentational collapsible Problems panel. All data (file-grouped, severity-ordered) comes in via
 * `model`; open/close is controlled by the parent (status-bar toggle + header close). Rows are
 * marker-derived only -- no server command/env/config is ever passed in. Clicking a row asks the
 * parent to reveal that uri/line/column.
 */
export interface ProblemsPanelProps {
  model: ProblemsModel;
  open: boolean;
  height?: number;
  minHeight?: number;
  maxHeight?: number;
  onResizeHeight?: (height: number) => void;
  onClose: () => void;
  onReveal: (uri: string, line: number, column: number) => void;
}

export const DEFAULT_PROBLEMS_PANEL_HEIGHT = 200;
export const MIN_PROBLEMS_PANEL_HEIGHT = 120;
export const MAX_PROBLEMS_PANEL_HEIGHT = 480;
const RESIZE_KEY_STEP = 10;

const SEVERITY_ICON: Record<ProblemSeverity, JSX.Element> = {
  error: <CircleAlert size={12} style={{ color: 'var(--desk-danger, #ff5f56)' }} />,
  warning: <AlertTriangle size={12} style={{ color: 'var(--desk-warn, #e6a500)' }} />,
  info: <Info size={12} style={{ color: 'var(--desk-accent, #5ad1ff)' }} />
};

export function clampProblemsPanelHeight(
  height: number,
  minHeight = MIN_PROBLEMS_PANEL_HEIGHT,
  maxHeight = MAX_PROBLEMS_PANEL_HEIGHT
): number {
  if (!Number.isFinite(height)) {
    return DEFAULT_PROBLEMS_PANEL_HEIGHT;
  }
  const min = Math.max(0, Math.min(minHeight, maxHeight));
  const max = Math.max(min, maxHeight);
  return Math.min(max, Math.max(min, Math.round(height)));
}

export function getProblemsPanelDragHeight(
  startHeight: number,
  startY: number,
  currentY: number,
  minHeight = MIN_PROBLEMS_PANEL_HEIGHT,
  maxHeight = MAX_PROBLEMS_PANEL_HEIGHT
): number {
  return clampProblemsPanelHeight(startHeight - (currentY - startY), minHeight, maxHeight);
}

export function ProblemsPanel({
  model,
  open,
  height = DEFAULT_PROBLEMS_PANEL_HEIGHT,
  minHeight = MIN_PROBLEMS_PANEL_HEIGHT,
  maxHeight = MAX_PROBLEMS_PANEL_HEIGHT,
  onResizeHeight,
  onClose,
  onReveal
}: ProblemsPanelProps): JSX.Element | null {
  if (!open) {
    return null;
  }
  const panelHeight = clampProblemsPanelHeight(height, minHeight, maxHeight);
  const reportHeight = (nextHeight: number): void => {
    onResizeHeight?.(clampProblemsPanelHeight(nextHeight, minHeight, maxHeight));
  };
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onResizeHeight) {
      return;
    }
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelHeight;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const onMove = (moveEvent: PointerEvent): void => {
      reportHeight(getProblemsPanelDragHeight(startHeight, startY, moveEvent.clientY, minHeight, maxHeight));
    };
    const onEnd = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd, { once: true });
    window.addEventListener('pointercancel', onEnd, { once: true });
  };
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!onResizeHeight) {
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      reportHeight(panelHeight + RESIZE_KEY_STEP);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      reportHeight(panelHeight - RESIZE_KEY_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      reportHeight(minHeight);
    } else if (event.key === 'End') {
      event.preventDefault();
      reportHeight(maxHeight);
    }
  };
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    padding: '1px 10px',
    fontSize: 11,
    lineHeight: 1.6,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    color: 'var(--desk-text)'
  };
  return (
    <div
      className="problemsPanel"
      aria-label="Problems"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--desk-line)',
        height: panelHeight,
        minHeight,
        maxHeight,
        background: 'var(--desk-bg, #0a0e12)'
      }}
    >
      <div
        role="separator"
        aria-label="Resize problems panel"
        aria-orientation="horizontal"
        aria-valuemin={Math.max(0, Math.min(minHeight, maxHeight))}
        aria-valuemax={Math.max(minHeight, maxHeight)}
        aria-valuenow={panelHeight}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={onResizeKeyDown}
        style={{
          height: 6,
          flex: '0 0 6px',
          cursor: 'ns-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent'
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 36,
            height: 2,
            borderRadius: 1,
            background: 'var(--desk-line)'
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          borderBottom: '1px solid var(--desk-line)'
        }}
      >
        <span className="settingsSectionLabel" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Problems
          <span style={{ opacity: 0.6 }}>
            ({model.counts.errors} error{model.counts.errors === 1 ? '' : 's'}, {model.counts.warnings} warning
            {model.counts.warnings === 1 ? '' : 's'}
            {model.counts.infos > 0 ? `, ${model.counts.infos} info` : ''})
          </span>
        </span>
        <button
          type="button"
          aria-label="Close problems panel"
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: 'var(--desk-text)', cursor: 'pointer', display: 'inline-flex' }}
        >
          <X size={13} />
        </button>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {model.total === 0 ? (
          <div className="settingsHint" style={{ padding: '6px 10px' }}>
            No problems detected.
          </div>
        ) : (
          model.groups.map((group) => (
            <div key={group.uri}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 10px',
                  fontSize: 11,
                  opacity: 0.8
                }}
              >
                <ChevronDown size={11} />
                <span>{group.path}</span>
                <span style={{ opacity: 0.6 }}>{group.items.length}</span>
              </div>
              {group.items.map((item, index) => (
                <button
                  type="button"
                  key={`${group.uri}:${index}`}
                  style={rowStyle}
                  onClick={() => onReveal(group.uri, item.line, item.column)}
                >
                  <span style={{ flexShrink: 0 }}>{SEVERITY_ICON[item.severity]}</span>
                  <span style={{ flex: 1 }}>{item.message}</span>
                  {item.source ? (
                    <span style={{ opacity: 0.55, flexShrink: 0 }}>
                      {item.source}
                      {item.code ? `(${item.code})` : ''}
                    </span>
                  ) : null}
                  <span style={{ opacity: 0.55, flexShrink: 0 }}>
                    [{item.line}:{item.column}]
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
