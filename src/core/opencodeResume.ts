import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultOpencodeConfigDir } from './opencodeConfig.js';

export const OPENCODE_LAUNCH_RESUME_RECENT_MS = 24 * 60 * 60 * 1000;

export interface OpencodeSession {
  id: string;
  title: string;
  created: number;
  updated: number;
  projectId?: string;
  directory: string;
}

/** A valid opencode session id: `ses_` followed by base62, safe for shell argv. */
const OPENCODE_SESSION_ID_PATTERN = /^ses_[0-9A-Za-z]+$/;

export function isOpencodeSessionId(value: string): boolean {
  return OPENCODE_SESSION_ID_PATTERN.test(value);
}

export function parseOpencodeSessionList(stdout: string): OpencodeSession[] {
  const raw = extractJsonArray(stdout);
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const sessions: OpencodeSession[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      !isOpencodeSessionId(record.id) ||
      typeof record.directory !== 'string' ||
      typeof record.created !== 'number' ||
      typeof record.updated !== 'number'
    ) {
      continue;
    }
    sessions.push({
      id: record.id,
      title: typeof record.title === 'string' ? record.title : '',
      created: record.created,
      updated: record.updated,
      projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
      directory: record.directory
    });
  }
  return sessions;
}

/** First balanced top-level `[...]` in the text, tolerant of log noise. */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function pickOpencodeResumeSession(
  sessions: OpencodeSession[],
  opts: { directory: string; sinceMs?: number }
): OpencodeSession | null {
  const inDir = sessions.filter((session) => session.directory === opts.directory);
  if (opts.sinceMs !== undefined) {
    const sinceMs = opts.sinceMs;
    const candidates = inDir.filter((session) => session.created >= sinceMs);
    if (candidates.length > 0) {
      return candidates.length === 1 ? candidates[0]! : null;
    }
    const updatedCandidates = inDir.filter((session) => session.updated >= sinceMs);
    return updatedCandidates.length === 1 ? updatedCandidates[0]! : null;
  }
  if (inDir.length === 0) {
    return null;
  }
  return inDir.reduce((latest, session) => (session.updated > latest.updated ? session : latest));
}

export function pickOpencodeCaptureResumeSession(
  sessions: OpencodeSession[],
  opts: { directory: string; sinceMs?: number; launchResumeId?: string }
): OpencodeSession | null {
  const inDir = sessions.filter((session) => session.directory === opts.directory);
  if (opts.launchResumeId) {
    return inDir.find((session) => session.id === opts.launchResumeId) ?? null;
  }
  if (opts.sinceMs === undefined) {
    return null;
  }
  return pickOpencodeResumeSession(sessions, { directory: opts.directory, sinceMs: opts.sinceMs });
}

export function pickRecentOpencodeLaunchResumeSession(
  sessions: OpencodeSession[],
  opts: { directory: string; nowMs: number; recentMs?: number }
): OpencodeSession | null {
  const minUpdated = opts.nowMs - (opts.recentMs ?? OPENCODE_LAUNCH_RESUME_RECENT_MS);
  const candidates = sessions.filter(
    (session) => session.directory === opts.directory && session.updated >= minUpdated
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

export interface FindOpencodeLaunchResumeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: number;
  recentMs?: number;
  spawn?: typeof spawnSync;
}

export function findOpencodeLaunchResume(options: FindOpencodeLaunchResumeOptions): string | null {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const spawn = options.spawn ?? spawnSync;
  const bin = resolveOpencodeBinary({ env, homeDir, spawn });
  if (!bin) {
    return null;
  }
  const configDir = env.DESK_OPENCODE_CONFIG_DIR || defaultOpencodeConfigDir(homeDir);
  const result = spawn(bin, ['session', 'list', '--format', 'json'], {
    cwd: options.cwd,
    env: { ...env, OPENCODE_CONFIG_DIR: configDir },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5000
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return (
    pickRecentOpencodeLaunchResumeSession(parseOpencodeSessionList(result.stdout), {
      directory: options.cwd,
      nowMs: options.nowMs ?? Date.now(),
      recentMs: options.recentMs
    })?.id ?? null
  );
}

function resolveOpencodeBinary({
  env,
  homeDir,
  spawn
}: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  spawn: typeof spawnSync;
}): string | null {
  if (env.DESK_OPENCODE_BIN && existsSync(env.DESK_OPENCODE_BIN)) {
    return env.DESK_OPENCODE_BIN;
  }
  const which = spawn('sh', ['-lc', 'command -v opencode 2>/dev/null || true'], {
    encoding: 'utf8',
    env
  }) as SpawnSyncReturns<string>;
  const found = which.status === 0 ? which.stdout.trim() : '';
  if (found) {
    return found;
  }
  const fallback = join(homeDir, '.opencode', 'bin', 'opencode');
  return existsSync(fallback) ? fallback : null;
}
