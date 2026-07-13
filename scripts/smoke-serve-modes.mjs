import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRuntimeSuffix = join('libexec', 'desk-standalone');
const waitTimeoutMs = 20_000;
const requestTimeoutMs = 2_000;
const outputLimitBytes = 1 << 20;
const responseLimitBytes = 2 << 20;
const activeProcesses = new Set();
let childEnvironment;

function createIsolatedTmuxEnvironment() {
  const smokeHome = mkdtempSync(join(realpathSync(tmpdir()), 'desk-smoke-home-'));
  const tmuxTmpdir = mkdtempSync(join(realpathSync(tmpdir()), 'desk-smoke-tmux-'));
  chmodSync(tmuxTmpdir, 0o700);
  childEnvironment = {
    ...process.env,
    FORCE_COLOR: '0',
    HOME: smokeHome,
    NO_COLOR: '1',
    TMPDIR: smokeHome,
    TMUX_TMPDIR: tmuxTmpdir,
    XDG_CACHE_HOME: join(smokeHome, '.cache'),
    XDG_CONFIG_HOME: join(smokeHome, '.config'),
    XDG_DATA_HOME: join(smokeHome, '.local', 'share')
  };
  delete childEnvironment.TMUX;
  delete childEnvironment.DESK_CHANNELS_DEBUG;
  delete childEnvironment.DESK_CODEX_HOME;
  delete childEnvironment.DESK_HOST;
  delete childEnvironment.DESK_OPENCODE_BIN;
  delete childEnvironment.DESK_PLUGINS;
  delete childEnvironment.DESK_PORT;
  return { childEnvironment, smokeHome, tmuxTmpdir };
}

function cleanupIsolatedTmux({ childEnvironment: environment, smokeHome, tmuxTmpdir }) {
  try {
    const result = spawnSync('tmux', ['kill-server'], {
      encoding: 'utf8',
      env: environment,
      maxBuffer: 1 << 20
    });
    if (result.error !== undefined && result.error.code !== 'ENOENT') {
      throw result.error;
    }
    if (
      result.error === undefined &&
      result.status !== 0 &&
      !/no server running|failed to connect|no such file or directory/i.test(result.stderr)
    ) {
      throw new Error(`isolated tmux cleanup failed: ${result.stderr.trim()}`);
    }
  } finally {
    rmSync(tmuxTmpdir, { recursive: true, force: true });
    rmSync(smokeHome, { recursive: true, force: true });
  }
}

function formatFailure(error, indent = '') {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const nested = error instanceof AggregateError ? error.errors : error instanceof Error && error.cause ? [error.cause] : [];
  if (nested.length === 0) {
    return `${indent}${text}`;
  }
  return `${indent}${text}\n${nested.map((item) => formatFailure(item, `${indent}  `)).join('\n')}`;
}

function parseOptions(argv) {
  let desk;
  let cwd;
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--desk' && flag !== '--cwd') {
      throw new Error(`unknown argument ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`${flag} may be specified only once`);
    }
    seen.add(flag);

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires an absolute path`);
    }
    if (!isAbsolute(value)) {
      throw new Error(`${flag} must be an absolute path`);
    }
    if (flag === '--desk') {
      desk = value;
    } else {
      cwd = value;
    }
    index += 1;
  }

  return { desk: desk ?? join(repoRoot, 'dist', 'cli', 'main.js'), cwd };
}

function pathIsInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === '' ||
    (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent))
  );
}

function validateDeskCommand(command) {
  let stats;
  try {
    stats = statSync(command);
    accessSync(command, constants.X_OK);
  } catch (error) {
    throw new Error(`--desk must name an executable file: ${command}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new Error(`--desk must name an executable file: ${command}`);
  }
}

function prepareWorkingDirectory(requestedCwd) {
  const checkout = realpathSync(repoRoot);
  if (requestedCwd !== undefined) {
    let cwd;
    try {
      cwd = realpathSync(requestedCwd);
    } catch (error) {
      throw new Error(`--cwd must name an existing directory: ${requestedCwd}`, { cause: error });
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`--cwd must name an existing directory: ${requestedCwd}`);
    }
    if (pathIsInside(checkout, cwd)) {
      throw new Error(`--cwd must be outside the checkout: ${requestedCwd}`);
    }
    return { cwd, temporaryCwd: undefined };
  }

  const temporaryCwd = mkdtempSync(join(realpathSync(tmpdir()), 'desk-serve-smoke-'));
  if (pathIsInside(checkout, temporaryCwd)) {
    rmSync(temporaryCwd, { recursive: true, force: true });
    throw new Error('the system temporary directory must be outside the checkout');
  }
  return { cwd: temporaryCwd, temporaryCwd };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(predicate, description, timeoutMs = waitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`, { cause: lastError });
}

async function bindUnusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('expected a TCP port');
  }
  return { server, port: address.port };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function unusedPort() {
  const bound = await bindUnusedPort();
  await closeServer(bound.server);
  return bound.port;
}

