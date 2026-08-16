import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { CLAUDE_NOTIFICATION_MATCHERS } from './agentState/claudeFacts.js';
import { buildOpencodeAttentionPlugin } from './agentState/opencodeProducer.js';
import { defaultOpencodeConfigDir } from './opencodeConfig.js';
import { buildProducerRuntime } from './agentState/producerEmit.js';
import { shellQuote } from '../shared/shell.js';
import { writeTextFileAtomic } from '../shared/atomicFile.js';
import { withFileLockSync } from '../shared/fileLock.js';
import { PROVIDER_SESSION_ID_PAYLOAD_FIELD } from '../shared/providerSessionIdentity.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface HookHandler {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export interface CodexHooksConfig {
  hooks: {
    SessionStart: HookGroup[];
    UserPromptSubmit: HookGroup[];
    PreToolUse: HookGroup[];
    PostToolUse: HookGroup[];
    PermissionRequest: HookGroup[];
    Stop: HookGroup[];
    SessionEnd: HookGroup[];
  };
}

export interface ClaudeHooksSettings {
  hooks: {
    SessionStart: HookGroup[];
    UserPromptSubmit: HookGroup[];
    PreToolUse: HookGroup[];
    PostToolUse: HookGroup[];
    PostToolUseFailure: HookGroup[];
    PostToolBatch: HookGroup[];
    PermissionRequest: HookGroup[];
    Notification: HookGroup[];
    Stop: HookGroup[];
    StopFailure: HookGroup[];
    SessionEnd: HookGroup[];
  };
}

export type HookPreflightStatus =
  | { active: true }
  | { active: false; degradedReason: 'hook-not-installed' | 'codex-hook-untrusted' | 'hook-not-firing' };

export interface InstallAgentHooksOptions {
  homeDir?: string;
  shimPath?: string;
}

export interface InstalledAgentHooks {
  shimPath: string;
  codexHooksPath: string;
  claudeSettingsPath: string;
  opencodePluginPath: string;
  /** Config paths that were NOT written because their existing content was
   *  malformed JSON (a .bak was made). The caller must report these honestly. */
  skipped: string[];
}

/**
 * The shim is an ES module (`.mjs`): the shared producer runtime imports
 * node:fs to keep its sequence durable, and node decides module type by
 * extension. An extensionless file would be parsed as CommonJS and fail on the
 * first import — silently, since a hook's failure never breaks the agent.
 */
const DESK_SHIM_BASENAME = 'desk-agent-event';

/**
 * Desk's OWN Claude settings file, handed to the CLI with `--settings` at
 * launch.
 *
 * Desk does not write `~/.claude/settings.json`. That file is the operator's —
 * their credentials, their model, their hooks — and a tool that installs its
 * reporting by editing it has taken something it was not given. The launch
 * flag achieves the same result for the session Desk starts, and leaves the
 * operator's file exactly as they wrote it.
 */
export function deskClaudeSettingsPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'desk', 'claude', 'settings.json');
}

export function defaultAgentEventShimPath(homeDir: string = homedir()): string {
  return join(homeDir, '.local', 'share', 'desk', 'hooks', `${DESK_SHIM_BASENAME}.mjs`);
}

/** Shim files earlier Desk versions wrote, removed so a stale one cannot run. */
function removeRetiredShims(homeDir: string, currentShimPath: string): void {
  const retired = [join(homeDir, '.local', 'share', 'desk', 'hooks', DESK_SHIM_BASENAME)];
  for (const path of retired) {
    if (path !== currentShimPath) {
      rmSync(path, { force: true });
    }
  }
}

// shellQuote now lives in ../shared/shell.ts (single audited copy).

function command(shimPath: string, agent: string, event: string): string {
  return `${shellQuote(shimPath)} --agent ${shellQuote(agent)} --event ${shellQuote(event)}`;
}

function commandHook(shimPath: string, agent: string, event: string, timeout = 2): HookHandler {
  return { type: 'command', command: command(shimPath, agent, event), timeout };
}

/**
 * The Codex hook set. `PreToolUse`/`PostToolUse` give Codex the same heartbeat
 * Claude has, and `SessionEnd` retires the producer — all three are present in
 * the Codex CLI (verified against the shipped binary's hook event names in
 * 0.145.0; an earlier Desk comment claiming `SessionEnd` was unsupported was
 * wrong). `Notification` also exists but is not subscribed here: its matcher
 * vocabulary is unverified, and subscribing to a discriminant nobody has read
 * would put a guess into the one place this design forbids guessing.
 */
