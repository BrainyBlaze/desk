export type AgentKind = 'agent' | 'shell';
export type AgentSessionIdShape = 'uuid' | 'opencode' | 'opaque';
export type AgentHooksStyle = 'claude' | 'codex' | 'plugin' | 'qwen' | 'kimi';

export interface AgentDescriptor {
  id: string;
  label: string;
  kind: AgentKind;
  terminalProducer?: string;
  nativeProducer?: string;
  native?: boolean;
  sessionIdField?: string;
  sessionIdShape?: AgentSessionIdShape;
  profileEnvVar?: string;
  hooks?: AgentHooksStyle;
}

export const AGENTS = [
  {
    id: 'codex',
    label: 'codex',
    kind: 'agent',
    terminalProducer: 'codex-hooks',
    nativeProducer: 'codex-native',
    native: true,
    sessionIdField: 'session_id',
    sessionIdShape: 'uuid',
    profileEnvVar: 'CODEX_HOME',
    hooks: 'codex'
  },
  {
    id: 'claude',
    label: 'claude',
    kind: 'agent',
    terminalProducer: 'claude-hooks',
    nativeProducer: 'claude-native',
    native: true,
    sessionIdField: 'session_id',
    sessionIdShape: 'uuid',
    profileEnvVar: 'CLAUDE_CONFIG_DIR',
    hooks: 'claude'
  },
  {
    id: 'opencode',
    label: 'opencode',
    kind: 'agent',
    terminalProducer: 'opencode-terminal',
    nativeProducer: 'opencode-native',
    native: true,
    sessionIdField: 'sessionID',
    sessionIdShape: 'opencode',
    hooks: 'plugin'
  },
  {
    id: 'qwen',
    label: 'qwen',
    kind: 'agent',
    terminalProducer: 'qwen-hooks',
    native: false,
    sessionIdField: 'session_id',
    sessionIdShape: 'uuid',
    profileEnvVar: 'QWEN_HOME',
    hooks: 'qwen'
  },
  {
    id: 'kimi',
    label: 'kimi',
    kind: 'agent',
    terminalProducer: 'kimi-hooks',
    native: false,
    sessionIdField: 'session_id',
    sessionIdShape: 'opaque',
    profileEnvVar: 'KIMI_CODE_HOME',
    hooks: 'kimi'
  },
  {
    id: 'bash',
    label: 'bash',
    kind: 'shell'
  }
] as const satisfies readonly AgentDescriptor[];

export type AgentEntry = (typeof AGENTS)[number];
export type AgentProviderEntry = Extract<AgentEntry, { kind: 'agent' }>;
export type AgentProfileProviderEntry = Extract<AgentProviderEntry, { profileEnvVar: string }>;
export type AgentNativeProviderEntry = Extract<AgentProviderEntry, { nativeProducer: string }>;

export type AgentId = AgentEntry['id'];
export type AgentProviderId = AgentProviderEntry['id'];
export type AgentProfileProviderId = AgentProfileProviderEntry['id'];
export type AgentProducerId =
  | AgentProviderEntry['terminalProducer']
  | AgentNativeProviderEntry['nativeProducer'];

const AGENT_LIST: readonly AgentDescriptor[] = AGENTS;

export const AGENT_IDS = AGENT_LIST.map((agent) => agent.id) as [AgentId, ...AgentId[]];

export const AGENT_PROVIDER_ENTRIES: readonly AgentDescriptor[] = AGENT_LIST.filter(
  (agent) => agent.kind === 'agent'
);

export const AGENT_PROVIDER_IDS = AGENT_PROVIDER_ENTRIES.map((agent) => agent.id) as [
  AgentProviderId,
  ...AgentProviderId[]
];

export const AGENT_PROFILE_PROVIDER_IDS = AGENT_PROVIDER_ENTRIES.filter(
  (agent) => agent.profileEnvVar !== undefined
).map((agent) => agent.id) as [AgentProfileProviderId, ...AgentProfileProviderId[]];

export const AGENT_PRODUCER_IDS = AGENT_PROVIDER_ENTRIES.flatMap((agent) =>
  [agent.terminalProducer, agent.nativeProducer].filter((producer) => producer !== undefined)
) as [AgentProducerId, ...AgentProducerId[]];

export const AGENT_PRODUCER_BINDINGS_TABLE = Object.fromEntries(
  AGENT_PROVIDER_ENTRIES.flatMap((agent) => {
    const provider = agent.id as AgentProviderId;
    const bindings: [string, { provider: AgentProviderId; mode: 'terminal' | 'native' }][] = [];
    if (agent.terminalProducer !== undefined) {
      bindings.push([agent.terminalProducer, { provider, mode: 'terminal' }]);
    }
    if (agent.nativeProducer !== undefined) {
      bindings.push([agent.nativeProducer, { provider, mode: 'native' }]);
    }
    return bindings;
  })
) as Record<AgentProducerId, { provider: AgentProviderId; mode: 'terminal' | 'native' }>;

const AGENT_BY_ID = new Map<string, AgentDescriptor>(AGENT_LIST.map((agent) => [agent.id, agent]));

export function agentById(id: string | undefined): AgentDescriptor | undefined {
  return id === undefined ? undefined : AGENT_BY_ID.get(id);
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_BY_ID.has(value);
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  const entry = typeof value === 'string' ? AGENT_BY_ID.get(value) : undefined;
  return entry?.kind === 'agent';
}

export function agentProvider(id: string | undefined): AgentDescriptor | undefined {
  const entry = agentById(id);
  return entry?.kind === 'agent' ? entry : undefined;
}

export function nativeProducerOf(id: string | undefined): AgentProducerId | undefined {
  return agentProvider(id)?.nativeProducer as AgentProducerId | undefined;
}
