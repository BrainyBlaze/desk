import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import type { DeskManifest } from '../../core/types.js';
import { normalizeConfiguredLspServers, type NormalizedLspLanguage } from './settings.js';

export interface LspLanguageDetectionResult {
  languages: string[];
  truncated: boolean;
}

export interface LspLanguageDetector {
  detect(input: { root: string; refresh?: boolean }): Promise<LspLanguageDetectionResult>;
}

/** The subset of a spawnSync result the ripgrep path inspects. Injectable so the timeout/kill
 *  fallback is deterministically testable without depending on the runner's rg version/speed. */
export interface RipgrepSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout: string;
}
export type RipgrepRunner = (root: string, args: string[], timeoutMs: number) => RipgrepSpawnResult;

export interface CreateLspLanguageDetectorOptions {
  readManifest: () => Pick<DeskManifest, 'settings'>;
  now?: () => number;
  ttlMs?: number;
  maxFiles?: number;
  maxDepth?: number;
  maxElapsedMs?: number;
  /** Defaults to a real `rg --files` spawn; overridden in tests to simulate timeout/kill/error. */
  runRipgrep?: RipgrepRunner;
}

const defaultRunRipgrep: RipgrepRunner = (root, args, timeoutMs) => {
  const result = spawnSync('rg', args, { cwd: root, encoding: 'utf8', timeout: timeoutMs });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : ''
  };
};

interface CacheEntry {
  expiresAt: number;
  result: LspLanguageDetectionResult;
  signature: string;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_ELAPSED_MS = 750;
const SKIPPED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  '__pycache__',
  'vendor',
  'coverage',
  '.next',
  '.cache'
];
const SKIPPED_DIR_SET = new Set(SKIPPED_DIRS);

export function createLspLanguageDetector(options: CreateLspLanguageDetectorOptions): LspLanguageDetector {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxElapsedMs = options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const runRipgrep = options.runRipgrep ?? defaultRunRipgrep;
  const cache = new Map<string, CacheEntry>();

  return {
    async detect(input) {
      const manifest = options.readManifest();
      const root = resolveAuthorizedRoot(manifest.settings?.editor?.root, input.root);
      const config = normalizeConfiguredLspServers((manifest.settings as { lsp?: unknown } | undefined)?.lsp);
      const signature = configSignature(config.languages);
      const cacheKey = `${root}\0${signature}`;
      const cached = cache.get(cacheKey);
      if (!input.refresh && cached && cached.expiresAt > now()) {
        return cached.result;
      }
      const listed = listCandidateFiles(root, { maxFiles, maxDepth, maxElapsedMs }, runRipgrep);
      const languages = detectLanguages(listed.files, config.languages);
      const result = {
        languages: listed.truncated
          ? detectMissingLanguagesWithRipgrep(root, { maxDepth, maxElapsedMs }, runRipgrep, config.languages, languages)
          : languages,
        truncated: listed.truncated
      };
      cache.set(cacheKey, { expiresAt: now() + ttlMs, result, signature });
      return result;
    }
  };
}

function resolveAuthorizedRoot(authorityRoot: string | undefined, candidateRoot: string): string {
  if (!authorityRoot || !isAbsolute(authorityRoot) || !isAbsolute(candidateRoot)) {
    throw new Error('invalid root');
  }
  let authority: string;
  let candidate: string;
  try {
    authority = realpathSync(authorityRoot);
    candidate = realpathSync(candidateRoot);
    if (!statSync(authority).isDirectory() || !statSync(candidate).isDirectory()) {
      throw new Error('invalid root');
    }
  } catch {
    throw new Error('invalid root');
  }
  const rel = relative(authority, candidate);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error('invalid root');
  }
  return candidate;
}

function configSignature(languages: NormalizedLspLanguage[]): string {
  return JSON.stringify(
    languages.map((language) => ({
      id: language.id,
      languageIds: language.languageIds,
      extensions: language.extensions
    }))
  );
}

function listCandidateFiles(
  root: string,
  limits: { maxFiles: number; maxDepth: number; maxElapsedMs: number },
  runRipgrep: RipgrepRunner
): { files: string[]; truncated: boolean } {
  const rg = listWithRipgrep(runRipgrep, root, limits.maxFiles, limits.maxDepth, limits.maxElapsedMs);
  if (rg) {
    return rg;
  }
  return walkFiles(root, limits);
}

