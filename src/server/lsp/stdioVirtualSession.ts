import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeLspMessage, LspStdioMessageParser } from './stdioFraming.js';
import { isLspRequestMetricsEnabled, type LspRequestMetricsRecorder } from './requestMetrics.js';
import type { LspVirtualSession } from '../lspWebSocketBridge.js';

export interface StdioVirtualSessionOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceRoot: string;
  initializationOptions?: Record<string, unknown>;
  startupTimeoutMs?: number;
  forceKillTimeoutMs?: number;
  sessionId?: string;
  requestMetrics?: LspRequestMetricsRecorder;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { message?: string };
}

const INITIALIZE_REQUEST_ID = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 250;
const STDERR_TAIL_LIMIT = 4_096;
const activeStdioChildren = new Set<ChildProcessWithoutNullStreams>();
const CLIENT_CAPABILITIES = {
  workspace: {
    fileOperations: {
      dynamicRegistration: true,
      didCreate: true,
      didRename: true,
      didDelete: true,
      willCreate: true,
      willRename: true,
      willDelete: true
    },
    diagnostics: {
      refreshSupport: true
    }
  },
  textDocument: {
    diagnostic: {
      dynamicRegistration: true,
      relatedInformation: true
    },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true
    }
  }
};

export async function createStdioVirtualSession(options: StdioVirtualSessionOptions): Promise<LspVirtualSession> {
  const session = new StdioVirtualSession(options);
  await session.start();
  return session;
}

export function forceKillActiveStdioVirtualSessionChildren(): void {
  for (const child of [...activeStdioChildren]) {
    if (!isChildRunning(child)) {
      activeStdioChildren.delete(child);
      continue;
    }
    try {
      const signaled = killProcessTree(child, 'SIGKILL');
      if (!signaled) {
        activeStdioChildren.delete(child);
      }
    } catch {
      activeStdioChildren.delete(child);
    }
  }
}

class StdioVirtualSession implements LspVirtualSession {
  capabilities: Record<string, unknown> = {};

  private child: ChildProcessWithoutNullStreams | undefined;
  private parser: LspStdioMessageParser | undefined;
  private ready = false;
  private disposed = false;
  private disposalRequested = false;
  private exitHandled = false;
  private stderrTail = '';
  private readonly serverMessageListeners: Array<(message: unknown) => void> = [];
  private readonly exitListeners: Array<(exit: { code: number | null; signal: string | null }) => void> = [];
  private startupResolve: ((value: unknown) => void) | undefined;
  private startupReject: ((error: Error) => void) | undefined;

  constructor(private readonly options: StdioVirtualSessionOptions) {}

