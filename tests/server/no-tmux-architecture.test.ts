import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

/**
 * The Track B terminal gate: tmux is gone. Runtime code must not name the
 * legacy transport — not as an identifier, an env key, a spawned binary, or a
 * flag. The ONLY sanctioned mentions are the one-way migration transforms
 * (they read legacy stores by definition) and their record shapes.
 */
const SANCTIONED = new Set([
  'server/cutoverStoreMigration.ts',
  'server/channelsEvents.ts', // migrateDeliveryEventLine reads the legacy field
  'server/channelsProtocol.ts', // migrateMemberManifestContent reads `tmux:` lines
  'core/resumeCaptureState.ts', // LegacyPendingResumeCapture + its transform
  'core/manifest.ts', // the permanent fail-closed guard REJECTING the legacy key
  'core/sessionIdentity.ts' // the migration's legacy read-source shape
]);

/** The one-way store transforms read legacy shapes by definition. */
const SANCTIONED_PREFIXES = ['shared/migration/'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx|js)$/.test(name) ? [path] : [];
  });
}

describe('no-tmux architecture gate (Track B terminal state)', () => {
  it('keeps every runtime source free of tmux identifiers outside the sanctioned migration transforms', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (SANCTIONED.has(rel) || SANCTIONED_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      if (/tmux/i.test(source)) {
        const lines = source
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => /tmux/i.test(line))
          .map(({ index }) => index + 1);
        offenders.push(`${rel}:${lines.join(',')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the native flag out of the runtime — one path, no gate', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => source.includes('DESK_ATCH_NATIVE') || source.includes('nativeSessionsEnabled'))
      .map(({ file }) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
