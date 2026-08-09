#!/usr/bin/env node
import { copyFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addSessionToManifest,
  createEmptyManifest,
  resolveManifestPath,
  updateManifestFileSync,
  withManifestFileLockSync,
  writeManifestFile
} from '../core/config.js';
import { installAgentHooks } from '../core/agentHooks.js';
import {
  attachSession,
  captureSession,
  findSession,
  loadDesk,
  planDeskUp,
  printStatus,
  runPlan
} from '../core/runner.js';
import { runChannelsCli } from './channelsCli.js';
import { createServeLaunch, findPackageRoot, parseServeOptions, runServeLaunch } from './serveCommand.js';
import { assertAllowedOption, requireOptionValue } from './args.js';
import { runAgentHostFromEnv } from '../server/agents/host/cli.js';
import { SUPPORTED_AGENTS, isSupportedAgent } from '../core/types.js';
import type { DeskSessionDraft } from '../core/types.js';
import { requestProviderSessionReset } from '../shared/daemonControlClient.js';
import { isProviderSessionProvider } from '../shared/providerSessionIdentity.js';

const HELP = `desk — agent-first multiplexer, IDE/CDE, and Slack-style chat for agent fleets

Usage: desk <command> [options]

  desk serve [--host HOST] [--port PORT]
      Start the private standalone runtime.
  desk serve --dev [--host HOST] [--port PORT]
      Start the Vite dev server + UI.
  up [--dry-run]                            Start every missing session
  status                                    Show which sessions exist
  init                                      Create an empty user config
  add --group G --name N --cwd DIR ...      Add a session to the config
  attach <name|sessionId|resume>            Attach a terminal to a session
  capture <name|sessionId|resume> [--lines N]
                                            Print recent output of a session
  reset-provider-session <name|sessionId> --force
                                            Authorize one fresh provider launch
  hooks install [--home DIR]                 Install global agent event hooks
  agent-host                                Run the native UI adapter host (spawned by desk; not user-facing)
  terminal-daemon                           Run the atch terminal daemon (spawned by desk serve; not user-facing)
  channels <list|read|post> …               Agent messaging channels (desk channels help)
  config                                    Print the active config path
  help                                      Show this help

Serve host/port precedence: flags > DESK_HOST/DESK_PORT > 127.0.0.1/5173.

Quick start: desk serve   then open the printed URL.`;

interface ParsedArgs {
  command: string;
  manifestPath?: string;
  dryRun: boolean;
  force: boolean;
  target?: string;
  lines: number;
  options: Map<string, string>;
}

const COMMAND_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['help', new Set()],
  ['--help', new Set()],
  ['-h', new Set()],
  ['serve', new Set(['--host', '--port'])],
  ['hooks', new Set(['--home'])],
  ['config', new Set(['--file', '-f'])],
  ['init', new Set(['--file', '-f', '--force'])],
  [
    'add',
    new Set([
      '--file',
      '-f',
      '--group',
      '--group-label',
      '--name',
      '--cwd',
      '--command',
      '--agent',
      '--resume'
    ])
  ],
  ['status', new Set(['--file', '-f'])],
  ['up', new Set(['--file', '-f', '--dry-run'])],
  ['attach', new Set(['--file', '-f'])],
  ['capture', new Set(['--file', '-f', '--lines'])],
  ['reset-provider-session', new Set(['--force'])]
]);

