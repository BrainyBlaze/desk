import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendMessage,
  listChannels,
  readChannelDetail,
  readChannelMessage,
  readThread,
  resolveChannelsHome
} from '../server/channelsStore.js';
import { parseConversation, type ChannelMessage } from '../server/channelsProtocol.js';

/**
 * `desk channels …` — the protocol CLI agents use from inside their sessions.
 *
 *   desk channels list
 *   desk channels read <channel> [<parent-msg-id>|--message <msg-id>]
 *   desk channels post <channel> [--thread <parent-msg-id>] [--as <member>] "<body>"
 *
 * Posts go through the desk server (DESK_API, default http://127.0.0.1:5173)
 * so dispatch is immediate; when the server is unreachable the CLI appends to
 * the channel file directly and the server's watcher dispatches on its next
 * scan. Identity comes from the surrounding tmux session — the server maps it
 * to the channel member it backs — with `--as` as the explicit override.
 */

const HELP = `desk channels — slack-like messaging between desk agents

  desk channels list                                     List channels
  desk channels read <channel> [<parent-msg-id>]         Read a channel (or one thread)
  desk channels read <channel> --message <msg-id>        Read one message
  desk channels post <channel> [--thread <id>] [--as <member>] "<body>"
                                                         Post a message

Mention members with @name, everyone with @channel, the operator with @human.`;

function apiBase(): string {
  return (process.env.DESK_API ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
}

/**
 * The tmux session this CLI runs inside (empty outside tmux). Resolved via
 * TMUX_PANE: a bare `display-message` resolves "current" from the most
 * recently used *client*, which can be a different session entirely when the
 * operator is attached elsewhere — the pane id is the only honest anchor.
 */
export function currentTmuxSession(): string {
  if (!process.env.TMUX && !process.env.TMUX_PANE) {
    return '';
  }
  const args = process.env.TMUX_PANE
    ? ['display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}']
    : ['display-message', '-p', '#{session_name}'];
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function apiPost(path: string, payload: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `request failed ${response.status}`);
  }
  return body;
}

function printMessages(messages: ChannelMessage[]): void {
  for (const message of messages) {
    console.log(`### ${message.id}`);
    console.log(`@${message.author} · ${message.timestamp}`);
    if (message.threadFile) {
      console.log(`(thread: ${message.threadFile}, ${message.threadReplies ?? 0} replies)`);
    }
    console.log('');
    console.log(message.body);
    console.log('');
  }
}

export async function runChannelsCli(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift() ?? 'help';

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(HELP);
      return 0;
    }

    const home = resolveChannelsHome();

    if (command === 'list') {
      for (const channel of listChannels(home)) {
        const agents = channel.members.filter((member) => member.type !== 'human').length;
        console.log(`#${channel.name}\t${channel.messageCount} messages, ${agents} agents\t${channel.goal}`);
      }
      return 0;
    }

    if (command === 'read') {
      const channel = args.shift();
      if (!channel) {
        throw new Error('usage: desk channels read <channel> [<parent-msg-id>|--message <msg-id>]');
      }
      let parent: string | undefined;
      let messageId: string | undefined;
      let expectsMessageId = false;
      while (args.length > 0) {
        const next = args.shift() as string;
        if (next === '--message') {
          expectsMessageId = true;
          messageId = args.shift();
          if (!messageId) {
            throw new Error('usage: desk channels read <channel> --message <msg-id>');
          }
        } else if (!parent) {
          parent = next;
        } else {
          throw new Error('usage: desk channels read <channel> [<parent-msg-id>|--message <msg-id>]');
        }
      }
      if (expectsMessageId && parent) {
        throw new Error('usage: desk channels read <channel> [<parent-msg-id>|--message <msg-id>]');
      }
      if (messageId) {
        printMessages([readChannelMessage(home, channel, messageId)]);
      } else if (parent) {
        printMessages(readThread(home, channel, parent));
      } else {
        const detail = readChannelDetail(home, channel);
        console.log(`#${detail.name} — ${detail.goal}`);
        console.log(`members: ${detail.members.map((member) => `@${member.name}`).join(' ')}`);
        console.log('');
        printMessages(detail.messages);
      }
      return 0;
    }

    if (command === 'post') {
      const channel = args.shift();
      let thread: string | undefined;
      let as: string | undefined;
      const bodyParts: string[] = [];
      while (args.length > 0) {
        const next = args.shift() as string;
        if (next === '--thread') {
          thread = args.shift();
        } else if (next === '--as') {
          as = args.shift();
        } else {
          bodyParts.push(next);
        }
      }
      const body = bodyParts.join(' ').trim();
      if (!channel || body.length === 0) {
        throw new Error('usage: desk channels post <channel> [--thread <id>] [--as <member>] "<body>"');
      }

      const tmux = currentTmuxSession();
      try {
        const result = await apiPost('/api/channels/post', {
          channel,
          body,
          thread,
          as,
          tmux: tmux || undefined
        });
        console.log(String(result.id ?? 'posted'));
        return 0;
      } catch (error) {
        if (error instanceof Error && /not a member|cannot be empty|invalid|not found/.test(error.message)) {
          throw error; // protocol error — do not retry as a blind file append
        }
        // Server unreachable: append directly; the watcher dispatches later.
        const author = as ?? resolveAuthorOffline(home, channel, tmux);
        const appended = await appendMessage(home, channel, { author, body, threadParentId: thread });
        console.log(appended.message.id);
        return 0;
      }
    }

    throw new Error(`unknown channels command: ${command} (try: desk channels help)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function resolveAuthorOffline(home: string, channel: string, tmux: string): string {
  if (tmux) {
    const membersDir = join(home, channel, '_members');
    if (existsSync(membersDir)) {
      try {
        const detail = readChannelDetail(home, channel);
        const member = detail.members.find((candidate) => candidate.tmuxSession === tmux);
        if (member) {
          return member.name;
        }
      } catch {
        // fall through to human
      }
    }
  }
  return 'human';
}

/** Used by tests to confirm protocol round-trips through the CLI fallback path. */
export function readRawConversation(home: string, channel: string, file = 'root.md'): ChannelMessage[] {
  return parseConversation(readFileSync(join(home, channel, file), 'utf8')).messages;
}