async function portIsOpen(port) {
  return await new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function waitForPortToClose(port) {
  await waitFor(async () => !(await portIsOpen(port)), `port ${port} to close`);
  assert.equal(await portIsOpen(port), false, `port ${port} remained open`);
}

async function readHttpResponse(port, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  timer.unref();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let body = '';
    if (reader !== undefined) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytesRead += chunk.value.byteLength;
        if (bytesRead > responseLimitBytes) {
          await reader.cancel();
          throw new Error(`response from ${path} exceeded ${responseLimitBytes} bytes`);
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    }
    return {
      body,
      contentType: response.headers.get('content-type') ?? '',
      status: response.status
    };
  } finally {
    clearTimeout(timer);
  }
}

function isViteClientResponse(response) {
  return (
    response.status === 200 &&
    /javascript|ecmascript/i.test(response.contentType) &&
    /createHotContext|__vite__|vite\/hmr/i.test(response.body)
  );
}

async function waitForHttpResponse(port, path, predicate, description) {
  return await waitFor(async () => {
    try {
      const response = await readHttpResponse(port, path);
      return predicate(response) ? response : undefined;
    } catch {
      return undefined;
    }
  }, description);
}

function appendOutput(tracked, stream, chunk) {
  const bytes = Buffer.byteLength(chunk);
  const byteKey = stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
  tracked[byteKey] += bytes;
  if (tracked[byteKey] > outputLimitBytes) {
    tracked.outputOverflow = true;
  }
  const current = tracked[stream];
  if (Buffer.byteLength(current) < outputLimitBytes) {
    tracked[stream] = `${current}${chunk}`.slice(0, outputLimitBytes);
  }
}

function startDesk(command, cwd, args) {
  assert.notEqual(childEnvironment, undefined, 'isolated child environment was not initialized');
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const tracked = {
    args,
    child,
    closed: undefined,
    observedDescendants: new Set(),
    observedProcessGroups: new Set(),
    outputOverflow: false,
    stderr: '',
    stderrBytes: 0,
    stdout: '',
    stdoutBytes: 0
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => appendOutput(tracked, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendOutput(tracked, 'stderr', chunk));
  tracked.closed = new Promise((resolveClose, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      if (!settled) {
        settled = true;
        resolveClose({ code, signal });
      }
    });
  });
  activeProcesses.add(tracked);
  return tracked;
}

