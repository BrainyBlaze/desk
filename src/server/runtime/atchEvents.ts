import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

export type AtchEvent =
  | { ts: number; type: 'ready' }
  | { ts: number; type: 'state'; state: 'busy' | 'idle'; title: string }
  | { ts: number; type: 'link'; uri: string }
  | { ts: number; type: 'exit'; code: number };

export type AtchEventDiagnosticCode =
  | 'invalid-json'
  | 'invalid-record'
  | 'invalid-utf8'
  | 'line-too-long'
  | 'unterminated-line'
  | 'tailer-io'
  | 'consumer-error';

export interface AtchEventDiagnostic {
  code: AtchEventDiagnosticCode;
  message: string;
}

export interface AtchEventDecoderOptions {
  maxLineBytes?: number;
  onDiagnostic?: (diagnostic: AtchEventDiagnostic) => void;
}

const DEFAULT_MAX_LINE_BYTES = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseAtchEvent(value: unknown): AtchEvent | null {
  if (!isRecord(value) || !validTimestamp(value.ts) || typeof value.type !== 'string') {
    return null;
  }
  switch (value.type) {
    case 'ready':
      return hasExactKeys(value, ['ts', 'type'])
        ? { ts: value.ts, type: 'ready' }
        : null;
    case 'state':
      return hasExactKeys(value, ['ts', 'type', 'state', 'title']) &&
        (value.state === 'busy' || value.state === 'idle') &&
        typeof value.title === 'string'
        ? { ts: value.ts, type: 'state', state: value.state, title: value.title }
        : null;
    case 'link':
      return hasExactKeys(value, ['ts', 'type', 'uri']) && typeof value.uri === 'string'
        ? { ts: value.ts, type: 'link', uri: value.uri }
        : null;
    case 'exit':
      return hasExactKeys(value, ['ts', 'type', 'code']) &&
        typeof value.code === 'number' &&
        Number.isInteger(value.code) &&
        value.code >= 0
        ? { ts: value.ts, type: 'exit', code: value.code }
        : null;
    default:
      return null;
  }
}

export class AtchEventDecoder {
  private readonly maxLineBytes: number;
  private readonly onDiagnostic?: (diagnostic: AtchEventDiagnostic) => void;
  private pending = Buffer.alloc(0);
  private discardingOversizedLine = false;

  constructor(options: AtchEventDecoderOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new Error('maxLineBytes must be a positive safe integer');
    }
    this.onDiagnostic = options.onDiagnostic;
  }

  push(chunk: Uint8Array): AtchEvent[] {
    const events: AtchEvent[] = [];
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;

    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline < 0 ? bytes.length : newline;
      const fragment = bytes.subarray(start, end);

      if (this.discardingOversizedLine) {
        if (newline >= 0) this.discardingOversizedLine = false;
      } else if (this.pending.length + fragment.length > this.maxLineBytes) {
        this.pending = Buffer.alloc(0);
        this.diagnostic('line-too-long', `atch event exceeded ${this.maxLineBytes} bytes`);
        this.discardingOversizedLine = newline < 0;
      } else {
        this.pending = this.pending.length === 0
          ? Buffer.from(fragment)
          : Buffer.concat([this.pending, fragment]);
        if (newline >= 0) {
          const event = this.decodeLine(this.pending);
          this.pending = Buffer.alloc(0);
          if (event) events.push(event);
        }
      }

      if (newline < 0) break;
      start = newline + 1;
    }
    return events;
  }

  finish(): AtchEvent[] {
    if (this.pending.length > 0 || this.discardingOversizedLine) {
      this.diagnostic('unterminated-line', 'atch event stream ended with an incomplete line');
    }
    this.pending = Buffer.alloc(0);
    this.discardingOversizedLine = false;
    return [];
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.discardingOversizedLine = false;
  }

  private decodeLine(line: Buffer): AtchEvent | null {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(line);
    } catch {
      this.diagnostic('invalid-utf8', 'atch event line is not valid UTF-8');
      return null;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.diagnostic('invalid-json', 'atch event line is not valid JSON');
      return null;
    }

    const event = parseAtchEvent(value);
    if (!event) {
      this.diagnostic('invalid-record', 'atch event record does not match the supported schema');
    }
    return event;
  }

  private diagnostic(code: AtchEventDiagnosticCode, message: string): void {
    this.onDiagnostic?.({ code, message });
  }
}

