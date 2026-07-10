import type { DeskSessionView } from '../ui/model.js';

export function StatusDot({ state, attention }: { state: DeskSessionView['state']; attention?: boolean }): JSX.Element {
  const tone = attention && state === 'running' ? 'attention' : state === 'running' ? 'running' : 'missing';
  return <span className={`statusDot ${tone}`} />;
}
