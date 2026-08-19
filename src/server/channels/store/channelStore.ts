// Where the conversation lives.
//
// Every operation the server performs on a channel, as one contract. The size
// of this interface is not a choice: it is the set of things the HTTP surface
// and the delivery engine actually do, and anything left off would be a hole a
// replacement store silently fails to fill.
//
// Two things were deliberately kept OFF it, because they are not operations on
// a store:
//
//   - where the store lives. `resolveChannelsHome`/`ensureChannelsHome` compute
//     and prepare a filesystem path. That is how a FileChannelStore is built,
//     not something a store does, and requiring it would mean every
//     implementation has to have a home directory.
//   - saved view filters. A `{name, filter}` never references a message, a
//     channel or an author: it is operator preference, and requiring it here
//     would make anyone writing a conversation backend also implement UI
//     settings storage. See `ChannelViews`.
//   - attachments. Bytes are a different medium from conversation, and the old
//     `channelFilePath` handed a caller an absolute path to run its own
//     `createReadStream` on — a store that is not a filesystem could not
//     satisfy it at all. See `ChannelFiles`.
//
// Unread is a read PARAMETER, not an operation: `listChannels({ seen })`
// resolves it, because the caller that wants unread counts always wanted the
// summaries too, and the store is the only place that can compute them cheaply
// (the filesystem one memoises on a file fingerprint).

import {
  addMemberWithUniqueHandle,
  appendMessage,
  ChannelsWatcher,
  createChannel,
  deleteMessage,
  destroyChannel,
  editChannelGoal,
  editMessage,
  ingestMessage,
  listChannelMembers,
  listChannels,
  readChannelDetail,
  readChannelMessage,
  readChannelMessages,
  readThread,
  removeMember,
  resolveUnreadSummaries,
  searchChannelMessages,
  updateMemberRole,
  updateMemberSupervisor,
  type AppendedMessage,
  type AppendMessageOptions,
  type ChannelDetail,
  type ChannelSearchOptions,
  type ChannelSearchResult,
  type ChannelSummary,
  type IncomingChannelMessage,
  type IngestMessageInput,
  type IngestResult,
  type MessageSliceOpts,
  type MessageWindow
} from './fileStore.js';

export type { IngestMessageInput, IngestResult } from './fileStore.js';
export { IngestParentNotFoundError } from './fileStore.js';
import {
  addReaction,
  clearReactionsForMessage,
  listReactions,
  removeReaction,
  type ReactionInput,
  type ReactionRef
} from './reactions.js';
import {
  addFeatured,
  listFeaturedItems,
  removeFeatured,
  type FeaturedInput,
  type FeaturedItem,
  type FeaturedRef
} from './featured.js';
import type { ChannelMember, ChannelMessage } from '../protocol/format.js';

export type Unsubscribe = () => void;

/** Read cursor per channel: the last message id this reader has seen. */
export type SeenCursors = Record<string, string>;

export interface NewMemberSpec {
  type: string;
  sessionId?: string;
  agentLabel?: string;
}

export interface ChannelStore {
  // ---- channels -----------------------------------------------------------

  /** Summaries for every channel. With `seen`, unread counts are resolved too. */
  listChannels(opts?: { seen?: SeenCursors }): Promise<ChannelSummary[]>;
  createChannel(name: string, goal: string): Promise<void>;
  destroyChannel(name: string): Promise<void>;
  setGoal(name: string, goal: string): Promise<void>;

  // ---- conversation -------------------------------------------------------

  /** A channel with a window of its messages — the initial view. */
  readChannel(channel: string, window?: MessageSliceOpts): Promise<ChannelDetail>;
  /** A further window of messages — scroll paging. */
  readMessages(channel: string, window: MessageSliceOpts): Promise<MessageWindow>;
  /** One message by id, wherever in the channel it lives (root or any thread). */
  readMessage(channel: string, id: string): Promise<ChannelMessage>;
  readThread(channel: string, parentId: string): Promise<ChannelMessage[]>;
  search(opts: ChannelSearchOptions): Promise<ChannelSearchResult[]>;

  append(channel: string, options: AppendMessageOptions): Promise<AppendedMessage>;

