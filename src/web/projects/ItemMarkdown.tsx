import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/**
 * Lean GFM renderer for issue/draft bodies and comments (no katex/mermaid —
 * GitHub bodies rarely need them and the drawer must open fast). Lazy-loaded
 * so react-markdown stays out of the main bundle.
 */
export default function ItemMarkdown({ body }: { body: string }): JSX.Element {
  return (
    <div className="markdownBody projItemBody">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          )
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
