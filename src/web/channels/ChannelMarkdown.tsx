import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { channelFileUrl } from './channelsClient.js';

/**
 * react-markdown's default urlTransform strips protocols it doesn't know —
 * including our mention:// scheme — which used to demote mention chips into
 * external links. Keep our schemes, keep web/mail links, drop active content.
 */
function channelUrlTransform(url: string): string {
  if (/^(mention:\/\/|_files\/|\/|~|file:\/\/|https?:\/\/|mailto:)/i.test(url)) {
    return url;
  }
  // Relative links without a scheme are harmless; anything else (javascript:,
  // data:, vbscript:) is dropped.
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? '' : url;
}

/**
 * Markdown renderer for channel messages. Link flavours on top of GFM + code
 * highlight:
 *  - mention://<handle>   → mention chip; clicking an agent's handle jumps to
 *    its terminal in the agents subsystem
 *  - _files/<name>        → channel upload, served by the desk server
 *  - absolute / ~ paths   → open in the editor subsystem
 */
function parseFileTarget(target: string): { path: string; reveal?: { line: number; column: number } } {
  const raw = target.startsWith('file://') ? target.slice('file://'.length) : target;
  const hash = /#L(\d+)(?:C(\d+))?$/i.exec(raw);
  if (hash) {
    return { path: raw.slice(0, hash.index), reveal: { line: Number(hash[1]), column: hash[2] ? Number(hash[2]) : 1 } };
  }
  const colon = /:(\d+)(?::(\d+))?$/.exec(raw);
  if (colon) {
    return { path: raw.slice(0, colon.index), reveal: { line: Number(colon[1]), column: colon[2] ? Number(colon[2]) : 1 } };
  }
  return { path: raw };
}

function ChannelMarkdown({
  body,
  channel,
  onOpenFile,
  onMentionClick
}: {
  body: string;
  channel: string;
  onOpenFile: (path: string, reveal?: { line: number; column: number }) => void;
  /** navigate to the member behind a mention chip (agent handles only) */
  onMentionClick?: (handle: string) => void;
}): JSX.Element {
  return (
    <div className="markdownBody chanMessageBody">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={channelUrlTransform}
        components={{
          a: ({ href, children }) => {
            const target = href ?? '';
            if (target.startsWith('mention://')) {
              const handle = target.slice('mention://'.length);
              const broad = handle === 'human' || handle === 'channel';
              if (broad || !onMentionClick) {
                return <span className={`chanMention ${broad ? 'broad' : ''}`}>{children}</span>;
              }
              return (
                <button
                  type="button"
                  className="chanMention clickable"
                  title={`Open @${handle}'s terminal`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onMentionClick(handle);
                  }}
                >
                  {children}
                </button>
              );
            }
            if (target.startsWith('_files/')) {
              return (
                <a href={channelFileUrl(channel, target.slice('_files/'.length))} target="_blank" rel="noreferrer noopener" className="chanFileLink">
                  {children}
                </a>
              );
            }
            if (target.startsWith('/') || target.startsWith('~') || target.startsWith('file://')) {
              const { path, reveal } = parseFileTarget(target);
              return (
                <button type="button" className="chanPathLink" title={`Open ${path} in the editor`} onClick={() => onOpenFile(path, reveal)}>
                  {children}
                </button>
              );
            }
            return (
              <a href={target} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          }
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Memoized: the message feed re-renders on every poll and on scroll, but a
 * message body is immutable — re-parsing its markdown each time is wasted work
 * in the message feed. React.memo skips the re-parse when body / channel / handlers are
 * unchanged.
 */
export default memo(ChannelMarkdown);
