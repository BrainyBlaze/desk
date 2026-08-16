import { spawn } from 'node:child_process';
import { DeskApiError } from './apiValidation.js';

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

export interface SearchOptions {
  /**
   * Bytes of rg output after which the run is stopped and reported as
   * truncated. Exposed so a test can hit the cap with a small tree; production
   * callers take the default.
   */
  outputCapBytes?: number;
}

export const SEARCH_RESULT_CAP = 500;

/** rg output beyond this is a runaway; the run is killed and marked truncated. */
export const RIPGREP_OUTPUT_CAP_BYTES = 8_000_000;

/**
 * Search has exactly one engine: ripgrep. When rg cannot be started there is
 * nothing weaker to fall through to — the request is refused under this name
 * so the operator learns which host requirement is missing, instead of getting
 * a silently smaller answer from a different implementation.
 */
export class RipgrepUnavailableError extends DeskApiError {
  constructor(cause: NodeJS.ErrnoException) {
    const detail =
      cause.code === 'ENOENT'
        ? 'ENOENT: rg is not on PATH'
        : `${cause.code ?? cause.name}: rg was found but could not be started (${cause.message})`;
    super(
      `ripgrep (rg) is required for search but could not be started — ${detail}. Install ripgrep (install.sh provisions it) and search again.`,
      503,
      'ripgrep-required'
    );
    this.name = 'RipgrepUnavailableError';
  }
}

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

export async function searchFiles(root: string, query: string, options: SearchOptions = {}): Promise<FileSearchResult> {
  const run = await runRipgrep(['--files', '--hidden', '--glob', '!.git/**'], root, options.outputCapBytes);
  const scored = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((path) => ({ path, score: scoreFuzzyPath(query, path) }))
    .filter((match) => match.score >= 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    matches: scored.slice(0, SEARCH_RESULT_CAP),
    truncated: run.capped || scored.length > SEARCH_RESULT_CAP
  };
}

export async function searchContent(root: string, query: string, options: SearchOptions = {}): Promise<ContentSearchResult> {
  const run = await runRipgrep(
    ['--json', '--smart-case', '--hidden', '--glob', '!.git/**', '--max-count', '20', '-e', query, '.'],
    root,
    options.outputCapBytes
  );
  const matches = parseRipgrepJson(run.stdout).map((match) => ({ ...match, path: match.path.replace(/^\.\//, '') }));
  return {
    matches: matches.slice(0, SEARCH_RESULT_CAP),
    truncated: run.capped || matches.length > SEARCH_RESULT_CAP
  };
}

interface RipgrepRun {
  stdout: string;
  /** True when the output cap stopped the run: what came back may not be all there is. */
  capped: boolean;
}

function runRipgrep(args: string[], cwd: string, outputCapBytes = RIPGREP_OUTPUT_CAP_BYTES): Promise<RipgrepRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('rg', args, { cwd });
    let stdout = '';
    let stderr = '';
    let capped = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!capped && stdout.length > outputCapBytes) {
        capped = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // Spawn itself failed: rg is absent or not startable. Only rg's own exit
      // codes are search outcomes; this is a host-requirement failure and is
      // named as such rather than left for the generic ENOENT → 404 mapping,
      // which would tell the user the search root does not exist.
      rejectPromise(new RipgrepUnavailableError(error));
    });
    child.on('close', (code) => {
      // rg exits 1 when there are simply no matches. A capped run was killed
      // by us and its partial output is the answer, flagged as such.
      if (capped || code === 0 || code === 1 || stdout.length > 0) {
        resolvePromise({ stdout, capped });
      } else {
        rejectPromise(new Error(stderr.trim() || `rg exited with code ${code}`));
      }
    });
  });
}
