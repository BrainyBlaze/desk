import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  type AgentProducerId,
  AGENT_IDS,
  AGENT_PRODUCER_BINDINGS_TABLE,
  AGENT_PRODUCER_IDS,
  AGENT_PROVIDER_ENTRIES,
  AGENT_PROVIDER_IDS
} from '../src/shared/agentRegistry.js';

describe('agent registry invariants', () => {
  it('keeps agent ids unique and provider ids a strict subset', () => {
    expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length);
    expect(new Set(AGENT_PROVIDER_IDS).size).toBe(AGENT_PROVIDER_IDS.length);
    for (const id of AGENT_PROVIDER_IDS) {
      expect(AGENT_IDS).toContain(id);
    }
  });

  it('keeps producer ids unique and bound back to their provider', () => {
    expect(new Set(AGENT_PRODUCER_IDS).size).toBe(AGENT_PRODUCER_IDS.length);
    for (const agent of AGENT_PROVIDER_ENTRIES) {
      if (agent.terminalProducer !== undefined) {
        expect(AGENT_PRODUCER_BINDINGS_TABLE[agent.terminalProducer as AgentProducerId]).toEqual({
          provider: agent.id,
          mode: 'terminal'
        });
      }
      if (agent.nativeProducer !== undefined) {
        expect(AGENT_PRODUCER_BINDINGS_TABLE[agent.nativeProducer as AgentProducerId]).toEqual({
          provider: agent.id,
          mode: 'native'
        });
      }
    }
    expect(Object.keys(AGENT_PRODUCER_BINDINGS_TABLE).sort()).toEqual([...AGENT_PRODUCER_IDS].sort());
  });

  it('gives every provider the fields the launch and identity seams rely on', () => {
    for (const agent of AGENT_PROVIDER_ENTRIES) {
      expect(agent.terminalProducer, `${agent.id} terminalProducer`).toBeDefined();
      expect(agent.sessionIdField, `${agent.id} sessionIdField`).toBeDefined();
      expect(agent.sessionIdShape, `${agent.id} sessionIdShape`).toBeDefined();
      expect(agent.hooks, `${agent.id} hooks`).toBeDefined();
      if (agent.launch !== undefined && agent.bypass === true) {
        expect(agent.launch.bypassFlag, `${agent.id} bypassFlag`).toBeDefined();
      }
    }
  });

  it('keeps shell entries out of every provider projection', () => {
    for (const agent of AGENTS) {
      if (agent.kind === 'shell') {
        expect(AGENT_PROVIDER_IDS).not.toContain(agent.id);
      }
    }
  });
});
