import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSurfacePermissionOption } from '../../../core/agentSurfaceProtocol.js';
import {
  driverCommandError,
  type AgentDriver,
  type DriverEvent,
  type DriverStatusEvent
} from '../host/driver.js';

/**
 * Claude Code driver (spec: docs/native-ui-mode-spec.md §5).
 *
 * Drives a persistent Claude Code session through the Claude Agent SDK in
 * streaming-input mode with the claude_code system-prompt preset and default
 * setting sources, so a native-mode session behaves like its terminal twin.
 * The SDK boundary is injectable for hermetic tests; production uses the real
 * SDK. Documented interop constraint: resume requires the same cwd, and the
 * respawn flow guarantees the previous consumer is dead before start().
 */

/** Loose structural view of an SDK message; the driver reads only what it maps. */
export interface ClaudeSdkMessage {
  type: string;
  [key: string]: unknown;
}

export interface ClaudePermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface ClaudeQueryOptions {
  resume?: string;
  cwd: string;
  systemPrompt: { type: 'preset'; preset: 'claude_code' };
  includePartialMessages: boolean;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: Record<string, unknown>
  ) => Promise<ClaudePermissionDecision>;
}

export interface ClaudeQueryConfig {
  prompt: AsyncIterable<Record<string, unknown>>;
  options: ClaudeQueryOptions;
}

export interface ClaudeQueryHandle extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<void>;
  /** Live model switch without respawn (SDK Query.setModel); absent on old SDKs. */
  setModel?: (model?: string) => Promise<void>;
  /** Slash-command discovery (SDK Query.supportedCommands); absent on old SDKs. */
  supportedCommands?: () => Promise<Array<{ name: string; description?: string }>>;
  close?: () => void;
}

/**
 * Slash commands that only make sense in the interactive TUI (auth flows,
 * pickers, conversation resets that would break the resume-id identity).
 * These fail with a typed unsupported-command error instead of being pushed
 * into the stream where they would hang or corrupt the session.
 */
const INTERACTIVE_SLASH_BLOCKLIST = new Set(['login', 'logout', 'exit', 'quit', 'clear', 'resume', 'theme', 'vim', 'terminal-setup']);

function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z][\w-]*)\s*(.*)$/is.exec(text.trim());
  if (!match) {
    return null;
  }
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}

export interface ClaudeSdkBoundary {
  query(config: ClaudeQueryConfig): ClaudeQueryHandle;
  getSessionMessages?(sessionId: string): Promise<ClaudeSdkMessage[]>;
}

export interface ClaudeDriverOptions {
  cwd: string;
  resume?: string;
  bypassPermissions: boolean;
  sdk?: ClaudeSdkBoundary;
}

interface PendingPermission {
  resolve: (decision: ClaudePermissionDecision) => void;
  variant: 'tool' | 'command' | 'file-edit' | 'question';
  toolName: string;
  input: Record<string, unknown>;
}

class PushableInput implements AsyncIterable<Record<string, unknown>> {
  private queue: Array<Record<string, unknown>> = [];
  private waiters: Array<(result: IteratorResult<Record<string, unknown>>) => void> = [];
  private closed = false;

  push(value: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as never });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ done: false, value: this.queue.shift() as Record<string, unknown> });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined as never });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

