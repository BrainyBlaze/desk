/**
 * The no-tmux surface scanner backing the architecture gate, extracted so a
 * mutant-style test can prove the gate REJECTS an extra legacy reference —
 * whole-file exemptions cannot establish the property, so every file is
 * scanned and every legacy-token line must match the exact allowlist for its
 * file, with the total per-file count pinned. A new tmux reference anywhere —
 * including inside a sanctioned file that refuses the retired shapes — fails
 * on either the pattern check or the count.
 */

export interface ScannedFile {
  /** Path relative to src/, forward slashes. */
  rel: string;
  source: string;
}

interface Sanction {
  /** Exact number of lines containing a legacy token this file may have. */
  count: number;
  /**
   * Every legacy-token line must include at least one of these substrings —
   * the retired on-disk shapes a reader must still be able to NAME in order to
   * refuse them (the cutover migration that read them is gone; recognising
   * the shape and stating the support floor is all that is left).
   */
  allowed: string[];
}

const PRE_CUTOVER_SHAPES = [
  'tmuxSession', // the retired session key: refused in the manifest and the delivery-events ring
  "PRE_CUTOVER_MEMBER_FIELD = 'tmux'" // the retired member-manifest field: refused by the member parser
];

/**
 * Per-file sanctions: count is EXACT — moving a line is fine, adding one is
 * a violation even when it reuses an allowed construct.
 */
export const SANCTIONS: Record<string, Sanction> = {
  'server/channels/delivery/events.ts': { count: 1, allowed: PRE_CUTOVER_SHAPES },
  'server/channels/protocol/format.ts': { count: 1, allowed: PRE_CUTOVER_SHAPES },
  'core/manifest.ts': { count: 5, allowed: PRE_CUTOVER_SHAPES }
};

/** Legacy-token lines of one source, 1-indexed. */
function legacyLines(source: string): Array<{ line: number; text: string }> {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => /tmux/i.test(text));
}

/**
 * Scans every file; returns human-readable violations (empty = the property
 * holds). Three violation kinds: an unsanctioned file mentioning the legacy
 * transport at all, a sanctioned file whose line does not match its
 * allowlist (e.g. a live spawn), and a sanctioned file whose count drifted.
 */
export function scanLegacySurface(files: ScannedFile[]): string[] {
  const violations: string[] = [];
  for (const { rel, source } of files) {
    const hits = legacyLines(source);
    const sanction = SANCTIONS[rel];
    if (!sanction) {
      if (hits.length > 0) {
        violations.push(`${rel}:${hits.map((h) => h.line).join(',')} — legacy transport reference in unsanctioned file`);
      }
      continue;
    }
    for (const hit of hits) {
      if (!sanction.allowed.some((token) => hit.text.includes(token))) {
        violations.push(`${rel}:${hit.line} — legacy-token line outside the refusal allowlist: ${hit.text.trim()}`);
      }
    }
    if (hits.length !== sanction.count) {
      violations.push(
        `${rel} — legacy-token line count drifted: expected ${sanction.count}, found ${hits.length} (update the sanction ONLY when a refusal of a retired shape changes)`
      );
    }
  }
  return violations;
}

/** The flag scan: the cutover flag and its predicate must not exist at all. */
export function scanFlagSurface(files: ScannedFile[]): string[] {
  return files
    .filter(({ source }) => source.includes('nativeSessionsEnabled'))
    .map(({ rel }) => rel);
}
