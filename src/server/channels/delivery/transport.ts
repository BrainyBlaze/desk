// What actually reaches an agent.
//
// Everything the engine can do TO a session, as one contract: submit one
// complete prompt and read what the authority says it is doing. Nothing here knows about
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

}

/**
 * The transport primitives as the engine receives them. Kept as separate
 * functions because that is how the runtime resolves them — terminal paste and
 * native injection are wired independently — and composed into one port here so
 * the engine depends on the contract rather than the wiring.
 */
export interface TransportPrimitives {
  sendText: (sessionId: string, text: string) => Promise<boolean>;
  readAgentStates: () => Promise<AgentStateBatch>;
}

export function agentDelivery(parts: TransportPrimitives): AgentDelivery {
  return {
    send: (sessionId, text) => parts.sendText(sessionId, text),
    states: () => parts.readAgentStates()
  };
}
