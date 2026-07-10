import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Animator } from '@arwes/react';
import { CLIP_OCTAGON_PILL, Cmd, TextReveal } from './arwes/primitives.js';
import { sparklinePoints } from './systemFormat.js';

export function CommandButton({
  icon,
  label,
  onClick,
  disabled,
  submit,
  title
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  submit?: boolean;
  title?: string;
}): JSX.Element {
  return <Cmd icon={icon} label={label} onClick={onClick} disabled={disabled} submit={submit} title={title} />;
}

export function HeaderClock(): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    <div className="headerClock" title={now.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}>
      <span>{pad(now.getHours())}:{pad(now.getMinutes())}</span>
      <small>{pad(now.getSeconds())}</small>
    </div>
  );
}

export function TelemetryCell({
  label,
  value,
  sub,
  tone,
  title,
  spark,
  sparkFloor = 100
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'ok' | 'warn' | 'muted';
  title?: string;
  /** history ring rendered as a right-aligned sparkline (percent series by default) */
  spark?: number[];
  /** scale ceiling floor: 100 anchors percent series; 1 lets rates autoscale to their window peak */
  sparkFloor?: number;
}): JSX.Element {
  const points = spark ? sparklinePoints(spark, sparkFloor) : '';
  return (
    <Animator>
      <Animated
        className={`telemetryCell ${tone ?? ''}`}
        animated={['flicker', ['y', 6, 0]]}
        style={{ clipPath: CLIP_OCTAGON_PILL }}
        title={title}
        data-cell={label.toLowerCase()}
      >
        {/* Label is static -> safe to decipher once. Value/sub update every 2s -> must stay plain text. */}
        <TextReveal as="span" manager="decipher">{label}</TextReveal>
        <strong>{value}</strong>
        <small>{sub}</small>
        {points ? (
          <svg className="telemetrySpark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={points} />
          </svg>
        ) : null}
      </Animated>
    </Animator>
  );
}
