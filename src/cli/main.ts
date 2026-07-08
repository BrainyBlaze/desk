#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSessionToManifest, createEmptyManifest, readManifestFile, resolveManifestPath, writeManifestFile } from '../core/config.js';
import { installAgentHooks } from '../core/agentHooks.js';
import { createAttachArgv } from '../core/tmux.js';
import { captureSession, findSession, loadDesk, planDeskUp, printStatus, runPlan } from '../core/runner.js';
import { runChannelsCli } from './channelsCli.js';
import { runAgentHostFromEnv } from '../server/agents/host/cli.js';
import type { DeskSession } from '../core/types.js';

const HELP = `desk — agent-first multiplexer, IDE/CDE, and Slack-style chat for agent fleets

Usage: desk <command> [options]

  serve [--port 5173] [--host 127.0.0.1]    Start the Vite dev server + UI.
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

Quick start: desk serve   then open the printed URL.`;

/** Locate the installed package root (holds package.json + vite.config + node_modules). */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    // The package root holds package.json plus EITHER the dev config (a source
    // checkout) OR the built CLI (a prebuilt artifact ships dist/ + node_modules
    // but no vite.config.ts/src).
    if (
      existsSync(join(dir, 'package.json')) &&
      (existsSync(join(dir, 'vite.config.ts')) || existsSync(join(dir, 'dist', 'cli', 'main.js')))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('cannot locate the desk package root (reinstall desk)');
}

function serve(options: Map<string, string>): number {
  const root = findPackageRoot();
  const host = options.get('host') ?? '127.0.0.1';
  const port = options.get('port') ?? '5173';

  // The Vite dev server (serves the client source with HMR).
  const viteBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  if (!existsSync(viteBin)) {
    throw new Error(`vite is not installed in ${root}; run "npm install" there first`);
  }
  console.log(`desk serving (dev) on http://${host}:${port}  (Ctrl-C to stop)`);
  const result = spawnSync(viteBin, ['--host', host, '--port', port], { cwd: root, stdio: 'inherit' });
  return result.status ?? 0;
}

interface ParsedArgs {
  command: string;
  manifestPath?: string;
  dryRun: boolean;
  target?: string;
  lines: number;
  options: Map<string, string>;
}

function main(argv: string[]): number {
  try {
    const args = parseArgs(argv);

    // Commands that do not need an existing manifest are handled first so a
    // brand-new user can run them with no config present.
    if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
      console.log(HELP);
      return 0;
    }

    if (args.command === 'serve') {
      return serve(args.options);
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
      writeManifestFile(manifestPath, createEmptyManifest());
      console.log(`created ${manifestPath}`);
      return 0;
    }

    if (args.command === 'add') {
      const manifest = readManifestFile(manifestPath);
      const session = readSessionOptions(args.options);
      const updated = addSessionToManifest(manifest, {
        groupId: requireOption(args.options, 'group'),
        groupLabel: args.options.get('group-label'),
        session
      });
      writeManifestFile(manifestPath, updated);
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

  while (args.length > 0) {
    const next = args.shift();
    if (next === '--file' || next === '-f') {
      manifestPath = requireValue(next, args.shift());
    } else if (next === '--dry-run') {
      dryRun = true;
    } else if (next === '--lines') {
      lines = Number.parseInt(requireValue(next, args.shift()), 10);
    } else if (next?.startsWith('--')) {
      options.set(next.slice(2), requireValue(next, args.shift()));
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
  // agent-host runs forever (driver + broker WS bridge) and resolves only on shutdown,
  // fatal error, or signal — top-level await is the natural exit gate.
  try {
    await runAgentHostFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
} else {
  process.exitCode = main(cliArgs);
}
