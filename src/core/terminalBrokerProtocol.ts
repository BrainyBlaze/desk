import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from './terminalSizing.js';

export const MAX_TERMINAL_BROKER_INPUT_LENGTH = 1024 * 1024;
export const MAX_TERMINAL_DIMENSION = 1000;

export type TerminalBrokerClientFrame =
  | { type: 'subscribe'; session: string; surfaceId: string; visible: boolean }
  | { type: 'visibility'; session: string; surfaceId: string; visible: boolean }
  | { type: 'unsubscribe'; session: string; surfaceId: string }
  | { type: 'input'; session: string; surfaceId: string; data: string }
  | { type: 'resize'; session: string; surfaceId: string; cols: number; rows: number };

export type TerminalBrokerServerFrame =
  | { type: 'ready'; version: 1 }
  // Server liveness beacon (every 15s). The client tracks the time of the last
  // frame of ANY type; a half-open TCP delivers none, so the client can detect a
  // dead-but-OPEN socket and reconnect. Carries the server clock for diagnostics.
  | { type: 'heartbeat'; at: number }
  | { type: 'snapshot'; session: string; surfaceId: string; data: string }
  | { type: 'output'; session: string; data: string }
  | { type: 'error'; session?: string; message: string }
  | { type: 'exit'; session: string; exitCode: number | null };

export function parseBrokerClientFrame(value: unknown): TerminalBrokerClientFrame {
  if (!value || typeof value !== 'object') {
    throw invalidBrokerFrame();
  }
  const frame = value as Record<string, unknown>;
  const session = readSession(frame.session);
  const surfaceId = readNonEmptyString(frame.surfaceId);
  switch (frame.type) {
    case 'subscribe':
      return { type: 'subscribe', session, surfaceId, visible: readBoolean(frame.visible) };
    case 'visibility':
      return { type: 'visibility', session, surfaceId, visible: readBoolean(frame.visible) };
    case 'unsubscribe':
      return { type: 'unsubscribe', session, surfaceId };
    case 'input':
      if (typeof frame.data !== 'string' || frame.data.length > MAX_TERMINAL_BROKER_INPUT_LENGTH) {
        throw invalidBrokerFrame();
      }
      return { type: 'input', session, surfaceId, data: frame.data };
    case 'resize': {
      const cols = readTerminalDimension(frame.cols, MIN_TERMINAL_COLS);
      const rows = readTerminalDimension(frame.rows, MIN_TERMINAL_ROWS);
      return { type: 'resize', session, surfaceId, cols, rows };
    }
    default:
      throw invalidBrokerFrame();
  }
}

function readSession(value: unknown): string {
  return readNonEmptyString(value);
}

function readNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidBrokerFrame();
  }
  return value;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw invalidBrokerFrame();
  }
  return value;
}

function readTerminalDimension(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_TERMINAL_DIMENSION) {
    throw invalidBrokerFrame();
  }
  return value;
}

function invalidBrokerFrame(): Error {
  return new Error('invalid terminal broker frame');
}