  async start(): Promise<void> {
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.workspaceRoot,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: 'pipe',
      shell: false,
      detached: process.platform !== 'win32'
    });
    trackActiveStdioChild(this.child);
    this.parser = new LspStdioMessageParser((message) => this.handleMessage(message));
    this.child.stdout.on('data', (chunk: Buffer) => this.parser?.push(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.appendStderr(chunk));
    this.child.stdin.on('error', (error: Error) => this.handleStdinError(error));
    this.child.stdin.on('close', () => this.handleStdinClosed());
    this.child.once('error', () => this.handleChildGone(null, null, new Error('LSP server failed to start')));
    this.child.once('exit', (code, signal) => this.handleChildGone(code, signal, undefined));

    const startup = new Promise<unknown>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    const timeout = setTimeout(() => {
      this.rejectStartup(new Error('LSP initialize timed out'));
      this.dispose();
    }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    timeout.unref();

    this.writeMessage({
      jsonrpc: '2.0',
      id: INITIALIZE_REQUEST_ID,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(this.options.workspaceRoot).toString(),
        workspaceFolders: [
          {
            uri: pathToFileURL(this.options.workspaceRoot).toString(),
            name: this.options.workspaceRoot
          }
        ],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.options.initializationOptions ?? {}
      }
    });

    const initializeResult = await startup.finally(() => clearTimeout(timeout));
    this.capabilities = readCapabilities(initializeResult);
    this.ready = true;
    this.writeMessage({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }

  sendClientMessage(message: unknown): void {
    this.writeMessage(message);
  }

  onServerMessage(listener: (message: unknown) => void): void {
    this.serverMessageListeners.push(listener);
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitListeners.push(listener);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposalRequested = true;
    const child = this.child;
    if (!child || !isChildRunning(child)) {
      return;
    }

    this.writeMessage({ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, method: 'shutdown', params: null });
    this.writeMessage({ jsonrpc: '2.0', method: 'exit', params: {} });

    const forceKill = setTimeout(() => {
      if (isChildRunning(child)) {
        killProcessTree(child, 'SIGKILL');
      }
    }, this.options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS);
    child.once('exit', () => clearTimeout(forceKill));
    killProcessTree(child, 'SIGTERM');
  }

  private handleMessage(message: unknown): void {
    if (!this.ready) {
      if (isInitializeResponse(message)) {
        if (message.error) {
          this.rejectStartup(new Error(message.error.message ?? 'LSP initialize failed'));
        } else {
          this.resolveStartup(message.result);
        }
      }
      return;
    }
    for (const listener of this.serverMessageListeners) {
      listener(message);
    }
  }

  private handleChildGone(code: number | null, signal: NodeJS.Signals | null, error: Error | undefined): void {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    if (!this.ready) {
      this.rejectStartup(error ?? new Error('LSP server exited before ready'));
      return;
    }
    if (this.disposalRequested) {
      return;
    }
    for (const listener of this.exitListeners) {
      listener({ code, signal });
    }
  }

  private handleStdinError(error: Error): void {
    if (!this.disposalRequested) {
      this.handleChildGone(null, null, error);
    }
    const child = this.child;
    if (child && isChildRunning(child)) {
      killProcessTree(child, 'SIGTERM');
    }
  }

  private handleStdinClosed(): void {
    const check = setTimeout(() => {
      const child = this.child;
      if (!child || this.exitHandled || this.disposalRequested || !isChildRunning(child)) {
        return;
      }
      this.handleStdinError(new Error('LSP stdin closed'));
    }, 0);
    check.unref();
  }

  private resolveStartup(value: unknown): void {
    const resolve = this.startupResolve;
    this.startupResolve = undefined;
    this.startupReject = undefined;
    resolve?.(value);
  }

  private rejectStartup(error: Error): void {
    const reject = this.startupReject;
    this.startupResolve = undefined;
    this.startupReject = undefined;
    reject?.(error);
  }

  private writeMessage(message: unknown): void {
    const child = this.child;
    if (!child || this.exitHandled || child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      child.stdin.write(encodeLspMessage(message), (error) => {
        if (error) {
          this.recordWriterError();
          this.handleStdinError(error);
        }
      });
    } catch (error) {
      this.recordWriterError();
      this.handleStdinError(error instanceof Error ? error : new Error('LSP stdin write failed'));
    }
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
  }

  private recordWriterError(): void {
    if (isLspRequestMetricsEnabled(this.options.requestMetrics)) {
      this.options.requestMetrics.writerError({ sessionId: this.options.sessionId });
    }
  }
}

function trackActiveStdioChild(child: ChildProcessWithoutNullStreams): void {
  activeStdioChildren.add(child);
  const remove = () => {
    activeStdioChildren.delete(child);
  };
  child.once('exit', remove);
  child.once('error', remove);
}

function isChildRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return child.kill(signal);
      }
      return false;
    }
  }
  return child.kill(signal);
}

function isInitializeResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { id?: unknown }).id === INITIALIZE_REQUEST_ID &&
    !('method' in value)
  );
}

function readCapabilities(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    const capabilities = (value as { capabilities?: unknown }).capabilities;
    if (typeof capabilities === 'object' && capabilities !== null) {
      return capabilities as Record<string, unknown>;
    }
  }
  return {};
}