export function createClaudeDriver(options: ClaudeDriverOptions): AgentDriver {
  const sdk = options.sdk ?? createRealSdkBoundary();
  const handlers = new Set<(event: DriverEvent) => void>();
  const input = new PushableInput();
  const pendingPermissions = new Map<string, PendingPermission>();

  let handle: ClaudeQueryHandle | undefined;
  let sessionId = options.resume;
  let isShutdown = false;
  let turnCounter = 0;
  let permissionCounter = 0;
  let currentTurnId = 't0';
  let currentModel: string | undefined;

  function emit(event: DriverEvent): void {
    if (isShutdown) {
      return;
    }
    for (const handler of handlers) {
      handler(event);
    }
  }

  function status(state: DriverStatusEvent['state'], detail?: string): void {
    emit({ kind: 'status', state, ...(detail === undefined ? {} : { detail }) });
  }

  function assertLive(action: string): void {
    if (isShutdown) {
      throw driverCommandError(`claude driver is shut down; cannot ${action}`, 'adapter-unavailable', false);
    }
  }

  function canUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    _context: Record<string, unknown>
  ): Promise<ClaudePermissionDecision> {
    permissionCounter += 1;
    const requestId = `perm-${permissionCounter}`;
    const variant = permissionVariant(toolName);
    emit({
      kind: 'permission-request',
      requestId,
      variant,
      title: permissionTitle(toolName, toolInput),
      ...(permissionDetail(toolInput) === undefined ? {} : { detail: permissionDetail(toolInput) }),
      ...(buildDiff(toolName, toolInput) === undefined ? {} : { diff: buildDiff(toolName, toolInput) }),
      options: permissionOptions(variant, toolInput)
    });
    status('awaiting-permission', toolName);
    return new Promise((resolve) => {
      pendingPermissions.set(requestId, { resolve, variant, toolName, input: toolInput });
    });
  }

  async function consume(active: ClaudeQueryHandle): Promise<void> {
    try {
      for await (const message of active) {
        if (isShutdown) {
          return;
        }
        routeMessage(message);
      }
      // Stream ended without an error and outside shutdown: the claude process
      // is gone. Surface it so the cell never sits "idle" forever (glm review).
      if (!isShutdown) {
        emit({ kind: 'agent-error', message: 'claude session ended unexpectedly', fatal: false });
        status('exited');
      }
    } catch (error) {
      if (!isShutdown) {
        emit({ kind: 'agent-error', message: error instanceof Error ? error.message : String(error), fatal: true });
      }
    }
  }

  function routeMessage(message: ClaudeSdkMessage): void {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          if (typeof message.session_id === 'string' && message.session_id !== '') {
            sessionId = message.session_id;
          }
          // In streaming-input mode the CLI emits init only after the first
          // user message, so this arrives mid-session — surface it as a
          // session-info event rather than blocking start() on it.
          if (typeof message.model === 'string') {
            currentModel = message.model;
          }
          emit({
            kind: 'session-info',
            ...(sessionId ? { agentSessionId: sessionId } : {}),
            ...(typeof message.model === 'string' ? { model: message.model } : {})
          });
          // UX item 9: fetch the slash-command list once per spawn and surface it
          // via a follow-up session-info so the composer palette can populate.
          if (typeof handle?.supportedCommands === 'function') {
            void handle
              .supportedCommands()
              .then((commands) => {
                if (isShutdown || !Array.isArray(commands)) return;
                emit({
                  kind: 'session-info',
                  ...(sessionId ? { agentSessionId: sessionId } : {}),
                  commands: [
                    // Driver-intercepted command — not in SDK discovery but fully supported here.
                    { name: 'model', description: 'switch the model live (e.g. /model sonnet)' },
                    ...commands
                      .filter((c) => c && typeof c.name === 'string' && c.name !== '')
                      .map((c) => ({ name: c.name, ...(typeof c.description === 'string' ? { description: c.description } : {}) }))
                  ]
                });
              })
              .catch((err: unknown) => {
                console.error('claude driver: supportedCommands discovery failed:', err instanceof Error ? err.message : String(err));
              });
          }
        }
        return;
      }
      case 'stream_event': {
        const text = deltaText(message);
        if (text !== undefined) {
          emit({ kind: 'assistant-delta', turnId: currentTurnId, text });
        }
        return;
      }
      case 'assistant': {
        const record = message.message as Record<string, unknown> | undefined;
        const blocks = Array.isArray(record?.content) ? (record?.content as Array<Record<string, unknown>>) : [];
        const markdown = blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('');
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            emit({
              kind: 'tool-start',
              toolUseId: String(block.id ?? ''),
              name: String(block.name ?? 'tool'),
              summary: summarizeToolInput(String(block.name ?? 'tool'), block.input as Record<string, unknown> | undefined)
            });
            status('tool-executing', String(block.name ?? 'tool'));
          }
        }
        if (markdown !== '') {
          const id = String(record?.id ?? message.uuid ?? `assistant-${currentTurnId}`);
          emit({ kind: 'assistant-message', id, turnId: currentTurnId, markdown });
        }
        return;
      }
      case 'user': {
        const record = message.message as Record<string, unknown> | undefined;
        const blocks = Array.isArray(record?.content) ? (record?.content as Array<Record<string, unknown>>) : [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            emit({
              kind: 'tool-end',
              toolUseId: String(block.tool_use_id ?? ''),
              status: block.is_error === true ? 'error' : 'ok',
              ...(typeof block.content === 'string' ? { summary: block.content.slice(0, 200) } : {})
            });
          }
        }
        if (blocks.some((block) => block.type === 'tool_result')) {
          status('processing');
        }
        return;
      }
      case 'result': {
        if (message.subtype === 'success' || message.subtype === undefined) {
          const usage = message.usage as Record<string, unknown> | undefined;
          emit({
            kind: 'turn-complete',
            turnId: currentTurnId,
            usage: {
              ...(typeof usage?.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
              ...(typeof usage?.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
              ...(typeof message.total_cost_usd === 'number' ? { costUsd: message.total_cost_usd } : {})
            }
          });
        } else {
          emit({
            kind: 'agent-error',
            message: typeof message.result === 'string' ? message.result : `turn ended: ${String(message.subtype)}`,
            fatal: false
          });
        }
        status('idle');
        return;
      }
      default:
        return;
    }
  }

  return {
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    async start() {
      assertLive('start');
      const queryOptions: ClaudeQueryOptions = {
        cwd: options.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        ...(options.resume ? { resume: options.resume } : {}),
        ...(options.bypassPermissions
          ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
          : { canUseTool })
      };
      handle = sdk.query({ prompt: input, options: queryOptions });
      // Streaming-input deadlock guard (live-probe finding): the CLI emits its
      // init message only AFTER the first user message arrives on the input
      // stream, so start() must NOT wait for init. Return the best-known
      // session identity now; init surfaces later as a session-info event.
      // A short settle race still catches instant spawn failures so start()
      // honors its throw-on-unrecoverable contract.
      const loopEnded = consume(handle).then(() => 'ended' as const);
      const settled = await Promise.race([
        loopEnded,
        new Promise<'ok'>((resolve) => setTimeout(() => resolve('ok'), 300))
      ]);
      if (settled === 'ended' && !isShutdown) {
        throw new Error('claude session ended immediately after launch; see pane log for details');
      }
      return {
        session: {
          ...(sessionId ? { agentSessionId: sessionId } : {})
        },
        status: { kind: 'status', state: 'idle' }
      };
    },

    async inject(text, source) {
      assertLive('inject');
      const slash = parseSlashCommand(text);
      if (slash?.name === 'model') {
        turnCounter += 1;
        if (!slash.args) {
          // Bare /model opens a picker in the TUI; natively we report the current
          // model instead of silently doing nothing (found live: bare /model gave
          // zero feedback).
          emit({ kind: 'user-message', id: `user-${turnCounter}`, text, source });
          emit({
            kind: 'attention-hint',
            attention: 'session-status',
            detail: `current model: ${currentModel ?? 'provider default'} — use /model <name> to switch (e.g. /model sonnet)`
          });
          return;
        }
        if (typeof handle?.setModel !== 'function') {
          throw driverCommandError('/model is not supported by this claude sdk version', 'unsupported-command', false);
        }
        await handle.setModel(slash.args);
        currentModel = slash.args;
        emit({ kind: 'user-message', id: `user-${turnCounter}`, text, source });
        // No turn starts — confirm the switch via session-info so the model
        // badge updates immediately.
        emit({
          kind: 'session-info',
          ...(sessionId ? { agentSessionId: sessionId } : {}),
          ...(slash.args ? { model: slash.args } : {})
        });
        return;
      }
      if (slash && INTERACTIVE_SLASH_BLOCKLIST.has(slash.name)) {
        throw driverCommandError(
          `/${slash.name} is not available in native mode — switch this session to terminal UI for interactive commands`,
          'unsupported-command',
          false
        );
      }
      // Remaining slash text passes through as a prompt: the CLI processes its
      // known slash commands natively in streaming-input mode (/compact etc.).
      turnCounter += 1;
      currentTurnId = `t${turnCounter}`;
      emit({ kind: 'user-message', id: `user-${turnCounter}`, text, source });
      status('processing');
      input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: sessionId ?? ''
      });
    },

    async respondPermission(requestId, optionId, note) {
      assertLive('respond to a permission');
      const pending = pendingPermissions.get(requestId);
      if (!pending) {
        throw driverCommandError(`unknown permission request ${requestId}`, 'unknown-permission', false);
      }
      pendingPermissions.delete(requestId);
      emit({ kind: 'permission-resolved', requestId, optionId, via: 'ui' });
      status('processing');
      pending.resolve(buildDecision(pending, optionId, note));
    },

    async interrupt() {
      assertLive('interrupt');
      if (!handle) {
        throw driverCommandError('claude session is not running', 'adapter-unavailable', true);
      }
      await handle.interrupt();
      status('interrupted');
    },

    async fetchHistory() {
      assertLive('fetch history');
      if (!sessionId) {
        return [];
      }
      if (typeof sdk.getSessionMessages !== 'function') {
        throw driverCommandError(
          'claude sdk does not expose session history on this version',
          'adapter-unavailable',
          false
        );
      }
      const messages = await sdk.getSessionMessages(sessionId);
      const events: DriverEvent[] = [];
      let index = 0;
      for (const message of messages) {
        index += 1;
        const mapped = mapHistoryMessage(message, index);
        events.push(...mapped);
      }
      return events;
    },

    async shutdown() {
      if (isShutdown) {
        return;
      }
      isShutdown = true;
      for (const [requestId, pending] of pendingPermissions) {
        pendingPermissions.delete(requestId);
        pending.resolve({ behavior: 'deny', message: 'desk native session is shutting down' });
      }
      input.close();
      handle?.close?.();
    }
  };
}

