import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { channelSwitchCursorSeed } from '../src/web/channels/channelCursorSeed.js';

describe('channelSwitchCursorSeed', () => {
  it('seeds the saved viewport anchor on a plain cached restore (useSavedAnchor=true)', () => {
    expect(channelSwitchCursorSeed('saved-1', 'read-1', true)).toBe('saved-1');
  });

  it('falls back to the read anchor when there is no saved viewport anchor', () => {
    expect(channelSwitchCursorSeed(undefined, 'read-1', true)).toBe('read-1');
    expect(channelSwitchCursorSeed(null, 'read-1', true)).toBe('read-1');
  });

  it('ignores the saved anchor on a fresh/reanchor visit and seeds the read anchor', () => {
    // The saved viewport anchor may be off the re-fetched window, which would
    // re-trigger the oldest-row jump; the read anchor sits in the new window.
    expect(channelSwitchCursorSeed('saved-1', 'read-1', false)).toBe('read-1');
  });

  it('returns null only when the channel was never visited or read', () => {
    expect(channelSwitchCursorSeed(null, null, true)).toBeNull();
    expect(channelSwitchCursorSeed(undefined, undefined, false)).toBeNull();
  });
});

describe('ChannelsSubsystem cursor/thread wiring', () => {
  const source = readFileSync(new URL('../src/web/channels/ChannelsSubsystem.tsx', import.meta.url), 'utf8');

  it('selectChannel reseeds the keyboard cursor on switch (no stale cross-channel cursor)', () => {
    expect(source).toContain('setCursorId(channelSwitchCursorSeed(savedAnchor, readAnchor, true))');
    expect(source).toContain('setCursorId(channelSwitchCursorSeed(savedAnchor, readAnchor, false))');
  });

  it('navigateToMessage preserves an explicit target by not reseeding when a message is given', () => {
    expect(source).toContain('seedCursor: !messageId');
  });

  it('openThread uses the live selectedRef.current, not the stale selected state', () => {
    // The 't'-key path runs through a once-registered keydown listener whose
    // closure holds a stale `selected`; refreshThread must get the live channel.
    expect(source).toContain('const channel = selectedRef.current;');
    expect(source).toContain('void refreshThread(channel, parentId)');
    expect(source).not.toContain('void refreshThread(selected, parentId)');
  });
});
