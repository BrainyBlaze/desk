import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../server/fsOps.js';

export interface PendingResumeCapture {
  tmuxSession: string;
  agent: 'codex' | 'opencode';
  cwd: string;
  sinceMs: number;
  deadlineMs: number;
  launchResumeId?: string;
}

export interface ResumeCaptureStateOptions {
  path?: string;
  homeDir?: string;
}

export function resolveResumeCaptureStatePath(options: ResumeCaptureStateOptions = {}): string {
  if (options.path) {
    return options.path;
  }
  if (process.env.DESK_RESUME_CAPTURE_STATE_PATH) {
    return process.env.DESK_RESUME_CAPTURE_STATE_PATH;
  }
  return join(options.homeDir ?? homedir(), '.config', 'desk', 'resume-captures.json');
}

export function readPendingResumeCaptures(options: ResumeCaptureStateOptions = {}): PendingResumeCapture[] {
  const path = resolveResumeCaptureStatePath(options);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const captures = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { captures?: unknown }).captures)
        ? (parsed as { captures: unknown[] }).captures
        : [];
    return captures.filter(isPendingResumeCapture);
  } catch {
    return [];
  }
}

export function upsertPendingResumeCapture(
  capture: PendingResumeCapture,
  options: ResumeCaptureStateOptions = {}
): void {
  const captures = readPendingResumeCaptures(options).filter((entry) => entry.tmuxSession !== capture.tmuxSession);
  captures.push(capture);
  writePendingResumeCaptures(captures, options);
}

export function removePendingResumeCapture(tmuxSession: string, options: ResumeCaptureStateOptions = {}): void {
  const captures = readPendingResumeCaptures(options).filter((entry) => entry.tmuxSession !== tmuxSession);
  writePendingResumeCaptures(captures, options);
}

export function findPendingResumeCapture(
  tmuxSession: string,
  options: ResumeCaptureStateOptions = {}
): PendingResumeCapture | undefined {
  return readPendingResumeCaptures(options).find((entry) => entry.tmuxSession === tmuxSession);
}

export function writePendingResumeCaptures(
  captures: PendingResumeCapture[],
  options: ResumeCaptureStateOptions = {}
): void {
  const path = resolveResumeCaptureStatePath(options);
  writeFileAtomic(path, `${JSON.stringify({ captures }, null, 2)}\n`);
}

export function clearPendingResumeCaptures(options: ResumeCaptureStateOptions = {}): void {
  try {
    unlinkSync(resolveResumeCaptureStatePath(options));
  } catch {
    // missing or raced delete: already clear
  }
}

function isPendingResumeCapture(value: unknown): value is PendingResumeCapture {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.tmuxSession === 'string' &&
    (record.agent === 'codex' || record.agent === 'opencode') &&
    typeof record.cwd === 'string' &&
    typeof record.sinceMs === 'number' &&
    Number.isFinite(record.sinceMs) &&
    typeof record.deadlineMs === 'number' &&
    Number.isFinite(record.deadlineMs) &&
    (record.launchResumeId === undefined || typeof record.launchResumeId === 'string')
  );
}
