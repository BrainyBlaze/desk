// Attachments.
//
// Bytes are a different medium from conversation, and they were the one place
// where the store's internals escaped: `channelFilePath` handed the route an
// absolute path, and the route then ran its own `existsSync`, `statSync` and
// `createReadStream` on it. That is the API doing filesystem I/O with a path it
// was lent — and a store that is not a filesystem could not satisfy it at all.
//
// The port hands back what an HTTP response actually needs, a length and a
// readable, and the path never leaves the implementation.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { channelFilePath, ensureUploadFileBucket, saveChannelFile } from './fileStore.js';

export interface ChannelAttachment {
  /** Byte length, for `content-length`. */
  size: number;
  /** The bytes. Called once per response. */
  open(): Readable;
}

export interface ChannelFiles {
  /**
   * Store bytes under a channel. Returns the name they were stored as, which
   * may differ from the one offered: implementations sanitise, and deduplicate
   * against an existing name rather than overwriting it.
   *
   * Throws on a name that cannot be stored safely.
   */
  save(channel: string, name: string, bytes: Buffer): string;

  /**
   * Locate an attachment. `undefined` means it does not exist; a name that is
   * not addressable at all (a traversal attempt, a dotfile) throws, because
   * that is a malformed request rather than a miss.
   */
  open(channel: string, name: string): ChannelAttachment | undefined;

  /**
   * Prepare a channel that exists only to carry uploads and has no
   * conversation of its own.
   */
  ensureBucket(channel: string): void;
}

/** Attachments as files under `<home>/<channel>/_files/`. */
export class FileChannelFiles implements ChannelFiles {
  constructor(private readonly home: string) {}

  save(channel: string, name: string, bytes: Buffer): string {
    return saveChannelFile(this.home, channel, name, bytes);
  }

  open(channel: string, name: string): ChannelAttachment | undefined {
    // Throws on an unaddressable name — traversal, dotfile, empty.
    const path = channelFilePath(this.home, channel, name);
    if (!existsSync(path)) {
      return undefined;
    }
    return {
      size: statSync(path).size,
      open: () => createReadStream(path)
    };
  }

  ensureBucket(channel: string): void {
    ensureUploadFileBucket(this.home, channel);
  }
}
