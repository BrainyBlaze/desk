import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listChannelMembers, readThread, listChannels } from './channelsStore.js';
import { parseConversation, type ChannelMessage } from './channelsProtocol.js';

/**
 * Channels export-to-markdown. Serializes a channel's conversation
 * (root + optional thread) into a clean, readable markdown transcript with
 * channel title, goal, member roster, export date, and per-message sections.
 * Strips the protocol overhead (--- separators, ### msg-* headers, END_TURN,
 * thread links) and produces a format suitable for archiving, sharing, or
 * offline reading.
 */

export function exportChannelToMarkdown(
  home: string,
  channel: string,
  threadParentId?: string
): string {
  if (threadParentId) {
    return exportThread(home, channel, threadParentId);
  }
  return exportRoot(home, channel);
}

function exportRoot(home: string, channel: string): string {
  const rootFile = join(home, channel, 'root.md');
  if (!existsSync(rootFile)) {
    throw new Error(`channel '${channel}' not found`);
  }
  const { preamble, messages } = parseConversation(readFileSync(rootFile, 'utf8'));
  const goal = extractGoal(preamble);
  const members = listChannelMembers(home, channel);
  const lines: string[] = [
    `# #${channel}`,
    ''
  ];
  if (goal) {
    lines.push(`> ${goal}`, '');
  }
  lines.push(`_Exported: ${new Date().toISOString()}_`, '');
  if (members.length > 0) {
    lines.push(
      `**Members**: ${members.map((m) => `\@${m.name} (${m.type})`).join(', ')}`,
      ''
    );
  }
  lines.push('---', '');
  for (const message of messages) {
    appendMessageSection(lines, message);
    if (message.threadFile) {
      const threadName = message.threadFile.replace(/\.md$/, '');
      const replyCount = message.threadReplies ?? 0;
      lines.push(`> 📎 _Thread: [${threadName}] — ${replyCount} replies_`, '');
    }
  }
  return lines.join('\n');
}

function exportThread(home: string, channel: string, parentId: string): string {
  const messages = readThread(home, channel, parentId);
  if (messages.length === 0) {
    throw new Error(`thread '${parentId}' not found in #${channel}`);
  }
  const lines: string[] = [
    `# Thread: ${parentId}`,
    '',
    `_In [#${channel}](root.md) — ${messages.length} replies_`,
    '',
    '---',
    ''
  ];
  for (const message of messages) {
    appendMessageSection(lines, message);
  }
  return lines.join('\n');
}

function appendMessageSection(lines: string[], message: ChannelMessage): void {
  lines.push(`## @${message.author} · ${message.timestamp}`, '');
  if (message.body.trim().length > 0) {
    lines.push(message.body.trim(), '');
  }
}

function extractGoal(preamble: string): string {
  for (const line of preamble.split('\n')) {
    if (line.startsWith('> ')) {
      return line.slice(2).trim();
    }
  }
  return '';
}
