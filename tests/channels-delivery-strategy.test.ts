import { describe, expect, it, vi } from 'vitest';
import type { SessionProbe, SessionProbeSnapshot } from '../src/server/channelsProbe.js';
import {
  NativePromptDeliveryStrategy,
  NotificationDeliveryStrategy,
  PromptDeliveryStrategy
} from '../src/server/channelsDeliveryStrategy.js';

function snapshot(
  paneState: SessionProbeSnapshot['paneState'],
  blockedReason?: SessionProbeSnapshot['blockedReason']
): SessionProbeSnapshot {
  return {
    tmuxSession: 'tmux-a',
    source: 'drain',
    observedAt: '2026-07-10T00:00:00.000Z',
    paneState,
    ready: paneState === 'ready',
    working: paneState === 'working',
    blockedReason,
    footerRegion: '',
    footerHash: 'hash',
    tailPreview: ''
  };
}

function probeReturning(value: SessionProbeSnapshot): SessionProbe {
  return {
    probe: vi.fn(async () => value),
    clear: vi.fn()
  };
}

describe('PromptDeliveryStrategy', () => {
  it('permits only a fresh ready-pane snapshot', async () => {
    const probe = probeReturning(snapshot('ready'));

    const decision = await new PromptDeliveryStrategy(probe).decide('tmux-a');

    expect(decision).toEqual({ deliver: true, snapshot: snapshot('ready') });
    expect(probe.probe).toHaveBeenCalledWith('tmux-a', { source: 'drain', forceFresh: true });
  });

  it.each([
    ['working', undefined, 'busy'],
    ['blocked', 'approval', 'approval'],
    ['blocked', 'input-requested', 'input-requested'],
    ['blocked', 'trust-menu', 'trust-menu'],
    ['blocked', 'selection-menu', 'selection-menu'],
    ['blocked', 'unknown-menu', 'unknown-menu'],
    ['blocked', 'unrecognized-shape', 'not-ready'],
    ['booting', undefined, 'booting'],
    ['empty-capture', undefined, 'empty-capture'],
    ['offline', undefined, 'offline'],
    ['unobservable', 'capture-failed', 'capture-failed']
  ] as const)('holds %s panes with %s', async (paneState, blockedReason, reason) => {
    const value = snapshot(paneState, blockedReason);

    const decision = await new PromptDeliveryStrategy(probeReturning(value)).decide('tmux-a');

    expect(decision).toEqual({ deliver: false, reason, snapshot: value });
  });
});

describe('NotificationDeliveryStrategy', () => {
  it('permits notification-only delivery without consulting pane state', async () => {
    await expect(new NotificationDeliveryStrategy().decide('tmux-a')).resolves.toEqual({ deliver: true });
  });
});

describe('NativePromptDeliveryStrategy', () => {
  it('delivers when the native broker reports idle', async () => {
    const state = vi.fn(async () => 'ready' as const);
    await expect(new NativePromptDeliveryStrategy(state).decide('native-a')).resolves.toEqual({ deliver: true });
    expect(state).toHaveBeenCalledWith('native-a');
  });

  it.each([
    ['busy', 'busy'],
    ['booting', 'booting'],
    ['approval', 'approval'],
    ['offline', 'offline']
  ] as const)('holds native %s sessions as %s', async (state, reason) => {
    await expect(new NativePromptDeliveryStrategy(() => state).decide('native-a')).resolves.toEqual({ deliver: false, reason });
  });
});
