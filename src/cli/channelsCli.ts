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
import { assertAllowedOption, requireOptionValue } from './args.js';

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
  desk channels edit <channel> --message <id> [--thread <id>] [--as <member>] "<body>"
                                                         Edit a message in place

Mention members with @name, everyone with @channel, the operator with @human.`;

const CHANNEL_COMMAND_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['help', new Set()],
  ['--help', new Set()],
  ['-h', new Set()],
  ['list', new Set()],
  ['read', new Set(['--message'])],
  ['post', new Set(['--thread', '--as'])],
  ['edit', new Set(['--message', '--thread', '--as'])]
]);

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

/** The desk server could not be reached at all — the request never left, so a
 *  local file-append fallback is safe (it can't duplicate a server-side post). */
class ServerUnreachableError extends Error {}

async function apiPost(path: string, payload: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    // A TIMEOUT means the request WAS sent — the server may have processed it —
    // so falling back to a local append would duplicate the message. Only a
    // genuine connection failure (server not running) is safe to fall back on.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('desk server did not respond within 5s; the message may or may not have posted — check the channel before retrying');
    }
    throw new ServerUnreachableError('desk server unreachable');
  }
  // Text-first parse: a reachable-but-misbehaving server (a proxy 502 HTML page,
  // an empty body) must surface its real status, not a SyntaxError misread as
  // "unreachable".
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
  }
  if (!response.ok) {
    throw new Error(body && typeof body.error === 'string' ? body.error : `request failed ${response.status}`);
  }
  return body ?? {};
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
      assertNoArguments(command, args);
      console.log(HELP);
      return 0;
    }

    const home = resolveChannelsHome();

    if (command === 'list') {
      assertNoArguments(command, args);
      for (const channel of listChannels(home)) {
        const agents = channel.members.filter((member) => member.type !== 'human').length;
        console.log(`#${channel.name}\t${channel.messageCount} messages, ${agents} agents\t${channel.goal}`);
      }
      return 0;
    }

    if (command === 'read') {
      const channel = args.shift();
      if (channel?.startsWith('-')) {
        assertChannelOption(command, channel);
      }
      if (!channel || channel.startsWith('-')) {
        throw new Error('usage: desk channels read <channel> [<parent-msg-id>|--message <msg-id>]');
      }
      let parent: string | undefined;
      let messageId: string | undefined;
      let expectsMessageId = false;
      while (args.length > 0) {
        const next = args.shift() as string;
        if (next.startsWith('-')) {
          assertChannelOption(command, next);
        }
        if (next === '--message') {
          expectsMessageId = true;
          messageId = requireOptionValue(next, args.shift());
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
      if (channel?.startsWith('-')) {
        assertChannelOption(command, channel);
      }
      if (!channel || channel.startsWith('-')) {
        throw new Error('usage: desk channels post <channel> [--thread <id>] [--as <member>] "<body>"');
      }
      let thread: string | undefined;
      let as: string | undefined;
      const bodyParts: string[] = [];
      while (args.length > 0) {
        const next = args.shift() as string;
        if (next.startsWith('-')) {
          assertChannelOption(command, next);
        }
        if (next === '--thread') {
          thread = requireOptionValue(next, args.shift());
        } else if (next === '--as') {
          as = requireOptionValue(next, args.shift());
        } else {
          bodyParts.push(next);
        }
      }
      const body = bodyParts.join(' ').trim();
      if (body.length === 0) {
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
        // Only a genuine connection failure is safe to fall back on. A protocol
        // error (server rejected), a timeout (may have posted), or a non-JSON
        // response must NOT trigger a blind local append — that duplicated the
        // message. The old regex on the error text misclassified all three.
        if (!(error instanceof ServerUnreachableError)) {
          throw error;
        }
        // Server unreachable: append directly; the watcher dispatches later.
        const author = as ?? resolveAuthorOffline(home, channel, tmux);
        if (!readChannelDetail(home, channel).members.some((member) => member.name === author)) {
          throw new Error(`@${author} is not a member of #${channel}`);
        }
        const appended = await appendMessage(home, channel, { author, body, threadParentId: thread });
        console.log(appended.message.id);
        return 0;
      }
    }

    if (command === 'edit') {
      const channel = args.shift();
      if (channel?.startsWith('-')) {
        assertChannelOption(command, channel);
      }
      if (!channel || channel.startsWith('-')) {
        throw new Error('usage: desk channels edit <channel> --message <id> [--thread <id>] [--as <member>] "<body>"');
      }
      let messageId: string | undefined;
      let thread: string | undefined;
      let as: string | undefined;
      const bodyParts: string[] = [];
      while (args.length > 0) {
        const next = args.shift() as string;
        if (next.startsWith('-')) {
          assertChannelOption(command, next);
        }
        if (next === '--message') {
          messageId = requireOptionValue(next, args.shift());
        } else if (next === '--thread') {
          thread = requireOptionValue(next, args.shift());
        } else if (next === '--as') {
          as = requireOptionValue(next, args.shift());
        } else {
          bodyParts.push(next);
        }
      }
      if (!messageId) {
        throw new Error('desk channels edit requires --message <id>');
      }
      const body = bodyParts.join(' ').trim();
      if (body.length === 0) {
        throw new Error('desk channels edit requires a new body');
      }
      // --as is display-only for CLI edit today (server rewrites body without
      // author checks), kept in the option grammar so tools like the supervisor
      // prompt can pass it uniformly with `post`.
      void as;
      try {
        const result = await apiPost('/api/channels/message-edit', {
          channel,
          id: messageId,
          thread,
          body
        });
        console.log(String((result?.message as { id?: string })?.id ?? messageId));
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    throw new Error(`unknown channels command: ${command} (try: desk channels help)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function assertChannelOption(command: string, option: string): void {
  const allowedOptions = CHANNEL_COMMAND_OPTIONS.get(command);
  if (allowedOptions) {
    assertAllowedOption(`desk channels ${command}`, option, allowedOptions);
  }
}

function assertNoArguments(command: string, args: string[]): void {
  const unexpected = args.shift();
  if (!unexpected) {
    return;
  }
  if (unexpected.startsWith('-')) {
    assertChannelOption(command, unexpected);
  }
  throw new Error(`unexpected argument ${unexpected} for desk channels ${command}`);
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