async function runCli(argv: string[]): Promise<number> {
  if ((argv[0] ?? 'help') !== 'serve') {
    return await main(argv);
  }

  try {
    const options = parseServeOptions(argv.slice(1));
    const launch = createServeLaunch(findPackageRoot(import.meta.url), options);
    console.log(launch.label);
    return await runServeLaunch(launch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);

    // Commands that do not need an existing manifest are handled first so a
    // brand-new user can run them with no config present.
    if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
      console.log(HELP);
      return 0;
    }

    if (args.command === 'hooks') {
      return runHooksCommand(args.target, args.options);
    }

    // `config` and `init` must work even when the manifest is unparseable — they
    // are exactly the commands a user needs to FIND and REPLACE a broken file,
    // so they must run before loadDesk (which parses the manifest and would
    // otherwise die on the very corruption the user is trying to fix).
    const manifestPath = resolveManifestPath(args.manifestPath);

    if (args.command === 'config') {
      console.log(manifestPath);
      return 0;
    }

    if (args.command === 'init') {
      // Never silently destroy an existing config. Overwriting with an empty
      // manifest is irreversible (atomic rename), so refuse unless --force, and
      // even then keep a .bak copy. Run `desk config` to find the file.
      if (existsSync(manifestPath) && !args.force) {
        console.error(
          `desk: ${manifestPath} already exists — refusing to overwrite it.\n` +
            `Run 'desk config' to see it, or 'desk init --force' to replace it (a .bak copy is kept).`
        );
        return 1;
      }
      withManifestFileLockSync(manifestPath, () => {
        if (existsSync(manifestPath)) {
          copyFileSync(manifestPath, `${manifestPath}.bak`);
        }
        writeManifestFile(manifestPath, createEmptyManifest());
      });
      console.log(`created ${manifestPath}`);
      return 0;
    }

    const desk = loadDesk({ manifestPath: args.manifestPath });

    if (args.command === 'add') {
      const session = readSessionOptions(args.options);
      updateManifestFileSync(manifestPath, (manifest) => {
        return addSessionToManifest(manifest, {
          groupId: requireOption(args.options, 'group'),
          groupLabel: args.options.get('group-label'),
          session
        });
      });
      console.log(`added ${session.name} to ${manifestPath}`);
      return 0;
    }

    if (args.command === 'status') {
      printStatus(desk.sessions);
      return 0;
    }

    if (args.command === 'up') {
      if (args.manifestPath) {
        return await runPlan(planDeskUp(desk.sessions), args.dryRun);
      }
      return await requestDeskUp(args.dryRun);
    }

    if (args.command === 'attach') {
      if (!args.target) {
        throw new Error('attach requires a session name, sessionId, or resume id');
      }
      const session = findSession(desk.sessions, args.target);
      return await attachSession(session, { fromUrl: import.meta.url });
    }

    if (args.command === 'capture') {
      if (!args.target) {
        throw new Error('capture requires a session name, sessionId, or resume id');
      }
      const session = findSession(desk.sessions, args.target);
      return await captureSession(session, args.lines);
    }

    if (args.command === 'reset-provider-session') {
      if (!args.target) {
        throw new Error(
          'reset-provider-session requires a session name or sessionId'
        );
      }
      if (!args.force) {
        throw new Error('reset-provider-session requires --force');
      }
      const session = findSession(desk.sessions, args.target);
      if (args.target !== session.name && args.target !== session.sessionId) {
        throw new Error(
          'reset-provider-session target must be a session name or sessionId'
        );
      }
      if (!isProviderSessionProvider(session.agent)) {
        throw new Error(
          `Desk session ${session.sessionId} is not configured for a supported provider`
        );
      }
      const result = await requestProviderSessionReset(session.sessionId);
      if (!result.ok) {
        throw new Error(
          result.error ??
            `provider-session reset failed for Desk session ${session.sessionId}`
        );
      }
      if (
        result.body?.state !== 'authorized' ||
        typeof result.body.authorizationId !== 'string' ||
        !Number.isSafeInteger(result.body.generation) ||
        (result.body.generation as number) < 0
      ) {
        throw new Error(
          'terminal daemon returned an invalid provider-session reset receipt'
        );
      }
      console.log(
        `authorized one fresh provider launch for ${session.name} (${session.sessionId})`
      );
      return 0;
    }

    throw new Error(`unknown command ${args.command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function requestDeskUp(dryRun: boolean, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const baseUrl = env.DESK_API ?? env.DESK_SERVER_URL ?? 'http://127.0.0.1:5173';
  const url = new URL('/api/up', baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new Error(
      `desk server unreachable at ${url}; start it with \`desk serve\`: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const body = (await response.json().catch(() => ({}))) as { exitCode?: unknown; error?: unknown };
  if (!response.ok || typeof body.exitCode !== 'number') {
    throw new Error(
      typeof body.error === 'string' ? body.error : `desk server returned HTTP ${response.status} for session start`
    );
  }
  return body.exitCode;
}

function runHooksCommand(target: string | undefined, options: Map<string, string>): number {
  if (target !== 'install') {
    throw new Error('hooks requires subcommand: install');
  }
  const installed = installAgentHooks({ homeDir: options.get('home') });
  const skipped = new Set(installed.skipped);
  const report = (path: string): void => {
    // Report honestly: a path whose existing JSON was malformed was NOT merged.
    console.log(skipped.has(path) ? `SKIPPED ${path} (invalid JSON; a .bak was written — fix it and re-run)` : `merged ${path}`);
  };
  console.log(`installed ${installed.shimPath}`);
  report(installed.codexHooksPath);
  report(installed.claudeSettingsPath);
  console.log(`installed ${installed.opencodePluginPath}`);
  console.log('codex note: non-managed command hooks may require trust before they fire');
  return skipped.size > 0 ? 1 : 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  let manifestPath: string | undefined;
  let dryRun = false;
  let force = false;
  let target: string | undefined;
  let lines = 200;
  const options = new Map<string, string>();
  const valueOptions =
    command === 'add'
      ? new Set(['group', 'group-label', 'name', 'cwd', 'command', 'agent', 'resume'])
      : command === 'hooks'
        ? new Set(['home'])
        : new Set<string>();

  while (args.length > 0) {
    const next = args.shift();
    if (next?.startsWith('-')) {
      const allowedOptions = COMMAND_OPTIONS.get(command);
      if (allowedOptions) {
        assertAllowedOption(`desk ${command}`, next, allowedOptions);
      }
    }
    if (next === '--file' || next === '-f') {
      manifestPath = requireOptionValue(next, args.shift());
    } else if (next === '--dry-run') {
      dryRun = true;
    } else if (next === '--force') {
      force = true;
    } else if (next === '--lines') {
      lines = Number.parseInt(requireOptionValue(next, args.shift()), 10);
    } else if (next?.startsWith('--')) {
      const name = next.slice(2);
      if (!valueOptions.has(name)) {
        throw new Error(`unknown option ${next}`);
      }
      options.set(name, requireOptionValue(next, args.shift()));
    } else if (next && !target) {
      target = next;
    } else if (next) {
      throw new Error(`unexpected argument ${next}`);
    }
  }

  return { command, manifestPath, dryRun, force, target, lines, options };
}

function readSessionOptions(options: Map<string, string>): DeskSessionDraft {
  const session: DeskSessionDraft = {
    name: requireOption(options, 'name'),
    cwd: requireOption(options, 'cwd')
  };
  const command = options.get('command');

  if (command) {
    session.command = command;
    return session;
  }

  const agent = options.get('agent') ?? 'codex';
  // Validate at the write boundary. `parseDeskManifest` only rejects an
  // unsupported agent on the next READ, so a typo like --agent gemini (or a
  // case slip) used to write fine and then brick every later desk command.
  if (!isSupportedAgent(agent)) {
    throw new Error(
      `unsupported --agent '${agent}'; use one of ${SUPPORTED_AGENTS.join(', ')}, or --command for a custom command`
    );
  }
  session.agent = agent;
  session.resume = requireOption(options, 'resume');
  return session;
}

function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

// Only dispatch when run AS the CLI entry point, not when imported (tests import
// `main` directly and drive it in-process — importing must have no side effects).
// Compare via realpathSync so `npm link`'s bin symlink (~/.node/bin/desk →
// dist/cli/main.js) still counts as "run as CLI" — a naive URL equality would
// mismatch because import.meta.url follows the symlink to the real file while
// argv[1] keeps the symlink path, silently skipping the whole dispatch block.
const isCliEntry = ((): boolean => {
  if (typeof process.argv[1] !== 'string') {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();
if (isCliEntry) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === 'channels') {
    process.exitCode = await runChannelsCli(cliArgs.slice(1));
  } else if (cliArgs[0] === 'terminal-daemon') {
    // The atch terminal daemon: spawned + supervised by `desk serve`
    // (daemonSupervisor). Runs until SIGINT/SIGTERM; a fatal
    // start error exits non-zero so the supervisor's bounded restart sees it.
    try {
      const { runTerminalDaemonMain } = await import('../server/runtime/terminalDaemonMain.js');
      await new Promise<void>((_resolve, reject) => {
        runTerminalDaemonMain().catch(reject);
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } else if (cliArgs[0] === 'agent-host') {
    const argument = cliArgs[1];
    if (argument !== undefined) {
      console.error(argument.startsWith('--') ? `unknown option ${argument}` : `unexpected argument ${argument}`);
      process.exitCode = 1;
    } else {
      // agent-host runs forever (driver + broker WS bridge) and resolves only on shutdown,
      // fatal error, or signal — top-level await is the natural exit gate.
      try {
        await runAgentHostFromEnv();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }
  } else {
    process.exitCode = await runCli(cliArgs);
  }
}
