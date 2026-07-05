import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { AgentSurfacePermissionOption } from '../../../core/agentSurfaceProtocol.js';
import type { ServerNotification } from '../codexBindings/ServerNotification.js';
import type { ServerRequest } from '../codexBindings/ServerRequest.js';
import type { Thread } from '../codexBindings/v2/Thread.js';
import type { ThreadItem } from '../codexBindings/v2/ThreadItem.js';
import type { Turn } from '../codexBindings/v2/Turn.js';
import type { UserInput } from '../codexBindings/v2/UserInput.js';
import { driverCommandError, type AgentDriver, type DriverEvent, type DriverStatusEvent } from '../host/driver.js';

export type CodexTransportEvent = ServerNotification | ServerRequest;

export interface CodexAppServerTransport {
  onEvent(handler: (event: CodexTransportEvent) => void): () => void;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): Promise<void>;
  respond(requestId: string, result: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface CodexAppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface CodexAppServerTransportOptions {
  process?: CodexAppServerProcess;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexDriverOptions {
  transport?: CodexAppServerTransport;
  transportOptions?: CodexAppServerTransportOptions;
  cwd: string;
  model?: string;
  resumeId?: string;
}

export function createCodexAppServerTransport(options: CodexAppServerTransportOptions = {}): CodexAppServerTransport {
  return new JsonlCodexAppServerTransport(
    options.process ??
      spawn(options.command ?? 'codex', options.args ?? ['app-server'], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
  );
}

export function createCodexDriver(options: CodexDriverOptions): AgentDriver {
  return new CodexDriver({
    ...options,
    transport: options.transport ?? createCodexAppServerTransport({ cwd: options.cwd, ...options.transportOptions })
  });
}

class JsonlCodexAppServerTransport implements CodexAppServerTransport {
  private nextId = 1;
  private buffer = '';
  private readonly handlers = new Set<(event: CodexTransportEvent) => void>();
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private exited = false;

  constructor(private readonly process: CodexAppServerProcess) {
    this.process.stdout.on('data', (chunk) => this.readStdout(String(chunk)));
    this.process.on('exit', (code, signal) => {
      this.exited = true;
      this.rejectPending(new Error(`codex app-server exited (${signal ?? code ?? 'unknown'})`));
    });
    this.process.on('error', (error) => {
      this.rejectPending(error);
    });
  }

  onEvent(handler: (event: CodexTransportEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) {
      throw new Error('codex app-server exited');
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  async notify(method: string): Promise<void> {
    this.write({ method });
  }

  async respond(requestId: string, result: unknown): Promise<void> {
    this.write({ id: requestId, result });
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.process.kill('SIGTERM');
  }

  private readStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error && typeof message.error === 'object' && 'message' in message.error) {
        pending.reject(new Error(String((message.error as { message: unknown }).message)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      for (const handler of this.handlers) {
        handler(message as CodexTransportEvent);
      }
    }
  }

  private write(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class CodexDriver implements AgentDriver {
  private readonly handlers = new Set<(event: DriverEvent) => void>();
  private thread: Thread | null = null;
  private activeTurnId: string | null = null;
  private pendingPermissions = 0;
  private readonly permissions = new Map<string, PendingPermission>();
  private unsubscribeTransport: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: CodexDriverOptions & { transport: CodexAppServerTransport }) {
    this.unsubscribeTransport = this.options.transport.onEvent((event) => this.handleTransportEvent(event));
  }

  onEvent(handler: (event: DriverEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<{ session: { agentSessionId?: string; model?: string }; status: DriverStatusEvent }> {
    await this.options.transport.request('initialize', { clientInfo: { name: 'desk', version: 1 } });
    await this.options.transport.notify('initialized');

    if (this.options.resumeId) {
      await this.options.transport.request('thread/resume', {
        threadId: this.options.resumeId,
        cwd: this.options.cwd,
        model: this.options.model ?? null
      });
    } else {
      await this.options.transport.request('thread/start', {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {})
      });
    }

    if (!this.thread) {
      throw new Error('codex app-server did not report a started thread');
    }

    return {
      session: { agentSessionId: this.thread.id, ...(this.options.model ? { model: this.options.model } : {}) },
      status: threadStatusToDriverStatus(this.thread)
    };
  }

  async inject(text: string, _source: 'ui' | 'channel' | 'external'): Promise<void> {
    if (!this.thread) {
      throw driverCommandError('Cannot inject into Codex before start', 'adapter-unavailable', true);
    }
    const input = [{ type: 'text' as const, text, text_elements: [] }];
    if (this.activeTurnId) {
      await this.options.transport.request('turn/steer', {
        threadId: this.thread.id,
        expectedTurnId: this.activeTurnId,
        input
      });
      return;
    }
    await this.options.transport.request('turn/start', {
      threadId: this.thread.id,
      input
    });
  }

  async respondPermission(requestId: string, optionId: string, _note?: string): Promise<void> {
    const permission = this.permissions.get(requestId);
    if (!permission) {
      throw driverCommandError(`Unknown Codex permission request ${requestId}`, 'unknown-permission', false);
    }
    await this.options.transport.respond(requestId, permission.responseFor(optionId));
  }

  async interrupt(): Promise<void> {
    if (!this.thread || !this.activeTurnId) {
      throw driverCommandError('No active Codex turn to interrupt', 'adapter-unavailable', false);
    }
    await this.options.transport.request('turn/interrupt', {
      threadId: this.thread.id,
      turnId: this.activeTurnId
    });
  }

  async fetchHistory(): Promise<DriverEvent[]> {
    const threadId = this.thread?.id ?? this.options.resumeId;
    if (!threadId) {
      throw driverCommandError('Cannot fetch Codex history before start', 'adapter-unavailable', true);
    }
    const response = (await this.options.transport.request('thread/read', { threadId, includeTurns: true })) as {
      thread?: Thread;
    };
    return flattenThreadHistory(response.thread);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.handlers.clear();
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    await this.options.transport.close();
  }

  private handleTransportEvent(event: CodexTransportEvent): void {
    if (this.stopped) {
      return;
    }
    if (event.method === 'thread/started') {
      this.thread = event.params.thread;
      this.activeTurnId = findActiveTurnId(event.params.thread);
      return;
    }
    if (event.method === 'turn/started') {
      this.activeTurnId = event.params.turn.id;
      this.emit({ kind: 'status', state: 'processing' });
      return;
    }
    if (event.method === 'item/agentMessage/delta') {
      this.emit({ kind: 'assistant-delta', turnId: event.params.turnId, text: event.params.delta });
      return;
    }
    if (event.method === 'item/started') {
      const payload = itemStartedEvent(event.params.item);
      if (payload) {
        this.emit(payload);
      }
      return;
    }
    if (event.method === 'item/commandExecution/outputDelta') {
      this.emit({ kind: 'tool-output-delta', toolUseId: event.params.itemId, text: event.params.delta });
      return;
    }
    if (event.method === 'item/completed') {
      const payload = itemCompletedEvent({ id: event.params.turnId } as Turn, event.params.item);
      if (payload) {
        this.emit(payload);
      }
      return;
    }
    if (event.method === 'turn/completed') {
      if (this.activeTurnId === event.params.turn.id) {
        this.activeTurnId = null;
      }
      this.emit({ kind: 'turn-complete', turnId: event.params.turn.id });
      this.emit({ kind: 'status', state: 'idle' });
      return;
    }
    const permission = permissionFromServerRequest(event);
    if (permission) {
      this.permissions.set(permission.event.requestId, permission);
      this.pendingPermissions += 1;
      this.emit({ kind: 'status', state: 'awaiting-permission' });
      this.emit(permission.event);
      return;
    }
    if (event.method === 'serverRequest/resolved') {
      this.pendingPermissions = Math.max(0, this.pendingPermissions - 1);
      this.permissions.delete(String(event.params.requestId));
      this.emit({ kind: 'permission-resolved', requestId: String(event.params.requestId), optionId: 'resolved', via: 'agent' });
      if (this.pendingPermissions === 0 && !this.activeTurnId) {
        this.emit({ kind: 'status', state: 'idle' });
      }
    }
  }

  private emit(event: DriverEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

function threadStatusToDriverStatus(thread: Thread): DriverStatusEvent {
  switch (thread.status.type) {
    case 'idle':
      return { kind: 'status', state: 'idle' };
    case 'active':
      return thread.status.activeFlags.includes('waitingOnApproval') || thread.status.activeFlags.includes('waitingOnUserInput')
        ? { kind: 'status', state: 'awaiting-permission' }
        : { kind: 'status', state: 'processing' };
    case 'systemError':
      return { kind: 'status', state: 'error' };
    case 'notLoaded':
      return { kind: 'status', state: 'starting' };
  }
}

function flattenThreadHistory(thread: Thread | undefined): DriverEvent[] {
  if (!thread) {
    return [];
  }
  const events: DriverEvent[] = [];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const event = itemToHistoryEvent(turn, item);
      if (event) {
        events.push(event);
      }
    }
    if (turn.status === 'completed') {
      events.push({ kind: 'turn-complete', turnId: turn.id });
    }
  }
  return events;
}

function findActiveTurnId(thread: Thread): string | null {
  for (const turn of thread.turns) {
    if (turn.status === 'inProgress') {
      return turn.id;
    }
  }
  return null;
}

function itemToHistoryEvent(turn: Turn, item: ThreadItem): DriverEvent | null {
  switch (item.type) {
    case 'userMessage':
      return { kind: 'user-message', id: item.id, text: userInputText(item.content), source: 'external' };
    case 'agentMessage':
      return { kind: 'assistant-message', id: item.id, turnId: turn.id, markdown: item.text };
    case 'commandExecution':
      return commandToolEnd(item);
    default:
      return null;
  }
}

function itemStartedEvent(item: ThreadItem): DriverEvent | null {
  if (item.type === 'commandExecution') {
    return { kind: 'tool-start', toolUseId: item.id, name: 'command', summary: item.command, detail: item.cwd };
  }
  return null;
}

function itemCompletedEvent(turn: Turn, item: ThreadItem): DriverEvent | null {
  if (item.type === 'agentMessage') {
    return { kind: 'assistant-message', id: item.id, turnId: turn.id, markdown: item.text };
  }
  if (item.type === 'commandExecution') {
    return commandToolEnd(item);
  }
  return null;
}

function commandToolEnd(item: Extract<ThreadItem, { type: 'commandExecution' }>): DriverEvent {
  return {
    kind: 'tool-end',
    toolUseId: item.id,
    status: item.status === 'completed' ? 'ok' : item.status === 'declined' ? 'denied' : 'error',
    summary: item.exitCode === null ? item.status : `exit ${item.exitCode}`,
    ...(item.aggregatedOutput ? { detail: item.aggregatedOutput } : {})
  };
}

function userInputText(inputs: UserInput[]): string {
  return inputs
    .filter((input): input is Extract<UserInput, { type: 'text' }> => input.type === 'text')
    .map((input) => input.text)
    .join('\n');
}

interface PendingPermission {
  event: Extract<DriverEvent, { kind: 'permission-request' }>;
  responseFor(optionId: string): unknown;
}

function permissionFromServerRequest(event: CodexTransportEvent): PendingPermission | null {
  if (event.method === 'item/commandExecution/requestApproval') {
    return {
      event: {
        kind: 'permission-request',
        requestId: String(event.id),
        variant: 'command',
        title: 'Run command',
        detail: [event.params.command, event.params.reason].filter(Boolean).join('\n\n'),
        options: commandDecisionOptions(event.params.availableDecisions)
      },
      responseFor: (optionId: string) => ({ decision: optionId })
    };
  }
  if (event.method === 'item/fileChange/requestApproval') {
    return {
      event: {
        kind: 'permission-request',
        requestId: String(event.id),
        variant: 'file-edit',
        title: 'Allow file changes',
        ...(event.params.reason ? { detail: event.params.reason } : {}),
        options: [
          { id: 'accept', label: 'Allow', treatment: 'allow' },
          { id: 'decline', label: 'Deny', treatment: 'deny' }
        ]
      },
      responseFor: (optionId: string) => ({ decision: optionId })
    };
  }
  if (event.method === 'item/tool/requestUserInput') {
    const question = event.params.questions[0];
    return {
      event: {
        kind: 'permission-request',
        requestId: String(event.id),
        variant: 'question',
        title: question?.header ?? 'Question',
        ...(question?.question ? { detail: question.question } : {}),
        options:
          question?.options?.map((option, index) => ({
            id: `${question.id}:${index}`,
            label: option.label,
            treatment: 'answer' as const
          })) ?? []
      },
      responseFor: (optionId: string) => {
        if (!question) {
          return { answers: {} };
        }
        const [_questionId, indexText] = optionId.split(':');
        const option = question.options?.[Number(indexText)];
        return { answers: { [question.id]: { answers: [option?.label ?? optionId] } } };
      }
    };
  }
  return null;
}

function commandDecisionOptions(decisions: unknown): AgentSurfacePermissionOption[] {
  const values = Array.isArray(decisions) && decisions.length > 0 ? decisions : ['accept', 'decline'];
  const options: AgentSurfacePermissionOption[] = [];
  for (const decision of values) {
    if (decision === 'accept') {
      options.push({ id: 'accept', label: 'Allow', treatment: 'allow' });
    } else if (decision === 'acceptForSession') {
      options.push({ id: 'acceptForSession', label: 'Allow for session', treatment: 'allow-session' });
    } else if (decision === 'decline' || decision === 'cancel') {
      options.push({ id: String(decision), label: 'Deny', treatment: 'deny' });
    }
  }
  return options;
}
