import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { channelSwitchCursorSeed } from '../src/web/channels/channelCursorSeed.js';

describe('channelSwitchCursorSeed', () => {
  it('seeds the saved viewport anchor on a plain cached restore (useSavedAnchor=true)', () => {
    expect(channelSwitchCursorSeed('saved-1', 'read-1', true, 'newest-1')).toBe('saved-1');
  });

  it('falls back to the read anchor when there is no saved viewport anchor', () => {
    expect(channelSwitchCursorSeed(undefined, 'read-1', true, 'newest-1')).toBe('read-1');
    expect(channelSwitchCursorSeed(null, 'read-1', true, 'newest-1')).toBe('read-1');
  });

  it('ignores the saved anchor on a fresh/reanchor visit and seeds the read anchor', () => {
    // The saved viewport anchor may be off the re-fetched window, which would
    // re-trigger the oldest-row jump; the read anchor sits in the new window.
    expect(channelSwitchCursorSeed('saved-1', 'read-1', false, 'newest-1')).toBe('read-1');
  });

  it('falls back to the newest in-window id for a never-visited channel (no saved/read anchor)', () => {
    // The exact gap: without this, the seed is null, adjacentMessageId treats
    // null like unknown, and the first j still jumps to the oldest row.
    expect(channelSwitchCursorSeed(null, null, true, 'newest-1')).toBe('newest-1');
    expect(channelSwitchCursorSeed(undefined, undefined, false, 'newest-1')).toBe('newest-1');
  });

  it('returns null only for a truly empty channel (no anchors AND no messages)', () => {
    expect(channelSwitchCursorSeed(null, null, true, null)).toBeNull();
    expect(channelSwitchCursorSeed(undefined, undefined, false, undefined)).toBeNull();
  });
});

describe('ChannelsSubsystem cursor/thread wiring', () => {
  const source = readFileSync(new URL('../src/web/channels/ChannelsSubsystem.tsx', import.meta.url), 'utf8');

  it('selectChannel reseeds the keyboard cursor on switch (no stale cross-channel cursor)', () => {
    // Three seed sites — reanchor, plain cached restore, fresh — each passing an
    // in-window newest fallback as the 4th arg.
    const seedCalls = source.match(/setCursorId\(channelSwitchCursorSeed\(savedAnchor, readAnchor, /g) ?? [];
    expect(seedCalls.length).toBe(3);
    expect(source).toContain('cached.messages.at(-1)?.id ?? null'); // cached-restore newest fallback
    expect(source).toContain(', newestFromSummary)'); // fresh/reanchor newest fallback
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

  it('both Channels key listeners ignore an open App modal (Settings), which navState.blocked cannot see', () => {
    // One .deskModal guard in the Cmd-K listener, one in the j/k/s/t listener.
    const modalGuards = source.match(/document\.querySelector\('\.deskModal'\)/g) ?? [];
    expect(modalGuards.length).toBeGreaterThanOrEqual(2);
  });

  it('the Cmd-K palette toggle also ignores editable targets (no hijack while typing)', () => {
    expect(source).toContain("don't hijack Cmd-K while the user is typing in a field");
  });

  it('both listeners guard SELECT/INPUT/TEXTAREA/contenteditable, matching the App shortcut guard', () => {
    // SELECT included so j/k on a focused channel select does not also navigate
    // the hidden feed, and Cmd-K cannot open from it.
    const editableGuards =
      source.match(
        /tagName === 'INPUT' \|\| target\.tagName === 'TEXTAREA' \|\| target\.tagName === 'SELECT' \|\| target\.isContentEditable/g
      ) ?? [];
    expect(editableGuards.length).toBeGreaterThanOrEqual(2);
  });
});

describe('MessageList cursor focus ownership', () => {
  const source = readFileSync(new URL('../src/web/channels/MessageList.tsx', import.meta.url), 'utf8');

  it('does not steal focus from a select while applying a deferred cursor move', () => {
    expect(source).toMatch(
      /active\.tagName === 'INPUT' \|\|\s+active\.tagName === 'TEXTAREA' \|\|\s+active\.tagName === 'SELECT' \|\|\s+active\.isContentEditable/
    );
  });
});
