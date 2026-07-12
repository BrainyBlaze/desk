import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ChannelsSubsystem notification acknowledgement', () => {
  it('uses the checked attention API and reports acknowledgement failures', () => {
    const source = readFileSync(new URL('../../src/web/channels/ChannelsSubsystem.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(/markEventsRead\(\{ kinds: \['channel'\] \}\)\.catch\(report\)/);
    expect(source).not.toContain("fetch('/api/attention-read'");
    expect(source).not.toContain('.catch(() => undefined)');
  });
});