function permissionVariant(toolName: string): PendingPermission['variant'] {
  if (toolName === 'Bash') {
    return 'command';
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    return 'file-edit';
  }
  if (toolName === 'AskUserQuestion') {
    return 'question';
  }
  return 'tool';
}

function permissionTitle(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return `Run: ${input.command.slice(0, 120)}`;
  }
  if (toolName === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    const first = questions[0];
    if (first && typeof first.question === 'string') {
      return first.question;
    }
    return 'The agent has a question';
  }
  if (typeof input.file_path === 'string') {
    return `${toolName}: ${input.file_path}`;
  }
  return `Allow ${toolName}?`;
}

function permissionDetail(input: Record<string, unknown>): string | undefined {
  if (typeof input.description === 'string') {
    return input.description;
  }
  return undefined;
}

function buildDiff(
  toolName: string,
  input: Record<string, unknown>
): { path: string; before?: string; after?: string } | undefined {
  if (typeof input.file_path !== 'string') {
    return undefined;
  }
  if (toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { path: input.file_path, before: input.old_string, after: input.new_string };
  }
  if (toolName === 'Write' && typeof input.content === 'string') {
    return { path: input.file_path, after: input.content };
  }
  return undefined;
}

function permissionOptions(variant: PendingPermission['variant'], input: Record<string, unknown>): AgentSurfacePermissionOption[] {
  if (variant === 'question') {
    const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    const first = questions[0];
    const answers = Array.isArray(first?.options) ? (first?.options as Array<Record<string, unknown>>) : [];
    const options: AgentSurfacePermissionOption[] = answers
      .filter((answer) => typeof answer.label === 'string')
      .map((answer) => ({
        id: answer.label as string,
        label: answer.label as string,
        treatment: 'answer' as const
      }));
    options.push({ id: 'other', label: 'Other', treatment: 'custom' });
    return options;
  }
  return [
    { id: 'allow', label: 'Allow', treatment: 'allow' },
    { id: 'deny', label: 'Deny', treatment: 'deny' }
  ];
}

