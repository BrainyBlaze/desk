import { useEffect, useState } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { Clock } from 'lucide-react';
import type { DeskBleepName } from './arwes/bleeps.js';
import { formatClock, useStatusSegments, type StatusSegment } from './statusSegments.js';

export interface StatusBarProps {
  /** active subsystem key — selects which published scope renders on the left */
  scope: string;
  /** app-level segments (sync, attention, unread, mute) rendered on the right */
  globals: StatusSegment[];
}

/**
 * Thin bottom status bar: workflow context for the active subsystem on the
 * left (active file, branch, channel, session...), app-wide signals on the
 * right. System metrics live in the topbar — never duplicated here.
 */
export function StatusBar({ scope, globals }: StatusBarProps): JSX.Element {
  const segments = useStatusSegments(scope);
  return (
    <Animator>
      <Animated as="footer" className="statusBar" animated={['flicker', ['y', 6, 0]]} aria-label="Status bar">
        <div className="statusSegments statusLeft">
          {segments.map((segment) => (
            <Segment key={segment.key} segment={segment} />
          ))}
        </div>
        <div className="statusSegments statusRight">
          {globals.map((segment) => (
            <Segment key={segment.key} segment={segment} />
          ))}
          <StatusClock />
        </div>
      </Animated>
    </Animator>
  );
}

function Segment({ segment }: { segment: StatusSegment }): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const body = (
    <>
      {segment.icon}
      <span className="statusSegmentText">{segment.text}</span>
    </>
  );
  if (segment.onClick) {
    return (
      <button
        type="button"
        className={`statusSegment ${segment.tone ?? ''}`}
        title={segment.hint ?? segment.text}
        onClick={() => {
          bleeps.click?.play();
          segment.onClick?.();
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={`statusSegment ${segment.tone ?? ''}`} title={segment.hint ?? segment.text}>
      {body}
    </span>
  );
}

function StatusClock(): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick aligned to the minute boundary so the clock never shows stale minutes.
    let timer: number;
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_000 - (Date.now() % 60_000) + 50);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <span className="statusSegment statusClock" title={now.toLocaleString()}>
      <Clock size={10} />
      <span className="statusSegmentText">{formatClock(now)}</span>
    </span>
  );
}
