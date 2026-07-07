import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Animated,
  Animator,
  BleepsOnAnimator,
  Dots,
  FrameKranox,
  FrameOctagon,
  GridLines,
  Illuminator,
  MovingLines,
  Text,
  styleFrameClipKranox,
  styleFrameClipOctagon,
  useBleeps
} from '@arwes/react';
import { ChevronDown, HelpCircle, X } from 'lucide-react';
import { createDeskTheme, type DeskBuiltTheme } from './theme.js';
import { isReducedMotion } from './motion.js';
import type { DeskBleepName } from './bleeps.js';

/* ---------- Theme context (canvas/JS consumers can't read CSS vars) ---------- */

export const DeskThemeContext = createContext<DeskBuiltTheme>(createDeskTheme('cyan-night'));

export function useDeskTheme(): DeskBuiltTheme {
  return useContext(DeskThemeContext);
}

/* Shared clip-paths (computed once — pure strings, no SVG cost). */
export const CLIP_OCTAGON_CELL = styleFrameClipOctagon({ squareSize: 10 });
export const CLIP_OCTAGON_PILL = styleFrameClipOctagon({ squareSize: 6 });
export const CLIP_OCTAGON_TINY = styleFrameClipOctagon({ squareSize: 4 });

/* ---------- TextReveal ---------- */

export function TextReveal({
  children,
  as = 'span',
  manager = 'decipher',
  className,
  contentClassName
}: {
  children: ReactNode;
  as?: keyof HTMLElementTagNameMap;
  manager?: 'sequence' | 'decipher';
  className?: string;
  contentClassName?: string;
}): JSX.Element {
  if (isReducedMotion()) {
    return createElement(as, { className }, children);
  }
  return (
    <Text as={as} manager={manager} fixed className={className} contentClassName={contentClassName}>
      {children}
    </Text>
  );
}

/* ---------- Pill ---------- */

