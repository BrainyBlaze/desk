import { BpError } from '../shared/browserProtocol/index.js';

/** Human-readable text for a browser-protocol error code (§7.4 ERROR frame). */
export function describeBpError(code: number): string {
  switch (code) {
    case BpError.BAD_CHANNEL:
      return 'terminal channel is no longer valid';
    case BpError.STALE_GENERATION:
      return 'session was recreated; reattaching';
    case BpError.STALE_LEASE:
      return 'another surface holds the input lease';
    case BpError.INPUT_UNAVAILABLE:
      return 'terminal input is unavailable while the session reconnects or exits';
    case BpError.PAYLOAD_TOO_LARGE:
      return 'terminal frame too large';
    default:
      return `terminal error ${code}`;
  }
}
