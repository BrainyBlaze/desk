/**
 * The no-tmux surface scanner backing the architecture gate, extracted so a
 * mutant-style test can prove the gate REJECTS an extra legacy reference —
 * whole-file exemptions cannot establish the property, so every file is
 * scanned and every legacy-token line must match the exact allowlist for its
 * file, with the total per-file count pinned. A new tmux reference anywhere —
 * including inside a sanctioned mixed runtime+migration module — fails on
 * either the pattern check or the count.
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
   * the specific migration constructs that legitimately name the legacy
   * transport (reading old stores is their whole job).
   */
  allowed: string[];
}

const MIGRATION_CONSTRUCTS = [
  'tmuxSession', // legacy record fields the transforms read
  'tmuxToSessionId', // the canonical re-key map
  'tmuxSeen', // the transform's duplicate-source guard
  "tmux:", // the legacy member-manifest line the transform re-keys
  'legacy tmuxSession', // fail-closed rejection message
  'tmux-era', // transform doc referring to the source era
  'tmux ', // transform doc prose ("the tmux name", "tmux store")
  'tmux→', // the re-key direction in transform docs
  'tmux-' // transform doc compounds
];

/**
 * Per-file sanctions: count is EXACT — moving a line is fine, adding one is
 * a violation even when it reuses an allowed construct.
 */
export const SANCTIONS: Record<string, Sanction> = {
  'server/cutoverStoreMigration.ts': { count: 38, allowed: MIGRATION_CONSTRUCTS },
  'server/channelsEvents.ts': { count: 9, allowed: MIGRATION_CONSTRUCTS },
  'server/channelsProtocol.ts': { count: 6, allowed: MIGRATION_CONSTRUCTS },
  'core/resumeCaptureState.ts': { count: 6, allowed: MIGRATION_CONSTRUCTS },
  'core/manifest.ts': { count: 2, allowed: MIGRATION_CONSTRUCTS },
  'core/sessionIdentity.ts': { count: 5, allowed: MIGRATION_CONSTRUCTS },
  'shared/migration/channelsPausedTransform.ts': { count: 8, allowed: MIGRATION_CONSTRUCTS },
  'shared/migration/durabilityTransform.ts': { count: 6, allowed: MIGRATION_CONSTRUCTS },
  'shared/migration/index.ts': { count: 1, allowed: MIGRATION_CONSTRUCTS },
  'shared/migration/manifestTransform.ts': { count: 25, allowed: MIGRATION_CONSTRUCTS },
  'shared/migration/sessionId.ts': { count: 1, allowed: MIGRATION_CONSTRUCTS }
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
        violations.push(`${rel}:${hit.line} — legacy-token line outside the migration allowlist: ${hit.text.trim()}`);
      }
    }
    if (hits.length !== sanction.count) {
      violations.push(
        `${rel} — legacy-token line count drifted: expected ${sanction.count}, found ${hits.length} (update the sanction ONLY for migration-transform changes)`
      );
    }
  }
  return violations;
}

/** The flag scan: the cutover flag and its predicate must not exist at all. */
export function scanFlagSurface(files: ScannedFile[]): string[] {
  return files
    .filter(({ source }) => source.includes('DESK_ATCH_NATIVE') || source.includes('nativeSessionsEnabled'))
    .map(({ rel }) => rel);
}
