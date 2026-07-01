import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import type { editor } from 'monaco-editor';
import 'katex/dist/katex.min.css';

export interface MarkdownViewProps {
  /** live Monaco model — the preview tracks unsaved edits */
  model: editor.ITextModel;
  /** absolute path of the markdown file (resolves relative links/images) */
  path: string;
  root: string;
  mode: 'dark' | 'light';
  /** open a relative link target inside the editor */
  onOpenPath: (path: string) => void;
}

/** Normalize `dir + relative` without touching absolute/external targets. */
function resolveRelative(dir: string, href: string): string {
  const segments = `${dir}/${href}`.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return `/${out.join('/')}`;
}

function isExternal(href: string): boolean {
  return /^([a-z]+:)?\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('#');
}

function MermaidBlock({ code, mode }: { code: string; mode: 'dark' | 'light' }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mode === 'dark' ? 'dark' : 'default'
        });
        const rendered = await mermaid.render(idRef.current, code);
        if (!cancelled) {
          setSvg(rendered.svg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, mode]);

  if (error) {
    return <pre className="mermaidError">{`mermaid: ${error}`}</pre>;
  }
  if (!svg) {
    return <div className="viewerStatus">rendering diagram…</div>;
  }
  // mermaid output with securityLevel: 'strict' is sanitized by mermaid itself.
  return <div className="mermaidBlock" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default function MarkdownView({ model, path, root, mode, onOpenPath }: MarkdownViewProps): JSX.Element {
  const [source, setSource] = useState(() => model.getValue());
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';

  // Live preview: re-render (debounced) as the buffer changes.
  useEffect(() => {
    setSource(model.getValue());
    let timer: number | undefined;
    const subscription = model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setSource(model.getValue()), 300);
    });
    return () => {
      window.clearTimeout(timer);
      subscription.dispose();
    };
  }, [model]);

  return (
    <div className="markdownView">
      <article className="markdownBody">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          components={{
            // `node` is react-markdown's AST handle — keep it off the DOM.
            code({ className, children, node: _node, ...props }) {
              const language = /language-(\w+)/.exec(className ?? '')?.[1];
              if (language === 'mermaid') {
                return <MermaidBlock code={String(children).trim()} mode={mode} />;
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            a({ href, children }) {
              if (!href) {
                return <span>{children}</span>;
              }
              if (isExternal(href)) {
                return (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                );
              }
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenPath(href.startsWith('/') ? href : resolveRelative(dir, href));
                  }}
                >
                  {children}
                </a>
              );
            },
            img({ src, alt, title }) {
              if (!src || isExternal(src)) {
                return <img src={src} alt={alt ?? ''} title={title} />;
              }
              const absolute = src.startsWith('/') ? src : resolveRelative(dir, src);
              return (
                <img
                  src={`/api/fs/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(absolute)}&v=0`}
                  alt={alt ?? ''}
                  title={title}
                />
              );
            }
          }}
        >
          {source}
        </ReactMarkdown>
      </article>
    </div>
  );
}

export type MarkdownRenderable = ReactNode;
