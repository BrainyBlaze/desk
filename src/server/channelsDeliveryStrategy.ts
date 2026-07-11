import type { DeliveryBlockReason } from './channelsProtocol.js';
import type { SessionProbe, SessionProbeSnapshot } from './channelsProbe.js';

export type DeliveryDecision =
  | { deliver: true; snapshot?: SessionProbeSnapshot }
  | { deliver: false; reason: DeliveryBlockReason; snapshot?: SessionProbeSnapshot };

export type NativeDeliveryState = 'ready' | 'busy' | 'booting' | 'offline' | 'approval';

export interface DeliveryStrategy {
  decide(tmuxSession: string): Promise<DeliveryDecision>;
}

function blockReasonFromSnapshot(snapshot: SessionProbeSnapshot): DeliveryBlockReason {
  switch (snapshot.paneState) {
    case 'working':
      return 'busy';
    case 'offline':
      return 'offline';
    case 'booting':
      return 'booting';
    case 'empty-capture':
      return 'empty-capture';
    case 'unobservable':
      return 'capture-failed';
    case 'blocked':
      if (snapshot.blockedReason === 'approval' || snapshot.blockedReason === 'input-requested') {
        return snapshot.blockedReason;
      }
      if (
        snapshot.blockedReason === 'trust-menu' ||
        snapshot.blockedReason === 'selection-menu' ||
        snapshot.blockedReason === 'unknown-menu'
      ) {
        return snapshot.blockedReason;
      }
      return 'not-ready';
    default:
      return 'not-ready';
  }
}

export class PromptDeliveryStrategy implements DeliveryStrategy {
  constructor(private readonly probe: SessionProbe) {}

  async decide(tmuxSession: string): Promise<DeliveryDecision> {
    const snapshot = await this.probe.probe(tmuxSession, { source: 'drain', forceFresh: true });
    if (snapshot.paneState === 'ready') {
      return { deliver: true, snapshot };
    }
    return { deliver: false, reason: blockReasonFromSnapshot(snapshot), snapshot };
  }
}

export class NotificationDeliveryStrategy implements DeliveryStrategy {
  async decide(_tmuxSession: string): Promise<DeliveryDecision> {
    return { deliver: true };
  }
}

export class NativePromptDeliveryStrategy implements DeliveryStrategy {
  constructor(private readonly state: (tmuxSession: string) => NativeDeliveryState | Promise<NativeDeliveryState>) {}

  async decide(tmuxSession: string): Promise<DeliveryDecision> {
    const state = await this.state(tmuxSession);
    if (state === 'ready') {
      return { deliver: true };
    }
    return {
      deliver: false,
      reason: state === 'approval' ? 'approval' : state
    };
  }
}
