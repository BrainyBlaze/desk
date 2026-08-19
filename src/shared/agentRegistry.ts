export type AgentSessionIdShape = 'uuid' | 'opencode' | 'opaque';
export type AgentHooksStyle = 'claude' | 'codex' | 'qwen' | 'kimi' | 'grok';

type ManagedLauncher = {
  readonly kind: 'managed';
  readonly driver: 'codex' | 'claude' | 'opencode';
};

type CliLauncher = {
  readonly kind: 'cli';
  readonly executable: 'qwen' | 'kimi' | 'grok';
  readonly resumeFlag: '--resume' | '--session';
  readonly lsp: { readonly kind: 'none' } | { readonly kind: 'settings-env' };
};

type TerminalSurface = {
  readonly kind: 'terminal';
  readonly producer: string;
};

type TerminalNativeSurface = {
  readonly kind: 'terminal-native';
  readonly terminalProducer: string;
  readonly nativeProducer: string;
};

type BypassPermissions = {
  readonly kind: 'bypass';
  readonly mechanism:
    | { readonly kind: 'managed' }
    | { readonly kind: 'flag'; readonly flag: '--yolo' };
};

type UncontrolledPermissions = {
  readonly kind: 'uncontrolled';
  readonly reason: 'no-approval-model';
};

type DirectoryProfile = {
  readonly kind: 'directory';
  readonly envVar: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR';
};

type NoProfile = { readonly kind: 'none' };

type HookIdentity = {
  readonly kind: 'hooks';
  readonly hooksStyle: AgentHooksStyle;
  readonly payloadField: 'session_id';
  readonly sessionIdShape: Exclude<AgentSessionIdShape, 'opencode'>;
};

type PluginIdentity = {
  readonly kind: 'plugin';
  readonly hooksStyle: 'plugin';
  readonly payloadField: 'sessionID';
  readonly sessionIdShape: 'opencode';
};

interface ProviderDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: 'provider';
  readonly launcher: ManagedLauncher | CliLauncher;
  readonly surfaces: TerminalSurface | TerminalNativeSurface;
  readonly permissions: BypassPermissions | UncontrolledPermissions;
  readonly profile: DirectoryProfile | NoProfile;
  readonly identity: HookIdentity | PluginIdentity;
}

interface ShellDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: 'shell';
}

