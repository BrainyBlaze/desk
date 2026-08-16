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
  type MessageSliceOpts,
  type MessageWindow
} from './fileStore.js';
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
  listChannels(opts?: { seen?: SeenCursors }): ChannelSummary[];
  createChannel(name: string, goal: string): void;
  destroyChannel(name: string): void;
  setGoal(name: string, goal: string): void;

  // ---- conversation -------------------------------------------------------

  /** A channel with a window of its messages — the initial view. */
  readChannel(channel: string, window?: MessageSliceOpts): ChannelDetail;
  /** A further window of messages — scroll paging. */
  readMessages(channel: string, window: MessageSliceOpts): MessageWindow;
  /** One message by id, wherever in the channel it lives (root or any thread). */
  readMessage(channel: string, id: string): ChannelMessage;
  readThread(channel: string, parentId: string): ChannelMessage[];
  search(opts: ChannelSearchOptions): ChannelSearchResult[];

  append(channel: string, options: AppendMessageOptions): Promise<AppendedMessage>;
  editMessage(channel: string, file: string, id: string, body: string): Promise<ChannelMessage>;
  deleteMessage(channel: string, file: string, id: string): Promise<void>;

  // ---- roster -------------------------------------------------------------

  listMembers(channel: string): ChannelMember[];
  addMember(channel: string, handle: string, spec: NewMemberSpec): ChannelMember;
  removeMember(channel: string, name: string): void;
  updateMemberRole(channel: string, name: string, role?: string, functions?: string): ChannelMember | undefined;
  updateMemberSupervisor(
    channel: string,
    name: string,
    supervisor: boolean,
    maxIdleMinutes?: number
  ): ChannelMember | undefined;

  // ---- annotations --------------------------------------------------------
  //
  // Reactions and stars are anchored to a message by (channel, file, id), so
  // they are channel data: an implementation that moves conversations somewhere
  // else must move these too, or half of a channel stays behind on local disk.
  // They live on THIS interface rather than a sibling one precisely so that
  // cannot be done by halves.

  listReactions(): ReactionRef[];
  addReaction(input: ReactionInput): ReactionRef;
  removeReaction(ref: Pick<ReactionRef, 'channel' | 'file' | 'id' | 'kind'>): boolean;
  clearReactions(channel: string, file: string, id: string): number;

  listFeatured(): FeaturedItem[];
  addFeatured(input: FeaturedInput): FeaturedRef;
  removeFeatured(ref: Pick<FeaturedRef, 'channel' | 'file' | 'id'>): boolean;

  // ---- change notification ------------------------------------------------

  /**
   * Every finalised message, from either door: the server appended one, or
   * something outside wrote the file directly. The CLI's offline fallback does
   * exactly that, and this is the only reason it works — a consumer should not
   * have to know which door was used, or that a watcher exists.
   */
  onFinalized(handler: (incoming: IncomingChannelMessage) => void): Unsubscribe;

  /**
   * Record that a message has already been dispatched, so the change feed does
   * not hand it over a second time. Callers mark AFTER dispatch succeeds: if
   * dispatch throws, the message stays undispatched and is picked up again.
   */
  markSeen(channel: string, file: string, id: string): void;
}

/** The filesystem store: conversations as markdown under a channels home. */
export class FileChannelStore implements ChannelStore {
  private watcher: ChannelsWatcher | undefined;
  private readonly handlers = new Set<(incoming: IncomingChannelMessage) => void>();

  constructor(private readonly home: string) {}

  listChannels(opts: { seen?: SeenCursors } = {}): ChannelSummary[] {
    const summaries = listChannels(this.home);
    return opts.seen === undefined ? summaries : resolveUnreadSummaries(this.home, summaries, opts.seen);
  }

  createChannel(name: string, goal: string): void {
    createChannel(this.home, name, goal);
  }

  destroyChannel(name: string): void {
    destroyChannel(this.home, name);
  }

  setGoal(name: string, goal: string): void {
    editChannelGoal(this.home, name, goal);
  }

  readChannel(channel: string, window?: MessageSliceOpts): ChannelDetail {
    return readChannelDetail(this.home, channel, window);
  }

  readMessages(channel: string, window: MessageSliceOpts): MessageWindow {
    return readChannelMessages(this.home, channel, window);
  }

  readMessage(channel: string, id: string): ChannelMessage {
    return readChannelMessage(this.home, channel, id);
  }

  readThread(channel: string, parentId: string): ChannelMessage[] {
    return readThread(this.home, channel, parentId);
  }

  search(opts: ChannelSearchOptions): ChannelSearchResult[] {
    return searchChannelMessages(this.home, opts);
  }

  append(channel: string, options: AppendMessageOptions): Promise<AppendedMessage> {
    return appendMessage(this.home, channel, options);
  }

  editMessage(channel: string, file: string, id: string, body: string): Promise<ChannelMessage> {
    return editMessage(this.home, channel, file, id, body);
  }

  deleteMessage(channel: string, file: string, id: string): Promise<void> {
    return deleteMessage(this.home, channel, file, id);
  }

  listMembers(channel: string): ChannelMember[] {
    return listChannelMembers(this.home, channel);
  }

  addMember(channel: string, handle: string, spec: NewMemberSpec): ChannelMember {
    return addMemberWithUniqueHandle(this.home, channel, handle, spec);
  }

  removeMember(channel: string, name: string): void {
    removeMember(this.home, channel, name);
  }

  updateMemberRole(channel: string, name: string, role?: string, functions?: string): ChannelMember | undefined {
    return updateMemberRole(this.home, channel, name, role, functions);
  }

  updateMemberSupervisor(
    channel: string,
    name: string,
    supervisor: boolean,
    maxIdleMinutes?: number
  ): ChannelMember | undefined {
    return updateMemberSupervisor(this.home, channel, name, supervisor, maxIdleMinutes);
  }

  listReactions(): ReactionRef[] {
    return listReactions(this.home);
  }

  addReaction(input: ReactionInput): ReactionRef {
    return addReaction(this.home, input);
  }

  removeReaction(ref: Pick<ReactionRef, 'channel' | 'file' | 'id' | 'kind'>): boolean {
    return removeReaction(this.home, ref);
  }

  clearReactions(channel: string, file: string, id: string): number {
    return clearReactionsForMessage(this.home, channel, file, id);
  }

  listFeatured(): FeaturedItem[] {
    return listFeaturedItems(this.home);
  }

  addFeatured(input: FeaturedInput): FeaturedRef {
    return addFeatured(this.home, input);
  }

  removeFeatured(ref: Pick<FeaturedRef, 'channel' | 'file' | 'id'>): boolean {
    return removeFeatured(this.home, ref);
  }

  onFinalized(handler: (incoming: IncomingChannelMessage) => void): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher) {
      this.watcher = new ChannelsWatcher(this.home, (incoming) => {
        for (const fn of this.handlers) {
          fn(incoming);
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

  markSeen(channel: string, file: string, id: string): void {
    // Before any subscriber exists there is no watcher to inform, and nothing
    // to dedupe against: the message has not been observed by anyone.
    this.watcher?.markSeen(channel, file, id);
  }
}
