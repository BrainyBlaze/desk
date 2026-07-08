import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChannelDeliverySender } from '../src/server/channelsApi.js';
import { claimDelivering, revertAllDeliveringToJson } from '../src/server/channelsDurability.js';
import { ChannelsEngine } from '../src/server/channelsEngine.js';
import type { ChannelMember, ChannelMessage } from '../src/server/channelsProtocol.js';

const READY_PANE = 'ready prompt';

function member(name: string, tmuxSession: string): ChannelMember {
  return { name, type: 'codex', tmuxSession };
}

function message(id: string, author: string, body: string): ChannelMessage {
  return {
    id,
    author,
    body,
    createdAt: '2026-07-05T00:00:00.000Z',
    reactions: []
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    if (predicate()) {
      return;
    }
    await flush();
  }
  throw new Error('condition not met');
}

describe('native-mode channel delivery', () => {
  it('routes a queued delivery by the current uiMode at send time', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-native-channel-'));
    let uiMode: 'terminal' | 'native' = 'terminal';
    const terminalSent: Array<{ session: string; text: string }> = [];
    const nativeSent: Array<{ session: string; text: string; source: string }> = [];
    const sendText = createChannelDeliverySender({
      lookupSession: (tmuxSession) => ({ tmuxSession, uiMode }),
      terminalSender: async (session, text) => {
        terminalSent.push({ session, text });
        return true;
      },
      agentSurfaceBroker: {
        injectUserMessage: async (session, text, source) => {
          nativeSent.push({ session, text, source });
        }
      }
    });
    const engine = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      sendText,
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => READY_PANE
    });

    engine.pauseSession('tmux-a', 'hold before delivery');
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-native-1', 'human', '@alpha hi') }, [member('alpha', 'tmux-a')]);
    await flush();
    expect(terminalSent).toEqual([]);
    expect(nativeSent).toEqual([]);

    uiMode = 'native';
    engine.resumeSession('tmux-a');
    await waitFor(() => nativeSent.length === 1);

    expect(terminalSent).toEqual([]);
    expect(nativeSent[0]).toMatchObject({ session: 'tmux-a', source: 'channel' });
    expect(nativeSent[0].text).toContain('notificationId:msg-native-1');
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('routes back to terminal send-keys when uiMode switches back before delivery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-terminal-channel-'));
    let uiMode: 'terminal' | 'native' = 'native';
    const terminalSent: Array<{ session: string; text: string }> = [];
    const nativeSent: Array<{ session: string; text: string; source: string }> = [];
    const sendText = createChannelDeliverySender({
      lookupSession: (tmuxSession) => ({ tmuxSession, uiMode }),
      terminalSender: async (session, text) => {
        terminalSent.push({ session, text });
        return true;
      },
      agentSurfaceBroker: {
        injectUserMessage: async (session, text, source) => {
          nativeSent.push({ session, text, source });
        }
      }
    });
    const engine = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      sendText,
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => READY_PANE
    });

    engine.pauseSession('tmux-a', 'hold before delivery');
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-terminal-1', 'human', '@alpha hi') }, [member('alpha', 'tmux-a')]);
    await flush();

    uiMode = 'terminal';
    engine.resumeSession('tmux-a');
    await waitFor(() => terminalSent.length === 1);

    expect(nativeSent).toEqual([]);
    expect(terminalSent[0]).toMatchObject({ session: 'tmux-a' });
    expect(terminalSent[0].text).toContain('notificationId:msg-terminal-1');
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns false instead of throwing when a native session has no broker', async () => {
    const logs: string[] = [];
    const sendText = createChannelDeliverySender({
      lookupSession: (tmuxSession) => ({ tmuxSession, uiMode: 'native' }),
      terminalSender: async () => {
        throw new Error('terminal sender should not be used');
      },
      log: (message) => logs.push(message)
    });

    await expect(sendText('tmux-a', 'hello')).resolves.toBe(false);
    expect(logs.join('\n')).toContain('no agent surface broker');
  });

  it('parks non-retryable native failures and reverts the delivering queue item', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-native-fatal-'));
    let engine!: ChannelsEngine;
    const sendText = createChannelDeliverySender({
      lookupSession: (tmuxSession) => ({ tmuxSession, uiMode: 'native' }),
      agentSurfaceBroker: {
        injectUserMessage: async () => {
          throw Object.assign(new Error('session deleted'), { code: 'not-native-session', retryable: false });
        }
      },
      terminalSender: async () => {
        throw new Error('terminal sender should not be used');
      },
      log: () => undefined,
      onNonRetryableNativeFailure: (tmuxSession, error) => {
        engine.pauseSession(tmuxSession, `native channel delivery failed (${error.code}): ${error.message}`);
      }
    });
    engine = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      sendText: async (session, text) => {
        const ok = await sendText(session, text);
        if (!ok) {
          revertAllDeliveringToJson(home, session);
        }
        return ok;
      },
      onSubmitStateChange: (session, state, context) => {
        if (state === 'delivering') {
          claimDelivering(home, session, context.seq);
        }
      },
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => READY_PANE
    });

    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-fatal-1', 'human', '@alpha hi') }, [member('alpha', 'tmux-a')]);
    await waitFor(() => engine.lifecycleStates().some((state) => state.tmuxSession === 'tmux-a' && state.pausedByOperator));

    expect(readdirSync(join(home, '_engine', 'queue', 'tmux-a'))).toEqual(['0000000001.json']);
    expect(engine.lifecycleStates().find((state) => state.tmuxSession === 'tmux-a')).toMatchObject({
      pausedByOperator: true,
      pauseReason: 'native channel delivery failed (not-native-session): session deleted'
    });
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });
});
