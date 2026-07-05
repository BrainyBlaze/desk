import YAML from 'yaml';
import type {
  AgentMcpLaunchConfig,
  BuildSessionOptions,
  DeskGroup,
  DeskManifest,
  DeskProject,
  DeskSession,
  SessionSpec
} from './types.js';
import { defaultOpencodeConfigDir, opencodePermissionConfigContent } from './opencodeConfig.js';

const DEFAULT_NAMESPACE = 'agentdesk';

export function parseDeskManifest(source: string): DeskManifest {
  const parsed = YAML.parse(source) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('desk manifest must be an object');
  }

  const manifest = {
    // UI settings live in the manifest so they survive reboots and browsers;
    // every write path spreads the manifest, so parse must carry them through.
    settings: isRecord(parsed.settings) ? (parsed.settings as DeskManifest['settings']) : undefined,
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : undefined
  } as unknown as DeskManifest;

  for (const group of manifest.groups) {
    validateGroup(group);
    for (const session of group.sessions) {
      validateSession(group.id, session);
    }
  }

  for (const project of manifest.projects ?? []) {
    if (!project || typeof project.id !== 'string' || project.id.trim() === '') {
      throw new Error('each project requires an id');
    }
    if (typeof project.cwd !== 'string' || project.cwd.trim() === '') {
      throw new Error(`project ${project.id} requires cwd`);
    }
    if (!Array.isArray(project.groups)) {
      throw new Error(`project ${project.id} requires a groups array`);
    }
    for (const group of project.groups) {
      validateGroup(group);
      for (const session of group.sessions) {
        validateSession(group.id, session, project.cwd);
      }
    }
  }

  return manifest;
}

export function buildSessionSpecs(
  manifest: DeskManifest,
  options: BuildSessionOptions
): SessionSpec[] {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  const rootSpecs = manifest.groups.flatMap((group) =>
    group.sessions.map((session) => {
      const cwd = expandHome(session.cwd ?? options.homeDir, options.homeDir);
      const tmuxSession =
        session.tmuxSession ??
        [
          namespace,
          slugPart(group.id),
          slugPart(session.name),
          session.resume ? session.resume.slice(0, 8) : shortHash(sessionHashSeed(session, cwd))
        ]
          .filter(Boolean)
          .join('-');
      const hasCustomCommand = typeof session.command === 'string' && session.command.trim() !== '';
      const command =
        session.command ?? buildAgentCommand(session, cwd, options.homeDir, tmuxSession, options.agentMcp?.(session, cwd));

      return {
        groupId: group.id,
        groupLabel: group.label ?? group.id,
        groupLayout: group.layout,
        groupOrder: group.order,
        order: session.order,
        name: session.name,
        cwd,
        agent: session.agent,
        resume: session.resume,
        bypassPermissions: session.bypassPermissions,
        ...(hasCustomCommand ? { customCommand: true } : {}),
        tmuxSession,
        command,
        uiMode: session.uiMode ?? 'terminal'
      };
    })
  );

  const projectSpecs = (manifest.projects ?? []).flatMap((project) =>
    project.groups.flatMap((group) =>
      group.sessions.map((session) =>
        buildProjectSessionSpec({
          namespace,
          project,
          group,
          session,
          homeDir: options.homeDir,
          agentMcp: options.agentMcp
        })
      )
    )
  );

  return [...rootSpecs, ...projectSpecs];
}

export function expandHome(path: string, homeDir: string): string {
  if (path === '~') {
    return homeDir;
  }
  if (path.startsWith('~/')) {
    return `${homeDir}${path.slice(1)}`;
  }
  return path;
}

function validateGroup(group: DeskGroup): void {
  if (!group || typeof group.id !== 'string' || group.id.trim() === '') {
    throw new Error('each group requires an id');
  }
  if (!Array.isArray(group.sessions)) {
    throw new Error(`group ${group.id} requires a sessions array`);
  }
}

function validateSession(groupId: string, session: DeskSession, inheritedCwd?: string): void {
  if (!session || typeof session.name !== 'string' || session.name.trim() === '') {
    throw new Error(`group ${groupId} has a session without a name`);
  }
  validateSessionUiMode(session);
  if (typeof session.command === 'string' && session.command.trim() !== '') {
    return;
  }
  if ((!inheritedCwd || inheritedCwd.trim() === '') && (typeof session.cwd !== 'string' || session.cwd.trim() === '')) {
    throw new Error(`session ${session.name} requires cwd`);
  }
  if (session.agent === 'codex' || session.agent === 'claude' || session.agent === 'bash' || session.agent === 'opencode') {
    return;
  }
  throw new Error(`session ${session.name} requires a supported agent or command`);
}

