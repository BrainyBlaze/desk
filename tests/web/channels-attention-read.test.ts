import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ChannelsSubsystem notification acknowledgement', () => {
  it('uses the checked attention API and reports acknowledgement failures', () => {
    const source = readFileSync(new URL('../../src/web/channels/ChannelsSubsystem.tsx', import.meta.url), 'utf8');

    // 'channel-message' is the unified feed's kind for a channel notification;
    // the old 'channel' kind belonged to the attention store that is gone.
    expect(source).toMatch(/markEventsRead\(\{ kinds: \['channel-message'\] \}\)\.catch\(report\)/);
    expect(source).not.toContain("fetch('/api/attention-read'");
    expect(source).not.toContain('.catch(() => undefined)');
  });
});
