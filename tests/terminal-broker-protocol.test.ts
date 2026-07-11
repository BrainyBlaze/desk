import { describe, expect, it } from 'vitest';
import {
  MAX_TERMINAL_BROKER_INPUT_LENGTH,
  MAX_TERMINAL_DIMENSION,
  parseBrokerClientFrame
} from '../src/core/terminalBrokerProtocol';

describe('terminal broker protocol', () => {
  it('parses subscribe, visibility, unsubscribe, input, and resize frames', () => {
    expect(parseBrokerClientFrame({ type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true })).toEqual({
      type: 'subscribe',
      session: 'agentdesk-a',
      surfaceId: 'cell-a',
      visible: true
    });
    expect(parseBrokerClientFrame({ type: 'visibility', session: 'agentdesk-a', surfaceId: 'cell-a', visible: false })).toEqual({
      type: 'visibility',
      session: 'agentdesk-a',
      surfaceId: 'cell-a',
      visible: false
    });
    expect(parseBrokerClientFrame({ type: 'unsubscribe', session: 'agentdesk-a', surfaceId: 'cell-a' })).toEqual({
      type: 'unsubscribe',
      session: 'agentdesk-a',
      surfaceId: 'cell-a'
    });
    expect(parseBrokerClientFrame({ type: 'input', session: 'agentdesk-a', surfaceId: 'cell-a', data: 'ls\r' })).toEqual({
      type: 'input',
      session: 'agentdesk-a',
      surfaceId: 'cell-a',
      data: 'ls\r'
    });
    expect(parseBrokerClientFrame({ type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 120, rows: 40 })).toEqual({
      type: 'resize',
      session: 'agentdesk-a',
      surfaceId: 'cell-a',
      cols: 120,
      rows: 40
    });
  });

  it('rejects malformed broker frames', () => {
    const invalid = [
      null,
      {},
      { type: 'unknown', session: 'agentdesk-a' },
      { type: 'subscribe', session: '', surfaceId: 'cell-a', visible: true },
      { type: 'subscribe', session: 'agentdesk-a', visible: true },
      { type: 'subscribe', session: 'agentdesk-a', surfaceId: '', visible: true },
      { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: 'true' },
      { type: 'unsubscribe', session: 7, surfaceId: 'cell-a' },
      { type: 'input', session: 'agentdesk-a', surfaceId: 'cell-a' },
      { type: 'input', session: 'agentdesk-a', surfaceId: 'cell-a', data: 7 },
      { type: 'visibility', session: 'agentdesk-a', surfaceId: 'cell-a' },
      { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 39, rows: 40 },
      { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 120, rows: 11 },
      { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 120.5, rows: 40 },
      {
        type: 'input',
        session: 'agentdesk-a',
        surfaceId: 'cell-a',
        data: 'x'.repeat(MAX_TERMINAL_BROKER_INPUT_LENGTH + 1)
      },
      { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: MAX_TERMINAL_DIMENSION + 1, rows: 40 },
      { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 120, rows: MAX_TERMINAL_DIMENSION + 1 }
    ];

    for (const frame of invalid) {
      expect(() => parseBrokerClientFrame(frame)).toThrow(/invalid terminal broker frame/i);
    }
  });
});
