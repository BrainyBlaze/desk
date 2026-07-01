import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
