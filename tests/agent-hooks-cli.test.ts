import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installAgentHooks } from '../src/core/agentHooks.js';

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
      expect(existsSync(join(home, '.local', 'share', 'desk', 'hooks', 'desk-agent-event'))).toBe(true);
      expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toContain('UserPromptSubmit');
      expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toContain('Stop');
      expect(readFileSync(join(home, '.config', 'opencode', 'plugin', 'desk-attention.js'), 'utf8')).toContain('/api/agent-event');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a malformed settings.json, backs it up, and reports it (finding N3)', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-malformed-'));
    try {
      const claudePath = join(home, '.claude', 'settings.json');
      mkdirSync(dirname(claudePath), { recursive: true });
      // Real user content with a JSON syntax error (trailing comma). Degrading
      // this to {} and writing hooks-only content back would destroy the
      // permissions block — the data loss this test guards against.
      const original = '{\n  "permissions": { "allow": ["Bash"] },\n}\n';
      writeFileSync(claudePath, original);

      const installed = installAgentHooks({ homeDir: home });

      // The malformed file is untouched, a backup exists, and it is reported skipped.
      expect(readFileSync(claudePath, 'utf8')).toBe(original);
      expect(existsSync(`${claudePath}.bak`)).toBe(true);
      expect(installed.skipped).toContain(claudePath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
