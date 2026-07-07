/**
 * Shared slash-command grammar for every native driver. One definition keeps
 * the three drivers' parsing in lockstep — a syntax change edited in only one
 * driver is exactly the drift this file exists to prevent.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z][\w-]*)\s*(.*)$/is.exec(text.trim());
  if (!match) {
    return null;
  }
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}
