// The extension point, exercised.
//
// A plugin declares `channels` providers; each receives the implementation Desk
// would otherwise use and returns the one to use instead. These tests prove the
// three properties that make that useful: a provider is actually consulted,
// several compose in plugin order, and a provider that returns its argument
// changes nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelsEngine } from '../src/server/channels/delivery/engine.js';
import { createChannel } from '../src/server/channels/store/fileStore.js';
import {
  agentDelivery,
  defaultPromptRenderer,
  FileChannelFiles,
  FileChannelStore,
  FileChannelViews,
  MentionRouter,
  type AgentDelivery,
  type ChannelFiles,
  type ChannelStore,
  type ChannelViews,
  type MessageRouter,
  type PromptRenderer,
  type Recipient
} from '../src/server/channels/ports.js';
import type { ChannelsProviders } from '../src/server/plugin.js';
import { canonicalAgentStateBatch } from './helpers/canonicalAgentState.js';
import type { ChannelMember, ChannelMessage } from '../src/server/channels/protocol/format.js';
import type { SavedView } from '../src/server/channels/store/views.js';

/** The same lazy composition the Channels runtime performs over plugin providers. */
function compose<T>(
  make: () => T,
  providers: ChannelsProviders[],
  pick: (p: ChannelsProviders) => ((base: () => T) => T) | undefined
): T {
  let built: { value: T } | undefined;
  let current: () => T = () => (built ??= { value: make() }).value;
  for (const provider of providers) {
    const wrap = pick(provider);
    if (!wrap) continue;
    const inner = current;
    let made: { value: T } | undefined;
    current = () => (made ??= { value: wrap(inner) }).value;
  }
  return current();
}

const members: ChannelMember[] = [
  { name: 'alpha', type: 'claude-code', status: 'active', joined: '', sessionId: 'alpha-1' },
  { name: 'beta', type: 'claude-code', status: 'active', joined: '', sessionId: 'beta-1' }
];

function message(body: string, author = 'human'): ChannelMessage {
  return { id: 'msg-20260816-120000-abcd', author, timestamp: '2026-08-16 12:00:00', body, hasEndTurn: true };
}