function listWithRipgrep(
  runRipgrep: RipgrepRunner,
  root: string,
  maxFiles: number,
  maxDepth: number,
  maxElapsedMs: number
): { files: string[]; truncated: boolean } | undefined {
  const ignoreGlobs = SKIPPED_DIRS.flatMap((dir) => ['--glob', `!${dir}/**`]);
  const result = runRipgrep(root, ['--files', '--hidden', '--max-depth', String(maxDepth), ...ignoreGlobs], maxElapsedMs);
  // Non-authoritative outcomes -> fall back to the filesystem walk (which honors max-depth and reports
  // truncation correctly). result.error = spawn failed; signal set / status null = killed or timed out
  // (e.g. a slow runner exceeding maxElapsedMs). Treating a timeout as "truncated" was the CI flake.
  if (result.error || result.signal != null || result.status === null) {
    return undefined;
  }
  const allFiles = typeof result.stdout === 'string' ? result.stdout.split('\n').filter(Boolean) : [];
  if (result.status !== 0 && result.status !== 1) {
    return {
      files: allFiles.slice(0, maxFiles),
      truncated: true
    };
  }
  return {
    files: allFiles.slice(0, maxFiles),
    truncated: allFiles.length > maxFiles
  };
}

function walkFiles(
  root: string,
  limits: { maxFiles: number; maxDepth: number; maxElapsedMs: number }
): { files: string[]; truncated: boolean } {
  const startedAt = Date.now();
  const files: string[] = [];
  let truncated = false;
  let stopped = false;

  const visit = (dir: string, depth: number) => {
    if (stopped || files.length >= limits.maxFiles || Date.now() - startedAt > limits.maxElapsedMs) {
      truncated = true;
      stopped = true;
      return;
    }
    if (depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      if (stopped || files.length >= limits.maxFiles) {
        truncated = true;
        stopped = true;
        return;
      }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_SET.has(entry.name)) {
          visit(path, depth + 1);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(relative(root, path));
      }
    }
  };

  visit(root, 0);
  return { files, truncated };
}

function detectLanguages(files: string[], configured: NormalizedLspLanguage[]): string[] {
  const languages: string[] = [];
  for (const command of configured) {
    if (!hasExtensionMatch(files, command.extensions)) {
      continue;
    }
    const ids = command.languageIds.length > 0 ? command.languageIds : [command.id];
    for (const id of ids) {
      if (!languages.includes(id)) {
        languages.push(id);
      }
    }
  }
  return languages;
}

function detectMissingLanguagesWithRipgrep(
  root: string,
  limits: { maxDepth: number; maxElapsedMs: number },
  runRipgrep: RipgrepRunner,
  configured: NormalizedLspLanguage[],
  detected: string[]
): string[] {
  const languages = [...detected];
  const seen = new Set(languages);
  const ignoreGlobs = SKIPPED_DIRS.flatMap((dir) => ['--glob', `!${dir}/**`]);
  for (const command of configured) {
    const ids = command.languageIds.length > 0 ? command.languageIds : [command.id];
    if (ids.every((id) => seen.has(id))) {
      continue;
    }
    const includeGlobs = extensionGlobs(command.extensions);
    if (includeGlobs.length === 0) {
      continue;
    }
    const result = runRipgrep(
      root,
      ['--files', '--hidden', '--max-depth', String(limits.maxDepth), ...ignoreGlobs, ...includeGlobs.flatMap((glob) => ['--glob', glob])],
      limits.maxElapsedMs
    );
    if (result.error || result.signal != null || result.status === null) {
      continue;
    }
    const files = typeof result.stdout === 'string' ? result.stdout.split('\n').filter(Boolean) : [];
    if (!hasExtensionMatch(files, command.extensions)) {
      continue;
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        languages.push(id);
      }
    }
  }
  return languages;
}

function hasExtensionMatch(files: string[], extensions: string[]): boolean {
  const normalized = extensions.map((extension) => extension.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return false;
  }
  return files.some((file) => normalized.some((extension) => fileMatchesExtension(file, extension)));
}

function fileMatchesExtension(file: string, extension: string): boolean {
  if (extension.startsWith('.')) {
    return file.endsWith(extension);
  }
  const withDot = `.${extension}`;
  return extname(file) === withDot || basename(file).endsWith(withDot);
}

function extensionGlobs(extensions: string[]): string[] {
  const globs: string[] = [];
  for (const extension of extensions.map((value) => value.trim()).filter(Boolean)) {
    globs.push(`*${extension.startsWith('.') ? extension : `.${extension}`}`);
  }
  return globs;
}
