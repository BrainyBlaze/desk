import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextFileAtomic } from '../shared/atomicFile.js';

/**
 * Desk-owned OpenCode config dir.
 *
 * Desk ships a tiny OpenCode server plugin that posts typed v2 agent events to
 * `/api/agent-event` on idle/status/permission/error hooks. This replaces the
 * old OSC-9/BEL terminal-byte path, so channels delivery authority comes from
 * the same event stream as Claude/Codex hooks instead of terminal scraping.
 * Desk launches opencode with OPENCODE_CONFIG_DIR pointing here so the plugin
 * loads in any cwd without touching the user's ~/.config/opencode.
 *
 * The plugin lives at plugin/desk-attention.js and is loaded by OpenCode's
 * auto-discovery of that dir. Registering via tui.json's `plugin` array does
 * not fire the server hooks; the attention hooks are server hooks, not TUI
 * hooks.
 */
const DESK_ATTENTION_PLUGIN_SOURCE_PATH = fileURLToPath(new URL('./opencode/desk-attention.js', import.meta.url));

/**
 * Desk-managed opencode.json. Intentionally carries NO permission block: the
 * permission ruleset is per-session (it follows the bypass-permissions
 * checkbox), and the config dir is shared across all opencode sessions, so it
 * cannot encode a per-session setting. Permission is supplied per launch via
 * OPENCODE_CONFIG_CONTENT instead (see opencodePermissionConfigContent).
 */
export const OPENCODE_CONFIG_JSON = `${JSON.stringify(
  {
    $schema: 'https://opencode.ai/config.json'
  },
  null,
  2
)}\n`;

/**
 * Per-session permission config delivered inline via OPENCODE_CONFIG_CONTENT,
 * which OpenCode merges OVER the config dir's opencode.json (verified in the
 * opencode source config.ts: merge(OPENCODE_CONFIG_CONTENT, ..., "local")).
 * This is what makes the Desk bypass-permissions checkbox REAL per session
 * instead of the shared config dir's one global setting:
 *   bypass on  -> "*": "allow"  (yolo: tools run with no prompt, like claude/codex --dangerously)
 *   bypass off -> "*": "ask"    (OpenCode shows a permission prompt per tool)
 * Both empirically verified on opencode 1.17.7 (allow -> autonomous run; ask ->
 * a "Permission required" prompt that blocks the tool). The "*" wildcard is
 * matched by OpenCode's permission engine against every (current and future)
 * permission key, broader than enumerating edit/bash/webfetch/etc.
 */
export function opencodePermissionConfigContent(bypassPermissions: boolean): string {
  // NOTE on provider-retry visibility: opencode retries provider stream errors
  // internally, silently and unbounded (observed live: AI_APICallError loop,
  // attempt 15+, 7h, zero /event frames). The SDK's types declare an
  // experimental.chatMaxRetries cap, but the pinned opencode 1.17.13 RUNTIME
  // does not know the key (binary has no trace of it; boot-verified it is
  // tolerated-and-ignored) — so desk does NOT ship it: an ignored knob would be
  // a false claim. Visibility is owned by the opencode driver's turn-liveness
  // watchdog (status-endpoint probe). Revisit the cap on the next opencode
  // upgrade whose runtime honors it.
  return JSON.stringify({ permission: { '*': bypassPermissions ? 'allow' : 'ask' } });
}

/** Default Desk-owned opencode config dir (NOT the user's ~/.config/opencode). */
export function defaultOpencodeConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'desk', 'opencode');
}

/**
 * Idempotently writes the Desk-owned opencode config dir (opencode.json +
 * plugin/desk-attention.js) and returns its path. Refreshes file content so a
 * Desk upgrade ships an updated plugin. Safe to call on every boot/launch.
 */
export function ensureOpencodeConfigDir(dir: string = defaultOpencodeConfigDir()): string {
  const pluginDir = join(dir, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeIfChanged(join(dir, 'opencode.json'), OPENCODE_CONFIG_JSON);
  writeIfChanged(join(pluginDir, 'desk-attention.js'), readFileSync(DESK_ATTENTION_PLUGIN_SOURCE_PATH, 'utf8'));
  removeStaleTuiRegistration(dir);
  return dir;
}

/**
 * Converge a dir that a prior Desk version wrote with the (non-firing)
 * tui.json + desk-plugin/ registration: a lingering tui.json pointing at a
 * removed plugin path can break launch. Safe no-op on a clean dir.
 */
function removeStaleTuiRegistration(dir: string): void {
  rmSync(join(dir, 'tui.json'), { force: true });
  rmSync(join(dir, 'desk-plugin'), { recursive: true, force: true });
}

function writeIfChanged(path: string, content: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== content) {
    // Atomic temp+rename, like the agentHooks writer this mirrors: a crash
    // mid-write must not leave a truncated opencode.json / desk-attention.js
    // that boots opencode without the attention plugin (silent notification loss).
    writeTextFileAtomic(path, content);
  }
}
