// What an operator downloads.
//
// A channel (or one thread) as a clean markdown transcript: title, goal,
// roster, export date, one section per message, with the protocol overhead —
// block separators, `### msg-…` headers, END_TURN, thread link lines — stripped
// out. Suitable for archiving, sharing, or reading offline.
//
// This is rendering, not storage, which is why it sits beside the prompt
// renderer rather than in `store/`. It used to live there and read `root.md`
// with its own `readFileSync(join(home, channel, 'root.md'))`, so an embedder
// who moved conversations elsewhere got an export of whatever happened to be on
// local disk. It now asks the store, and works for any of them.

import type { ChannelStore } from '../store/channelStore.js';
import type { ChannelMessage } from '../protocol/format.js';

export function exportChannelToMarkdown(
  store: ChannelStore,
  channel: string,
  threadParentId?: string
): string {
  return threadParentId ? exportThread(store, channel, threadParentId) : exportRoot(store, channel);
}

function exportRoot(store: ChannelStore, channel: string): string {
  // Throws when the channel does not exist, which is what the route reports.
  const detail = store.readChannel(channel, { limit: 0 });
  const { messages } = store.readMessages(channel, { limit: Number.MAX_SAFE_INTEGER });
  const lines: string[] = [`# #${channel}`, ''];
  if (detail.goal) {
    lines.push(`> ${detail.goal}`, '');
  }
  lines.push(`_Exported: ${new Date().toISOString()}_`, '');
  if (detail.members.length > 0) {
    lines.push(`**Members**: ${detail.members.map((m) => `\\@${m.name} (${m.type})`).join(', ')}`, '');
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

function exportThread(store: ChannelStore, channel: string, parentId: string): string {
  const messages = store.readThread(channel, parentId);
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
