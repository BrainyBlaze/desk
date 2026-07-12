#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  addSessionToManifest,
  createEmptyManifest,
  resolveManifestPath,
  updateManifestFileSync,
  withManifestFileLockSync,
  writeManifestFile
} from '../core/config.js';
import { installAgentHooks } from '../core/agentHooks.js';
import { createAttachArgv } from '../core/tmux.js';
import { captureSession, findSession, loadDesk, planDeskUp, printStatus, runPlan } from '../core/runner.js';
import { runChannelsCli } from './channelsCli.js';
import { createServeLaunch, findPackageRoot, parseServeOptions, runServeLaunch } from './serveCommand.js';
import { runAgentHostFromEnv } from '../server/agents/host/cli.js';
import type { DeskSession } from '../core/types.js';

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
  attach <name|tmux|resume>                 Attach a terminal to a session
  capture <name|tmux|resume> [--lines N]    Print recent output of a session
  hooks install [--home DIR]                 Install global agent event hooks
  agent-host                                Run the native UI adapter host (spawned by desk; not user-facing)
  channels <list|read|post> …               Agent messaging channels (desk channels help)
  config                                    Print the active config path
  help                                      Show this help

Serve host/port precedence: flags > DESK_HOST/DESK_PORT > 127.0.0.1/5173.

Quick start: desk serve   then open the printed URL.`;

interface ParsedArgs {
  command: string;
  manifestPath?: string;
  dryRun: boolean;
  target?: string;
  lines: number;
  options: Map<string, string>;
}

async function main(argv: string[]): Promise<number> {
  try {
    if ((argv[0] ?? 'help') === 'serve') {
      const options = parseServeOptions(argv.slice(1));
      const launch = createServeLaunch(findPackageRoot(import.meta.url), options);
      console.log(launch.label);
      return await runServeLaunch(launch);
    }

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

    const desk = loadDesk({ manifestPath: args.manifestPath });
    const manifestPath = resolveManifestPath(args.manifestPath);

    if (args.command === 'config') {
      console.log(manifestPath);
      return 0;
    }

    if (args.command === 'init') {
      withManifestFileLockSync(manifestPath, () => writeManifestFile(manifestPath, createEmptyManifest()));
      console.log(`created ${manifestPath}`);
      return 0;
    }

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
      return runPlan(planDeskUp(desk.sessions), args.dryRun);
    }

    if (args.command === 'attach') {
      if (!args.target) {
        throw new Error('attach requires a session name, tmux id, or resume id');
      }
      const session = findSession(desk.sessions, args.target);
      const result = spawnSync('tmux', createAttachArgv(session.tmuxSession), {
        stdio: 'inherit'
      });
      return result.status ?? 0;
    }

    if (args.command === 'capture') {
      if (!args.target) {
        throw new Error('capture requires a session name, tmux id, or resume id');
      }
      const session = findSession(desk.sessions, args.target);
      return captureSession(session, args.lines);
    }

    throw new Error(`unknown command ${args.command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runHooksCommand(target: string | undefined, options: Map<string, string>): number {
  if (target !== 'install') {
    throw new Error('hooks requires subcommand: install');
  }
  const installed = installAgentHooks({ homeDir: options.get('home') });
  console.log(`installed ${installed.shimPath}`);
  console.log(`merged ${installed.codexHooksPath}`);
  console.log(`merged ${installed.claudeSettingsPath}`);
  console.log(`installed ${installed.opencodePluginPath}`);
  console.log('codex note: non-managed command hooks may require trust before they fire');
  return 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  let manifestPath: string | undefined;
  let dryRun = false;
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
    if (next === '--file' || next === '-f') {
      manifestPath = requireValue(next, args.shift());
    } else if (next === '--dry-run') {
      dryRun = true;
    } else if (next === '--lines') {
      lines = Number.parseInt(requireValue(next, args.shift()), 10);
    } else if (next?.startsWith('--')) {
      const name = next.slice(2);
      if (!valueOptions.has(name)) {
        throw new Error(`unknown option ${next}`);
      }
      options.set(name, requireValue(next, args.shift()));
    } else if (next && !target) {
      target = next;
    } else if (next) {
      throw new Error(`unexpected argument ${next}`);
    }
  }

  return { command, manifestPath, dryRun, target, lines, options };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readSessionOptions(options: Map<string, string>): DeskSession {
  const session: DeskSession = {
    name: requireOption(options, 'name'),
    cwd: requireOption(options, 'cwd')
  };
  const command = options.get('command');

  if (command) {
    session.command = command;
    return session;
  }

  session.agent = options.get('agent') ?? 'codex';
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

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === 'channels') {
  process.exitCode = await runChannelsCli(cliArgs.slice(1));
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
  process.exitCode = await main(cliArgs);
}