  /**
   * Apply a message that already has an identity, preserving id, author and
   * timestamp verbatim. The inverse of the markdown export, and the only door
   * for material that re-enters the store: a restore, a transfer between
   * homes, a replay of externally produced blocks. Idempotent by id across
   * the whole channel; a thread reply without its parent throws
   * IngestParentNotFoundError so the caller can park and retry.
   *
   * `quiet: true` applies WITHOUT dispatching: the message is marked seen
   * before it becomes visible, so agents get no prompts — restoring a month
   * of history must not bombard terminals with a month of turn prompts (the
   * same behaviour join notices already have). Without it, the applied block
   * reaches subscribers through onFinalized like any externally written one.
   */
  ingest(channel: string, input: IngestMessageInput, opts?: { quiet?: boolean }): Promise<IngestResult>;

  editMessage(channel: string, file: string, id: string, body: string): Promise<ChannelMessage>;
  deleteMessage(channel: string, file: string, id: string): Promise<void>;

  // ---- roster -------------------------------------------------------------

  listMembers(channel: string): Promise<ChannelMember[]>;
  addMember(channel: string, handle: string, spec: NewMemberSpec): Promise<ChannelMember>;
  removeMember(channel: string, name: string): Promise<void>;
  updateMemberRole(channel: string, name: string, role?: string, functions?: string): Promise<ChannelMember | undefined>;
  updateMemberSupervisor(
    channel: string,
    name: string,
    supervisor: boolean,
    maxIdleMinutes?: number
  ): Promise<ChannelMember | undefined>;

  // ---- annotations --------------------------------------------------------
  //
  // Reactions and stars are anchored to a message by (channel, file, id), so
  // they are channel data: an implementation that moves conversations somewhere
  // else must move these too, or half of a channel stays behind on local disk.
  // They live on THIS interface rather than a sibling one precisely so that
  // cannot be done by halves.

  listReactions(): Promise<ReactionRef[]>;
  addReaction(input: ReactionInput): Promise<ReactionRef>;
  removeReaction(ref: Pick<ReactionRef, 'channel' | 'file' | 'id' | 'kind'>): Promise<boolean>;
  clearReactions(channel: string, file: string, id: string): Promise<number>;

  listFeatured(): Promise<FeaturedItem[]>;
  addFeatured(input: FeaturedInput): Promise<FeaturedRef>;
  removeFeatured(ref: Pick<FeaturedRef, 'channel' | 'file' | 'id'>): Promise<boolean>;

  // ---- change notification ------------------------------------------------

  /**
   * Every finalised message, from either door: the server appended one, or
   * something outside wrote the file directly. The CLI's offline fallback does
   * exactly that, and this is the only reason it works — a consumer should not
   * have to know which door was used, or that a watcher exists.
   */
  onFinalized(handler: (incoming: IncomingChannelMessage) => void | Promise<void>): Unsubscribe;

  /**
   * Record that a message has already been dispatched, so the change feed does
   * not hand it over a second time. Callers mark AFTER dispatch succeeds: if
   * dispatch throws or rejects, the message stays undispatched and is picked up
   * again.
   */
  markSeen(channel: string, file: string, id: string): Promise<void>;
}

/** The filesystem store: conversations as markdown under a channels home. */
export class FileChannelStore implements ChannelStore {
  private watcher: ChannelsWatcher | undefined;
  private readonly handlers = new Set<(incoming: IncomingChannelMessage) => void | Promise<void>>();

  constructor(private readonly home: string) {}

  async listChannels(opts: { seen?: SeenCursors } = {}): Promise<ChannelSummary[]> {
    const summaries = listChannels(this.home);
    return opts.seen === undefined ? summaries : resolveUnreadSummaries(this.home, summaries, opts.seen);
  }

  async createChannel(name: string, goal: string): Promise<void> {
    createChannel(this.home, name, goal);
  }

  async destroyChannel(name: string): Promise<void> {
    destroyChannel(this.home, name);
  }

  async setGoal(name: string, goal: string): Promise<void> {
    editChannelGoal(this.home, name, goal);
  }

