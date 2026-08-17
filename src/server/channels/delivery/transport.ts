// What actually reaches an agent.
//
// Everything the engine can do TO a session, as one contract: put text in
// front of it, read what the authority says it is doing, and — for terminal
// sessions only — look at the screen and press Enter. Nothing here knows about
// queues, channels, mentions or prompts; it is the boundary between "we decided
// to deliver" and "the session received something".
//
// The engine used to carry these as four unrelated fields with no name between
// them, so there was no way to say "replace how Desk reaches agents" without
// naming four functions and hoping you had them all.

import type { AgentStateBatch } from './strategy.js';

export interface AgentDelivery {
  /** Put `text` in front of the session. `false` = the transport did not accept it. */
  send(sessionId: string, text: string): Promise<boolean>;

  /** The canonical authority's current view of every session, one batch per decision. */
  states(): Promise<AgentStateBatch>;

  /**
   * A stable fingerprint of what the session is showing, or `null` when it
   * cannot be observed. Used only to CLASSIFY a stalled submit — never to
   * decide whether to deliver.
   */
  probe(sessionId: string): Promise<string | null>;

  /**
   * Press Enter. The one safe recovery action for a prompt whose submit was
   * eaten: a no-op on an idle composer, a submit on a filled one.
   */
  submit(sessionId: string): Promise<boolean>;
}

/**
 * The transport primitives as the engine receives them. Kept as separate
 * functions because that is how the runtime resolves them — terminal paste and
 * native injection are wired independently — and composed into one port here so
 * the engine depends on the contract rather than the wiring.
 */
export interface TransportPrimitives {
  sendText: (sessionId: string, text: string) => Promise<boolean>;
  capturePane: (sessionId: string) => Promise<string | null>;
  sendEnter: (sessionId: string) => Promise<boolean>;
  readAgentStates: () => Promise<AgentStateBatch>;
}

export function agentDelivery(parts: TransportPrimitives): AgentDelivery {
  return {
    send: (sessionId, text) => parts.sendText(sessionId, text),
    states: () => parts.readAgentStates(),
    probe: (sessionId) => parts.capturePane(sessionId),
    submit: (sessionId) => parts.sendEnter(sessionId)
  };
}