export function atchEventPath(
  socketRoot: string,
  sessionId: string,
  generation: number
): string {
  if (!isAbsolute(socketRoot)) throw new Error('atch socket root must be absolute');
  if (!sessionId) throw new Error('sessionId must not be empty');
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('generation must be a positive safe integer');
  }
  const sessionKey = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return join(socketRoot, `${sessionKey}.${generation}.events.ndjson`);
}

export function prepareAtchEventSink(
  socketRoot: string,
  sessionId: string,
  generation: number
): string {
  const rootStat = lstatSync(socketRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('atch socket root must be a real directory');
  }
  if ((rootStat.mode & 0o777) !== 0o700) {
    throw new Error('atch socket root must have mode 0700');
  }
  if (process.getuid && rootStat.uid !== process.getuid()) {
    throw new Error('atch socket root must be owned by the current user');
  }

  const path = atchEventPath(socketRoot, sessionId, generation);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('atch event sink must be a regular file with mode 0600');
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error('atch event sink must be owned by the current user');
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // Preserve the preparation error.
      }
    }
    throw error;
  }
  closeSync(fd);
  return path;
}

export interface AtchEventTailerOptions {
  path: string;
  onEvent: (event: AtchEvent, context: AtchEventDeliveryContext) => void;
  onDiagnostic?: (diagnostic: AtchEventDiagnostic) => void;
  pollIntervalMs?: number;
}

export interface AtchEventDeliveryContext {
  phase: 'replay' | 'resync' | 'live';
}

const TAILER_READ_BYTES = 64 * 1024;

export class AtchEventTailer {
  private readonly path: string;
  private readonly onEvent: (
    event: AtchEvent,
    context: AtchEventDeliveryContext
  ) => void;
  private readonly onDiagnostic?: (diagnostic: AtchEventDiagnostic) => void;
  private readonly pollIntervalMs: number;
  private readonly decoder: AtchEventDecoder;
  private fd: number | undefined;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastIoError: string | undefined;
  private replayPending = true;

  constructor(options: AtchEventTailerOptions) {
    this.path = options.path;
    this.onEvent = options.onEvent;
    this.onDiagnostic = options.onDiagnostic;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error('pollIntervalMs must be a positive safe integer');
    }
    this.decoder = new AtchEventDecoder({ onDiagnostic: this.onDiagnostic });
  }

  start(): boolean {
    if (this.timer) return true;
    if (!this.pollNow()) return false;
    this.timer = setInterval(() => this.pollNow(), this.pollIntervalMs);
    this.timer.unref?.();
    return true;
  }

  pollNow(): boolean {
    try {
      const fd = this.ensureOpen();
      const stat = fstatSync(fd);
      let phase: AtchEventDeliveryContext['phase'] = this.replayPending
        ? 'replay'
        : 'live';
      if (stat.size < this.offset) {
        this.offset = 0;
        this.decoder.reset();
        phase = 'resync';
      }

      const buffer = Buffer.allocUnsafe(TAILER_READ_BYTES);
      while (true) {
        const read = readSync(fd, buffer, 0, buffer.length, this.offset);
        if (read === 0) break;
        this.offset += read;
        for (const event of this.decoder.push(buffer.subarray(0, read))) {
          try {
            this.onEvent(event, { phase });
          } catch (error) {
            this.onDiagnostic?.({
              code: 'consumer-error',
              message: `atch event consumer failed: ${errorMessage(error)}`
            });
          }
        }
      }
      this.replayPending = false;
      this.lastIoError = undefined;
      return true;
    } catch (error) {
      this.closeFile();
      const message = errorMessage(error);
      if (message !== this.lastIoError) {
        this.lastIoError = message;
        this.onDiagnostic?.({ code: 'tailer-io', message: `atch event tailer failed: ${message}` });
      }
      return false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeFile();
    this.offset = 0;
    this.decoder.reset();
    this.replayPending = true;
  }

  private ensureOpen(): number {
    if (this.fd !== undefined) return this.fd;
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('atch event sink must be a regular file with mode 0600');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('atch event sink must be owned by the current user');
      }
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.fd = fd;
    return fd;
  }

  private closeFile(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
