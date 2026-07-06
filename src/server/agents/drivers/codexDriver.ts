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

type CodexTransportClosedEvent = { method: 'transport/closed'; params: { message: string } };

export type CodexTransportEvent = ServerNotification | ServerRequest | CodexTransportClosedEvent;

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

const CODEX_INTERACTIVE_SLASH_BLOCKLIST = new Set([
  'login',
  'logout',
  'exit',
  'quit',
  'clear',
  'resume',
  'import',
  'raw',
  'experimental',
  'memories',
  'skills',
  'approve',
  'permissions'
]);

const CODEX_GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const CODEX_REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const CODEX_PERSONALITIES = new Set(['none', 'friendly', 'pragmatic']);

function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z][\w-]*)\s*(.*)$/is.exec(text.trim());
  if (!match) {
    return null;
  }
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}

function codexSettingsSlashPatch(name: string, args: string): Record<string, unknown> | null {
  switch (name) {
    case 'personality':
      if (!CODEX_PERSONALITIES.has(args)) {
        throw driverCommandError('/personality requires one of: none, friendly, pragmatic', 'unsupported-command', false);
      }
      return { personality: args };
    case 'effort':
      if (!args) {
        throw driverCommandError('/effort requires a value', 'unsupported-command', false);
      }
      return { effort: args };
    case 'summary':
      if (!CODEX_REASONING_SUMMARIES.has(args)) {
        throw driverCommandError('/summary requires one of: auto, concise, detailed, none', 'unsupported-command', false);
      }
      return { summary: args };
    case 'service-tier':
    case 'tier':
      return { serviceTier: args || null };
    case 'permission-profile':
      return { permissions: args || null };
    case 'approval':
    case 'approvals':
      if (!['untrusted', 'on-failure', 'on-request', 'never'].includes(args)) {
        throw driverCommandError('/approval requires one of: untrusted, on-failure, on-request, never', 'unsupported-command', false);
      }
      return { approvalPolicy: args };
    case 'fast':
      if (!args) {
        throw driverCommandError('/fast requires an explicit Codex service tier in native mode', 'unsupported-command', false);
      }
      return { serviceTier: args };
    default:
      return null;
  }
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
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private exited = false;
  private failed = false;

  constructor(private readonly process: CodexAppServerProcess) {
    this.process.stdout.on('data', (chunk) => this.readStdout(String(chunk)));
    this.process.stdin.on('error', (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.process.on('exit', (code, signal) => {
      this.fail(new Error(`codex app-server exited (${signal ?? code ?? 'unknown'})`));
    });
    this.process.on('error', (error) => {
      this.fail(error);
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
    const id = String(this.nextId++);
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
    this.exited = true;
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
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch (error) {
          console.error(
            `dropping malformed codex app-server stdout line: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }
        this.handleMessage(message as Record<string, unknown>);
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'string' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        console.error(`dropping codex app-server response for unknown request id ${message.id}`);
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
      return;
    }
    console.error(`dropping unrecognized codex app-server message: ${summarizeJson(message)}`);
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

  private fail(error: Error): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.exited = true;
    this.rejectPending(error);
    for (const handler of this.handlers) {
      handler({ method: 'transport/closed', params: { message: error.message } });
    }
  }
}

function summarizeJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

class CodexDriver implements AgentDriver {
  private readonly handlers = new Set<(event: DriverEvent) => void>();
  private thread: Thread | null = null;
  private activeTurnId: string | null = null;
  private pendingPermissions = 0;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly uiPermissionResolutions = new Map<string, string>();
  private unsubscribeTransport: (() => void) | null = null;
  private stopped = false;
  private userMessageCounter = 0;

  constructor(private readonly options: CodexDriverOptions & { transport: CodexAppServerTransport }) {
    this.unsubscribeTransport = this.options.transport.onEvent((event) => this.handleTransportEvent(event));
  }

  onEvent(handler: (event: DriverEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<{ session: { agentSessionId?: string; model?: string }; status: DriverStatusEvent }> {
    await this.options.transport.request('initialize', {
      clientInfo: { name: 'desk', title: 'Desk', version: '0.2.0' },
      capabilities: null
    });
    await this.options.transport.notify('initialized');

    let threadResult: unknown;
    if (this.options.resumeId) {
      threadResult = await this.options.transport.request('thread/resume', {
        threadId: this.options.resumeId,
        cwd: this.options.cwd,
        model: this.options.model ?? null
      });
    } else {
      threadResult = await this.options.transport.request('thread/start', {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {})
      });
    }

    const returnedThread = threadFromRpcResult(threadResult);
    if (!this.thread && returnedThread) {
      this.thread = returnedThread;
    }

    if (!this.thread) {
      throw new Error('codex app-server did not report a started thread');
    }

    return {
      session: { agentSessionId: this.thread.id, ...(this.options.model ? { model: this.options.model } : {}) },
      status: threadStatusToDriverStatus(this.thread)
    };
  }

  async inject(text: string, source: 'ui' | 'channel' | 'external'): Promise<void> {
    if (!this.thread) {
      throw driverCommandError('Cannot inject into Codex before start', 'adapter-unavailable', false);
    }
    const input = [{ type: 'text' as const, text, text_elements: [] }];
    const emitLocalUserMessage = (id?: string) => {
      this.userMessageCounter += 1;
      this.emit({ kind: 'user-message', id: id ?? `codex-user-${this.userMessageCounter}`, text, source });
    };
    const slash = parseSlashCommand(text);
    if (slash) {
      const confirmations = await this.handleSlashCommand(slash.name, slash.args);
      emitLocalUserMessage();
      for (const confirmation of confirmations) {
        this.emit(confirmation);
      }
      return;
    }
    if (this.activeTurnId) {
      await this.options.transport.request('turn/steer', {
        threadId: this.thread.id,
        expectedTurnId: this.activeTurnId,
        input
      });
      emitLocalUserMessage();
      return;
    }
    const result = await this.options.transport.request('turn/start', {
      threadId: this.thread.id,
      input
    });
    emitLocalUserMessage(userMessageIdFromTurnResult(result, text));
  }

  private async handleSlashCommand(name: string, args: string): Promise<DriverEvent[]> {
    if (!this.thread) {
      throw driverCommandError('Cannot run Codex slash command before start', 'adapter-unavailable', false);
    }
    if (CODEX_INTERACTIVE_SLASH_BLOCKLIST.has(name)) {
      throw driverCommandError(
        `/${name} is not available in native mode — switch this session to terminal UI for interactive commands`,
        'unsupported-command',
        false
      );
    }
    if (name === 'model') {
      await this.options.transport.request('thread/settings/update', {
        threadId: this.thread.id,
        model: args || null
      });
      return [{
        kind: 'session-info',
        agentSessionId: this.thread.id,
        ...(args ? { model: args } : {})
      }];
    }
    if (name === 'goal') {
      await this.handleGoalSlash(args);
      return [];
    }
    const settings = codexSettingsSlashPatch(name, args);
    if (settings) {
      await this.options.transport.request('thread/settings/update', {
        threadId: this.thread.id,
        ...settings
      });
      return [];
    }
    throw driverCommandError(
      `/${name} is not available in Codex native mode — switch this session to terminal UI for interactive commands`,
      'unsupported-command',
      false
    );
  }

  private async handleGoalSlash(args: string): Promise<void> {
    if (!this.thread) {
      throw driverCommandError('Cannot run Codex goal command before start', 'adapter-unavailable', false);
    }
    if (!args) {
      throw driverCommandError('/goal requires an objective, status, or clear in native mode', 'unsupported-command', false);
    }
    if (args === 'clear') {
      await this.options.transport.request('thread/goal/clear', { threadId: this.thread.id });
      return;
    }
    if (CODEX_GOAL_STATUSES.has(args)) {
      await this.options.transport.request('thread/goal/set', { threadId: this.thread.id, status: args });
      return;
    }
    await this.options.transport.request('thread/goal/set', { threadId: this.thread.id, objective: args });
  }

  async respondPermission(requestId: string, optionId: string, _note?: string): Promise<void> {
    const permission = this.permissions.get(requestId);
    if (!permission) {
      throw driverCommandError(`Unknown Codex permission request ${requestId}`, 'unknown-permission', false);
    }
    await this.options.transport.respond(requestId, permission.responseFor(optionId));
    this.uiPermissionResolutions.set(requestId, optionId);
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
      throw driverCommandError('Cannot fetch Codex history before start', 'adapter-unavailable', false);
    }
    let response: { thread?: Thread };
    try {
      response = (await this.options.transport.request('thread/read', { threadId, includeTurns: true })) as {
        thread?: Thread;
      };
    } catch (error) {
      if (isUnmaterializedThreadReadError(error)) {
        return [];
      }
      throw error;
    }
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
    if (event.method === 'transport/closed') {
      if (!this.thread) {
        return;
      }
      this.activeTurnId = null;
      this.pendingPermissions = 0;
      this.permissions.clear();
      this.uiPermissionResolutions.clear();
      this.emit({ kind: 'agent-error', fatal: false, message: event.params.message });
      this.emit({ kind: 'status', state: 'exited' });
      return;
    }
    const currentThreadId = this.thread?.id ?? this.options.resumeId;
    const incomingThreadId = eventThreadId(event);
    if (currentThreadId && incomingThreadId && incomingThreadId !== currentThreadId) {
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
    if (event.method === 'item/mcpToolCall/progress') {
      this.emit({ kind: 'tool-output-delta', toolUseId: event.params.itemId, text: event.params.message });
      return;
    }
    if (event.method === 'item/fileChange/patchUpdated') {
      this.emit({ kind: 'tool-output-delta', toolUseId: event.params.itemId, text: fileChangePatchSummary(event.params.changes) });
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
      const requestId = String(event.params.requestId);
      const uiOptionId = this.uiPermissionResolutions.get(requestId);
      this.pendingPermissions = Math.max(0, this.pendingPermissions - 1);
      this.permissions.delete(requestId);
      this.uiPermissionResolutions.delete(requestId);
      this.emit({
        kind: 'permission-resolved',
        requestId,
        optionId: uiOptionId ?? 'resolved',
        via: uiOptionId === undefined ? 'agent' : 'ui'
      });
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

function eventThreadId(event: CodexTransportEvent): string | null {
  if (event.method === 'thread/started') {
    return event.params.thread.id;
  }
  const params = event.params as { threadId?: unknown };
  return typeof params.threadId === 'string' ? params.threadId : null;
}

function threadFromRpcResult(result: unknown): Thread | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const thread = (result as { thread?: unknown }).thread;
  if (!thread || typeof thread !== 'object' || typeof (thread as { id?: unknown }).id !== 'string') {
    return null;
  }
  return thread as Thread;
}

function isUnmaterializedThreadReadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('is not materialized yet') && error.message.includes('includeTurns is unavailable before first user message');
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
    const eventCountBeforeTurn = events.length;
    for (const item of turn.items) {
      events.push(...itemToHistoryEvents(turn, item));
    }
    if (turn.status === 'completed' && events.length > eventCountBeforeTurn) {
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

function itemToHistoryEvents(turn: Turn, item: ThreadItem): DriverEvent[] {
  switch (item.type) {
    case 'userMessage':
      return [{ kind: 'user-message', id: item.id, text: userInputText(item.content), source: 'external' }];
    case 'agentMessage':
      return [{ kind: 'assistant-message', id: item.id, turnId: turn.id, markdown: item.text }];
    case 'commandExecution':
      return [commandToolStart(item), commandToolEnd(item)];
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'fileChange':
    case 'collabAgentToolCall':
    case 'webSearch':
    case 'imageView':
    case 'sleep':
    case 'imageGeneration':
      return toolHistoryEvents(item);
    default:
      return [];
  }
}

function itemStartedEvent(item: ThreadItem): DriverEvent | null {
  return toolStartEvent(item);
}

function itemCompletedEvent(turn: Turn, item: ThreadItem): DriverEvent | null {
  if (item.type === 'agentMessage') {
    return { kind: 'assistant-message', id: item.id, turnId: turn.id, markdown: item.text };
  }
  return toolEndEvent(item);
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

function commandToolStart(item: Extract<ThreadItem, { type: 'commandExecution' }>): DriverEvent {
  return { kind: 'tool-start', toolUseId: item.id, name: 'command', summary: item.command, detail: item.cwd };
}

function toolHistoryEvents(item: ThreadItem): DriverEvent[] {
  const start = toolStartEvent(item);
  const end = toolEndEvent(item);
  return [start, end].filter((event): event is DriverEvent => event !== null);
}

function toolStartEvent(item: ThreadItem): DriverEvent | null {
  switch (item.type) {
    case 'commandExecution':
      return commandToolStart(item);
    case 'mcpToolCall':
      return withOptionalDetail(
        { kind: 'tool-start', toolUseId: item.id, name: 'mcp', summary: `${item.server}.${item.tool}` },
        safeJson(item.arguments)
      );
    case 'dynamicToolCall':
      return withOptionalDetail(
        { kind: 'tool-start', toolUseId: item.id, name: 'dynamic-tool', summary: dottedName(item.namespace, item.tool) },
        safeJson(item.arguments)
      );
    case 'fileChange':
      return withOptionalDetail(
        { kind: 'tool-start', toolUseId: item.id, name: 'file-change', summary: plural(item.changes.length, 'file change') },
        fileChangePatchSummary(item.changes)
      );
    case 'collabAgentToolCall':
      return withOptionalDetail(
        { kind: 'tool-start', toolUseId: item.id, name: 'agent', summary: item.tool },
        [item.model ? `model ${item.model}` : '', item.prompt ?? ''].filter(Boolean).join('\n')
      );
    case 'webSearch':
      return withOptionalDetail(
        { kind: 'tool-start', toolUseId: item.id, name: 'web-search', summary: item.query },
        safeJson(item.action)
      );
    case 'imageView':
      return { kind: 'tool-start', toolUseId: item.id, name: 'image-view', summary: item.path };
    case 'sleep':
      return { kind: 'tool-start', toolUseId: item.id, name: 'sleep', summary: `${item.durationMs}ms` };
    case 'imageGeneration':
      return withOptionalDetail(
        { kind: 'tool-start', toolUseId: item.id, name: 'image-generation', summary: item.revisedPrompt ?? item.status },
        item.savedPath
      );
    default:
      return null;
  }
}

function toolEndEvent(item: ThreadItem): DriverEvent | null {
  switch (item.type) {
    case 'commandExecution':
      return commandToolEnd(item);
    case 'mcpToolCall':
      return withOptionalDetail(
        { kind: 'tool-end', toolUseId: item.id, status: item.status === 'completed' ? 'ok' : 'error', summary: item.status },
        item.error?.message ?? safeJson(item.result)
      );
    case 'dynamicToolCall':
      return withOptionalDetail(
        { kind: 'tool-end', toolUseId: item.id, status: item.status === 'completed' && item.success !== false ? 'ok' : 'error', summary: item.status },
        dynamicToolContentDetail(item.contentItems)
      );
    case 'fileChange':
      return withOptionalDetail(
        {
          kind: 'tool-end',
          toolUseId: item.id,
          status: item.status === 'completed' ? 'ok' : item.status === 'declined' ? 'denied' : 'error',
          summary: item.status
        },
        fileChangePatchSummary(item.changes)
      );
    case 'collabAgentToolCall':
      return withOptionalDetail(
        { kind: 'tool-end', toolUseId: item.id, status: item.status === 'completed' ? 'ok' : 'error', summary: item.status },
        item.receiverThreadIds.join('\n')
      );
    case 'webSearch':
    case 'imageView':
    case 'sleep':
      return { kind: 'tool-end', toolUseId: item.id, status: 'ok', summary: 'completed' };
    case 'imageGeneration':
      return withOptionalDetail(
        { kind: 'tool-end', toolUseId: item.id, status: imageGenerationStatus(item.status), summary: item.status },
        item.savedPath ?? item.result
      );
    default:
      return null;
  }
}

function dottedName(namespace: string | null, tool: string): string {
  return namespace ? `${namespace}.${tool}` : tool;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function fileChangePatchSummary(changes: Array<Extract<ThreadItem, { type: 'fileChange' }>['changes'][number]>): string {
  return changes.map((change) => change.path).join('\n');
}

function dynamicToolContentDetail(items: Extract<ThreadItem, { type: 'dynamicToolCall' }>['contentItems']): string {
  return (items ?? []).map((item) => (item.type === 'inputText' ? item.text : item.imageUrl)).join('\n');
}

function imageGenerationStatus(status: string): 'ok' | 'error' {
  return ['completed', 'complete', 'succeeded', 'success', 'saved'].includes(status.toLowerCase()) ? 'ok' : 'error';
}

function withOptionalDetail<T extends DriverEvent>(event: T, detail: string | undefined | null): T {
  return detail ? ({ ...event, detail } as T) : event;
}

function safeJson(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function userMessageIdFromTurnResult(result: unknown, text: string): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const turn = (result as { turn?: unknown }).turn;
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }
  const items = (turn as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return undefined;
  }
  const userMessage = items.find((item): item is Extract<ThreadItem, { type: 'userMessage' }> => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const maybeItem = item as Partial<ThreadItem>;
    return maybeItem.type === 'userMessage' && userInputText(maybeItem.content ?? []) === text;
  });
  return userMessage?.id;
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
    const question = firstValidUserInputQuestion(event.params);
    if (!question) {
      const requestId = String(event.id);
      console.error(`malformed codex user-input request ${requestId}: expected one question with id, prompt, and labeled options`);
      return {
        event: {
          kind: 'permission-request',
          requestId,
          variant: 'question',
          title: 'Invalid question request',
          detail: 'Codex sent a user-input request without a valid question payload.',
          options: [{ id: 'dismiss', label: 'Dismiss', treatment: 'deny' }]
        },
        responseFor: () => ({ answers: {} })
      };
    }
    return {
      event: {
        kind: 'permission-request',
        requestId: String(event.id),
        variant: 'question',
        title: question.header,
        ...(question.question ? { detail: question.question } : {}),
        options: question.options.map((option, index) => ({
          id: `${question.id}:${index}`,
          label: option.label,
          treatment: 'answer' as const
        }))
      },
      responseFor: (optionId: string) => {
        const [_questionId, indexText] = optionId.split(':');
        const optionIndex = Number(indexText);
        const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
        if (!option) {
          console.error(`invalid codex user-input response option ${optionId} for request ${String(event.id)}`);
          return { answers: { [question.id]: { answers: [optionId] } } };
        }
        return { answers: { [question.id]: { answers: [option.label] } } };
      }
    };
  }
  return null;
}

function firstValidUserInputQuestion(params: unknown): { id: string; header: string; question: string; options: Array<{ label: string }> } | null {
  const questions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const question = questions[0];
  if (!question || typeof question !== 'object') {
    return null;
  }
  const candidate = question as { id?: unknown; header?: unknown; question?: unknown; options?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.header !== 'string' || typeof candidate.question !== 'string') {
    return null;
  }
  if (!Array.isArray(candidate.options) || candidate.options.length === 0) {
    return null;
  }
  const options: Array<{ label: string }> = [];
  for (const option of candidate.options) {
    if (!option || typeof option !== 'object' || typeof (option as { label?: unknown }).label !== 'string') {
      return null;
    }
    options.push({ label: (option as { label: string }).label });
  }
  return { id: candidate.id, header: candidate.header, question: candidate.question, options };
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
