// Fake binary WebSocket for the browser terminal broker client. Records the
// client's on-wire frames (decoded) and lets a test deliver server frames the
// way a real WS with binaryType 'arraybuffer' would — as an ArrayBuffer.
// Shared by the broker-client suite and the end-to-end exit-frame witness so
// both drive the SAME transport double.

import {
  decodeBpFrame,
  encodeBpFrame,
  type BpFrame,
  type BpFrameType
} from '../../src/shared/browserProtocol/index.js';
import type { BinaryBrokerSocket } from '../../src/web/binaryTerminalBrokerClient.js';

export class FakeBinaryBrokerSocket implements BinaryBrokerSocket {
  readyState = 1; // OPEN — the client only sends once it sees the 'open' event
  binaryType = '';
  sent: BpFrame[] = [];
  private handlers = new Map<string, (event: any) => void>();
  send(data: Uint8Array): void {
    this.sent.push(decodeBpFrame(data));
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, handler: (event: any) => void): void {
    this.handlers.set(type, handler);
  }
  fireOpen(): void {
    this.handlers.get('open')?.({});
  }
  fireClose(): void {
    this.readyState = 3;
    this.handlers.get('close')?.({});
  }
  /** Deliver a typed frame: encoded exactly as the server would encode it. */
  deliver(frame: BpFrame): void {
    this.deliverBytes(encodeBpFrame(frame));
  }
  /** Deliver already-encoded bytes (a frame the server produced) as one WS message. */
  deliverBytes(bytes: Uint8Array): void {
    // WS binaryType 'arraybuffer' delivers an ArrayBuffer.
    this.handlers.get('message')?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  /** Frames of a given type the client has sent so far. */
  ofType<T extends BpFrameType>(type: T): Extract<BpFrame, { type: T }>[] {
    return this.sent.filter((f) => f.type === type) as Extract<BpFrame, { type: T }>[];
  }
}
