import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('channels thread panel UI', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  const subsystem = readFileSync(new URL('../src/web/channels/ChannelsSubsystem.tsx', import.meta.url), 'utf8');
  const messageList = readFileSync(new URL('../src/web/channels/MessageList.tsx', import.meta.url), 'utf8');

  it('drives the feed/thread split through useDefaultLayout so the panel-count change never throws', () => {
    // Both panels carry a stable id and the group is layout-managed — otherwise
    // a remembered 2-panel layout is applied to the 1-panel (thread-closed)
    // render and react-resizable-panels throws "Invalid 1 panel layout".
    expect(subsystem).toContain('threadSplitLayout');
    expect(subsystem).toContain('id={CHANNEL_FEED_PANEL_ID}');
    expect(subsystem).toContain('id={CHANNEL_THREAD_PANEL_ID}');
    expect(subsystem).toContain('defaultLayout={threadSplitLayout.defaultLayout}');
    expect(subsystem).toContain('onLayoutChanged={threadSplitLayout.onLayoutChanged}');
    // panelIds must be conditional on the thread being open
    expect(subsystem).toMatch(/panelIds: \[CHANNEL_FEED_PANEL_ID, \.\.\.\(threadParent \? \[CHANNEL_THREAD_PANEL_ID\]/);
  });

  it('remembers the open thread per channel and reopens it', () => {
    expect(subsystem).toContain("'desk.channelsThreadOpen'");
    expect(subsystem).toContain('rememberThreadOpen');
    expect(subsystem).toContain('forgetThreadOpen');
  });

  it('re-anchors the feed instead of jumping when the container resizes', () => {
    expect(messageList).toContain('ResizeObserver');
    expect(messageList).toContain('reflowingRef');
    expect(messageList).toMatch(/if \(reflowingRef\.current\) \{\s*return;\s*\}/);
  });

  it('reflow and programmatic scrolls are visible to the reducer, which owns read state', () => {
    expect(messageList).toContain("type: 'REFLOW'");
    expect(messageList).toContain('certifyScroll');
    expect(messageList).toContain("type: 'SCROLLED_PAST'");
    expect(messageList).not.toContain('programmaticScrollRef');
    expect(messageList).not.toContain('stickToBottomRef');
  });

  it('renders the feed in normal flow and lets native scroll anchoring absorb reflows', () => {
    const feedRule = /\.chanFeed\s*\{(?<body>[^}]*)\}/.exec(css)?.groups?.body ?? '';
    expect(feedRule).not.toContain('overflow-anchor: none');
    expect(messageList).not.toContain('useVirtualizer');
    expect(messageList).not.toContain('translateY');
    expect(messageList).toContain('chanFlowInner');
  });
});
