import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isBinary, MAX_EDITABLE_BYTES } from './fsOps.js';

export interface ContentMatch {
  path: string; // relative to the search root
  line: number; // 1-based
  column: number; // 1-based
  text: string;
}

export interface FileSearchResult {
  matches: Array<{ path: string; score: number }>;
  truncated: boolean;
}

export interface ContentSearchResult {
  matches: ContentMatch[];
  truncated: boolean;
}

export const SEARCH_RESULT_CAP = 500;

/**
 * Case-insensitive subsequence scorer. -1 = no match. Bonuses: consecutive
 * runs, hits inside the basename, hit on the basename's first character.
 */
export function scoreFuzzyPath(query: string, path: string): number {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  if (q.length === 0) {
    return 0;
  }
  const baseStart = p.lastIndexOf('/') + 1;
  let score = 0;
  let pi = 0;
  let lastHit = -2;
  for (const target of q) {
    let found = -1;
    while (pi < p.length) {
      if (p[pi] === target) {
        found = pi;
        pi += 1;
        break;
      }
      pi += 1;
    }
    if (found === -1) {
      return -1;
    }
    score += 1;
    if (found === lastHit + 1) {
      score += 2;
    }
    if (found >= baseStart) {
      score += 3;
    }
    if (found === baseStart) {
      score += 5;
    }
    lastHit = found;
  }
  return score;
}

export function parseRipgrepJson(output: string): ContentMatch[] {
  const matches: ContentMatch[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== 'match') {
      continue;
    }
    const data = record.data as {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: Array<{ start?: number }>;
    };
    matches.push({
      path: data.path?.text ?? '',
      line: data.line_number ?? 0,
      column: (data.submatches?.[0]?.start ?? 0) + 1,
      text: (data.lines?.text ?? '').replace(/\n$/, '').slice(0, 400)
    });
  }
  return matches;
}

let ripgrepAvailable: boolean | undefined;

export function hasRipgrep(): boolean {
  if (ripgrepAvailable === undefined) {
    ripgrepAvailable = spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0;
  }
  return ripgrepAvailable;
}

export async function searchFiles(root: string, query: string): Promise<FileSearchResult> {
  const files = hasRipgrep()
    ? (await runRipgrep(['--files', '--hidden', '--glob', '!.git/**'], root)).split('\n').filter(Boolean)
    : walkFiles(root);
  const scored = files
    .map((path) => ({ path, score: scoreFuzzyPath(query, path) }))
    .filter((match) => match.score >= 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    matches: scored.slice(0, SEARCH_RESULT_CAP),
    truncated: scored.length > SEARCH_RESULT_CAP
  };
}

export async function searchContent(root: string, query: string): Promise<ContentSearchResult> {
  const matches = hasRipgrep()
    ? parseRipgrepJson(
        await runRipgrep(
          ['--json', '--smart-case', '--hidden', '--glob', '!.git/**', '--max-count', '20', '-e', query, '.'],
          root
        )
      ).map((match) => ({ ...match, path: match.path.replace(/^\.\//, '') }))
    : walkTextSearch(root, query);
  return {
    matches: matches.slice(0, SEARCH_RESULT_CAP),
    truncated: matches.length > SEARCH_RESULT_CAP
  };
}

function runRipgrep(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('rg', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8_000_000) {
        child.kill(); // runaway output — cap and use what we have
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      // rg exits 1 when there are simply no matches.
      if (code === 0 || code === 1 || stdout.length > 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(new Error(stderr.trim() || `rg exited with code ${code}`));
      }
    });
  });
}

/** Node fallback: list files (relative paths), hidden included, .git skipped. */
export function walkFiles(root: string, dir = '', out: string[] = [], depthLeft = 16): string[] {
  if (depthLeft <= 0 || out.length >= 20_000) {
    return out;
  }
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkFiles(root, rel, out, depthLeft - 1);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Node fallback content search: case-insensitive substring over text files.
 *
 * Collects up to `SEARCH_RESULT_CAP + 1` matches so that callers can detect
 * truncation: if the returned array length equals `SEARCH_RESULT_CAP + 1` the
 * result was cut short. `searchContent` slices to `SEARCH_RESULT_CAP` and
 * sets `truncated: true` accordingly.
 */
export function walkTextSearch(root: string, query: string): ContentMatch[] {
  const needle = query.toLowerCase();
  const limit = SEARCH_RESULT_CAP + 1;
  const matches: ContentMatch[] = [];
  for (const path of walkFiles(root)) {
    if (matches.length >= limit) {
      break;
    }
    let buffer: Buffer;
    try {
      if (statSync(join(root, path)).size > MAX_EDITABLE_BYTES) {
        continue;
      }
      buffer = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (isBinary(buffer)) {
      continue;
    }
    const lines = buffer.toString('utf8').split('\n');
    for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
      const column = lines[index]!.toLowerCase().indexOf(needle);
      if (column !== -1) {
        matches.push({ path, line: index + 1, column: column + 1, text: lines[index]!.slice(0, 400) });
      }
    }
  }
  return matches;
}