function processIsAlive(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      return commandEnd !== -1 && stat.slice(commandEnd + 2, commandEnd + 3) !== 'Z';
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') {
        return false;
      }
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function processGroupIsAlive(pid) {
  return processTable().some(([, , processGroup, state]) => processGroup === pid && !state.startsWith('Z'));
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function processTable() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8',
    maxBuffer: 4 << 20
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`cannot inspect process descendants: ${result.error ?? result.stderr}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, parentPid, processGroup, state] = line.split(/\s+/);
      return [Number(pid), Number(parentPid), Number(processGroup), state];
    })
    .filter(
      ([pid, parentPid, processGroup, state]) =>
        Number.isInteger(pid) &&
        Number.isInteger(parentPid) &&
        Number.isInteger(processGroup) &&
        typeof state === 'string'
    );
}

function descendantPids(rootPid, table = processTable()) {
  const childrenByParent = new Map();
  for (const [pid, parentPid] of table) {
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function observeDescendants(tracked) {
  const cliPid = tracked.child.pid;
  if (cliPid === undefined || !processGroupIsAlive(cliPid)) {
    return [];
  }
  const table = processTable();
  const descendants = descendantPids(cliPid, table);
  for (const pid of descendants) {
    tracked.observedDescendants.add(pid);
    const row = table.find(([candidate]) => candidate === pid);
    const processGroup = row?.[2];
    if (processGroup !== undefined && processGroup > 1 && processGroup !== cliPid) {
      tracked.observedProcessGroups.add(processGroup);
    }
  }
  return descendants;
}

function signalObservedProcessGroups(tracked, signal) {
  for (const processGroup of tracked.observedProcessGroups) {
    if (processGroupIsAlive(processGroup)) {
      signalProcessGroup(processGroup, signal);
    }
  }
}

function privateRuntimePathForPid(pid) {
  if (process.platform === 'linux') {
    try {
      const executable = readlinkSync(`/proc/${pid}/exe`);
      return executable.endsWith(privateRuntimeSuffix) ? executable : undefined;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') {
        return undefined;
      }
      throw error;
    }
  }

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 1 << 20
  });
  if (result.status !== 0) {
    return undefined;
  }
  const command = result.stdout.trim();
  const marker = `${sep}${privateRuntimeSuffix}`;
  const markerIndex = command.lastIndexOf(marker);
  return markerIndex === -1 ? undefined : command.slice(0, markerIndex + marker.length);
}

async function waitForPrivateRuntime(tracked) {
  const runtime = await waitFor(() => {
    for (const pid of observeDescendants(tracked)) {
      const path = privateRuntimePathForPid(pid);
      if (path !== undefined) {
        return { path, pid };
      }
    }
    return undefined;
  }, 'the private Bun runtime child');
  tracked.observedDescendants.add(runtime.pid);
  return runtime;
}

async function awaitTrackedExit(tracked, description, timeoutMs = waitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const tick = Symbol('tick');
  while (Date.now() < deadline) {
    observeDescendants(tracked);
    const result = await Promise.race([tracked.closed, delay(25).then(() => tick)]);
    if (result !== tick) {
      return result;
    }
  }
  throw new Error(`timed out waiting for ${description}${processDiagnostics(tracked)}`);
}

function processDiagnostics(tracked) {
  return `\nstdout:\n${tracked.stdout}\nstderr:\n${tracked.stderr}`;
}

function assertBoundedOutput(tracked) {
  assert.equal(tracked.outputOverflow, false, `child output exceeded ${outputLimitBytes} bytes`);
}

function survivorDiagnostics(tracked) {
  const cliPid = tracked.child.pid;
  const observed = [...tracked.observedDescendants];
  const rows = processTable().filter(
    ([pid, , processGroup]) => processGroup === cliPid || observed.includes(pid)
  );
  return JSON.stringify({ cliPid, observed, rows });
}

async function assertProcessTreeExited(tracked) {
  const cliPid = tracked.child.pid;
  if (cliPid === undefined) {
    throw new Error('Desk CLI did not receive a pid');
  }
  try {
    await waitFor(
      () =>
        !processGroupIsAlive(cliPid) &&
        [...tracked.observedDescendants].every((pid) => !processIsAlive(pid)),
      `Desk process group ${cliPid} and its descendants to exit`
    );
  } catch (error) {
    throw new Error(`Desk process tree survived: ${survivorDiagnostics(tracked)}`, { cause: error });
  }
  assert.equal(processGroupIsAlive(cliPid), false, `Desk process group ${cliPid} survived`);
  for (const pid of tracked.observedDescendants) {
    assert.equal(processIsAlive(pid), false, `Desk descendant ${pid} survived`);
  }
  activeProcesses.delete(tracked);
}

async function stopBySignalingOnlyCli(tracked, signal, port, requiredRuntimePid) {
  const cliPid = tracked.child.pid;
  if (cliPid === undefined) {
    throw new Error('Desk CLI did not receive a pid');
  }
  observeDescendants(tracked);
  assert.equal(processIsAlive(requiredRuntimePid), true, `private runtime ${requiredRuntimePid} was not alive`);
  assert.equal(tracked.child.kill(signal), true, `could not send ${signal} to CLI pid ${cliPid}`);
  const outcome = await awaitTrackedExit(tracked, `Desk CLI ${cliPid} to exit after ${signal}`);
  const expectedCode = signal === 'SIGINT' ? 130 : 143;
  assert.deepEqual(outcome, { code: expectedCode, signal: null }, processDiagnostics(tracked));
  await assertProcessTreeExited(tracked);
  await waitForPortToClose(port);
  assertBoundedOutput(tracked);
}

async function terminateTracked(tracked) {
  const cliPid = tracked.child.pid;
  if (cliPid === undefined) {
    activeProcesses.delete(tracked);
    return;
  }

  observeDescendants(tracked);
  if (processGroupIsAlive(cliPid)) {
    signalProcessGroup(cliPid, 'SIGTERM');
    try {
      await waitFor(() => !processGroupIsAlive(cliPid), `process group ${cliPid} cleanup`, 1_000);
    } catch {
      signalProcessGroup(cliPid, 'SIGKILL');
    }
  }
  signalObservedProcessGroups(tracked, 'SIGTERM');
  try {
    await waitFor(
      () => [...tracked.observedProcessGroups].every((processGroup) => !processGroupIsAlive(processGroup)),
      `observed runtime groups of ${cliPid} to stop`,
      1_000
    );
  } catch {
    signalObservedProcessGroups(tracked, 'SIGKILL');
  }
  try {
    await waitFor(
      () =>
        !processGroupIsAlive(cliPid) &&
        [...tracked.observedProcessGroups].every((processGroup) => !processGroupIsAlive(processGroup)) &&
        [...tracked.observedDescendants].every((pid) => !processIsAlive(pid)),
      `all descendants of ${cliPid} to stop during cleanup`,
      5_000
    );
  } catch (error) {
    throw new Error(`Desk cleanup process tree survived: ${survivorDiagnostics(tracked)}`, { cause: error });
  }
  await Promise.race([tracked.closed.catch(() => undefined), delay(1_000)]);
  activeProcesses.delete(tracked);
}

async function runStandaloneSignalProbe(command, cwd, signal, checkRouteIdentity) {
  const port = await unusedPort();
  const tracked = startDesk(command, cwd, [
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ]);
  const rootResponse = await waitForHttpResponse(
    port,
    '/',
    (response) => response.status === 200,
    `standalone root on ${port}`
  );
  assert.equal(rootResponse.status, 200);
  const runtime = await waitForPrivateRuntime(tracked);

  if (checkRouteIdentity) {
    const viteRoute = await readHttpResponse(port, '/@vite/client');
    assert.equal(
      isViteClientResponse(viteRoute),
      false,
      `plain serve exposed Vite's client route (${viteRoute.contentType})`
    );
  }

  await stopBySignalingOnlyCli(tracked, signal, port, runtime.pid);
  return runtime.path;
}

