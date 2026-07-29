import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANCTIONS, scanFlagSurface, scanLegacySurface, type ScannedFile } from './noTmuxScan.js';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const DOCS = join(ROOT, 'docs');
const VENDORED_ATCH = join(ROOT, 'vendor', 'atch');
const SHIPPED_RUNTIME_FILES = [
  'Dockerfile',
  'install.sh',
  'package.json',
  'scripts/smoke-serve-modes.mjs',
  ...readdirSync(join(ROOT, '.github', 'workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
].sort();
const HISTORICAL_DOC_PAGES = new Set(['release-notes']);
const RETIRED_DOC_RUNTIME = /\btmux\b|terminal[ -]broker|terminalBroker|capture-pane|send-keys|warm[- ]PTY/i;

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
  // The fork is shipped source, not Desk runtime source. Its own historical
  // vocabulary is intentionally outside this gate and pinned by provenance.
  return sourceFiles(SRC).map((file) => ({
    rel: relative(SRC, file).split(sep).join('/'),
    source: readFileSync(file, 'utf8')
  }));
}

function scannedShippedRuntime(): ScannedFile[] {
  return SHIPPED_RUNTIME_FILES.map((rel) => ({
    rel,
    source: readFileSync(join(ROOT, rel), 'utf8')
  }));
}

function currentRuntimeDocs(): ScannedFile[] {
  const docsConfig = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8')) as {
    navigation: { groups: Array<{ pages?: string[] }> };
  };
  const pageEntries = docsConfig.navigation.groups.flatMap((group) => group.pages ?? []);
  for (const page of pageEntries) {
    if (typeof page !== 'string') {
      throw new Error('docs gate requires flat string pages in docs.json navigation');
    }
  }
  const pages = pageEntries.filter((page) => !HISTORICAL_DOC_PAGES.has(page));
  const rels = [
    'README.md',
    ...pages.map((page) => `docs/${page}.md`),
    'docs/images/architecture-runtime.svg'
  ];
  return [...new Set(rels)].sort().map((rel) => ({
    rel,
    source: readFileSync(join(ROOT, rel), 'utf8')
  }));
}

function scanRetiredDocRuntime(files: ScannedFile[]): string[] {
  return files.flatMap(({ rel, source }) =>
    source
      .split('\n')
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => RETIRED_DOC_RUNTIME.test(text))
      .map(({ line }) => `${rel}:${line}`)
  );
}

describe('no-tmux architecture gate (Track B terminal state)', () => {
  it('keeps every source inside the exact sanctioned legacy surface (pattern + count per file)', () => {
    expect(scanLegacySurface(scannedTree())).toEqual([]);
  });

  it('keeps the native flag out of the runtime — one path, no gate', () => {
    expect(scanFlagSurface(scannedTree())).toEqual([]);
  });

  it('keeps the retired transport out of shipped runtime, installer, smoke, and CI surfaces', () => {
    expect(scanLegacySurface(scannedShippedRuntime())).toEqual([]);
  });

  it('keeps active public docs on the atch-native runtime', () => {
    expect(scanRetiredDocRuntime(currentRuntimeDocs())).toEqual([]);
  });

  it('deliberately keeps the pinned fork source outside the Desk vocabulary gate', () => {
    expect(relative(ROOT, VENDORED_ATCH).split(sep).join('/')).toBe('vendor/atch');
    expect(statSync(VENDORED_ATCH).isDirectory()).toBe(true);
    expect(scannedTree().every(({ rel }) => !rel.startsWith('vendor/atch/'))).toBe(true);
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

  it('rejects retired runtime vocabulary added to a current public page', () => {
    expect(
      scanRetiredDocRuntime([
        { rel: 'docs/concepts-architecture.md', source: 'The terminal broker attaches through tmux.' }
      ])
    ).toEqual(['docs/concepts-architecture.md:1']);
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