export function Pill({
  children,
  tone,
  title,
  pulse,
  onClick
}: {
  children: ReactNode;
  tone?: 'ok' | 'warn' | 'muted';
  title?: string;
  pulse?: boolean;
  onClick?: () => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const className = `deskPill ${tone ?? ''} ${pulse ? 'pulse' : ''}`;
  if (onClick) {
    return (
      <button
        type="button"
        className={`${className} clickable`}
        title={title}
        style={{ clipPath: CLIP_OCTAGON_PILL }}
        onMouseEnter={() => bleeps.hover?.play()}
        onClick={() => {
          bleeps.click?.play();
          onClick();
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={className} title={title} style={{ clipPath: CLIP_OCTAGON_PILL }}>
      {children}
    </span>
  );
}

/* ---------- Cmd (primary command button) ---------- */

export function Cmd({
  icon,
  label,
  onClick,
  disabled,
  submit,
  tone,
  pressed,
  expanded,
  controls,
  onMouseEnter
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  submit?: boolean;
  tone?: 'danger';
  /** toggle buttons (e.g. mute) expose their state to AT via aria-pressed */
  pressed?: boolean;
  /** disclosure buttons (e.g. the mobile burger) expose open state + target */
  expanded?: boolean;
  controls?: string;
  onMouseEnter?: () => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const builtTheme = useDeskTheme();
  return (
    <button
      className={`deskCmd ${tone === 'danger' ? 'danger' : ''}`}
      type={submit ? 'submit' : 'button'}
      disabled={disabled}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
      onMouseEnter={() => {
        bleeps.hover?.play();
        onMouseEnter?.();
      }}
      onClick={() => {
        bleeps.click?.play();
        onClick?.();
      }}
    >
      <div className="deskCmdBack" style={{ clipPath: CLIP_OCTAGON_PILL }}>
        <Illuminator color={builtTheme.canvas.illuminator} size={96} />
      </div>
      <FrameOctagon squareSize={6} strokeWidth={1} />
      <span className="deskCmdContent">
        {icon}
        <span>{label}</span>
      </span>
    </button>
  );
}

/* ---------- IconButton (small icon-only action, hover/click bleeps) ---------- */

export function IconButton({
  icon,
  label,
  onClick,
  disabled
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  return (
    <button
      className="iconButton"
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onMouseEnter={() => bleeps.hover?.play()}
      onClick={() => {
        bleeps.click?.play();
        onClick?.();
      }}
    >
      {icon}
    </button>
  );
}

/* ---------- DeskPanel (framed surface for low-count chrome) ---------- */

export function DeskPanel({
  children,
  className,
  texture = false
}: {
  children: ReactNode;
  className?: string;
  texture?: boolean;
}): JSX.Element {
  const builtTheme = useDeskTheme();
  return (
    <div className={`deskPanel ${className ?? ''}`}>
      <FrameKranox />
      {texture ? <Dots color={builtTheme.canvas.dots} type="cross" distance={28} size={5} crossSize={1} /> : null}
      <div className="deskPanelContent">{children}</div>
    </div>
  );
}

/* ---------- CellChrome (terminal cell — pure CSS clip, zero SVG) ---------- */

export function CellChrome({
  focused,
  children
}: {
  focused?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="cellChrome" data-focused={focused ? 'true' : undefined}>
      <div className="cellChromeBorder" style={{ clipPath: CLIP_OCTAGON_CELL }} />
      <div className="cellChromeBody" style={{ clipPath: CLIP_OCTAGON_CELL }}>
        {children}
      </div>
    </div>
  );
}

/* ---------- DeskSelect (animated dropdown — native selects cannot be styled) ---------- */

export interface DeskSelectOption {
  value: string;
  label: string;
}

export function DeskSelect({
  value,
  options,
  placeholder,
  onChange
}: {
  value: string;
  options: DeskSelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The panel is portalled OUT of the modal so it escapes the modal's clip-path
  // and the modalBody's overflow:auto — both of which used to clip a dropdown
  // opened low in a modal (the Add-group Layout select showed only its first
  // option). The target is `.deskShell`, not <body>: the shell carries the
  // theme CSS variables (an inline themeVars style) and has no clip-path, so the
  // panel keeps its colors and stays unclipped. Its overflow:hidden does not
  // clip a position:fixed child (the shell has no transform/filter). Falls back
  // to <body> for any select rendered outside the shell.
  const [coords, setCoords] = useState<{ left: number; top: number; width: number; placement: 'down' | 'up' } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  const reposition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const desired = panelRef.current?.offsetHeight ?? Math.min(180, options.length * 24 + 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Open downward unless there isn't room and there's more room above.
    const placement = spaceBelow < desired + 8 && spaceAbove > spaceBelow ? 'up' : 'down';
    setCoords({
      left: rect.left,
      top: placement === 'down' ? rect.bottom + 3 : rect.top - 3,
      width: rect.width,
      placement
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) {
      setPortalTarget((triggerRef.current?.closest('.deskShell') as HTMLElement | null) ?? document.body);
      reposition();
    }
  }, [open, reposition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onDocKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation(); // close the dropdown, not the surrounding modal
        setOpen(false);
      }
    };
    const onReflow = (): void => reposition();
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeyDown, true);
    // Capture-phase scroll catches the modalBody scroll too, keeping the
    // portalled panel pinned to its trigger.
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onDocKeyDown, true);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, reposition]);

  const current = options.find((option) => option.value === value);

  return (
    <div className="deskSelect" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`deskSelectTrigger ${open ? 'open' : ''}`}
        style={{ clipPath: CLIP_OCTAGON_TINY }}
        onMouseEnter={() => bleeps.hover?.play()}
        onClick={() => {
          bleeps.click?.play();
          setOpen((value) => !value);
        }}
      >
        <span>{current?.label ?? placeholder ?? 'Select'}</span>
        <ChevronDown size={12} className={open ? 'flip' : ''} />
      </button>
      {open && coords && portalTarget
        ? createPortal(
            <div
              ref={panelRef}
              className={`deskSelectPanel deskSelectPanelPortal ${coords.placement === 'up' ? 'placeUp' : ''}`}
              style={{
                left: `${coords.left}px`,
                width: `${coords.width}px`,
                ...(coords.placement === 'down'
                  ? { top: `${coords.top}px` }
                  : { top: `${coords.top}px`, transform: 'translateY(-100%)' }),
                clipPath: CLIP_OCTAGON_TINY
              }}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`deskSelectOption ${option.value === value ? 'selected' : ''}`}
                  onMouseEnter={() => bleeps.hover?.play()}
                  onClick={() => {
                    bleeps.click?.play();
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>,
            portalTarget
          )
        : null}
    </div>
  );
}

/* ---------- BackdropField (single global ambient field) ---------- */

export function BackdropField(): JSX.Element {
  const builtTheme = useDeskTheme();
  return (
    <div className="backgroundField" aria-hidden="true" key={builtTheme.name}>
      <Animator duration={{ enter: 0.8 }}>
        <GridLines lineColor={builtTheme.canvas.gridLine} distance={40} />
        <MovingLines lineColor={builtTheme.canvas.movingLine} distance={64} sets={6} />
        <Dots color={builtTheme.canvas.dots} type="cross" distance={28} size={5} crossSize={1} />
      </Animator>
    </div>
  );
}


/* ---------- HelpIcon (shows tooltip on hover) ---------- */

export function HelpIcon({ text }: { text: string }): JSX.Element {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const bleeps = useBleeps<DeskBleepName>();

  const handleMouseEnter = (): void => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setTooltipPos({
      x: rect.left + rect.width / 2,
      y: rect.top
    });
    setShowTooltip(true);
    bleeps.hover?.play();
  };

  const handleMouseLeave = (): void => {
    setShowTooltip(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="iconButton helpIconButton"
        type="button"
        aria-label="Help"
        title={text}
        style={{ clipPath: CLIP_OCTAGON_TINY }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={() => bleeps.click?.play()}
      >
        <HelpCircle size={13} />
      </button>
      {showTooltip && tooltipPos
        ? createPortal(
            <div
              style={{
                position: 'fixed',
                left: `${tooltipPos.x}px`,
                top: `${tooltipPos.y}px`,
                transform: 'translate(-50%, -100%)',
                marginTop: '-8px',
                backgroundColor: 'rgba(20, 20, 30, 0.95)',
                color: '#ccc',
                padding: '8px 12px',
                borderRadius: '4px',
                fontSize: '12px',
                maxWidth: '240px',
                whiteSpace: 'normal',
                zIndex: 100000,
                border: '1px solid rgba(100, 200, 255, 0.3)',
                pointerEvents: 'none'
              }}
            >
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

/* ---------- Modal (Kranox frame + enter choreography + open bleep) ---------- */

export function Modal({
  title,
  icon,
  onClose,
  children,
  tone,
  alarm,
  wide,
  help
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
  tone?: 'danger';
  alarm?: boolean;
  /** roomy two-pane layouts (settings) get a wider frame */
  wide?: boolean;
  /** short explainer surfaced via a "?" icon next to the title */
  help?: string;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(true);
  }, []);
  const requestClose = (): void => {
    setActive(false);
    window.setTimeout(onClose, 260);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    // Escape cancels, with the same exit animation as the X button. Safe for
    // every desk modal: destructive flows confirm via an explicit button.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const enterBleep: DeskBleepName = alarm ? 'alarm' : 'open';
  return (
    <Animator active={active} combine manager="stagger" duration={{ enter: 0.4, exit: 0.22, stagger: 0.06 }}>
      <BleepsOnAnimator<DeskBleepName> transitions={{ entering: enterBleep, exiting: 'close' }} />
      <Animated className={`modalScrim ${tone === 'danger' ? 'danger' : ''}`} animated={['fade']}>
        <section
          className={`deskModal ${tone === 'danger' ? 'danger' : ''} ${wide ? 'wide' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          style={{ clipPath: styleFrameClipKranox({ squareSize: 16, strokeWidth: 2, smallLineLength: 16, largeLineLength: 64 }) }}
        >
          <FrameKranox padding={2} squareSize={16} strokeWidth={2} bgStrokeWidth={2} smallLineLength={16} largeLineLength={64} />
          <div className="modalHeader">
            <div className="railTitle">
              {icon}
              <TextReveal as="span" manager="decipher">{title}</TextReveal>
              {help ? <HelpIcon text={help} /> : null}
            </div>
            <button
              className="iconButton"
              type="button"
              aria-label="Close"
              title="Close"
              style={{ clipPath: CLIP_OCTAGON_TINY }}
              onMouseEnter={() => bleeps.hover?.play()}
              onClick={() => {
                bleeps.click?.play();
                requestClose();
              }}
            >
              <X size={13} />
            </button>
          </div>
          <Animator duration={{ enter: 0.3 }}>
            <Animated className="modalBody" animated={['flicker', ['y', 14, 0]]}>
              {children}
            </Animated>
          </Animator>
        </section>
      </Animated>
    </Animator>
  );
}
