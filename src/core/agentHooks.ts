import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { shellQuote } from '../shared/shell.js';
import { writeTextFileAtomic } from '../shared/atomicFile.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    PermissionRequest: HookGroup[];
    Stop: HookGroup[];
  };
}

export interface ClaudeHooksSettings {
  hooks: {
    SessionStart: HookGroup[];
    UserPromptSubmit: HookGroup[];
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

const OPENCODE_PLUGIN_SOURCE_PATH = fileURLToPath(new URL('./opencode/desk-attention.js', import.meta.url));

export function defaultAgentEventShimPath(homeDir: string = homedir()): string {
  return join(homeDir, '.local', 'share', 'desk', 'hooks', 'desk-agent-event');
}

// shellQuote now lives in ../shared/shell.ts (single audited copy).

function command(shimPath: string, agent: string, event: string): string {
  return `${shellQuote(shimPath)} --agent ${shellQuote(agent)} --event ${shellQuote(event)}`;
}

function commandHook(shimPath: string, agent: string, event: string, timeout = 2): HookHandler {
  return { type: 'command', command: command(shimPath, agent, event), timeout };
}

export function buildCodexHooksConfig(shimPath: string): CodexHooksConfig {
  return {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [commandHook(shimPath, 'codex', 'SessionStart')] }],
      UserPromptSubmit: [{ hooks: [commandHook(shimPath, 'codex', 'UserPromptSubmit')] }],
      PermissionRequest: [{ hooks: [commandHook(shimPath, 'codex', 'PermissionRequest')] }],
      Stop: [{ hooks: [commandHook(shimPath, 'codex', 'Stop')] }]
    }
  };
}

export function buildClaudeHooksSettings(shimPath: string): ClaudeHooksSettings {
  return {
    hooks: {
      SessionStart: [{ hooks: [commandHook(shimPath, 'claude', 'SessionStart')] }],
      UserPromptSubmit: [{ hooks: [commandHook(shimPath, 'claude', 'UserPromptSubmit')] }],
      Notification: [
        { matcher: 'permission_prompt', hooks: [commandHook(shimPath, 'claude', 'Notification')] },
        { matcher: 'idle_prompt', hooks: [commandHook(shimPath, 'claude', 'Notification')] },
        { matcher: 'elicitation_dialog', hooks: [commandHook(shimPath, 'claude', 'Notification')] }
      ],
      Stop: [{ hooks: [commandHook(shimPath, 'claude', 'Stop')] }],
      StopFailure: [{ hooks: [commandHook(shimPath, 'claude', 'StopFailure')] }],
      SessionEnd: [{ hooks: [commandHook(shimPath, 'claude', 'SessionEnd')] }]
    }
  };
}

export function codexHookPreflightStatus(input: {
  installed: boolean;
  trusted: boolean;
  sessionStartSeen: boolean;
}): HookPreflightStatus {
  if (!input.installed) {
    return { active: false, degradedReason: 'hook-not-installed' };
  }
  if (!input.trusted) {
    return { active: false, degradedReason: 'codex-hook-untrusted' };
  }
  if (!input.sessionStartSeen) {
    return { active: false, degradedReason: 'hook-not-firing' };
  }
  return { active: true };
}

export function installAgentHooks(options: InstallAgentHooksOptions = {}): InstalledAgentHooks {
  const homeDir = options.homeDir ?? homedir();
  const shimPath = options.shimPath ?? defaultAgentEventShimPath(homeDir);
  const codexHooksPath = join(homeDir, '.codex', 'hooks.json');
  const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');
  const opencodePluginPath = join(homeDir, '.config', 'opencode', 'plugin', 'desk-attention.js');

  writeExecutable(shimPath, buildDeskAgentEventShim());
  const skipped: string[] = [];
  if (mergeHookConfig(codexHooksPath, buildCodexHooksConfig(shimPath)) === 'skipped-malformed') {
    skipped.push(codexHooksPath);
  }
  if (mergeHookConfig(claudeSettingsPath, buildClaudeHooksSettings(shimPath)) === 'skipped-malformed') {
    skipped.push(claudeSettingsPath);
  }
  writeTextIfChanged(opencodePluginPath, readFileSync(OPENCODE_PLUGIN_SOURCE_PATH, 'utf8'));

  return { shimPath, codexHooksPath, claudeSettingsPath, opencodePluginPath, skipped };
}

