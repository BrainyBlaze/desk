// Where the conversation lives.
//
// The port the rest of the subsystem reads a channel through: the roster, a
// message by id, and — the part that used to be assembled by hand at the API
// layer — notification that a finalised message exists.
//
// `onFinalized` belongs here rather than in the caller because "a new message
// appeared" is a property of the store, not of whoever happens to wire it.
// Messages arrive through two doors: the server appends one, or something
// outside the server writes the file directly (the CLI's offline fallback does
// exactly that, and the watcher is why it works). A consumer should not have to
// know which door was used, or that a watcher exists at all.

import {
  ChannelsWatcher,
  listChannelMembers,
  readChannelMessage,
  type IncomingChannelMessage
} from './fileStore.js';
import type { ChannelMember, ChannelMessage } from '../protocol/format.js';

export type Unsubscribe = () => void;

export interface ChannelStore {
  /** Roster of a channel. Throws when the channel is gone or its manifest is broken. */
  listMembers(channel: string): ChannelMember[];

  /** One message by id. Throws when it cannot be read. */
  readMessage(channel: string, id: string): ChannelMessage;

  /**
   * Every finalised message, from either door. Returns an unsubscribe; calling
   * it stops the underlying watch when the last subscriber leaves.
   */
  onFinalized(handler: (incoming: IncomingChannelMessage) => void): Unsubscribe;

  /**
   * Record that a message has already been dispatched, so the watcher does not
   * hand it over a second time. The append-then-dispatch path calls this after
   * dispatch succeeds — if dispatch throws, the watcher still finds the message.
   */
  markSeen(channel: string, file: string, id: string): void;
}

/** The filesystem store: conversations as markdown under a channels home. */
export class FileChannelStore implements ChannelStore {
  private watcher: ChannelsWatcher | undefined;
  private readonly handlers = new Set<(incoming: IncomingChannelMessage) => void>();

  constructor(private readonly home: string) {}

  listMembers(channel: string): ChannelMember[] {
    return listChannelMembers(this.home, channel);
  }

  readMessage(channel: string, id: string): ChannelMessage {
    return readChannelMessage(this.home, channel, id);
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
