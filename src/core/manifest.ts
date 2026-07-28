import YAML from 'yaml';
import { checkGlobalUniqueness, isValidSessionId } from '../shared/migration/index.js';
import { shellQuote } from '../shared/shell.js';
import { isSupportedAgent } from './types.js';
import type {
  AgentMcpLaunchConfig,
  AgentProfile,
  BuildSessionOptions,
  DeskGroup,
  DeskManifest,
  DeskProject,
  DeskSession,
  SessionSpec
} from './types.js';
import { deskClaudeSettingsPath } from './agentHooks.js';
import { defaultOpencodeConfigDir, opencodePermissionConfigContent } from './opencodeConfig.js';
import {
  collectSessions,
  type LegacyDeskGroup,
  type LegacyDeskManifest,
  type LegacyDeskSession
} from './sessionIdentity.js';
import {
  isProfileProvider,
  isValidProfileId,
  profileEnvPrefix,
  profileScrubPrefix
} from '../shared/agentProfiles.js';

const MANIFEST_TOP_LEVEL_KEYS = new Set(['settings', 'profiles', 'groups', 'projects']);

export class ManifestValidationError extends Error {
  readonly code = 'manifest-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

export function parseDeskManifest(source: string): DeskManifest {
  const manifest = parseLegacyDeskManifest(source);
  validateRuntimeSessionIdentities(manifest);
  return manifest;
}

/**
 * Migration-only parser for the pre-cutover manifest schema. Runtime callers
 * must use parseDeskManifest, which rejects missing ids and the legacy key.
 */
export function parseLegacyDeskManifest(source: string): LegacyDeskManifest {
  const parsed = YAML.parse(source) as unknown;

  if (!isRecord(parsed)) {
    throw new ManifestValidationError('desk manifest must be an object');
  }

  for (const key of Object.keys(parsed)) {
    if (!MANIFEST_TOP_LEVEL_KEYS.has(key)) {
      throw new ManifestValidationError(`desk manifest has unknown top-level key "${key}"`);
    }
  }

  const manifest = {
    // UI settings live in the manifest so they survive reboots and browsers;
    // every write path spreads the manifest, so parse must carry them through.
    settings: isRecord(parsed.settings) ? (parsed.settings as LegacyDeskManifest['settings']) : undefined,
    // Present-but-not-a-list is a mistake (e.g. an indentation slip turning
    // `groups:` into a scalar), NOT an empty config. Silently coercing it to []
    // dropped every project/session with zero diagnostics, and the next write
    // spread the empty manifest back to disk — permanent data loss. Throw
    // instead; an ABSENT key still means "none".
    // Same rule as groups/projects: absent means none, present-but-not-a-list
    // is a mistake worth throwing rather than silently dropping every profile.
    profiles: requireManifestListOrAbsent(parsed.profiles, 'profiles') as DeskManifest['profiles'],
    groups: (requireManifestListOrAbsent(parsed.groups, 'groups') ?? []) as LegacyDeskManifest['groups'],
    projects: requireManifestListOrAbsent(parsed.projects, 'projects') as LegacyDeskManifest['projects']
  } as LegacyDeskManifest;

  for (const group of manifest.groups) {
    validateGroup(group);
    for (const session of group.sessions) {
      validateSession(group.id, session);
    }
  }

  for (const project of manifest.projects ?? []) {
    if (!project || typeof project.id !== 'string' || project.id.trim() === '') {
      throw new ManifestValidationError('each project requires an id');
    }
    if (typeof project.cwd !== 'string' || project.cwd.trim() === '') {
      throw new ManifestValidationError(`project ${project.id} requires cwd`);
    }
    if (!Array.isArray(project.groups)) {
      throw new ManifestValidationError(`project ${project.id} requires a groups array`);
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

function validateRuntimeSessionIdentities(manifest: LegacyDeskManifest): asserts manifest is DeskManifest {
  const sessions = collectSessions(manifest);
  for (const session of sessions) {
    if (!isValidSessionId(session.sessionId)) {
      const value = session.sessionId === undefined ? 'missing' : JSON.stringify(session.sessionId);
      throw new ManifestValidationError(`session ${session.name} has ${value} sessionId`);
    }
    if ('tmuxSession' in session) {
      throw new ManifestValidationError(`session ${session.name} uses legacy tmuxSession; run the sessionId migration`);
    }
  }
  const unique = checkGlobalUniqueness(sessions.map((session) => session.sessionId!));
  if (!unique.ok) {
    throw new ManifestValidationError(`duplicate sessionId "${unique.duplicate}"`);
  }
  validateAgentProfiles(manifest as DeskManifest, sessions as DeskSession[]);
}

/**
 * Profiles fail CLOSED (R2): an unknown id, a provider that does not match the
 * session's agent, or a profile on a session that has no provider credential
 * store is a manifest error — never a silent fall back to the ambient account,
 * which is exactly the wrong-account outcome profiles exist to prevent.
 */
function validateAgentProfiles(manifest: DeskManifest, sessions: DeskSession[]): void {
  const byId = new Map<string, AgentProfile>();
  for (const profile of manifest.profiles ?? []) {
    if (!isValidProfileId(profile.id)) {
      throw new ManifestValidationError(`profile has an invalid id: ${JSON.stringify(profile.id)}`);
    }
    if (!isProfileProvider(profile.provider)) {
      throw new ManifestValidationError(`profile ${profile.id} has an unsupported provider: ${JSON.stringify(profile.provider)}`);
    }
    if (typeof profile.label !== 'string' || profile.label.trim() === '') {
      throw new ManifestValidationError(`profile ${profile.id} has an empty label`);
    }
    if (byId.has(profile.id)) {
      throw new ManifestValidationError(`duplicate profile id "${profile.id}"`);
    }
    byId.set(profile.id, profile);
  }
  for (const session of sessions) {
    const profileId = session.profileId;
    if (profileId === undefined) {
      continue; // ambient — unchanged behavior
    }
    const profile = byId.get(profileId);
    if (!profile) {
      throw new ManifestValidationError(`session ${session.name} references unknown profile "${profileId}"`);
    }
    if (session.command !== undefined) {
      throw new ManifestValidationError(`session ${session.name} is a custom command and cannot use a profile`);
    }
    if (session.agent !== profile.provider) {
      throw new ManifestValidationError(
        `session ${session.name} uses agent ${session.agent ?? 'none'} but profile ${profileId} is for ${profile.provider}`
      );
    }
  }
}

/** A manifest top-level list (`groups`/`projects`) may be absent (→ undefined,
 *  meaning "none") but if PRESENT must be a list. A present scalar/map is a
 *  hand-edit mistake and throws rather than silently dropping the data. */
function requireManifestListOrAbsent(value: unknown, key: string): unknown[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ManifestValidationError(`desk manifest: "${key}" must be a list`);
  }
  return value;
}

export function buildSessionSpecs(
  manifest: DeskManifest,
  options: BuildSessionOptions
): SessionSpec[] {
  const rootSpecs = manifest.groups.flatMap((group) =>
    group.sessions.map((session) => {
      const cwd = expandHome(session.cwd ?? options.homeDir, options.homeDir);
      const hasCustomCommand = typeof session.command === 'string' && session.command.trim() !== '';
      const command =
        session.command ?? buildAgentCommand(session, cwd, options.homeDir, session.sessionId, options.agentMcp?.(session, cwd));

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
        sessionId: session.sessionId,
        ...(session.profileId ? { profileId: session.profileId } : {}),
        command,
        uiMode: resolveSessionUiMode(session),
        ...(session.model ? { model: session.model } : {})
      };
    })
  );

  const projectSpecs = (manifest.projects ?? []).flatMap((project) =>
    project.groups.flatMap((group) =>
      group.sessions.map((session) =>
        buildProjectSessionSpec({
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

function validateGroup(group: LegacyDeskGroup): void {
  if (!group || typeof group.id !== 'string' || group.id.trim() === '') {
    throw new ManifestValidationError('each group requires an id');
  }
  if (!Array.isArray(group.sessions)) {
    throw new ManifestValidationError(`group ${group.id} requires a sessions array`);
  }
}

function validateSession(groupId: string, session: LegacyDeskSession, inheritedCwd?: string): void {
  if (!session || typeof session.name !== 'string' || session.name.trim() === '') {
    throw new ManifestValidationError(`group ${groupId} has a session without a name`);
  }
  validateSessionUiMode(session);
  if (typeof session.command === 'string' && session.command.trim() !== '') {
    return;
  }
  if ((!inheritedCwd || inheritedCwd.trim() === '') && (typeof session.cwd !== 'string' || session.cwd.trim() === '')) {
    throw new ManifestValidationError(`session ${session.name} requires cwd`);
  }
  if (isSupportedAgent(session.agent)) {
    return;
  }
  throw new ManifestValidationError(`session ${session.name} requires a supported agent or command`);
}

function validateSessionUiMode(session: Pick<DeskSession, 'name' | 'agent' | 'command' | 'uiMode'>): void {
  if (session.uiMode === undefined || session.uiMode === 'terminal') {
    return;
  }
  if (session.uiMode !== 'native') {
    throw new ManifestValidationError(`session ${session.name} has an unknown uiMode; expected terminal or native`);
  }
  if (!sessionSupportsNativeUiMode(session)) {
    throw new ManifestValidationError(
      `session ${session.name} cannot use native uiMode; only codex/claude/opencode agent sessions support it`
    );
  }
}

/** Native UI mode is limited to SDK-backed agents launched without a custom command. */
export function sessionSupportsNativeUiMode(session: Pick<DeskSession, 'agent' | 'command'>): boolean {
  const hasCustomCommand = typeof session.command === 'string' && session.command.trim() !== '';
  return !hasCustomCommand && (session.agent === 'codex' || session.agent === 'claude' || session.agent === 'opencode');
}

/**
 * Undeclared `uiMode` resolves to `terminal`; explicit values always win.
 *
 * Terminal is the default because it is the mode that works for every agent
 * Desk drives: it runs the CLI's own TUI, so anything the CLI can do, the
 * session can do. Native is a richer surface but a narrower one, and it is
 * marked experimental in the session form for the same reason.
 *
 * This has to agree with the wizard. The two disagreed for a while — the form
 * pre-selected `terminal` while an omitted field still resolved to `native` —
 * which gave the product two different answers to "what is the default", one
 * for an operator using the UI and another for an operator editing the
 * manifest by hand.
 */
export function resolveSessionUiMode(session: Pick<DeskSession, 'agent' | 'command' | 'uiMode'>): 'terminal' | 'native' {
  if (session.uiMode === 'native' && sessionSupportsNativeUiMode(session)) {
    return 'native';
  }
  return 'terminal';
}

function buildProjectSessionSpec({
  project,
  group,
  session,
  homeDir,
  agentMcp
}: {
  project: DeskProject;
  group: DeskGroup;
  session: DeskSession;
  homeDir: string;
  agentMcp?: (session: DeskSession, cwd: string) => AgentMcpLaunchConfig | undefined;
}): SessionSpec {
  const cwd = expandHome(session.cwd ?? project.cwd, homeDir);
  const hasCustomCommand = typeof session.command === 'string' && session.command.trim() !== '';
  const command = session.command ?? buildAgentCommand(session, cwd, homeDir, session.sessionId, agentMcp?.(session, cwd));

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
    sessionId: session.sessionId,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    command,
    uiMode: resolveSessionUiMode(session),
    ...(session.model ? { model: session.model } : {})
  };
}

/*
 * No launcher-injected notification setup lives here any more.
 *
 * Two retired paths were removed together:
 *  - Codex was launched with `tui.notification_method=bel`, and Claude with an
 *    inline `--settings` payload that set `preferredNotifChannel: terminal_bell`
 *    and installed curl hooks posting a schema the current route rejects. Both
 *    were the terminal-bell era, and a bell is an edge with no author: any
 *    child process ringing it produces the same byte.
 *  - The inline `--settings` also OVERRODE the managed hooks in the agent's own
 *    settings file, so the launcher could silently replace the installed
 *    producer with a retired one.
 *
 * Agent state now comes from the typed hooks installed by `desk hooks install`
 * (see core/agentHooks.ts) and reaches the authority through the provider
 * adapter. The launcher's job is to start the agent, not to teach it how to
 * report.
 */

export function buildAgentCommand(
  session: DeskSession,
  cwd: string,
  homeDir: string,
  sessionId: string,
  agentMcp?: AgentMcpLaunchConfig
): string {
  if (resolveSessionUiMode(session) === 'native') {
    // Static base only: runtime values (server URL, host token) are injected
    // at spawn time by the server-side rewrite (agentHostLaunch), keeping
    // manifest-derived commands deterministic.
    return `cd ${shellQuote(cwd)} && exec desk agent-host`;
  }
  if (session.agent === 'bash') {
    return `cd ${shellQuote(cwd)} && exec bash`;
  }
  // Profiles prepend a scrub + the provider's credential-dir assignment; the
  // ambient path yields '' so its command is byte-identical to before.
  const env = `${profileCommandPrefix(session, homeDir)}${agentEnvPrefix(session.agent, sessionId)}`;
  if (session.agent === 'claude') {
    // Desk's own settings file, not the operator's. It carries only the hooks
    // Desk needs to learn what the agent is doing; the operator's
    // ~/.claude/settings.json is never written by Desk.
    const args = ['claude', `--settings ${shellQuote(deskClaudeSettingsPath(homeDir))}`];
    if (agentMcp?.claudeConfigPath) {
      args.push('--mcp-config', shellQuote(agentMcp.claudeConfigPath));
    }
    if (session.bypassPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    const baseCommand = args.join(' ');
    if (session.resume) {
      return `cd ${shellQuote(cwd)} && ${buildClaudeResumeCommand(env, baseCommand, session.resume)}`;
    }
    return `cd ${shellQuote(cwd)} && ${env} ${baseCommand}`;
  }
  if (session.agent === 'codex') {
    const args = ['codex'];
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
    return buildOpencodeCommand(session, cwd, homeDir, sessionId);
  }
  throw new ManifestValidationError(`session ${session.name} requires an explicit command`);
}

function buildOpencodeCommand(session: DeskSession, cwd: string, homeDir: string, sessionId: string): string {
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
  const envPrefix = `${agentEnvPrefix(session.agent, sessionId)} OPENCODE_CONFIG_DIR="$desk_opencode_config" OPENCODE_CONFIG_CONTENT=${shellQuote(permissionContent)} OPENCODE_DISABLE_MOUSE=1`;
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

function agentEnvPrefix(agent: string | undefined, sessionId: string): string {
  return `DESK_SESSION_ID=${shellQuote(sessionId)} DESK_AGENT=${shellQuote(agent ?? 'unknown')}`;
}

/**
 * The profile contribution to a terminal launch: scrub inherited provider
 * credentials, then point the CLI at the profile's own directory. Empty for an
 * ambient session, so its command stays byte-identical to pre-profile Desk.
 */
function profileCommandPrefix(session: DeskSession, homeDir: string): string {
  const profileId = session.profileId;
  if (profileId === undefined || !isProfileProvider(session.agent)) {
    return '';
  }
  return `${profileScrubPrefix()} ${profileEnvPrefix(session.agent, profileId, homeDir)} `;
}

function buildClaudeResumeCommand(env: string, baseCommand: string, resume: string): string {
  const resumeArg = shellQuote(resume);
  return [
    `${env} ${baseCommand} --resume ${resumeArg}`,
    'desk_claude_resume_status=$?',
    `if [ "$desk_claude_resume_status" -ne 0 ]; then printf '%s\\n' "desk: exact claude --resume failed with exit $desk_claude_resume_status; leaving pane open for diagnostics" >&2; printf 'desk: claude resume id: %s\\n' ${resumeArg} >&2; exec "\${SHELL:-/bin/sh}"; fi`
  ].join('; ');
}

// shellQuote now lives in ../shared/shell.ts (single audited copy).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