async function runViteProbe(command, cwd) {
  const port = await unusedPort();
  const tracked = startDesk(command, cwd, [
    'serve',
    '--dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ]);
  const viteClient = await waitForHttpResponse(
    port,
    '/@vite/client',
    isViteClientResponse,
    `Vite client route on ${port}`
  );
  assert.equal(viteClient.status, 200);
  assert.match(viteClient.contentType, /javascript|ecmascript/i);
  const descendants = await waitFor(
    () => {
      const observed = observeDescendants(tracked);
      return observed.length > 0 ? observed : undefined;
    },
    'the Vite runtime child'
  );
  await stopBySignalingOnlyCli(tracked, 'SIGINT', port, descendants[0]);
}

async function runOccupiedPortProbe(command, cwd) {
  const bound = await bindUnusedPort();
  let tracked;
  try {
    tracked = startDesk(command, cwd, [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(bound.port)
    ]);
    const outcome = await awaitTrackedExit(tracked, 'standalone failure on an occupied port');
    assert.notEqual(outcome.code, 0, `occupied port unexpectedly succeeded${processDiagnostics(tracked)}`);
    assert.equal(outcome.signal, null, processDiagnostics(tracked));
    const output = `${tracked.stdout}\n${tracked.stderr}`;
    assert.match(output, /EADDRINUSE|address already in use|failed to (?:listen|start server)|is port .* in use/i);
    assert.doesNotMatch(output, /VITE|\bLocal:/i, `occupied standalone port fell back to Vite${processDiagnostics(tracked)}`);
    await assertProcessTreeExited(tracked);
    assert.equal(bound.server.listening, true, 'the requested pre-bound port was displaced');
    assertBoundedOutput(tracked);
  } finally {
    if (tracked !== undefined && activeProcesses.has(tracked)) {
      await terminateTracked(tracked);
    }
    await closeServer(bound.server);
  }
  await waitForPortToClose(bound.port);
}

function runtimeIdentity(path) {
  const stats = statSync(path);
  assert.equal(stats.isFile(), true, `private runtime is not a file: ${path}`);
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size };
}

async function runStatusPropagationProbe(command, cwd, runtimePath) {
  const originalIdentity = runtimeIdentity(runtimePath);
  const backupPath = `${runtimePath}.smoke-backup-${process.pid}-${randomUUID()}`;
  let originalMoved = false;
  let tracked;

  try {
    renameSync(runtimePath, backupPath);
    originalMoved = true;
    writeFileSync(runtimePath, '#!/usr/bin/env node\nprocess.exit(37);\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o700
    });

    const port = await unusedPort();
    tracked = startDesk(command, cwd, [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ]);
    const outcome = await awaitTrackedExit(tracked, 'the controlled private runtime to exit');
    assert.deepEqual(outcome, { code: 37, signal: null }, processDiagnostics(tracked));
    await assertProcessTreeExited(tracked);
    await waitForPortToClose(port);
    assertBoundedOutput(tracked);
  } finally {
    let cleanupError;
    try {
      if (tracked !== undefined && activeProcesses.has(tracked)) {
        await terminateTracked(tracked);
      }
    } catch (error) {
      cleanupError = error;
    }

    let restorationError;
    try {
      if (originalMoved) {
        rmSync(runtimePath, { force: true });
        renameSync(backupPath, runtimePath);
        assert.deepEqual(runtimeIdentity(runtimePath), originalIdentity, 'private runtime restoration changed the artifact');
      }
    } catch (error) {
      restorationError = error;
    }

    if (cleanupError !== undefined || restorationError !== undefined) {
      throw new AggregateError(
        [cleanupError, restorationError].filter((error) => error !== undefined),
        'controlled runtime cleanup/restoration failed'
      );
    }
  }
}

