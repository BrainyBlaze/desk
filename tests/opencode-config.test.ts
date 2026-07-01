import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultOpencodeConfigDir,
  ensureOpencodeConfigDir,
  opencodePermissionConfigContent
} from '../src/core/opencodeConfig.js';

function attentionPluginSource(): string {
  return readFileSync(join(process.cwd(), 'src', 'core', 'opencode', 'desk-attention.js'), 'utf8');
}

describe('desk-attention opencode plugin source', () => {
  it('is loaded from the real plugin source file in the tree', () => {
    expect(attentionPluginSource()).toContain('id: "desk-attention"');
  });

  it('posts typed Desk agent events instead of emitting terminal bytes', () => {
    const plugin = attentionPluginSource();
    expect(plugin).toContain('/api/agent-event');
    expect(plugin).toContain('schemaVersion: 2');
    expect(plugin).toContain('DESK_TMUX_SESSION');
    expect(plugin).not.toContain('/dev/tty');
    expect(plugin).not.toContain(']9;');
    expect(plugin).toContain('export default');
    expect(plugin).toContain('id: "desk-attention"');
    expect(plugin).toContain('session.idle');
    expect(plugin).toContain('session-idle');
    expect(plugin).toContain('permission.asked');
    expect(plugin).toContain('approval-requested');
  });

  // Runtime-critical guards (verified end-to-end; a unit test on source text
  // alone previously let both regressions through):
  it('puts hooks under the server slot, not tui (tui is typed `never` -> hooks dropped, 0 OSC-9)', () => {
    const plugin = attentionPluginSource();
    expect(plugin).toContain('server: async');
    expect(plugin).not.toMatch(/\btui:\s*async/);
  });
  it('does not rely on terminal ESC/BEL bytes for delivery authority', () => {
    const plugin = attentionPluginSource();
    expect(plugin).not.toContain('String.fromCharCode(27)');
    expect(plugin).not.toContain('String.fromCharCode(7)');
    expect(plugin).not.toContain('\\x1b');
  });
});

describe('opencodePermissionConfigContent (the per-session bypass toggle)', () => {
  it('bypass ON -> wildcard allow (yolo, no prompts)', () => {
    const parsed = JSON.parse(opencodePermissionConfigContent(true)) as { permission: Record<string, string> };
    expect(parsed.permission).toEqual({ '*': 'allow' });
  });
  it('bypass OFF -> wildcard ask (OpenCode prompts per tool)', () => {
    const parsed = JSON.parse(opencodePermissionConfigContent(false)) as { permission: Record<string, string> };
    expect(parsed.permission).toEqual({ '*': 'ask' });
  });
});

describe('defaultOpencodeConfigDir', () => {
  it('is a desk-owned dir under the home config, not the user opencode dir', () => {
    const dir = defaultOpencodeConfigDir('/home/u');
    expect(dir).toContain('/home/u');
    expect(dir).toContain('desk');
    expect(dir).not.toBe('/home/u/.config/opencode');
  });
});

describe('ensureOpencodeConfigDir', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates opencode.json + plugin/desk-attention.js and returns the dir', () => {
    const dir = ensureOpencodeConfigDir(base);
    expect(dir).toBe(base);
    expect(existsSync(join(base, 'opencode.json'))).toBe(true);
    const plugin = readFileSync(join(base, 'plugin', 'desk-attention.js'), 'utf8');
    expect(plugin).toBe(attentionPluginSource());
    // valid JSON config
    expect(() => JSON.parse(readFileSync(join(base, 'opencode.json'), 'utf8'))).not.toThrow();
  });

  it('base opencode.json carries NO permission block (permission is per-session via env)', () => {
    ensureOpencodeConfigDir(base);
    const config = JSON.parse(readFileSync(join(base, 'opencode.json'), 'utf8')) as { permission?: unknown };
    // a global permission here would override the per-session OPENCODE_CONFIG_CONTENT
    expect(config.permission).toBeUndefined();
  });

  it('is idempotent (re-running does not throw and leaves correct content)', () => {
    ensureOpencodeConfigDir(base);
    expect(() => ensureOpencodeConfigDir(base)).not.toThrow();
    expect(readFileSync(join(base, 'plugin', 'desk-attention.js'), 'utf8')).toBe(attentionPluginSource());
  });

  it('REFRESHES a stale plugin file (desk upgrade ships a new plugin)', () => {
    ensureOpencodeConfigDir(base);
    writeFileSync(join(base, 'plugin', 'desk-attention.js'), '// old stale content');
    ensureOpencodeConfigDir(base);
    expect(readFileSync(join(base, 'plugin', 'desk-attention.js'), 'utf8')).toBe(attentionPluginSource());
  });

  it('converges a dir from the prior (non-firing) tui.json + desk-plugin/ layout', () => {
    // simulate a config dir an earlier generator version wrote
    mkdirSync(join(base, 'desk-plugin'), { recursive: true });
    writeFileSync(join(base, 'tui.json'), '{"plugin":["./desk-plugin/desk-attention.js"]}');
    writeFileSync(join(base, 'desk-plugin', 'desk-attention.js'), '// stale');
    ensureOpencodeConfigDir(base);
    expect(existsSync(join(base, 'tui.json'))).toBe(false);
    expect(existsSync(join(base, 'desk-plugin'))).toBe(false);
    expect(existsSync(join(base, 'plugin', 'desk-attention.js'))).toBe(true);
  });
});
