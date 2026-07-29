import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installAgentHooks } from '../src/core/agentHooks.js';
import { defaultOpencodeConfigDir } from '../src/core/opencodeConfig.js';

describe('desk hooks install CLI', () => {
  it('installs global agent hooks under the requested home directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-cli-'));
    try {
      const result = spawnSync('npx', ['tsx', 'src/cli/main.ts', 'hooks', 'install', '--home', home], {
        cwd: process.cwd(),
        encoding: 'utf8'
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('desk-agent-event');
      expect(existsSync(join(home, '.local', 'share', 'desk', 'hooks', 'desk-agent-event.mjs'))).toBe(true);
      expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toContain('UserPromptSubmit');
      // Claude's hooks live in a DESK-OWNED file handed to the CLI at launch.
      expect(readFileSync(join(home, '.config', 'desk', 'claude', 'settings.json'), 'utf8')).toContain('Stop');
      // And the operator's own settings file is not created, not read, not
      // written. It holds their credentials, model, and hooks; installing
      // Desk's reporting by editing it would be taking something not given.
      expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
      // The OpenCode plugin goes in DESK's opencode config root — the one the
      // launch command hands the CLI — not the operator's `~/.config/opencode`,
      // which no Desk-launched session ever reads.
      expect(
        readFileSync(join(defaultOpencodeConfigDir(home), 'plugin', 'desk-attention.js'), 'utf8')
      ).toContain('/api/agent-event');
      expect(existsSync(join(home, '.config', 'opencode', 'plugin', 'desk-attention.js'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a malformed codex hooks file, backs it up, and reports it (finding N3)', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-malformed-'));
    try {
      // Codex's hooks.json is still MERGED — Desk adds its entries beside the
      // operator's — so the destructive case still applies there.
      const codexPath = join(home, '.codex', 'hooks.json');
      mkdirSync(dirname(codexPath), { recursive: true });
      // Real user content with a JSON syntax error (trailing comma). Degrading
      // this to {} and writing hooks-only content back would destroy their
      // other hooks — the data loss this test guards against.
      const original = '{\n  "hooks": { "Stop": [] },\n}\n';
      writeFileSync(codexPath, original);

      const installed = installAgentHooks({ homeDir: home });

      // The malformed file is untouched, a backup exists, and it is reported skipped.
      expect(readFileSync(codexPath, 'utf8')).toBe(original);
      expect(existsSync(`${codexPath}.bak`)).toBe(true);
      expect(installed.skipped).toContain(codexPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