async function cleanupAllProcesses() {
  const errors = [];
  for (const tracked of [...activeProcesses]) {
    try {
      await terminateTracked(tracked);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'one or more Desk child processes survived cleanup');
  }
}

async function runSmoke(command, cwd) {
  const privateRuntime = await runStandaloneSignalProbe(command, cwd, 'SIGINT', true);
  console.log('smoke: plain serve returned 200 without a Vite client route and stopped on SIGINT');

  const termRuntime = await runStandaloneSignalProbe(command, cwd, 'SIGTERM', false);
  assert.equal(
    realpathSync(termRuntime),
    realpathSync(privateRuntime),
    'separate standalone runs selected different private runtimes'
  );
  console.log('smoke: plain serve stopped its private runtime and process group on SIGTERM');

  await runViteProbe(command, cwd);
  console.log('smoke: serve --dev exposed the Vite client route and stopped cleanly');

  await runOccupiedPortProbe(command, cwd);
  console.log('smoke: occupied standalone port failed closed without a listener or Vite fallback');

  await runStatusPropagationProbe(command, cwd, realpathSync(privateRuntime));
  console.log('smoke: private runtime status 37 propagated and the original artifact was restored');
}

if (process.platform === 'win32') {
  throw new Error('smoke:serve-modes supports the macOS/Linux distribution targets only');
}

const options = parseOptions(process.argv.slice(2));
validateDeskCommand(options.desk);
const preparedCwd = prepareWorkingDirectory(options.cwd);
const isolatedTmux = createIsolatedTmuxEnvironment();
let failure;

try {
  await runSmoke(options.desk, preparedCwd.cwd);
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanupAllProcesses();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], 'smoke failure plus child-process cleanup failure');
  }
  try {
    cleanupIsolatedTmux(isolatedTmux);
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], 'smoke failure plus isolated-tmux cleanup failure');
  }
  if (preparedCwd.temporaryCwd !== undefined) {
    rmSync(preparedCwd.temporaryCwd, { recursive: true, force: true });
  }
}

if (failure !== undefined) {
  console.error(formatFailure(failure));
  process.exitCode = 1;
} else {
  assert.equal(activeProcesses.size, 0, 'smoke left a tracked Desk child process alive');
  console.log('smoke: serve modes passed with no surviving runtime or descendant');
}
