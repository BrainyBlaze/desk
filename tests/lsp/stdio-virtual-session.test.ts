import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStdioVirtualSession, forceKillActiveStdioVirtualSessionChildren } from '../../src/server/lsp/stdioVirtualSession';
import { createStubStdioServerCommand } from './stubStdioServer';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-stdio-session-'));
});

afterEach(() => {
  forceKillActiveStdioVirtualSessionChildren();
  rmSync(root, { recursive: true, force: true });
});

describe('createStdioVirtualSession', () => {
  it('advertises minimal diagnostic client capabilities while preserving file operations', async () => {
    const initializeFile = join(root, 'initialize.json');
    const fake = createStubStdioServerCommand({
      cwdFile: join(root, 'cwd.txt'),
      initializedFile: join(root, 'initialized.txt'),
      initializeFile
    });

    const session = await createStdioVirtualSession({
      command: fake.command,
      args: fake.args,
      env: fake.env,
      workspaceRoot: root
    });
    session.dispose();

    const initialize = JSON.parse(readFileSync(initializeFile, 'utf8'));
    expect(initialize.capabilities.workspace.fileOperations).toMatchObject({
      dynamicRegistration: true,
      didCreate: true,
      didRename: true,
      didDelete: true,
      willCreate: true,
      willRename: true,
      willDelete: true
    });
    expect(initialize.capabilities.workspace.diagnostics).toEqual({ refreshSupport: true });
    expect(initialize.capabilities.textDocument).toMatchObject({
      diagnostic: { dynamicRegistration: true, relatedInformation: true },
      publishDiagnostics: { relatedInformation: true, versionSupport: true }
    });
    expect(JSON.stringify(initialize.capabilities)).not.toMatch(
      /serverCommands|command|args|env|initializationOptions|token|secret|cache/i
    );
  });

  it('reports exit instead of crashing when the server stdin pipe breaks', async () => {
    const fake = createStdinClosingStdioServerCommand();
    const session = await createStdioVirtualSession({
      command: fake.command,
      args: fake.args,
      env: fake.env,
      workspaceRoot: root
    });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    try {
      session.onExit((exit) => exits.push(exit));
      await delay(20);
      for (let index = 0; index < 64; index += 1) {
        session.sendClientMessage({
          jsonrpc: '2.0',
          id: 2 + index,
          method: 'textDocument/hover',
          params: { payload: 'x'.repeat(65_536) }
        });
      }
      await waitFor(() => exits.length > 0);
      expect(exits).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it('rejects startup timeout without exposing initialization payloads', async () => {
    const fake = createSilentStdioServerCommand();

    await expect(
      createStdioVirtualSession({
        command: fake.command,
        args: fake.args,
        env: { SECRET_ENV_VALUE: 'SECRET_ENV_VALUE' },
        workspaceRoot: root,
        initializationOptions: { token: 'SECRET_INIT_TOKEN' },
        startupTimeoutMs: 20,
        forceKillTimeoutMs: 20
      })
    ).rejects.toThrow(/initialize timed out/);
  });

  it('kills the spawned process tree when dispose timeout expires', async () => {
    const pidFile = join(root, 'grandchild.pid');
    const fake = createProcessTreeStdioServerCommand(pidFile);
    const session = await createStdioVirtualSession({
      command: fake.command,
      args: fake.args,
      env: fake.env,
      workspaceRoot: root,
      forceKillTimeoutMs: 20
    });
    await waitFor(() => existsSync(pidFile));
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));

    try {
      session.dispose();
      await waitFor(() => !isProcessRunning(grandchildPid));
      expect(isProcessRunning(grandchildPid)).toBe(false);
    } finally {
      killPid(grandchildPid);
    }
  });
});

function createStdinClosingStdioServerCommand(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: ['--input-type=module', '--eval', STDIN_CLOSING_STDIO_SERVER_SOURCE],
    env: {}
  };
}

const STDIN_CLOSING_STDIO_SERVER_SOURCE = `
import { closeSync } from 'node:fs';
let buffer = Buffer.alloc(0);
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(\`Content-Length: \${body.byteLength}\\r\\n\\r\\n\`, 'ascii'), body]);
}
function handle(message) {
  if (message.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    process.stdout.write(encode({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
    return;
  }
  if (message.method === 'initialized') {
    closeSync(0);
    setInterval(() => undefined, 1_000);
  }
}
function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.toString('ascii', 0, headerEnd);
    const match = /^Content-Length:\\s*(\\d+)$/im.exec(header);
    if (!match) {
      throw new Error('missing Content-Length');
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.toString('utf8', bodyStart, bodyEnd);
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.resume();
`;

function createSilentStdioServerCommand(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: ['--input-type=module', '--eval', SILENT_STDIO_SERVER_SOURCE],
    env: {}
  };
}

const SILENT_STDIO_SERVER_SOURCE = `
process.stdin.resume();
setInterval(() => undefined, 1000);
`;

function createProcessTreeStdioServerCommand(pidFile: string): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: ['--input-type=module', '--eval', PROCESS_TREE_STDIO_SERVER_SOURCE],
    env: { PROCESS_TREE_PID_FILE: pidFile }
  };
}

const PROCESS_TREE_STDIO_SERVER_SOURCE = `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--input-type=module', '--eval', \`
process.on('SIGTERM', () => {});
setInterval(() => undefined, 1000);
\`], { stdio: 'ignore' });
writeFileSync(process.env.PROCESS_TREE_PID_FILE, String(child.pid), 'utf8');
process.on('SIGTERM', () => {});

let buffer = Buffer.alloc(0);
function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(\`Content-Length: \${body.byteLength}\\r\\n\\r\\n\`, 'ascii'), body]);
}
function handle(msg) {
  if (msg.method === 'initialize' && Object.prototype.hasOwnProperty.call(msg, 'id')) {
    process.stdout.write(encode({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
  }
}
function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.toString('ascii', 0, headerEnd);
    const match = /^Content-Length:\\s*(\\d+)$/im.exec(header);
    if (!match) {
      throw new Error('missing Content-Length');
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.toString('utf8', bodyStart, bodyEnd);
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.resume();
setInterval(() => undefined, 1000);
`;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (!isProcessRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort cleanup for the red test path.
  }
}