function validateSessionUiMode(session: DeskSession): void {
  if (session.uiMode === undefined || session.uiMode === 'terminal') {
    return;
  }
  if (session.uiMode !== 'native') {
    throw new Error(`session ${session.name} has an unknown uiMode; expected terminal or native`);
  }
  if (!sessionSupportsNativeUiMode(session)) {
    throw new Error(`session ${session.name} cannot use native uiMode; only codex/claude/opencode agent sessions support it`);
  }
}

/** Native UI mode is limited to SDK-backed agents launched without a custom command. */
export function sessionSupportsNativeUiMode(session: Pick<DeskSession, 'agent' | 'command'>): boolean {
  const hasCustomCommand = typeof session.command === 'string' && session.command.trim() !== '';
  return !hasCustomCommand && (session.agent === 'codex' || session.agent === 'claude' || session.agent === 'opencode');
}

function buildProjectSessionSpec({
  namespace,
  project,
  group,
  session,
  homeDir,
  agentMcp
}: {
  namespace: string;
  project: DeskProject;
  group: DeskGroup;
  session: DeskSession;
  homeDir: string;
  agentMcp?: (session: DeskSession, cwd: string) => AgentMcpLaunchConfig | undefined;
}): SessionSpec {
  const cwd = expandHome(session.cwd ?? project.cwd, homeDir);
  const tmuxSession =
    session.tmuxSession ??
    [
      namespace,
      slugPart(project.id),
      slugPart(group.id),
      slugPart(session.name),
      session.resume ? session.resume.slice(0, 8) : shortHash(sessionHashSeed(session, cwd))
    ]
      .filter(Boolean)
      .join('-');
  const hasCustomCommand = typeof session.command === 'string' && session.command.trim() !== '';
  const command = session.command ?? buildAgentCommand(session, cwd, homeDir, tmuxSession, agentMcp?.(session, cwd));

  return {
    projectId: project.id,
    projectLabel: project.label ?? project.id,
    projectCwd: expandHome(project.cwd, homeDir),
    projectOrder: project.order,
    groupId: group.id,
    groupLabel: group.label ?? group.id,
    groupLayout: group.layout,
    groupOrder: group.order,
    order: session.order,
    name: session.name,
    cwd,
    agent: session.agent,
    resume: session.resume,
    bypassPermissions: session.bypassPermissions,
    ...(hasCustomCommand ? { customCommand: true } : {}),
    tmuxSession,
    command,
    uiMode: session.uiMode ?? 'terminal'
  };
}

/**
 * Turn-complete / approval notifications: agents are launched so their TUIs
 * emit a terminal BEL Desk can capture both attached (PTY sniff) and
 * unattached (tmux bell-flag latch). BEL is chosen over OSC 9 because tmux
 * passthrough only delivers to attached clients — background sessions would
 * be silent. Applies to newly started/restarted sessions.
 */
const CODEX_NOTIFICATION_FLAGS =
  '-c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always';

/**
 * Claude Code: hooks are the reliable channel (preferredNotifChannel is a
 * config-store key and silently no-ops via --settings). The hook resolves its
 * own tmux session from the inherited TMUX_PANE and POSTs a typed event to
 * Desk's /api/agent-event (port overridable via DESK_API in the session env).
 */
function claudeEventHook(kind: 'turn-complete' | 'approval-requested'): string {
  return (
    'payload=$(cat); ' +
    'sid=$(printf %s "$payload" | grep -o \'"session_id":"[^"]*"\' | head -1 | cut -d\'"\' -f4); ' +
    's=$(tmux display-message -p -t "$TMUX_PANE" \'#{session_name}\' 2>/dev/null); ' +
    '[ -n "$s" ] && curl -s -m 2 -X POST "${DESK_API:-http://127.0.0.1:5173}/api/agent-event" ' +
    `-H 'content-type: application/json' --data "{\\"session\\":\\"$s\\",\\"kind\\":\\"${kind}\\",\\"sessionId\\":\\"$sid\\"}" >/dev/null 2>&1; exit 0`
  );
}

const CLAUDE_SETTINGS = {
  preferredNotifChannel: 'terminal_bell',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: claudeEventHook('turn-complete') }] }],
    Notification: [
      { matcher: 'permission_prompt', hooks: [{ type: 'command', command: claudeEventHook('approval-requested') }] }
    ]
  }
};

