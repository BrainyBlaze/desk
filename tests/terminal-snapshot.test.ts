import { describe, expect, it } from 'vitest';
import { applyTerminalSnapshot } from '../src/web/terminalSnapshot.js';

describe('applyTerminalSnapshot', () => {
  it('reports completion only after xterm has consumed the snapshot', () => {
    const events: string[] = [];
    let writeDone: (() => void) | undefined;
    const terminal = {
      options: { theme: {} },
      reset: () => events.push('reset'),
      write: (data: string, done?: () => void) => {
        events.push(`write:${data}`);
        writeDone = done;
      }
    };

    applyTerminalSnapshot(terminal, 'screen', { foreground: '#fff' }, () => {
      events.push('applied');
    });

    expect(events).toEqual(['reset', 'write:screen']);
    expect(terminal.options.theme).toEqual({ foreground: '#fff' });
    writeDone?.();
    expect(events).toEqual(['reset', 'write:screen', 'applied']);
  });
});