describe('Channels plugin providers', () => {
  let home: string;
  let sent: Array<{ session: string; text: string }>;
  let engines: ChannelsEngine[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-chan-providers-'));
    sent = [];
    engines = [];
    createChannel(home, 'ops', 'goal');
  });

  afterEach(() => {
    for (const engine of engines) engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const baseDelivery = (): AgentDelivery =>
    agentDelivery({
      sendText: async (session, text) => {
        sent.push({ session, text });
        return true;
      },
      capturePane: async () => 'ready',
      sendEnter: async () => true,
      readAgentStates: async () => canonicalAgentStateBatch(['alpha-1', 'beta-1'])
    });

  function engineWith(providers: ChannelsProviders[]): ChannelsEngine {
    const engine = new ChannelsEngine({
      home,
      sendText: async () => true,
      capturePane: async () => 'ready',
      sendEnter: async () => true,
      releaseSettleMs: 0,
      pumpIntervalMs: 60_000,
      delivery: compose<AgentDelivery>(baseDelivery, providers, (p) => p.delivery),
      router: compose<MessageRouter>(() => new MentionRouter(), providers, (p) => p.router),
      renderer: compose<PromptRenderer>(() => defaultPromptRenderer, providers, (p) => p.renderer)
    });
    engines.push(engine);
    return engine;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

  it('consults a delivery provider for every send', async () => {
    const seen: string[] = [];
    const engine = engineWith([
      {
        delivery: (base) => ({
          ...base(),
          send: (sessionId, text) => {
            seen.push(sessionId);
            return base().send(sessionId, text);
          }
        })
      }
    ]);
    await engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('@alpha go') }, members);
    await flush();
    expect(seen).toEqual(['alpha-1']);
    expect(sent).toHaveLength(1);
  });

  it('composes several providers in plugin order, each wrapping the previous', async () => {
    const order: string[] = [];
    const tag = (name: string): ChannelsProviders => ({
      delivery: (base) => ({
        ...base(),
        send: (sessionId, text) => {
          order.push(name);
          return base().send(sessionId, text);
        }
      })
    });
    const engine = engineWith([tag('first'), tag('second')]);
    await engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('@alpha go') }, members);
    await flush();
    // The last provider wraps the outside, so it runs first and delegates inward.
    expect(order).toEqual(['second', 'first']);
  });

  it('lets a router provider redirect a message the stock router would not', async () => {
    const engine = engineWith([
      {
        router: (base) => ({
          route: (input) => {
            const decision = base().route(input);
            const beta = input.members.filter((m): m is Recipient => m.name === 'beta' && Boolean(m.sessionId));
            return { ...decision, recipients: beta };
          }
        })
      }
    ]);
    await engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('@alpha go') }, members);
    await flush();
    expect(sent.map((entry) => entry.session)).toEqual(['beta-1']);
  });

  it('lets a renderer provider change what the agent sees', async () => {
    const engine = engineWith([
      {
        renderer: (base) => ({ ...base(), turn: (options) => `PREFIX\n${base().turn(options)}` })
      }
    ]);
    await engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('@alpha go') }, members);
    await flush();
    expect(sent[0]?.text.startsWith('PREFIX\n')).toBe(true);
  });

  it('is a no-op when a provider returns its argument', async () => {
    const engine = engineWith([{ delivery: (base) => base(), router: (base) => base(), renderer: (base) => base() }]);
    await engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('@alpha go') }, members);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.session).toBe('alpha-1');
    expect(sent[0]?.text).toContain('desk channels read ops');
  });

  it('lets a files provider serve an attachment the filesystem does not hold', () => {
    const base = new FileChannelFiles(home);
    const files = compose<ChannelFiles>(
      () => base,
      [
        {
          files: (inner) => ({
            ...inner(),
            open: (channel, name) =>
              name === 'virtual.txt'
                ? { size: 5, open: () => Readable.from(['hello']) }
                : inner().open(channel, name)
          })
        }
      ],
      (p) => p.files
    );
    // Served by the provider: nothing was ever written to disk under this name.
    expect(files.open('ops', 'virtual.txt')?.size).toBe(5);
    // Anything else still falls through to the stock implementation.
    expect(files.open('ops', 'absent.txt')).toBeUndefined();
  });

  it('carries reactions and stars with the store, so a replacement cannot leave half behind', async () => {
    const kept: string[] = [];
    const store = compose<ChannelStore>(
      () => new FileChannelStore(home),
      [
        {
          store: (base) => ({
            ...base(),
            addReaction: (input) => {
              kept.push(`${input.channel}/${input.id}:${input.kind}`);
              return base().addReaction(input);
            },
            // Answered entirely by the provider: nothing is read from disk.
            listReactions: async () => []
          })
        }
      ],
      (p) => p.store
    );
    await store.addReaction({ channel: 'ops', file: 'root.md', id: 'msg-20260816-120000-abcd', kind: 'ack' });
    expect(kept).toEqual(['ops/msg-20260816-120000-abcd:ack']);
    expect(await store.listReactions()).toEqual([]);
  });

  it('lets a views provider hold saved filters somewhere the store knows nothing about', () => {
    const held: SavedView[] = [];
    const views = compose<ChannelViews>(
      () => new FileChannelViews(home),
      [
        {
          views: () => ({
            list: () => held,
            add: (input) => {
              const view = { name: input.name, filter: input.filter, created: '2026-08-16 12:00:00' };
              held.push(view);
              return view;
            },
            remove: () => false
          })
        }
      ],
      (p) => p.views
    );
    views.add({ name: 'mine', filter: { mentionsMe: true } });
    expect(views.list().map((v) => v.name)).toEqual(['mine']);
    // The stock store never saw it.
    expect(new FileChannelViews(home).list()).toEqual([]);
  });

  it('never builds the stock store when a provider replaces it outright', async () => {
    let stockBuilt = 0;
    const replacement = {
      listMembers: async () => members,
      readMessage: async () => message('parent')
    } as unknown as ChannelStore;

    const store = compose<ChannelStore>(
      () => {
        stockBuilt += 1;
        return new FileChannelStore(home);
      },
      [{ store: () => replacement }],
      (p) => p.store
    );

    // The factory was never called: a store that lives elsewhere does not get a
    // filesystem one constructed underneath it first.
    expect(stockBuilt).toBe(0);
    expect(await store.listMembers('ops')).toEqual(members);
  });

  it('builds the stock store exactly once when a provider wraps it', async () => {
    let stockBuilt = 0;
    const store = compose<ChannelStore>(
      () => {
        stockBuilt += 1;
        return new FileChannelStore(home);
      },
      [
        // Two calls to base() inside one wrapper, plus a second wrapper: the
        // factory is memoised, so all of them see the same instance.
        { store: (base) => ({ ...base(), listMembers: (channel) => base().listMembers(channel) }) },
        { store: (base) => base() }
      ],
      (p) => p.store
    );
    await store.listMembers('ops');
    expect(stockBuilt).toBe(1);
  });

  it('accepts a store provider without the engine noticing which store it got', async () => {
    let asked = 0;
    const engine = engineWith([]);
    const wrapped: ChannelsProviders = {
      store: (base) => ({
        ...base(),
        listMembers: (channel) => {
          asked += 1;
          return base().listMembers(channel);
        }
      })
    };
    const store = compose<ChannelStore>(
      () => (engine as unknown as { store: ChannelStore }).store,
      [wrapped],
      (p) => p.store
    );
    expect(await store.listMembers('ops')).toEqual(expect.any(Array));
    expect(asked).toBe(1);
  });
});