  async readChannel(channel: string, window?: MessageSliceOpts): Promise<ChannelDetail> {
    return readChannelDetail(this.home, channel, window);
  }

  async readMessages(channel: string, window: MessageSliceOpts): Promise<MessageWindow> {
    return readChannelMessages(this.home, channel, window);
  }

  async readMessage(channel: string, id: string): Promise<ChannelMessage> {
    return readChannelMessage(this.home, channel, id);
  }

  async readThread(channel: string, parentId: string): Promise<ChannelMessage[]> {
    return readThread(this.home, channel, parentId);
  }

  async search(opts: ChannelSearchOptions): Promise<ChannelSearchResult[]> {
    return searchChannelMessages(this.home, opts);
  }

  append(channel: string, options: AppendMessageOptions): Promise<AppendedMessage> {
    return appendMessage(this.home, channel, options);
  }

  ingest(channel: string, input: IngestMessageInput, opts: { quiet?: boolean } = {}): Promise<IngestResult> {
    return ingestMessage(this.home, channel, input, {
      // Marked seen BEFORE the block is written: even an instant watcher scan
      // then skips it, so quiet is quiet without racing the change feed. A
      // phantom mark for a write that subsequently fails is harmless — the id
      // never exists. With no watcher yet, prewarm() covers it at start.
      onBeforeWrite: opts.quiet ? (file) => this.watcher?.markSeen(channel, file, input.id) : undefined
    });
  }

  editMessage(channel: string, file: string, id: string, body: string): Promise<ChannelMessage> {
    return editMessage(this.home, channel, file, id, body);
  }

  deleteMessage(channel: string, file: string, id: string): Promise<void> {
    return deleteMessage(this.home, channel, file, id);
  }

  async listMembers(channel: string): Promise<ChannelMember[]> {
    return listChannelMembers(this.home, channel);
  }

  async addMember(channel: string, handle: string, spec: NewMemberSpec): Promise<ChannelMember> {
    return addMemberWithUniqueHandle(this.home, channel, handle, spec);
  }

  async removeMember(channel: string, name: string): Promise<void> {
    removeMember(this.home, channel, name);
  }

  async updateMemberRole(channel: string, name: string, role?: string, functions?: string): Promise<ChannelMember | undefined> {
    return updateMemberRole(this.home, channel, name, role, functions);
  }

  async updateMemberSupervisor(
    channel: string,
    name: string,
    supervisor: boolean,
    maxIdleMinutes?: number
  ): Promise<ChannelMember | undefined> {
    return updateMemberSupervisor(this.home, channel, name, supervisor, maxIdleMinutes);
  }

  async listReactions(): Promise<ReactionRef[]> {
    return listReactions(this.home);
  }

  async addReaction(input: ReactionInput): Promise<ReactionRef> {
    return addReaction(this.home, input);
  }

  async removeReaction(ref: Pick<ReactionRef, 'channel' | 'file' | 'id' | 'kind'>): Promise<boolean> {
    return removeReaction(this.home, ref);
  }

  async clearReactions(channel: string, file: string, id: string): Promise<number> {
    return clearReactionsForMessage(this.home, channel, file, id);
  }

  async listFeatured(): Promise<FeaturedItem[]> {
    return listFeaturedItems(this.home);
  }

  async addFeatured(input: FeaturedInput): Promise<FeaturedRef> {
    return addFeatured(this.home, input);
  }

  async removeFeatured(ref: Pick<FeaturedRef, 'channel' | 'file' | 'id'>): Promise<boolean> {
    return removeFeatured(this.home, ref);
  }

  onFinalized(handler: (incoming: IncomingChannelMessage) => void | Promise<void>): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher) {
      this.watcher = new ChannelsWatcher(this.home, async (incoming) => {
        for (const fn of this.handlers) {
          await fn(incoming);
        }
      });
      this.watcher.start();
    }
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) {
        this.watcher?.stop();
        this.watcher = undefined;
      }
    };
  }

  async markSeen(channel: string, file: string, id: string): Promise<void> {
    // Before any subscriber exists there is no watcher to inform, and nothing
    // to dedupe against: the message has not been observed by anyone.
    this.watcher?.markSeen(channel, file, id);
  }
}
