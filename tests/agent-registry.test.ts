import { describe, expect, it } from 'vitest';
import {
  AGENTS,
  AGENT_IDS,
  AGENT_PRODUCER_BINDINGS_TABLE,
  AGENT_PRODUCER_IDS,
  AGENT_PROVIDER_ENTRIES,
  AGENT_PROVIDER_IDS,
  agentProvider,
  nativeProducerOf,
  terminalProducerOf
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
      const terminalProducer = terminalProducerOf(agent.id)!;
      expect(AGENT_PRODUCER_BINDINGS_TABLE[terminalProducer]).toEqual({
        provider: agent.id,
        mode: 'terminal'
      });
      const nativeProducer = nativeProducerOf(agent.id);
      if (nativeProducer !== undefined) {
        expect(AGENT_PRODUCER_BINDINGS_TABLE[nativeProducer]).toEqual({
          provider: agent.id,
          mode: 'native'
        });
      }
    }
    expect(Object.keys(AGENT_PRODUCER_BINDINGS_TABLE).sort()).toEqual([...AGENT_PRODUCER_IDS].sort());
  });

  it('gives every provider the fields the launch and identity seams rely on', () => {
    expect(
      Object.fromEntries(
        AGENT_PROVIDER_IDS.map((id) => {
          const agent = agentProvider(id)!;
          return [
            id,
            {
              launcher: agent.launcher.kind,
              surfaces: agent.surfaces.kind,
              permissions: agent.permissions.kind,
              profile: agent.profile.kind,
              identity: agent.identity.kind
            }
          ];
        })
      )
    ).toEqual({
      codex: {
        launcher: 'managed',
        surfaces: 'terminal-native',
        permissions: 'bypass',
        profile: 'directory',
        identity: 'hooks'
      },
      claude: {
        launcher: 'managed',
        surfaces: 'terminal-native',
        permissions: 'bypass',
        profile: 'directory',
        identity: 'hooks'
      },
      opencode: {
        launcher: 'managed',
        surfaces: 'terminal-native',
        permissions: 'bypass',
        profile: 'none',
        identity: 'plugin'
      },
      qwen: {
        launcher: 'cli',
        surfaces: 'terminal',
        permissions: 'bypass',
        profile: 'none',
        identity: 'hooks'
      },
      kimi: {
        launcher: 'cli',
        surfaces: 'terminal',
        permissions: 'bypass',
        profile: 'none',
        identity: 'hooks'
      },
      grok: {
        launcher: 'cli',
        surfaces: 'terminal',
        permissions: 'uncontrolled',
        profile: 'none',
        identity: 'hooks'
      }
    });

    for (const agent of AGENT_PROVIDER_ENTRIES) {
      expect(agent).not.toHaveProperty('terminalProducer');
      expect(agent).not.toHaveProperty('nativeProducer');
      expect(agent).not.toHaveProperty('bypass');
      expect(agent).not.toHaveProperty('sessionIdField');
      expect(agent).not.toHaveProperty('sessionIdShape');
      expect(agent).not.toHaveProperty('profileEnvVar');
      expect(agent).not.toHaveProperty('hooks');
      expect(agent).not.toHaveProperty('launch');
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
