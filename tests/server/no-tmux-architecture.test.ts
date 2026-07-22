import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANCTIONS, scanFlagSurface, scanLegacySurface, type ScannedFile } from './noTmuxScan.js';

const SRC = join(__dirname, '..', '..', 'src');

/**
 * The Track B terminal gate: tmux is gone. EVERY source is scanned — the
 * sanctioned migration modules included — and every legacy-token line must
 * match its file's exact allowlist with a pinned per-file count. See
 * noTmuxScan.ts for the scanner; the mutant suite below proves the gate
 * rejects one extra legacy reference even inside a sanctioned mixed file.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx|js)$/.test(name) ? [path] : [];
  });
}

function scannedTree(): ScannedFile[] {
  return sourceFiles(SRC).map((file) => ({
    rel: relative(SRC, file).split(sep).join('/'),
    source: readFileSync(file, 'utf8')
  }));
}

describe('no-tmux architecture gate (Track B terminal state)', () => {
  it('keeps every source inside the exact sanctioned legacy surface (pattern + count per file)', () => {
    expect(scanLegacySurface(scannedTree())).toEqual([]);
  });

  it('keeps the native flag out of the runtime — one path, no gate', () => {
    expect(scanFlagSurface(scannedTree())).toEqual([]);
  });
});

describe('no-tmux gate oracle (mutant rejection)', () => {
  const sanctionedRel = 'core/resumeCaptureState.ts';
  const realSource = readFileSync(join(SRC, sanctionedRel), 'utf8');

  it('rejects a live legacy invocation added to an otherwise sanctioned mixed file', () => {
    const mutant: ScannedFile = {
      rel: sanctionedRel,
      source: `${realSource}\nconst leaked = spawnSync('tmux', ['kill-server']);\n`
    };
    const violations = scanLegacySurface([mutant]);
    expect(violations.some((v) => v.includes('outside the migration allowlist'))).toBe(true);
  });

  it('rejects an extra reference even when it reuses an allowed migration construct', () => {
    const mutant: ScannedFile = {
      rel: sanctionedRel,
      source: `${realSource}\n// one more tmuxSession mention than the sanction pins\n`
    };
    const violations = scanLegacySurface([mutant]);
    expect(violations.some((v) => v.includes('count drifted'))).toBe(true);
  });

  it('rejects any legacy reference in an unsanctioned file', () => {
    const violations = scanLegacySurface([{ rel: 'server/newFeature.ts', source: "exec('tmux attach');" }]);
    expect(violations).toEqual(['server/newFeature.ts:1 — legacy transport reference in unsanctioned file']);
  });

  it('pins the sanction table itself to the migration surface (no runtime file may be added silently)', () => {
    expect(Object.keys(SANCTIONS).sort()).toEqual(
      [
        'core/manifest.ts',
        'core/resumeCaptureState.ts',
        'core/sessionIdentity.ts',
        'server/channelsEvents.ts',
        'server/channelsProtocol.ts',
        'server/cutoverStoreMigration.ts',
        'shared/migration/channelsPausedTransform.ts',
        'shared/migration/durabilityTransform.ts',
        'shared/migration/index.ts',
        'shared/migration/manifestTransform.ts',
        'shared/migration/sessionId.ts'
      ].sort()
    );
  });
});