export function buildCodexHooksConfig(shimPath: string): CodexHooksConfig {
  const hook = (event: string): HookGroup[] => [{ hooks: [commandHook(shimPath, 'codex', event)] }];
  return {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [commandHook(shimPath, 'codex', 'SessionStart')] }],
      UserPromptSubmit: hook('UserPromptSubmit'),
      PreToolUse: hook('PreToolUse'),
      PostToolUse: hook('PostToolUse'),
      PermissionRequest: hook('PermissionRequest'),
      Stop: hook('Stop'),
      SessionEnd: hook('SessionEnd')
    }
  };
}

/**
 * The Claude hook set. `PreToolUse`/`PostToolUse` are the heartbeat: between
 * `UserPromptSubmit` and `Stop` they are the only typed proof that a long turn
 * is still running, and without them a working session has no evidence at all
 * once the turn outlives the authority's lease window.
 *
 * The notification matchers are the full actionable set, not a subset:
 * `agent_needs_input` and `agent_completed` are how a session announces that it
 * is waiting on the human without opening a dialog.
 */
export function buildClaudeHooksSettings(shimPath: string): ClaudeHooksSettings {
  const hook = (event: string): HookGroup[] => [{ hooks: [commandHook(shimPath, 'claude', event)] }];
  return {
    hooks: {
      SessionStart: hook('SessionStart'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      PreToolUse: hook('PreToolUse'),
      PostToolUse: hook('PostToolUse'),
      // A failed tool still ENDS its interval. Without this every failing tool
      // call leaks an open interval and the session sits on the long open-tool
      // ceiling instead of its short working lease.
      PostToolUseFailure: hook('PostToolUseFailure'),
      PostToolBatch: hook('PostToolBatch'),
      PermissionRequest: hook('PermissionRequest'),
      Notification: CLAUDE_NOTIFICATION_MATCHERS.map((matcher) => ({
        matcher,
        hooks: [commandHook(shimPath, 'claude', 'Notification')]
      })),
      Stop: hook('Stop'),
      StopFailure: hook('StopFailure'),
      SessionEnd: hook('SessionEnd')
    }
  };
}

export function codexHookPreflightStatus(input: {
  installed: boolean;
  trusted: boolean;
  /** The authority has accepted at least one canonical event from this producer. */
  producerEvidenceSeen: boolean;
}): HookPreflightStatus {
  if (!input.installed) {
    return { active: false, degradedReason: 'hook-not-installed' };
  }
  if (!input.trusted) {
    return { active: false, degradedReason: 'codex-hook-untrusted' };
  }
  if (!input.producerEvidenceSeen) {
    return { active: false, degradedReason: 'hook-not-firing' };
  }
  return { active: true };
}

export type HookProbeProvider = 'claude' | 'codex' | 'opencode';

/**
 * What the filesystem can honestly say about a provider's trust records.
 *
 * `absent` is PROVABLE: no record names this hooks file, so nothing in it has
 * ever been trusted. `recorded` is only suggestive — the records name a file
 * and an event, not which hook inside it, and the stored hash is Codex's to
 * verify, not ours. So a probe may DOWNGRADE confidence; only evidence the
 * authority actually accepted may raise it.
 */
export type HookTrustSignal = 'recorded' | 'absent' | 'not-applicable';

export interface HookInstallationProbe {
  provider: HookProbeProvider;
  /** Desk's hook wiring is present and points at the CURRENT shim. */
  installed: boolean;
  trust: HookTrustSignal;
  /** Operator-facing explanation when something is missing. */
  detail?: string;
}

/**
 * Read-only inspection of Desk's own hook wiring. It never writes, never
 * installs, and never touches `~/.claude/settings.json` — that file belongs to
 * the operator, and Desk keeps its Claude hooks in its own file.
 *
 * Its purpose is to turn a silent `unknown` into an explained one: a session
 * whose producer was never installed should say so, not sit blank while the
 * operator wonders which command they forgot.
 */
export function probeHookInstallation(
  provider: HookProbeProvider,
  homeDir: string = homedir()
): HookInstallationProbe {
  // OpenCode's plugin is SELF-CONTAINED: it never invokes the shim, so a
  // missing shim says nothing about it. Gating every provider on the shim
  // would report a working OpenCode producer as uninstalled.
  if (provider === 'opencode') {
    return probeOpencodePlugin(homeDir);
  }
  const shimPath = defaultAgentEventShimPath(homeDir);
  if (!existsSync(shimPath)) {
    return { provider, installed: false, trust: 'not-applicable', detail: 'event shim is not installed' };
  }
  if (provider === 'claude') {
    const installed = hookConfigInvokes(deskClaudeSettingsPath(homeDir), shimPath);
    return {
      provider,
      installed,
      trust: 'not-applicable',
      ...(installed ? {} : { detail: 'desk-owned claude settings do not invoke the current shim' })
    };
  }
  const codexHooksPath = join(homeDir, '.codex', 'hooks.json');
  const installed = hookConfigInvokes(codexHooksPath, shimPath);
  return {
    provider,
    installed,
    trust: codexTrustSignal(homeDir, codexHooksPath),
    ...(installed ? {} : { detail: 'codex hooks.json does not invoke the current shim' })
  };
}

/**
 * Where OpenCode will actually look for the plugin.
 *
 * NOT `~/.config/opencode` — that is the operator's own OpenCode config, and
 * Desk-launched sessions never read it. Desk hands OpenCode its own config root
 * via `OPENCODE_CONFIG_DIR` (see `buildAgentCommand`), so the installer has
 * exactly one correct target and it is whatever the launch command says.
 *
 * These two halves disagreed once: the installer wrote a current plugin to the
 * operator's directory while every session loaded a stale one from Desk's, and
 * `desk hooks install` reported success throughout. Deriving the path from the
 * same helper the launcher uses is what keeps that from recurring — the
 * override is honoured for the same reason, since it moves the read side.
 */
function opencodePluginPathFor(homeDir: string): string {
  const configDir = process.env.DESK_OPENCODE_CONFIG_DIR?.trim() || defaultOpencodeConfigDir(homeDir);
  return join(configDir, 'plugin', 'desk-attention.js');
}

/**
 * The installed plugin must BE the current one, byte for byte.
 *
 * Presence is not installation: a plugin from an earlier release sits at the
 * same path, loads, and speaks a retired schema — reporting it as installed
 * would tell the operator the producer is fine while every event it sends is
 * rejected. Desk writes this file whole, so equality is exact and cheap.
 */
function probeOpencodePlugin(homeDir: string): HookInstallationProbe {
  const pluginPath = opencodePluginPathFor(homeDir);
  let contents: string;
  try {
    contents = readFileSync(pluginPath, 'utf8');
  } catch {
    return {
      provider: 'opencode',
      installed: false,
      trust: 'not-applicable',
      detail: 'opencode attention plugin is not installed'
    };
  }
  if (contents !== buildOpencodeAttentionPlugin()) {
    return {
      provider: 'opencode',
      installed: false,
      trust: 'not-applicable',
      detail: 'installed opencode plugin is from a different Desk build'
    };
  }
  return { provider: 'opencode', installed: true, trust: 'not-applicable' };
}

/**
 * Does this hook config actually INVOKE the shim?
 *
 * Substring matching cannot tell a live hook from a dead one: a file that
 * merely CONTAINS the path — in a comment, in an abandoned entry, or in JSON
 * too malformed for the agent to load at all — would report installed while
 * nothing runs. The structure is what the agent reads, so the structure is
 * what gets checked.
 */
function hookConfigInvokes(path: string, shimPath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Unreadable OR unparseable: the agent cannot load it either.
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    return false;
  }
  for (const groups of Object.values(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isRecord(hook) && hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes(shimPath)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Codex records hook trust as `[hooks.state."<hooksPath>:<event>:<i>:<j>"]`.
 * Scanned as text on purpose: Desk has no TOML parser, and the only question
 * asked here — does ANY record name this file — needs none.
 */
function codexTrustSignal(homeDir: string, codexHooksPath: string): HookTrustSignal {
  let config: string;
  try {
    config = readFileSync(join(homeDir, '.codex', 'config.toml'), 'utf8');
  } catch {
    return 'absent';
  }
  return config.includes(`[hooks.state."${codexHooksPath}:`) ? 'recorded' : 'absent';
}

export function installAgentHooks(options: InstallAgentHooksOptions = {}): InstalledAgentHooks {
  const homeDir = options.homeDir ?? homedir();
  const shimPath = options.shimPath ?? defaultAgentEventShimPath(homeDir);
  const codexHooksPath = join(homeDir, '.codex', 'hooks.json');
  const claudeSettingsPath = deskClaudeSettingsPath(homeDir);
  const opencodePluginPath = opencodePluginPathFor(homeDir);

  writeExecutable(shimPath, buildDeskAgentEventShim());
  removeRetiredShims(homeDir, shimPath);
  const skipped: string[] = [];
  if (mergeHookConfig(codexHooksPath, buildCodexHooksConfig(shimPath), shimPath) === 'skipped-malformed') {
    skipped.push(codexHooksPath);
  }
  // Desk-OWNED file, written whole. The operator's ~/.claude/settings.json is
  // never touched: it holds their auth, their model, their own hooks, and Desk
  // has no business editing it to install its own reporting.
  writeTextIfChanged(claudeSettingsPath, `${JSON.stringify(buildClaudeHooksSettings(shimPath), null, 2)}\n`);
  writeTextIfChanged(opencodePluginPath, buildOpencodeAttentionPlugin());

  return { shimPath, codexHooksPath, claudeSettingsPath, opencodePluginPath, skipped };
}

/**
 * The hook shim Claude and Codex invoke.
 *
 * It reports and does not judge: the hook name and a bounded slice of the
 * payload's discriminating fields go to Desk, and what they MEAN is decided by
 * the provider adapter on the server, under test. Deciding here — inside the
 * agent process, where no Desk test can reach — is how a mapping arm can be
 * wrong for months without anything failing.
 */
export function buildDeskAgentEventShim(): string {
  return `#!/usr/bin/env node
${buildProducerRuntime()}
const DESK_PROVIDER_SESSION_ID_FIELDS = ${JSON.stringify(PROVIDER_SESSION_ID_PAYLOAD_FIELD)};
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const hook = arg('--event') || '';
  // The ARGUMENT is the only source of the provider. Desk writes the --agent
  // flag into the hook command at install time, so it states which provider
  // this specific hook belongs to; DESK_AGENT is ambient and describes
  // whatever session happens to surround the process. Reading it — even as
  // a fallback for a hand-written hook that names no agent — mislabels the
  // producer of any hook that fires under a different session's environment
  // (a nested shell, a spawned helper), and a mislabelled producer is worse
  // than a silent one, because it is accepted as evidence about the wrong
  // agent. An agent-less hook is therefore unattributed and stays silent.
  deskUseProvider(arg('--agent') || '');
  if (!hook) {
    finish(hook);
    return;
  }
  let input = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    input = {};
  }
  const observation = {
    hook: hook,
    matcher: deskBounded(discriminantOf(hook, input)),
    message: deskBounded(input.message),
    tool: deskBounded(input.tool_name),
    toolUseId: deskBounded(input.tool_use_id),
    turnId: deskBounded(input.turn_id || input.turnId),
    providerSessionId: deskBounded(
      input[DESK_PROVIDER_SESSION_ID_FIELDS[DESK_PROVIDER]]
    ),
    notificationId: notificationIdFromPrompt(input.prompt)
  };
  // No throttling. A tool edge is an INTERVAL boundary, not a beat: dropping
  // one leaves an interval open (or closes nothing), and the authority pairs
  // edges by id. Throttling was also inert here — the shim is a one-shot
  // process, so its window reset on every invocation.
  await deskPost(observation);
  finish(hook);
});
process.stdin.resume();

/**
 * The field carrying the event's matcher value. Notification's is verified
 * (notification_type); the others are read from the candidates a hook payload
 * may use. An unrecognised discriminant costs only the REASON on a degraded
 * turn — the activity itself comes from the hook name, so a miss here reports
 * a finished turn with an unknown reason instead of a wrong state.
 */
function discriminantOf(hook, input) {
  if (hook === 'Notification') return input.notification_type;
  return input.reason || input.matcher || input.source || input.error_type;
}

function notificationIdFromPrompt(prompt) {
  const match = typeof prompt === 'string' ? prompt.match(/notificationId[:=]([A-Za-z0-9_.:-]+)/) : null;
  return match ? match[1] : undefined;
}

function finish(hook) {
  if (hook === 'Stop' || hook === 'SubagentStop') {
    process.stdout.write('{}\\n');
  }
  process.exit(0);
}
`;
}

function writeExecutable(path: string, content: string): void {
  writeTextIfChanged(path, content);
  chmodSync(path, 0o755);
}

function writeTextIfChanged(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== content) {
    writeTextFileAtomic(path, content);
  }
}

function mergeHookConfig(
  path: string,
  desired: { hooks: Record<string, HookGroup[]> },
  currentShimPath: string
): 'merged' | 'skipped-malformed' {
  // Lock the read-modify-write on this shared user config: `desk hooks install`
  // can race Claude Code (or a second install) writing ~/.claude/settings.json.
  // The atomic write prevents a torn file, not a lost update. Lock a separate
  // `.lock` path, matching the manifest update convention.
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(`${path}.lock`, () => mergeHookConfigLocked(path, desired, currentShimPath));
}

function mergeHookConfigLocked(
  path: string,
  desired: { hooks: Record<string, HookGroup[]> },
  currentShimPath: string
): 'merged' | 'skipped-malformed' {
  const read = readJsonObjectClassified(path);
  if (read.kind === 'malformed') {
    // The file exists but does not parse to a JSON object. Merging here would
    // read it as {} and write hooks-only content over it, silently destroying
    // the user's permissions/env/model settings. Back it up and skip instead;
    // the user fixes the JSON and re-runs. (Degrade-to-{} is safe for a READ,
    // never for a full-file overwrite.)
    const backup = `${path}.bak`;
    try {
      copyFileSync(path, backup);
    } catch {
      // best effort — even without a backup, refusing to overwrite is the goal
    }
    console.error(
      `desk: ${path} is not valid JSON — skipped to avoid overwriting it (backed up to ${backup}). Fix the JSON and re-run.`
    );
    return 'skipped-malformed';
  }
  const current = read.kind === 'object' ? read.value : {};
  const currentHooks = isRecord(current.hooks) ? current.hooks : {};
  const mergedHooks: Record<string, unknown> = { ...currentHooks };

  for (const [event, desiredGroups] of Object.entries(desired.hooks)) {
    mergedHooks[event] = mergeHookGroups(mergedHooks[event], desiredGroups, currentShimPath);
  }

  writeJsonIfChanged(path, { ...current, hooks: mergedHooks });
  return 'merged';
}

/**
 * A Desk-installed hook whose command points at a shim path Desk no longer
 * writes. The shim moved (extensionless -> .mjs when it became an ES module),
 * and the merge below keys on the exact command string — so a stale entry
 * would live forever beside the current one, firing a shim that either no
 * longer exists or speaks a retired schema. Both failures are silent: a hook
 * that errors never breaks the agent, so nobody would notice the duplicate.
 */
function isStaleDeskHook(hook: unknown, currentShimPath: string): boolean {
  if (!isRecord(hook) || typeof hook.command !== 'string') {
    return false;
  }
  return hook.command.includes(DESK_SHIM_BASENAME) && !hook.command.includes(currentShimPath);
}

function mergeHookGroups(
  existing: unknown,
  desiredGroups: HookGroup[],
  currentShimPath: string
): Array<Record<string, unknown>> {
  const groups: Array<Record<string, unknown>> = (
    Array.isArray(existing) ? existing.map((group) => normalizeHookGroup(group)) : []
  ).map((group) => ({
    ...group,
    hooks: (Array.isArray(group.hooks) ? group.hooks : []).filter((hook) => !isStaleDeskHook(hook, currentShimPath))
  }));
  for (const desired of desiredGroups) {
    const matcher = desired.matcher ?? '';
    const existingGroup = groups.find((group) => String(group.matcher ?? '') === matcher);
    if (!existingGroup) {
      groups.push({ ...desired, hooks: [...desired.hooks] });
      continue;
    }
    const hooks = Array.isArray(existingGroup.hooks) ? existingGroup.hooks : [];
    for (const hook of desired.hooks) {
      if (!hooks.some((existingHook) => isSameHook(existingHook, hook))) {
        hooks.push(hook);
      }
    }
    existingGroup.hooks = hooks;
  }
  return groups;
}

function normalizeHookGroup(group: unknown): Record<string, unknown> {
  if (!isRecord(group)) {
    return { hooks: [] };
  }
  return { ...group, hooks: Array.isArray(group.hooks) ? [...group.hooks] : [] };
}

function isSameHook(existing: unknown, desired: HookHandler): boolean {
  return isRecord(existing) && existing.type === desired.type && existing.command === desired.command;
}

type JsonObjectRead =
  | { kind: 'missing' }
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'malformed' };

/** Read a JSON object, distinguishing a missing file (safe to create fresh)
 *  from one that exists but does not parse to an object (must NOT be
 *  overwritten) — a degrade-to-fallback reader would collapse both to the fallback. */
function readJsonObjectClassified(path: string): JsonObjectRead {
  if (!existsSync(path)) {
    return { kind: 'missing' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'malformed' };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { kind: 'object', value: parsed } : { kind: 'malformed' };
  } catch {
    return { kind: 'malformed' };
  }
}

function writeJsonIfChanged(path: string, value: Record<string, unknown>): void {
  writeTextIfChanged(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
