import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAgentHooks, probeHookInstallation } from '../src/core/agentHooks.js';
import { buildAgentCommand } from '../src/core/manifest.js';
import { defaultOpencodeConfigDir } from '../src/core/opencodeConfig.js';
import type { DeskSession } from '../src/core/types.js';

/**
 * The seam between the two halves of the OpenCode integration.
 *
 * Desk launches OpenCode with `OPENCODE_CONFIG_DIR` pointed at a Desk-owned
 * directory, and OpenCode loads plugins from the directory it is given. The
 * installer therefore has exactly one correct target, and it is not a path a
 * human gets to choose independently: it is whatever the launch command says.
 *
 * These tests exist because the two halves disagreed in production. The
 * installer wrote a current plugin into `~/.config/opencode/plugin/` while
 * every Desk-launched session read `~/.config/desk/opencode/plugin/`, which
 * still held a plugin from an earlier release. Both halves were individually
 * correct, both were covered by their own passing tests, and the adapter work
 * they connected had no effect on the running product. `desk hooks install`
 * printed `installed` the whole time.
 *
 * So these assertions deliberately never name a literal path. They derive the
 * expectation from the launch command itself, which is the only way a test can
 * fail when either side moves.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'desk-oc-seam-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DESK_OPENCODE_CONFIG_DIR;
});

function opencodeSession(): DeskSession {
  return { name: 'glm', agent: 'opencode', uiMode: 'terminal' } as DeskSession;
}

/** The config dir the LAUNCH command hands OpenCode, read out of the command. */
function configDirFromLaunchCommand(): string {
  const command = buildAgentCommand(opencodeSession(), '/tmp/project', home, 'glm-1');
  const match = /desk_opencode_config='([^']+)'/.exec(command);
  if (!match) {
    throw new Error(`launch command names no opencode config dir:\n${command}`);
  }
  return match[1];
}

describe('the OpenCode plugin is installed where the launch command points', () => {
  it('writes the plugin under the config dir the launch command passes', () => {
    const launchConfigDir = configDirFromLaunchCommand();
    const installed = installAgentHooks({ homeDir: home });

    // The assertion is on the RELATIONSHIP, not on a path string: the plugin
    // must live under the directory OpenCode will actually be told to read.
    expect(installed.opencodePluginPath).toBe(
      join(launchConfigDir, 'plugin', 'desk-attention.js')
    );
    expect(readFileSync(installed.opencodePluginPath, 'utf8')).toContain('/api/agent-event');
  });

  it('agrees with the Desk-owned config dir helper the launcher defaults to', () => {
    // Belt and braces: the launch command's default and the helper the rest of
    // the server uses must be the same directory, or the seam only looks
    // closed because both sides drifted together.
    expect(configDirFromLaunchCommand()).toBe(defaultOpencodeConfigDir(home));
  });

  it('follows DESK_OPENCODE_CONFIG_DIR so an override cannot split the two halves', () => {
    // An operator override moves the read side. If the installer ignored it,
    // the override would silently restore exactly the bug this file exists for.
    const override = join(home, 'custom-opencode-root');
    process.env.DESK_OPENCODE_CONFIG_DIR = override;

    const installed = installAgentHooks({ homeDir: home });

    expect(installed.opencodePluginPath).toBe(join(override, 'plugin', 'desk-attention.js'));
  });

  it('probes the same file it installs, so `installed` cannot be reported about a file nothing reads', () => {
    expect(probeHookInstallation('opencode', home).installed).toBe(false);

    installAgentHooks({ homeDir: home });

    expect(probeHookInstallation('opencode', home).installed).toBe(true);
  });
});
