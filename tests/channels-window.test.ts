import { describe, expect, it } from 'vitest';
import { sliceMessages } from '../src/server/channelsStore.js';
import type { ChannelMessage } from '../src/server/channelsProtocol.js';

const message = (index: number): ChannelMessage => ({
  id: `msg-${index}`,
  author: 'codex',
  timestamp: `2026-06-21 09:${String(index).padStart(2, '0')}:00`,
  body: `message ${index}`,
  hasEndTurn: true
});

describe('channel message windowing', () => {
  it('loads a bounded window around a target message id for reliable list navigation', () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index));

    const window = sliceMessages(messages, { around: 'msg-6', limit: 5 });

    expect(window.messages.map((item) => item.id)).toEqual(['msg-4', 'msg-5', 'msg-6', 'msg-7', 'msg-8']);
    expect(window.startIndex).toBe(4);
    expect(window.hasOlder).toBe(true);
    expect(window.hasNewer).toBe(true);
  });
});