export const AGENTS = [
  {
    id: 'codex',
    label: 'codex',
    kind: 'provider',
    launcher: { kind: 'managed', driver: 'codex' },
    surfaces: {
      kind: 'terminal-native',
      terminalProducer: 'codex-hooks',
      nativeProducer: 'codex-native'
    },
    permissions: { kind: 'bypass', mechanism: { kind: 'managed' } },
    profile: { kind: 'directory', envVar: 'CODEX_HOME' },
    identity: {
      kind: 'hooks',
      hooksStyle: 'codex',
      payloadField: 'session_id',
      sessionIdShape: 'uuid'
    }
  },
  {
    id: 'claude',
    label: 'claude',
    kind: 'provider',
    launcher: { kind: 'managed', driver: 'claude' },
    surfaces: {
      kind: 'terminal-native',
      terminalProducer: 'claude-hooks',
      nativeProducer: 'claude-native'
    },
    permissions: { kind: 'bypass', mechanism: { kind: 'managed' } },
    profile: { kind: 'directory', envVar: 'CLAUDE_CONFIG_DIR' },
    identity: {
      kind: 'hooks',
      hooksStyle: 'claude',
      payloadField: 'session_id',
      sessionIdShape: 'uuid'
    }
  },
  {
    id: 'opencode',
    label: 'opencode',
    kind: 'provider',
    launcher: { kind: 'managed', driver: 'opencode' },
    surfaces: {
      kind: 'terminal-native',
      terminalProducer: 'opencode-terminal',
      nativeProducer: 'opencode-native'
    },
    permissions: { kind: 'bypass', mechanism: { kind: 'managed' } },
    profile: { kind: 'none' },
    identity: {
      kind: 'plugin',
      hooksStyle: 'plugin',
      payloadField: 'sessionID',
      sessionIdShape: 'opencode'
    }
  },
  {
    id: 'qwen',
    label: 'qwen',
    kind: 'provider',
    launcher: {
      kind: 'cli',
      executable: 'qwen',
      resumeFlag: '--resume',
      lsp: { kind: 'settings-env' }
    },
    surfaces: { kind: 'terminal', producer: 'qwen-hooks' },
    permissions: {
      kind: 'bypass',
      mechanism: { kind: 'flag', flag: '--yolo' }
    },
    profile: { kind: 'none' },
    identity: {
      kind: 'hooks',
      hooksStyle: 'qwen',
      payloadField: 'session_id',
      sessionIdShape: 'uuid'
    }
  },
  {
    id: 'kimi',
    label: 'kimi',
    kind: 'provider',
    launcher: {
      kind: 'cli',
      executable: 'kimi',
      resumeFlag: '--session',
      lsp: { kind: 'none' }
    },
    surfaces: { kind: 'terminal', producer: 'kimi-hooks' },
    permissions: {
      kind: 'bypass',
      mechanism: { kind: 'flag', flag: '--yolo' }
    },
    profile: { kind: 'none' },
    identity: {
      kind: 'hooks',
      hooksStyle: 'kimi',
      payloadField: 'session_id',
      sessionIdShape: 'opaque'
    }
  },
  {
    id: 'grok',
    label: 'grok',
    kind: 'provider',
    launcher: {
      kind: 'cli',
      executable: 'grok',
      resumeFlag: '--session',
      lsp: { kind: 'none' }
    },
    surfaces: { kind: 'terminal', producer: 'grok-hooks' },
    permissions: { kind: 'uncontrolled', reason: 'no-approval-model' },
    profile: { kind: 'none' },
    identity: {
      kind: 'hooks',
      hooksStyle: 'grok',
      payloadField: 'session_id',
      sessionIdShape: 'opaque'
    }
  },
  { id: 'bash', label: 'bash', kind: 'shell' }
] as const satisfies readonly (ProviderDefinition | ShellDefinition)[];

type AgentEntry = (typeof AGENTS)[number];
export type AgentProviderEntry = Extract<AgentEntry, { kind: 'provider' }>;
export type AgentManagedProviderEntry = Extract<
  AgentProviderEntry,
  { launcher: { kind: 'managed' } }
>;
export type AgentNativeProviderEntry = Extract<
  AgentProviderEntry,
  { surfaces: { kind: 'terminal-native' } }
>;
export type AgentProfileProviderEntry = Extract<
  AgentProviderEntry,
  { profile: { kind: 'directory' } }
>;
export type AgentHookIdentityEntry = Extract<
  AgentProviderEntry,
  { identity: { kind: 'hooks' } }
>;

export type AgentId = AgentEntry['id'];
export type AgentProviderId = AgentProviderEntry['id'];
export type AgentManagedProviderId = AgentManagedProviderEntry['id'];
export type AgentNativeProviderId = AgentNativeProviderEntry['id'];
export type AgentProfileProviderId = AgentProfileProviderEntry['id'];

type TerminalProducerOf<T> = T extends {
  surfaces: { kind: 'terminal'; producer: infer Producer extends string };
}
  ? Producer
  : T extends {
        surfaces: {
          kind: 'terminal-native';
          terminalProducer: infer Producer extends string;
        };
      }
    ? Producer
    : never;

type NativeProducerOf<T> = T extends {
  surfaces: {
    kind: 'terminal-native';
    nativeProducer: infer Producer extends string;
  };
}
  ? Producer
  : never;

export type AgentProducerId =
  | TerminalProducerOf<AgentProviderEntry>
  | NativeProducerOf<AgentProviderEntry>;

export const AGENT_IDS = AGENTS.map((agent) => agent.id) as [AgentId, ...AgentId[]];