const CLAUDE_NOTIFICATION_FLAGS = `--settings ${shellQuote(JSON.stringify(CLAUDE_SETTINGS))}`;

export function buildAgentCommand(
  session: DeskSession,
  cwd: string,
  homeDir: string,
  tmuxSession: string,
  agentMcp?: AgentMcpLaunchConfig
): string {
  if (session.agent === 'bash') {
    return `cd ${shellQuote(cwd)} && exec bash`;
  }
  const env = agentEnvPrefix(session.agent, tmuxSession);
  if (session.agent === 'claude') {
    const args = ['claude', CLAUDE_NOTIFICATION_FLAGS];
    if (agentMcp?.claudeConfigPath) {
      args.push('--mcp-config', shellQuote(agentMcp.claudeConfigPath));
    }
    if (session.bypassPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (session.resume) {
      args.push('--resume', shellQuote(session.resume));
    }
    return `cd ${shellQuote(cwd)} && ${env} ${args.join(' ')}`;
  }
  if (session.agent === 'codex') {
    const args = ['codex', CODEX_NOTIFICATION_FLAGS];
    if (agentMcp) {
      args.push(
        '-c',
        shellQuote('mcp_servers.desk_lsp.command="desk-lsp-mcp"'),
        '-c',
        shellQuote('mcp_servers.desk_lsp.args=[]'),
        '-c',
        shellQuote(`mcp_servers.desk_lsp.env.DESK_LSP_ENV_FILE="${agentMcp.envFilePath}"`)
      );
    }
    if (session.bypassPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (session.resume) {
      args.push('resume', shellQuote(session.resume));
    }
    return `cd ${shellQuote(cwd)} && ${env} ${args.join(' ')}`;
  }
  if (session.agent === 'opencode') {
    return buildOpencodeCommand(session, cwd, homeDir, tmuxSession);
  }
  throw new Error(`session ${session.name} requires an explicit command`);
}

function buildOpencodeCommand(session: DeskSession, cwd: string, homeDir: string, tmuxSession: string): string {
  const args = ['"$desk_opencode"'];
  const defaultConfigDir = defaultOpencodeConfigDir(homeDir);
  if (session.resume) {
    args.push('--session', shellQuote(session.resume));
  }
  // The bypass-permissions checkbox maps to OpenCode's per-session permission
  // ruleset, delivered inline via OPENCODE_CONFIG_CONTENT (the TUI has no
  // dangerous flag). Default is yolo (only an explicit unchecked box -> ask).
  const bypass = session.bypassPermissions !== false;
  const permissionContent = opencodePermissionConfigContent(bypass);
  const envPrefix = `${agentEnvPrefix(session.agent, tmuxSession)} OPENCODE_CONFIG_DIR="$desk_opencode_config" OPENCODE_CONFIG_CONTENT=${shellQuote(permissionContent)} OPENCODE_DISABLE_MOUSE=1`;
  const launch = session.resume
    ? `${envPrefix} exec ${args.join(' ')}`
    : `if [ -n "\${DESK_OPENCODE_RESUME_ID:-}" ]; then ${envPrefix} exec "$desk_opencode" --session "$DESK_OPENCODE_RESUME_ID"; else ${envPrefix} exec "$desk_opencode"; fi`;
  return [
    `cd ${shellQuote(cwd)}`,
    'desk_opencode="${DESK_OPENCODE_BIN:-$(command -v opencode 2>/dev/null || true)}"',
    'if [ -z "$desk_opencode" ]; then desk_opencode="$HOME/.opencode/bin/opencode"; fi',
    "if [ ! -x \"$desk_opencode\" ]; then printf '%s\\n' 'desk: opencode executable not found; set DESK_OPENCODE_BIN or install opencode' >&2; exit 127; fi",
    'desk_opencode_config="${DESK_OPENCODE_CONFIG_DIR:-}"',
    `if [ -z "$desk_opencode_config" ]; then desk_opencode_config=${shellQuote(defaultConfigDir)}; fi`,
    launch
  ].join(' && ');
}

function agentEnvPrefix(agent: string | undefined, tmuxSession: string): string {
  return `DESK_TMUX_SESSION=${shellQuote(tmuxSession)} DESK_AGENT=${shellQuote(agent ?? 'unknown')}`;
}

function sessionHashSeed(session: DeskSession, cwd: string): string {
  if (session.command) {
    return session.command;
  }
  return [session.agent ?? 'command', session.name, cwd, session.bypassPermissions === false ? 'ask' : 'allow'].join('|');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugPart(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