export function buildDeskAgentEventShim(): string {
  return `#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const hookEventName = arg('--event') || '';
  const agent = process.env.DESK_AGENT || arg('--agent') || 'unknown';
  const session = process.env.DESK_TMUX_SESSION || '';
  if (!session || !hookEventName) {
    finish(hookEventName);
    return;
  }
  let input = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    input = {};
  }
  const mapped = mapKind(hookEventName, input);
  const body = {
    schemaVersion: 2,
    kind: mapped.kind,
    session,
    agent,
    turnId: input.turn_id || input.turnId,
    notificationId: notificationIdFromPrompt(input.prompt),
    ts: new Date().toISOString(),
    message: mapped.message,
    status: mapped.status
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch((process.env.DESK_API || 'http://127.0.0.1:5173') + '/api/agent-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // fetch resolves for 4xx/5xx, so a desk server that REJECTS the event would
    // otherwise be swallowed with no trail. Treat a non-ok status as a failure.
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
  } catch (err) {
    // The event POST is best-effort: a down/slow/rejecting desk server must never
    // break the agent's own hook, so the failure stays non-fatal. But swallowing it
    // silently makes "notifications stopped working" undebuggable. Gate a one-line
    // diagnostic behind DESK_DEBUG (off by default) so it never pollutes an alt-screen TUI.
    if (process.env.DESK_DEBUG) {
      process.stderr.write('[desk-hook] agent-event POST failed: ' + (err && err.message ? err.message : String(err)) + '\\n');
    }
  } finally {
    clearTimeout(timer);
  }
  finish(hookEventName);
});
process.stdin.resume();

function mapKind(hookEventName, input) {
  switch (hookEventName) {
    case 'SessionStart':
      return { kind: 'session-start' };
    case 'UserPromptSubmit':
      return { kind: 'prompt-submitted' };
    case 'PermissionRequest':
      return { kind: 'approval-requested' };
    case 'Notification':
      return notificationKind(input);
    case 'Stop':
      return { kind: 'stop' };
    case 'StopFailure':
      return { kind: 'stop-failure' };
    case 'SessionEnd':
      return { kind: 'session-end' };
    default:
      return { kind: 'session-status', status: hookEventName };
  }
}

function notificationKind(input) {
  const type = input.notification_type || '';
  if (String(type).includes('permission')) return { kind: 'approval-requested', message: input.message };
  if (String(type).includes('elicitation')) return { kind: 'input-requested', message: input.message };
  if (String(type).includes('idle')) return { kind: 'session-idle', message: input.message };
  return { kind: 'session-status', message: input.message, status: String(type) };
}

function notificationIdFromPrompt(prompt) {
  const match = typeof prompt === 'string' ? prompt.match(/notificationId[:=]([A-Za-z0-9_.:-]+)/) : null;
  return match ? match[1] : undefined;
}

function finish(hookEventName) {
  if (hookEventName === 'Stop' || hookEventName === 'SubagentStop') {
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

function mergeHookConfig(path: string, desired: { hooks: Record<string, HookGroup[]> }): 'merged' | 'skipped-malformed' {
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
    mergedHooks[event] = mergeHookGroups(mergedHooks[event], desiredGroups);
  }

  writeJsonIfChanged(path, { ...current, hooks: mergedHooks });
  return 'merged';
}

function mergeHookGroups(existing: unknown, desiredGroups: HookGroup[]): Array<Record<string, unknown>> {
  const groups = Array.isArray(existing) ? existing.map((group) => normalizeHookGroup(group)) : [];
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
 *  overwritten). Unlike readJsonFileOr, which collapses both to the fallback. */
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
