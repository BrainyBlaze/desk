// desk-runtime control-plane RPC envelope (spec §3.2 "versioned RPC"). Pure
// encode/decode + version negotiation over a line/length-framed control socket;
// the daemon adapter does the socket I/O. This carries LOW-VOLUME control calls
// (ensure/stop/list/lease/state); the hot terminal path rides the moor wire and
// the binary browser protocol, not this. JSON keeps it debuggable.

export const RPC_VERSION = 1;

export interface RpcRequest {
  v: number;
  /** Correlation id, unique per in-flight request on a connection. */
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  v: number;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export class RpcError extends Error {
  constructor(readonly code: 'bad-version' | 'malformed' | 'method-error', message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export function encodeRequest(method: string, id: number, params?: unknown): string {
  const req: RpcRequest = { v: RPC_VERSION, id, method, params };
  return JSON.stringify(req);
}

/**
 * Decode a request, rejecting a version mismatch BEFORE trusting the shape (a
 * peer speaking another RPC version may lay out fields differently, so a clean
 * bad-version refusal beats a misparse). The daemon replies with an error
 * response carrying the same id when it can recover one.
 */
export function decodeRequest(text: string): RpcRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RpcError('malformed', 'invalid JSON');
  }
  if (!isObj(raw) || typeof raw.v !== 'number') throw new RpcError('malformed', 'missing v');
  if (raw.v !== RPC_VERSION) throw new RpcError('bad-version', `peer v${raw.v} != v${RPC_VERSION}`);
  if (typeof raw.id !== 'number' || typeof raw.method !== 'string') throw new RpcError('malformed', 'missing id/method');
  return { v: raw.v, id: raw.id, method: raw.method, params: raw.params };
}

export function encodeOk(id: number, result?: unknown): string {
  const res: RpcResponse = { v: RPC_VERSION, id, ok: true, result };
  return JSON.stringify(res);
}

export function encodeErr(id: number, code: string, message: string): string {
  const res: RpcResponse = { v: RPC_VERSION, id, ok: false, error: { code, message } };
  return JSON.stringify(res);
}

export function decodeResponse(text: string): RpcResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RpcError('malformed', 'invalid JSON');
  }
  if (!isObj(raw) || typeof raw.v !== 'number') throw new RpcError('malformed', 'missing v');
  if (raw.v !== RPC_VERSION) throw new RpcError('bad-version', `peer v${raw.v} != v${RPC_VERSION}`);
  if (typeof raw.id !== 'number' || typeof raw.ok !== 'boolean') throw new RpcError('malformed', 'missing id/ok');
  return { v: raw.v, id: raw.id, ok: raw.ok, result: raw.result, error: raw.error as RpcResponse['error'] };
}
