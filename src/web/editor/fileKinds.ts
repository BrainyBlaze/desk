export type ViewerKind = 'image' | 'pdf' | null;

const IMAGE_VIEW_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? '' : lower.slice(dot + 1);
}

/** Files that open in a dedicated viewer instead of Monaco. */
export function viewerKindFor(name: string): ViewerKind {
  const extension = extensionOf(name);
  if (IMAGE_VIEW_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (extension === 'pdf') {
    return 'pdf';
  }
  return null;
}

/** Files that support the rendered-markdown view (in addition to editing). */
export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(name));
}

export function rawFileUrl(root: string, path: string, revision: number): string {
  return `/api/fs/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&v=${revision}`;
}
