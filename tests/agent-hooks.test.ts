import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildClaudeHooksSettings,
  buildCodexHooksConfig,
  buildDeskAgentEventShim,
  codexHookPreflightStatus,
  installAgentHooks,
  probeHookInstallation
} from '../src/core/agentHooks.js';

describe('agent hook configuration generation', () => {
  it('generates Codex command hooks for every event the CLI actually supports', () => {
    const config = buildCodexHooksConfig('/workspace/.local/share/desk/hooks/desk-agent-event');

    // Verified against the hook event names in the shipped codex binary
    // (codex-cli 0.145.0). A previous version of this test asserted SessionEnd
    // was unsupported and pinned that belief; the binary has it.
    expect(Object.keys(config.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit'
    ]);
    expect(JSON.stringify(config)).toContain('"type":"command"');
    expect(JSON.stringify(config)).not.toContain('"type":"http"');
    expect(JSON.stringify(config)).toContain('/workspace/.local/share/desk/hooks/desk-agent-event');
  });

  it('generates Claude command hooks with the lifecycle events Desk needs', () => {
    const settings = buildClaudeHooksSettings('/workspace/.local/share/desk/hooks/desk-agent-event');

    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolBatch',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'UserPromptSubmit'
    ]);
    expect(JSON.stringify(settings)).toContain('"type":"command"');
    expect(JSON.stringify(settings)).toContain("--event 'Stop'");
    expect(JSON.stringify(settings)).toContain("--event 'UserPromptSubmit'");
    // The tool interval: its two edges are what hold `working` across a tool
    // that outlives the working lease. The FAILURE edge matters as much as the
    // success one — without it a failed tool leaks an open interval.
    expect(JSON.stringify(settings)).toContain("--event 'PreToolUse'");
    expect(JSON.stringify(settings)).toContain("--event 'PostToolUse'");
    expect(JSON.stringify(settings)).toContain("--event 'PostToolUseFailure'");
  });

  it('tracks Codex hooks as degraded until trust and boot preflight both succeed', () => {
    expect(
      codexHookPreflightStatus({
        installed: true,
        trusted: false,
        producerEvidenceSeen: false
      })
    ).toEqual({ active: false, degradedReason: 'codex-hook-untrusted' });

    expect(
      codexHookPreflightStatus({
        installed: true,
        trusted: true,
        producerEvidenceSeen: false
      })
    ).toEqual({ active: false, degradedReason: 'hook-not-firing' });

    expect(
      codexHookPreflightStatus({
        installed: true,
        trusted: true,
        producerEvidenceSeen: true
      })
    ).toEqual({ active: true });
  });

  it('produces a prompt-safe shim script that posts typed events and exits cleanly', () => {
    const shim = buildDeskAgentEventShim();

    expect(shim).toContain('process.stdin');
    expect(shim).toContain('DESK_SESSION_ID');
    expect(shim).toContain('/api/agent-event');
    // The generation must be INHERITED from the spawn, never resolved server
    // side: a producer that outlived a respawn has to stamp the generation it
    // was launched in or fencing cannot reject its late writes.
    expect(shim).toContain('DESK_SESSION_GENERATION');
    expect(shim).toContain('producerInstanceId');
    expect(shim).toContain('producerSeq');
    expect(shim).toContain('providerSessionId');
    expect(shim).toContain('const DESK_PROVIDER_SESSION_ID_FIELDS = {');
    expect(shim).toContain('"claude":"session_id"');
    expect(shim).toContain('"codex":"session_id"');
    expect(shim).toContain('"opencode":"sessionID"');
    expect(shim).toContain('"qwen":"session_id"');
    expect(shim).toContain('"kimi":"session_id"');
    expect(shim).toContain('"grok":"session_id"');
    expect(shim).toContain(
      'input[DESK_PROVIDER_SESSION_ID_FIELDS[DESK_PROVIDER]]'
    );
    expect(shim).not.toContain('input.session_id || input.sessionId');
    expect(shim).toContain('process.exit(0)');
    expect(shim).not.toContain('console.log');
    // Failure diagnostic is present but debug-gated (must not spam an alt-screen TUI).
    expect(shim).toContain('DESK_DEBUG');
    // The emitted file must PARSE as an ES module — the shim imports node:fs
    // for its durable sequence, so a script-mode check would fail on the first
    // import and prove nothing. `node --check` on a .mjs parses without
    // executing, which is exactly the guarantee wanted here: a broken template
    // escape fails the suite instead of shipping to every agent's hook path.
    const dir = mkdtempSync(join(tmpdir(), 'desk-shim-syntax-'));
    try {
      const path = join(dir, 'shim.mjs');
      writeFileSync(path, shim);
      const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs global hook files idempotently without clobbering existing hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-'));
    try {
      const codexPath = join(home, '.codex', 'hooks.json');
      const claudePath = join(home, '.claude', 'settings.json');
      mkdirSync(dirname(codexPath), { recursive: true });
      mkdirSync(dirname(claudePath), { recursive: true });
      writeFileSync(codexPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-codex' }] }] } }));
      const operatorClaudeSettings = JSON.stringify({
        theme: 'dark',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-claude' }] }] }
      });
      writeFileSync(claudePath, operatorClaudeSettings);
      const kimiPath = join(home, '.kimi-code', 'config.toml');
      mkdirSync(dirname(kimiPath), { recursive: true });
      writeFileSync(kimiPath, '[[hooks]]\nevent = "Stop"\ncommand = "echo keep-kimi"\ntimeout = 5\n');
      const grokPath = join(home, '.grok', 'user-settings.json');
      mkdirSync(dirname(grokPath), { recursive: true });
      writeFileSync(
        grokPath,
        JSON.stringify({
          apiKey: 'keep-key',
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-grok' }] }] }
        })
      );

      const installed = installAgentHooks({ homeDir: home });
      installAgentHooks({ homeDir: home });

      expect(existsSync(installed.shimPath)).toBe(true);
      expect(statSync(installed.shimPath).mode & 0o111).not.toBe(0);
      expect(readFileSync(installed.shimPath, 'utf8')).toContain('/api/agent-event');

      const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
      expect(JSON.stringify(codex)).toContain('echo keep-codex');
      expect(JSON.stringify(codex)).toContain('desk-agent-event');
      expect(JSON.stringify(codex)).toContain('UserPromptSubmit');
      expect(JSON.stringify(codex).match(/desk-agent-event/g)?.length).toBe(7);

      // The operator's own Claude settings are left EXACTLY as they were —
      // not merged into, not reformatted, not read for anything.
      expect(readFileSync(claudePath, 'utf8')).toBe(operatorClaudeSettings);

      // Desk's hooks live in Desk's own file, written whole.
      const claude = JSON.parse(readFileSync(installed.claudeSettingsPath, 'utf8'));
      expect(JSON.stringify(claude)).toContain('desk-agent-event');
      expect(JSON.stringify(claude)).toContain('UserPromptSubmit');
      // 10 single-group events + 5 Notification matchers, each with its own hook.
      expect(JSON.stringify(claude).match(/desk-agent-event/g)?.length).toBe(15);

      expect(readFileSync(installed.opencodePluginPath, 'utf8')).toContain('/api/agent-event');

      const kimi = readFileSync(kimiPath, 'utf8');
      expect(kimi).toContain('echo keep-kimi');
      expect(kimi.match(/desk-agent-event/g)?.length).toBe(7);
      expect(kimi.match(/timeout = 10/g)?.length).toBe(7);

      const qwen = JSON.parse(readFileSync(installed.qwenSettingsPath, 'utf8'));
      const qwenTimeouts = Object.values(qwen.hooks as Record<string, { hooks: { timeout: number }[] }[]>)
        .flat()
        .flatMap((group) => group.hooks.map((hook) => hook.timeout));
      expect(qwenTimeouts).toHaveLength(10);
      expect(new Set(qwenTimeouts)).toEqual(new Set([10]));

      const grok = JSON.parse(readFileSync(grokPath, 'utf8'));
      expect(grok.apiKey).toBe('keep-key');
      expect(JSON.stringify(grok)).toContain('echo keep-grok');
      expect(JSON.stringify(grok)).toContain('desk-agent-event');
      expect(JSON.stringify(grok)).toContain('UserPromptSubmit');
      expect(JSON.stringify(grok).match(/desk-agent-event/g)?.length).toBe(6);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('kimi hook config maintenance', () => {
  it('rewrites stale desk blocks to the current shim and keeps operator blocks', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-kimi-'));
    try {
      const kimiPath = join(home, '.kimi-code', 'config.toml');
      mkdirSync(dirname(kimiPath), { recursive: true });
      writeFileSync(
        kimiPath,
        '[[hooks]]\nevent = "Stop"\ncommand = "echo keep-kimi"\ntimeout = 5\n\n' +
          '[[hooks]]\nevent = "Stop"\ncommand = "\'/old/desk-agent-event.mjs\' --agent \'kimi\' --event \'Stop\'"\ntimeout = 10\n'
      );
      const installed = installAgentHooks({ homeDir: home });
      const kimi = readFileSync(kimiPath, 'utf8');
      expect(kimi).toContain('echo keep-kimi');
      expect(kimi).not.toContain('/old/desk-agent-event.mjs');
      expect(kimi).toContain(installed.shimPath);
      expect(kimi.match(/desk-agent-event/g)?.length).toBe(7);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips a config whose hooks entry cannot hold [[hooks]] blocks and reports it', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-kimi-'));
    try {
      const kimiPath = join(home, '.kimi-code', 'config.toml');
      mkdirSync(dirname(kimiPath), { recursive: true });
      const incompatible = '[hooks]\nfoo = 1\n';
      writeFileSync(kimiPath, incompatible);
      const installed = installAgentHooks({ homeDir: home });
      expect(installed.skipped).toContain(kimiPath);
      expect(readFileSync(kimiPath, 'utf8')).toBe(incompatible);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('agent hook shim runtime (child process)', () => {
  // Runs the emitted shim as a real node process against an unreachable desk
  // endpoint, so we exercise the actual fetch-failure path — not just syntax.
  function runShim(
    env: Record<string, string | undefined>,
    args: string[] = ['--event', 'Stop', '--agent', 'claude']
  ): { status: number | null; stderr: string; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'desk-shim-'));
    const shimPath = join(dir, 'shim.mjs');
    writeFileSync(shimPath, buildDeskAgentEventShim());
    try {
      const result = spawnSync(process.execPath, [shimPath, ...args], {
        input: '{}',
        // Unreachable endpoint => fetch rejects (ECONNREFUSED) well before the 1.5s abort.
        env: {
          ...env,
          DESK_SESSION_ID: 'runtime-test',
          DESK_SESSION_GENERATION: '7',
          DESK_API: 'http://127.0.0.1:1'
        },
        encoding: 'utf8',
        timeout: 10_000
      });
      return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('stays silent and exits 0 when DESK_DEBUG is unset (POST failure swallowed)', () => {
    const env = { ...process.env };
    delete env.DESK_DEBUG;
    const { status, stderr } = runShim(env);
    expect(status).toBe(0);
    expect(stderr).not.toContain('agent-event POST failed');
  });

  it('emits one diagnostic and still exits 0 under DESK_DEBUG when the POST fails', () => {
    const { status, stderr } = runShim({ ...process.env, DESK_DEBUG: '1' });
    expect(status).toBe(0); // best-effort: a failed POST never breaks the hook
    // Exactly one diagnostic line — not merely present (the impl writes once).
    const occurrences = stderr.split('[desk-producer] agent-event POST failed').length - 1;
    expect(occurrences).toBe(1);
  });

  it('sends NOTHING when the generation is missing — an unfenceable event is worse than silence', () => {
    const env = { ...process.env, DESK_DEBUG: '1' };
    delete env.DESK_SESSION_GENERATION;
    const dir = mkdtempSync(join(tmpdir(), 'desk-shim-'));
    const shimPath = join(dir, 'shim.mjs');
    writeFileSync(shimPath, buildDeskAgentEventShim());
    try {
      const result = spawnSync(process.execPath, [shimPath, '--event', 'Stop', '--agent', 'claude'], {
        input: '{}',
        // Deliberately NOT overriding DESK_SESSION_GENERATION here.
        env: { ...env, DESK_SESSION_ID: 'runtime-test', DESK_API: 'http://127.0.0.1:1' },
        encoding: 'utf8',
        timeout: 10_000
      });
      expect(result.status).toBe(0);
      // No POST was attempted, so there is no failure to report.
      expect(result.stderr ?? '').not.toContain('agent-event POST failed');
      // The hook still answers Claude, or the turn would hang waiting on it.
      expect(result.stdout ?? '').toContain('{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends NOTHING for a provider that has no registered producer binding', () => {
    const { status, stderr } = runShim({ ...process.env, DESK_DEBUG: '1' }, [
      '--event',
      'Stop',
      '--agent',
      'some-future-cli'
    ]);
    expect(status).toBe(0);
    expect(stderr).not.toContain('agent-event POST failed');
  });

  // The hook command states its provider; the environment merely surrounds the
  // process. When they disagree — a hook firing under a nested session, a
  // spawned helper — the argument has to win, or the event is attributed to the
  // wrong agent. A mislabelled producer is worse than a silent one: it is
  // accepted as evidence about a session that did nothing.
  it('lets the --agent ARGUMENT outrank an ambient DESK_AGENT', () => {
    const { status, stderr } = runShim(
      { ...process.env, DESK_DEBUG: '1', DESK_AGENT: 'claude' },
      ['--event', 'Stop', '--agent', 'some-future-cli']
    );
    expect(status).toBe(0);
    // If the env won, the shim would resolve `claude`, bind a producer, and
    // attempt a POST — which is exactly what this must not do.
    expect(stderr).not.toContain('agent-event POST failed');
  });
});

describe('upgrading over a previous install', () => {
  it('removes hooks and shim files that point at a retired shim path', () => {
    // The shim moved when it became an ES module. The merge keys on the exact
    // command string, so without pruning the old entry would live forever
    // beside the new one — firing a shim that either no longer exists or
    // speaks a retired schema. Both fail SILENTLY: a hook that errors never
    // breaks the agent, so nobody would see the duplicate.
    const home = mkdtempSync(join(tmpdir(), 'desk-hooks-upgrade-'));
    try {
      const oldShim = join(home, '.local', 'share', 'desk', 'hooks', 'desk-agent-event');
      mkdirSync(dirname(oldShim), { recursive: true });
      writeFileSync(oldShim, '// the previous release');

      // Codex's hooks.json is the file Desk still MERGES into, so it is where
      // a stale entry from a previous release could survive.
      const codexPath = join(home, '.codex', 'hooks.json');
      mkdirSync(dirname(codexPath), { recursive: true });
      writeFileSync(
        codexPath,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: `'${oldShim}' --agent 'codex' --event 'Stop'` },
                  { type: 'command', command: 'echo keep-mine' }
                ]
              }
            ]
          }
        })
      );

      installAgentHooks({ homeDir: home });

      const codex = JSON.parse(readFileSync(codexPath, 'utf8')) as { hooks: Record<string, unknown> };
      const serialized = JSON.stringify(codex);
      expect(serialized).not.toContain(`'${oldShim}' --agent`);
      expect(serialized).toContain('desk-agent-event.mjs');
      // A hook the operator installed themselves is not Desk's to remove.
      expect(serialized).toContain('echo keep-mine');
      // The retired shim file is deleted too: a config could still reference it
      // from somewhere Desk does not manage.
      expect(existsSync(oldShim)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('read-only hook probe', () => {
  it('reports what is installed WITHOUT reading or writing the operator settings', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hook-probe-'));
    try {
      // A trap: if the probe ever consults the operator's file, this content
      // would make it report claude as installed when it is not.
      const operatorPath = join(home, '.claude', 'settings.json');
      mkdirSync(dirname(operatorPath), { recursive: true });
      writeFileSync(operatorPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'desk-agent-event.mjs' }] }] } }));

      expect(probeHookInstallation('claude', home)).toMatchObject({ installed: false });
      installAgentHooks({ homeDir: home });
      expect(probeHookInstallation('claude', home)).toMatchObject({ installed: true });
      expect(probeHookInstallation('opencode', home)).toMatchObject({ installed: true });
      // Installing must not have created or altered the operator's file.
      expect(JSON.parse(readFileSync(operatorPath, 'utf8')).hooks.Stop).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('proves the ABSENCE of codex trust but never claims a specific hook is trusted', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-hook-trust-'));
    try {
      installAgentHooks({ homeDir: home });
      // No config.toml at all: nothing has ever been trusted. That negative is
      // provable, and it is the one the operator needs.
      expect(probeHookInstallation('codex', home)).toMatchObject({ installed: true, trust: 'absent' });

      const configPath = join(home, '.codex', 'config.toml');
      writeFileSync(
        configPath,
        `[hooks.state."${join(home, '.codex', 'hooks.json')}:session_start:0:0"]\ntrusted_hash = "sha256:deadbeef"\n`
      );
      // A record EXISTS — but it names a file and an event, not which hook
      // inside it, and the hash is Codex's to verify. So the probe reports
      // `recorded`, never `trusted`: only evidence the authority accepted may
      // raise confidence that far.
      expect(probeHookInstallation('codex', home)).toMatchObject({ trust: 'recorded' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the probe checks working configuration, not the presence of a string', () => {
  it('reports OpenCode independently of the shim, and rejects a plugin from another build', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-probe-oc-'));
    try {
      const installed = installAgentHooks({ homeDir: home });
      expect(probeHookInstallation('opencode', home)).toMatchObject({ installed: true });

      // The OpenCode plugin never invokes the shim, so a missing shim says
      // nothing about it. Gating on the shim reported a working producer as
      // uninstalled.
      rmSync(join(home, '.local', 'share', 'desk', 'hooks', 'desk-agent-event.mjs'), { force: true });
      expect(probeHookInstallation('opencode', home)).toMatchObject({ installed: true });

      // Presence is not installation: an older plugin sits at the same path,
      // loads, and speaks a retired schema. The path comes from the installer
      // rather than a literal — a literal here is what let the installer and
      // the launcher point at different directories without any test noticing.
      writeFileSync(
        installed.opencodePluginPath,
        '// a plugin from an earlier release\nexport default { id: "desk-attention" };\n'
      );
      expect(probeHookInstallation('opencode', home)).toMatchObject({
        installed: false,
        detail: 'installed opencode plugin is from a different Desk build'
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to call a config installed when the agent could not load it', () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-probe-json-'));
    try {
      installAgentHooks({ homeDir: home });
      expect(probeHookInstallation('codex', home)).toMatchObject({ installed: true });

      // Malformed JSON that CONTAINS the path. A substring check called this
      // installed; the agent cannot load the file at all.
      const codexPath = join(home, '.codex', 'hooks.json');
      const shimPath = join(home, '.local', 'share', 'desk', 'hooks', 'desk-agent-event.mjs');
      writeFileSync(codexPath, `{ "hooks": { "Stop": [ { "hooks": [ { "command": "${shimPath}" } ] } ] },}`);
      expect(probeHookInstallation('codex', home)).toMatchObject({ installed: false });

      // Parseable, mentions the path — but only in a place the agent never
      // executes. Structure is what the agent reads, so structure is checked.
      writeFileSync(codexPath, JSON.stringify({ note: `installed at ${shimPath}`, hooks: {} }));
      expect(probeHookInstallation('codex', home)).toMatchObject({ installed: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
