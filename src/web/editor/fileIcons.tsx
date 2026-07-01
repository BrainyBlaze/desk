import {
  Braces,
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Lock,
  TerminalSquare
} from 'lucide-react';

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs',
  'java', 'rb', 'php', 'swift', 'kt', 'lua', 'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte'
]);
const DATA_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'xml', 'csv']);
const CONFIG_EXTENSIONS = new Set(['toml', 'ini', 'conf', 'cfg', 'env', 'properties']);
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'log', 'pdf']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz']);
const SHELL_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd']);
const DB_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3']);

/** Icon for a directory row (open state swaps the glyph). */
export function dirIcon(expanded: boolean, size = 13): JSX.Element {
  return expanded ? <FolderOpen size={size} /> : <Folder size={size} />;
}

/** Icon for a file row/tab, mapped from the file extension. */
export function fileIcon(name: string, size = 13): JSX.Element {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot === -1 ? '' : lower.slice(dot + 1);
  if (lower.endsWith('.lock') || lower === 'package-lock.json') {
    return <Lock size={size} />;
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return <FileCode size={size} />;
  }
  if (DATA_EXTENSIONS.has(extension)) {
    return <Braces size={size} />;
  }
  if (CONFIG_EXTENSIONS.has(extension) || lower.startsWith('.env')) {
    return <FileCog size={size} />;
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return <FileText size={size} />;
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return <Image size={size} />;
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return <FileArchive size={size} />;
  }
  if (SHELL_EXTENSIONS.has(extension)) {
    return <TerminalSquare size={size} />;
  }
  if (DB_EXTENSIONS.has(extension)) {
    return <Database size={size} />;
  }
  return <File size={size} />;
}