function buildDecision(pending: PendingPermission, optionId: string, note?: string): ClaudePermissionDecision {
  if (optionId === 'deny') {
    return { behavior: 'deny', message: note ?? 'denied from desk' };
  }
  if (pending.variant === 'question') {
    const questions = Array.isArray(pending.input.questions)
      ? (pending.input.questions as Array<Record<string, unknown>>)
      : [];
    const first = questions[0];
    const question = typeof first?.question === 'string' ? first.question : 'question';
    const answer = optionId === 'other' && note ? note : optionId;
    return { behavior: 'allow', updatedInput: { ...pending.input, answers: { [question]: answer } } };
  }
  return { behavior: 'allow', updatedInput: pending.input };
}

function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) {
    return toolName;
  }
  if (typeof input.command === 'string') {
    return input.command.slice(0, 160);
  }
  if (typeof input.file_path === 'string') {
    return input.file_path;
  }
  if (typeof input.description === 'string') {
    return input.description.slice(0, 160);
  }
  return toolName;
}

function mapHistoryMessage(message: ClaudeSdkMessage, index: number): DriverEvent[] {
  const record = message.message as Record<string, unknown> | undefined;
  const turnId = `history-${index}`;
  if (message.type === 'user') {
    const events: DriverEvent[] = [];
    const blocks = Array.isArray(record?.content) ? (record?.content as Array<Record<string, unknown>>) : [];
    // tool_result blocks live on USER messages in the claude store — without
    // mapping them, every tool accordion vanished on restart (the live path
    // emitted tool-start/tool-end but backfill dropped both halves).
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        events.push({
          kind: 'tool-end',
          toolUseId: String(block.tool_use_id ?? ''),
          status: block.is_error === true ? 'error' : 'ok',
          ...(typeof block.content === 'string' ? { summary: block.content.slice(0, 200) } : {})
        });
      }
    }
    const text = historyText(record?.content);
    if (text !== undefined) {
      events.push({ kind: 'user-message', id: String(message.uuid ?? `history-user-${index}`), text, source: 'external' });
    }
    return events;
  }
  if (message.type === 'assistant') {
    const blocks = Array.isArray(record?.content) ? (record?.content as Array<Record<string, unknown>>) : [];
    const events: DriverEvent[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        events.push({
          kind: 'tool-start',
          toolUseId: String(block.id ?? ''),
          name: String(block.name ?? 'tool'),
          summary: summarizeToolInput(String(block.name ?? 'tool'), block.input as Record<string, unknown> | undefined)
        });
      }
    }
    const markdown = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    if (markdown !== '') {
      // tool-starts precede the message text — matches live emission order.
      events.push({
        kind: 'assistant-message',
        id: String(record?.id ?? message.uuid ?? `history-assistant-${index}`),
        turnId,
        markdown
      });
    }
    return events;
  }
  return [];
}

function historyText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const text = (content as Array<Record<string, unknown>>)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    return text === '' ? undefined : text;
  }
  return undefined;
}

function deltaText(message: ClaudeSdkMessage): string | undefined {
  const event = message.event as Record<string, unknown> | undefined;
  if (event?.type !== 'content_block_delta') {
    return undefined;
  }
  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return delta.text;
  }
  return undefined;
}

function createRealSdkBoundary(): ClaudeSdkBoundary {
  return {
    query: (config) => sdkQuery(config as never) as unknown as ClaudeQueryHandle,
    getSessionMessages: async (sessionId) => {
      const mod = (await import('@anthropic-ai/claude-agent-sdk')) as Record<string, unknown>;
      const fn = mod.getSessionMessages;
      if (typeof fn !== 'function') {
        throw driverCommandError(
          'claude sdk does not expose session history on this version',
          'adapter-unavailable',
          false
        );
      }
      const result = await (fn as (id: string) => Promise<unknown>)(sessionId);
      if (Array.isArray(result)) {
        return result as ClaudeSdkMessage[];
      }
      const collected: ClaudeSdkMessage[] = [];
      for await (const item of result as AsyncIterable<ClaudeSdkMessage>) {
        collected.push(item);
      }
      return collected;
    }
  };
}
