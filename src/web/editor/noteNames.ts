/**
 * Note filenames derive from content: first non-empty line, markdown lead-in
 * stripped, filesystem-hostile characters removed, capped at 20 characters.
 * Empty/whitespace content falls back to "untitled".
 */
export function deriveNoteName(content?: string): string {
  const firstLine =
    (content ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  const cleaned = firstLine
    .replace(/^[#>*+`\s-]+/, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20)
    .trim()
    .replace(/\.+$/, '');
  return cleaned || 'untitled';
}

/** Names produced for empty notes — eligible for content-based auto-rename. */
export function isUntitledNote(name: string): boolean {
  return /^untitled(-\d+)?\.md$/i.test(name);
}

/** nth dedupe candidate: base.md, base-2.md, base-3.md … */
export function noteFileName(base: string, attempt: number): string {
  return attempt === 0 ? `${base}.md` : `${base}-${attempt + 1}.md`;
}