export const AGENT_PROVIDER_ENTRIES = AGENTS.filter(
  (agent): agent is AgentProviderEntry => agent.kind === 'provider'
);

export const AGENT_PROVIDER_IDS = AGENT_PROVIDER_ENTRIES.map((agent) => agent.id) as [
  AgentProviderId,
  ...AgentProviderId[]
];

export const AGENT_NATIVE_PROVIDER_IDS = AGENT_PROVIDER_ENTRIES.filter(
  (agent): agent is AgentNativeProviderEntry => agent.surfaces.kind === 'terminal-native'
).map((agent) => agent.id) as [AgentNativeProviderId, ...AgentNativeProviderId[]];

export const AGENT_PROFILE_PROVIDER_IDS = AGENT_PROVIDER_ENTRIES.filter(
  (agent): agent is AgentProfileProviderEntry => agent.profile.kind === 'directory'
).map((agent) => agent.id) as [AgentProfileProviderId, ...AgentProfileProviderId[]];

type AgentProducerBinding = readonly [
  AgentProducerId,
  { readonly provider: AgentProviderId; readonly mode: 'terminal' | 'native' }
];

function producerBindingsFor(agent: AgentProviderEntry): AgentProducerBinding[] {
  if (agent.surfaces.kind === 'terminal') {
    return [
      [agent.surfaces.producer, { provider: agent.id, mode: 'terminal' as const }]
    ];
  }
  return [
    [
      agent.surfaces.terminalProducer,
      { provider: agent.id, mode: 'terminal' as const }
    ],
    [
      agent.surfaces.nativeProducer,
      { provider: agent.id, mode: 'native' as const }
    ]
  ];
}

const PRODUCER_BINDINGS = AGENT_PROVIDER_ENTRIES.flatMap(producerBindingsFor);

export const AGENT_PRODUCER_BINDINGS_TABLE = Object.fromEntries(
  PRODUCER_BINDINGS
) as Record<
  AgentProducerId,
  { provider: AgentProviderId; mode: 'terminal' | 'native' }
>;

export const AGENT_PRODUCER_IDS = PRODUCER_BINDINGS.map(([producer]) => producer) as [
  AgentProducerId,
  ...AgentProducerId[]
];

const AGENT_BY_ID = new Map<string, AgentEntry>(
  AGENTS.map((agent) => [agent.id, agent])
);

export function agentById(id: string | undefined): AgentEntry | undefined {
  return id === undefined ? undefined : AGENT_BY_ID.get(id);
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_BY_ID.has(value);
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return agentById(typeof value === 'string' ? value : undefined)?.kind === 'provider';
}

export function isAgentNativeProviderId(value: unknown): value is AgentNativeProviderId {
  return typeof value === 'string' && nativeProducerOf(value) !== undefined;
}

export function agentProvider(id: string | undefined): AgentProviderEntry | undefined {
  const entry = agentById(id);
  return entry?.kind === 'provider' ? entry : undefined;
}

export function terminalProducerOf(id: string | undefined): AgentProducerId | undefined {
  const surfaces = agentProvider(id)?.surfaces;
  if (surfaces === undefined) return undefined;
  return (surfaces.kind === 'terminal'
    ? surfaces.producer
    : surfaces.terminalProducer) as AgentProducerId;
}

export function nativeProducerOf(id: string | undefined): AgentProducerId | undefined {
  const surfaces = agentProvider(id)?.surfaces;
  return surfaces?.kind === 'terminal-native'
    ? (surfaces.nativeProducer as AgentProducerId)
    : undefined;
}

export function profileEnvVarOf(
  id: string | undefined
): DirectoryProfile['envVar'] | undefined {
  const profile = agentProvider(id)?.profile;
  return profile?.kind === 'directory' ? profile.envVar : undefined;
}

export function providerSupportsBypass(id: string | undefined): boolean {
  return agentProvider(id)?.permissions.kind === 'bypass';
}
