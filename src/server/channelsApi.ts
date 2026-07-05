import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { readJsonBody, sendJson } from './httpUtil.js';
import { addAgentSignalListener, attentionTracker } from './attention.js';
import { loadDesk, loadDeskCached } from '../core/runner.js';
import { buildOnboardingPrompt, ChannelsEngine, sendTextToTmux } from './channelsEngine.js';
import {
  claimDelivering,
  confirmDelivered,
  markStuck,
  revertAllDeliveringToJson
} from './channelsDurability.js';
import {
  addMemberWithUniqueHandle,
  appendMessage,
  channelFilePath,
  ChannelsWatcher,
  createChannel,
  deleteMessage,
  destroyChannel,
  editChannelGoal,
  editMessage,
  ensureChannelsHome,
  listChannelMembers,
  listChannels,
  readChannelDetail,
  readChannelMessages,
  readThread,
  removeMember,
  resolveChannelsHome,
  saveChannelFile,
  searchChannelMessages
} from './channelsStore.js';
import { addFeatured, listFeaturedItems, removeFeatured } from './channelsFeatured.js';
import {
  addReaction,
  clearReactionsForMessage,
  listReactions,
  removeReaction
} from './channelsReactions.js';
import {
  addView,
  listViews,
  removeView
} from './channelsViews.js';
import {
  listPausedSessions,
  pauseSession as persistPausedSession,
  resumeSession as persistResumedSession
} from './channelsPaused.js';
import { readDeliveryEvents, latestEventSeq } from './channelsEvents.js';
import { exportChannelToMarkdown } from './channelsExport.js';
import {
  formatSharedMessage,
  isValidChannelName,
  parseConversation,
  qualifiedMemberHandle,
  type ReactionKind,
  type ViewFilter
} from './channelsProtocol.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSurfaceBroker } from './agentSurfaceBroker.js';

/**
 * /api/channels/* — slack-like messaging between desk agents over the
 * filesystem channels protocol. The desk server is the engine: it appends
 * messages, watches for external protocol writes, resolves mentions and
 * drains per-agent prompt queues gated on agent turn signals.
 */

/** Lazy-load window sizes: messages rendered on open, per scroll page, and the
 *  read-context kept above the first unread when anchoring the initial window. */
const CHANNEL_PAGE_INITIAL = 50;
const CHANNEL_PAGE_MORE = 40;
const CHANNEL_UNREAD_CONTEXT = 5;
const REACTION_KINDS = new Set<ReactionKind>(['ack', 'seen', 'done', 'thumbs-up']);

interface ChannelsRuntime {
  home: string;
  engine: ChannelsEngine;
  watcher: ChannelsWatcher;
  /** unsubscribes the engine from agent turn signals */
  removeSignalListener: () => void;
}

let runtime: ChannelsRuntime | undefined;

export interface ChannelsRuntimeOptions {
  home?: string;
  agentSurfaceBroker?: ChannelDeliveryBroker;
}

export function initChannelsRuntime(options: ChannelsRuntimeOptions = {}): ChannelsRuntime {
  if (runtime) {
    return runtime;
  }
  const home = ensureChannelsHome(options.home ?? resolveChannelsHome());
  let engine!: ChannelsEngine;
  const sendChannelDelivery = createChannelDeliverySender({
    agentSurfaceBroker: options.agentSurfaceBroker,
    onNonRetryableNativeFailure: (tmuxSession, error) => {
      pauseEngineSession(home, engine, tmuxSession, `native channel delivery failed (${error.code}): ${error.message}`);
    }
  });
  engine = new ChannelsEngine({
    home,
    // sendText wrapper: on a false return (tmux unreachable / session vanished),
    // revert EVERY .delivering file for this session back to .json. The engine's
    // draining lock guarantees no concurrent in-flight delivery per session, so
    // the set of .delivering files at this point is exactly the digest fan-out
    // for this single failed send. The pump then re-drains the reverted items
    // when the session becomes reachable again.
    sendText: async (tmuxSession, text) => {
      const ok = await sendChannelDelivery(tmuxSession, text);
      if (!ok) {
        revertAllDeliveringToJson(home, tmuxSession);
      }
      return ok;
    },
    // onSubmitStateChange drives the per-item durability renames. Fires on
    // every transition (synchronous 'delivering' claim + async terminal
    // states from verifySubmitted). Each helper is idempotent — a re-fire
    // after restart no-ops rather than throws, so crash-mid-transition leaves
    // a clean durable state the restore pass classifies correctly.
    onSubmitStateChange: (tmuxSession, state, context) => {
      switch (state) {
        case 'delivering':
          claimDelivering(home, tmuxSession, context.seq);
          break;
        case 'submitted':
          confirmDelivered(home, tmuxSession, context.seq);
          break;
        case 'delivery-ack-timeout':
          confirmDelivered(home, tmuxSession, context.seq);
          break;
        case 'submit-stuck-paste':
          markStuck(home, tmuxSession, context.seq, 'paste');
          break;
        case 'submit-stuck-submit':
          markStuck(home, tmuxSession, context.seq, 'submit');
          break;
        case 'submit-stuck-unobservable':
          markStuck(home, tmuxSession, context.seq, 'unobservable');
          break;
      }
    },
    onChannelMessage: (channel, file, message, pingsHuman) => {
      const authorSession =
        listChannelMembers(home, channel).find((member) => member.name === message.author)?.tmuxSession ?? '';
      const preview = message.body.replace(/\s+/g, ' ').slice(0, 200);
      attentionTracker.pushEvent(
        authorSession,
        'channel',
        `${pingsHuman ? '@human · ' : ''}#${channel} @${message.author}: ${preview}`,
        {
          channel,
          messageId: message.id,
          thread: file.startsWith('thread-') ? file.slice('thread-'.length, -'.md'.length) : undefined
        }
      );
    },
    sessionInfo: (tmuxSession) => {
      const spec = loadDeskCached({}).sessions.find((candidate) => candidate.tmuxSession === tmuxSession);
      if (!spec) {
        return undefined;
      }
      return {
        sessionName: spec.name,
        agent: spec.agent,
        cwd: spec.cwd,
        resume: spec.resume,
        bypassPermissions: spec.bypassPermissions
      };
    }
  });
  const watcher = new ChannelsWatcher(home, (incoming) => engine.handleMessage(incoming));
  watcher.start();
  const removeSignalListener = addAgentSignalListener((tmuxSession, kind) => {
    if (kind === 'turn-complete' || kind === 'bell' || kind === 'approval-requested' || kind === 'input-requested') {
      engine.handleAgentSignal(tmuxSession, kind);
    }
  });
  runtime = { home, engine, watcher, removeSignalListener };
  return runtime;
}

function pauseEngineSession(home: string, engine: ChannelsEngine, tmuxSession: string, reason?: string): void {
  const paused = persistPausedSession(home, tmuxSession, reason);
  engine.pauseSession(tmuxSession, paused.reason, paused.pausedAt);
}

function resumeEngineSession(home: string, engine: ChannelsEngine, tmuxSession: string): void {
  persistResumedSession(home, tmuxSession);
  engine.resumeSession(tmuxSession);
}

/**
 * Tears the runtime down completely. MUST be called when the vite dev server
 * restarts (it re-imports this module in the same Node process): a leaked old
 * engine + watcher would dispatch every message a second time — double
 * prompts in the agent terminals.
 */
export function disposeChannelsRuntime(): void {
  runtime?.watcher.stop();
  runtime?.engine.dispose();
  runtime?.removeSignalListener();
  runtime = undefined;
}

/** test hook */
export function resetChannelsRuntime(): void {
  disposeChannelsRuntime();
}

/**
 * Ops-console recovery: tear the engine down and build a fresh one in-process.
 * The replacement re-reads the persisted disk queues and restarts the pump, so
 * a wedged engine recovers WITHOUT restarting `desk serve`.
 */
export function rebuildChannelsRuntime(): ChannelsRuntime {
  disposeChannelsRuntime();
  return initChannelsRuntime();
}

/**
 * Inline-safe content types for uploaded channel files. Deliberately excludes
 * anything that can run script on the app origin (svg, html); everything else
 * is forced to download as application/octet-stream.
 */
const FILE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.log': 'text/plain; charset=utf-8'
};

type ChannelDeliveryBroker = Pick<AgentSurfaceBroker, 'injectUserMessage'>;

interface ChannelDeliverySession {
  tmuxSession: string;
  uiMode?: 'terminal' | 'native';
}

export interface ChannelDeliveryFailure {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ChannelDeliverySenderOptions {
  agentSurfaceBroker?: ChannelDeliveryBroker;
  terminalSender?: (tmuxSession: string, text: string) => Promise<boolean>;
  lookupSession?: (tmuxSession: string) => ChannelDeliverySession | undefined;
  onNonRetryableNativeFailure?: (tmuxSession: string, error: ChannelDeliveryFailure) => void;
  log?: (message: string) => void;
}

export function createChannelDeliverySender(options: ChannelDeliverySenderOptions = {}): (tmuxSession: string, text: string) => Promise<boolean> {
  const terminalSender = options.terminalSender ?? sendTextToTmux;
  const lookupSession = options.lookupSession ?? lookupDeskSessionForDelivery;
  const log = options.log ?? ((message: string) => console.warn(message));
  return async (tmuxSession, text) => {
    const session = lookupSession(tmuxSession);
    if (session?.uiMode !== 'native') {
      return terminalSender(tmuxSession, text);
    }
    if (!options.agentSurfaceBroker) {
      log(`native channel delivery failed for ${tmuxSession}: no agent surface broker`);
      return false;
    }
    try {
      await options.agentSurfaceBroker.injectUserMessage(tmuxSession, text, 'channel');
      return true;
    } catch (error) {
      const failure = channelDeliveryFailure(error);
      log(`native channel delivery failed for ${tmuxSession}: ${failure.code}: ${failure.message}`);
      if (failure.retryable === false) {
        options.onNonRetryableNativeFailure?.(tmuxSession, failure);
      }
      return false;
    }
  };
}

function lookupDeskSessionForDelivery(tmuxSession: string): ChannelDeliverySession | undefined {
  return loadDeskCached({}).sessions.find((candidate) => candidate.tmuxSession === tmuxSession);
}

function channelDeliveryFailure(error: unknown): ChannelDeliveryFailure {
  if (error instanceof Error) {
    const record = error as { code?: unknown; retryable?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : 'adapter-unavailable',
      message: error.message,
      ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {})
    };
  }
  return { code: 'adapter-unavailable', message: String(error) };
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireReactionKind(value: unknown): ReactionKind {
  if (typeof value === 'string' && REACTION_KINDS.has(value as ReactionKind)) {
    return value as ReactionKind;
  }
  throw new Error('kind must be one of ack, seen, done, thumbs-up');
}

function optionalViewFilter(value: unknown): ViewFilter {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const input = value as Record<string, unknown>;
  return {
    text: typeof input.text === 'string' ? input.text : undefined,
    author: typeof input.author === 'string' ? input.author : undefined,
    mentionsMe: input.mentionsMe === true ? true : undefined,
    hasThread: input.hasThread === true ? true : undefined
  };
}

function requireChannel(value: unknown): string {
  const name = requireString(value, 'channel');
  if (!isValidChannelName(name)) {
    throw new Error(`invalid channel name: ${name}`);
  }
  return name;
}

/**
 * Resolves the message author for a post:
 *  - explicit member name (`as`), validated against the channel roster;
 *  - a tmux session name (`tmux`) mapped to the member it backs — this is
 *    how `desk channels post` identifies the agent without trusting input;
 *  - otherwise the human operator.
 */
function resolveAuthor(home: string, channel: string, body: Record<string, unknown>): string {
  const members = listChannelMembers(home, channel);
  if (typeof body.as === 'string' && body.as.length > 0) {
    if (body.as !== 'human' && !members.some((member) => member.name === body.as)) {
      throw new Error(`@${String(body.as)} is not a member of #${channel}`);
    }
    return body.as;
  }
  if (typeof body.tmux === 'string' && body.tmux.length > 0) {
    const member = members.find((candidate) => candidate.tmuxSession === body.tmux);
    if (member) {
      return member.name;
    }
    throw new Error(`tmux session ${String(body.tmux)} is not a member of #${channel}`);
  }
  return 'human';
}

const MEMBER_TYPE_BY_AGENT: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex-cli'
};

/** Maps an optional thread parent id to the conversation file it lives in. */
function resolveConversationFile(thread: unknown): string {
  if (typeof thread !== 'string' || thread.length === 0) {
    return 'root.md';
  }
  if (!/^msg-[A-Za-z0-9-]+$/.test(thread)) {
    throw new Error(`invalid thread id: ${thread}`);
  }
  return `thread-${thread}.md`;
}

export async function handleChannelsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/channels/')) {
    return false;
  }
  const { home, engine, watcher } = initChannelsRuntime();

  try {
    if (req.method === 'GET' && url.pathname === '/api/channels/state') {
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      sendJson(res, 200, {
        home,
        channels: listChannels(home),
        delivery: engine.lifecycleStates(),
        activity: engine.listActivity(since).slice(-100),
        activitySeq: engine.latestActivitySeq(),
        // another live desk process owns dispatch for this channels home
        passive: engine.passive,
        // the owning process's pid, so the UI can name the owner + offer recovery
        passiveOwner: engine.passiveOwnerPid
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/engine') {
      // Ops console: live per-session diagnostics (each runs a real pane probe,
      // so this is NOT on the hot /state poll path) plus engine health.
      const sessions = await engine.inspectAll();
      sendJson(res, 200, {
        home,
        passive: engine.passive,
        pumpAlive: engine.pumpAlive(),
        totalQueued: sessions.reduce((sum, session) => sum + session.queued, 0),
        sessions,
        activity: engine.listActivity(0).slice(-100)
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/engine/action') {
      const body = await readJsonBody(req);
      const action = requireString(body.action, 'action');
      const tmuxSession = typeof body.tmuxSession === 'string' ? body.tmuxSession : undefined;
      switch (action) {
        case 'mark-idle':
          engine.markIdle(requireString(tmuxSession, 'tmuxSession'));
          break;
        case 'pause-session':
          pauseEngineSession(home, engine, requireString(tmuxSession, 'tmuxSession'), typeof body.reason === 'string' ? body.reason : undefined);
          break;
        case 'resume-session':
          resumeEngineSession(home, engine, requireString(tmuxSession, 'tmuxSession'));
          break;
        case 'drop-queue':
          engine.dropQueue(requireString(tmuxSession, 'tmuxSession'));
          break;
        case 'drop-message': {
          const seq = Number(body.seq);
          if (!Number.isInteger(seq)) {
            throw new Error('seq is required');
          }
          engine.dropMessage(requireString(tmuxSession, 'tmuxSession'), seq);
          break;
        }
        case 'force-deliver': {
          const seq = Number.isInteger(Number(body.seq)) ? Number(body.seq) : undefined;
          await engine.forceDeliver(requireString(tmuxSession, 'tmuxSession'), seq);
          break;
        }
        case 'drain-ready-all':
          await engine.drainReady();
          break;
        case 'rebuild-engine': {
          const fresh = rebuildChannelsRuntime();
          sendJson(res, 200, { ok: true, sessions: await fresh.engine.inspectAll() });
          return true;
        }
        default:
          throw new Error(`unknown engine action: ${action}`);
      }
      sendJson(res, 200, { ok: true, sessions: await engine.inspectAll() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/channel') {
      // Initial window: anchored on the reader's first unread (`since`), else newest.
      const since = url.searchParams.get('since');
      sendJson(
        res,
        200,
        readChannelDetail(home, requireChannel(url.searchParams.get('name')), {
          since,
          limit: CHANNEL_PAGE_INITIAL,
          contextAbove: CHANNEL_UNREAD_CONTEXT
        })
      );
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/messages') {
      // Scroll paging: older before a cursor, newer after it, around a target
      // message id for jump/navigation, or the whole
      // channel (`all=1`, used when the operator activates the filter box).
      const channel = requireChannel(url.searchParams.get('name'));
      if (url.searchParams.get('all') === '1') {
        sendJson(res, 200, readChannelMessages(home, channel, { limit: Number.MAX_SAFE_INTEGER }));
        return true;
      }
      const before = url.searchParams.get('before') ?? undefined;
      const after = url.searchParams.get('after') ?? undefined;
      const around = url.searchParams.get('around') ?? undefined;
      sendJson(res, 200, readChannelMessages(home, channel, { before, after, around, limit: CHANNEL_PAGE_MORE }));
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/reactions') {
      sendJson(res, 200, { items: listReactions(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/reactions') {
      const body = await readJsonBody(req);
      const action = typeof body.action === 'string' ? body.action : 'add';
      const input = {
        channel: requireChannel(body.channel),
        file: requireString(body.file, 'file'),
        id: requireString(body.id, 'id'),
        kind: requireReactionKind(body.kind)
      };
      if (action === 'add') {
        addReaction(home, {
          ...input,
          author: typeof body.author === 'string' ? body.author : undefined
        });
      } else if (action === 'remove') {
        removeReaction(home, input);
      } else if (action === 'clear') {
        clearReactionsForMessage(home, input.channel, input.file, input.id);
      } else {
        throw new Error(`unknown reactions action: ${action}`);
      }
      sendJson(res, 200, { ok: true, items: listReactions(home) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/views') {
      sendJson(res, 200, { items: listViews(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/views') {
      const body = await readJsonBody(req);
      const action = typeof body.action === 'string' ? body.action : 'add';
      if (action === 'add') {
        addView(home, {
          name: requireString(body.name, 'name'),
          filter: optionalViewFilter(body.filter)
        });
      } else if (action === 'remove') {
        removeView(home, requireString(body.name, 'name'));
      } else {
        throw new Error(`unknown views action: ${action}`);
      }
      sendJson(res, 200, { ok: true, items: listViews(home) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/paused') {
      sendJson(res, 200, { items: listPausedSessions(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/paused') {
      const body = await readJsonBody(req);
      const action = typeof body.action === 'string' ? body.action : 'pause';
      const tmuxSession = requireString(body.tmuxSession, 'tmuxSession');
      if (action === 'pause') {
        pauseEngineSession(home, engine, tmuxSession, typeof body.reason === 'string' ? body.reason : undefined);
      } else if (action === 'resume') {
        resumeEngineSession(home, engine, tmuxSession);
      } else {
        throw new Error(`unknown paused action: ${action}`);
      }
      sendJson(res, 200, { ok: true, items: listPausedSessions(home), sessions: await engine.inspectAll() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/search') {
      const channel = url.searchParams.get('channel');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      sendJson(res, 200, {
        items: searchChannelMessages(home, {
          query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
          channel: channel ? requireChannel(channel) : undefined,
          author: url.searchParams.get('author') ?? undefined,
          mentions:
            url.searchParams.get('mentions') ??
            (url.searchParams.get('mentionsMe') === '1' || url.searchParams.get('mentionsMe') === 'true' ? 'human' : undefined),
          hasThread: url.searchParams.get('hasThread') === '1' || url.searchParams.get('hasThread') === 'true',
          dateFrom: url.searchParams.get('dateFrom') ?? undefined,
          dateTo: url.searchParams.get('dateTo') ?? undefined,
          limit: Number.isFinite(limit) ? limit : undefined
        })
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/thread') {
      const channel = requireChannel(url.searchParams.get('name'));
      const parent = requireString(url.searchParams.get('parent'), 'parent');
      sendJson(res, 200, { messages: readThread(home, channel, parent) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/featured') {
      sendJson(res, 200, { items: listFeaturedItems(home) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/file') {
      const channel = requireChannel(url.searchParams.get('channel'));
      const name = requireString(url.searchParams.get('name'), 'name');
      const filePath = channelFilePath(home, channel, name);
      if (!existsSync(filePath)) {
        sendJson(res, 404, { error: `file not found: ${name}` });
        return true;
      }
      const inlineType = FILE_CONTENT_TYPES[extname(name).toLowerCase()];
      res.statusCode = 200;
      res.setHeader('content-type', inlineType ?? 'application/octet-stream');
      res.setHeader('content-length', statSync(filePath).size);
      // Uploads are untrusted: never let them run script on the app origin.
      res.setHeader('content-security-policy', "default-src 'none'; sandbox");
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader(
        'content-disposition',
        `${inlineType ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`
      );
      createReadStream(filePath).pipe(res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/create') {
      const body = await readJsonBody(req);
      const name = requireChannel(body.name);
      createChannel(home, name, typeof body.goal === 'string' ? body.goal : '');
      sendJson(res, 200, { ok: true, channels: listChannels(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/edit') {
      const body = await readJsonBody(req);
      const name = requireChannel(body.name);
      editChannelGoal(home, name, typeof body.goal === 'string' ? body.goal : '');
      sendJson(res, 200, { ok: true, channels: listChannels(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/message-edit') {
      const body = await readJsonBody(req);
      const channel = requireChannel(body.channel);
      const fileName = resolveConversationFile(body.thread);
      const message = await editMessage(home, channel, fileName, requireString(body.id, 'id'), requireString(body.body, 'body'));
      // The id is already in the watcher's seen-set, so the rewrite never
      // re-dispatches; edits intentionally do not re-prompt agents.
      sendJson(res, 200, { ok: true, message });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/message-delete') {
      const body = await readJsonBody(req);
      const channel = requireChannel(body.channel);
      const fileName = resolveConversationFile(body.thread);
      await deleteMessage(home, channel, fileName, requireString(body.id, 'id'));
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/destroy') {
      const body = await readJsonBody(req);
      destroyChannel(home, requireChannel(body.name));
      sendJson(res, 200, { ok: true, channels: listChannels(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/member-add') {
      const body = await readJsonBody(req);
      const channel = requireChannel(body.channel);
      const tmuxSession = requireString(body.tmuxSession, 'tmuxSession');
      const allSessions = loadDesk({}).sessions;
      const spec = allSessions.find((candidate) => candidate.tmuxSession === tmuxSession);
      if (!spec) {
        sendJson(res, 404, { error: `no desk session backs tmux session ${tmuxSession}` });
        return true;
      }
      if (listChannelMembers(home, channel).some((member) => member.tmuxSession === tmuxSession)) {
        sendJson(res, 409, { error: `that agent is already a member of #${channel}` });
        return true;
      }
      const handle = qualifiedMemberHandle({
        sessionName: spec.name,
        projectLabel: spec.projectLabel,
        groupLabel: spec.groupLabel,
        roster: allSessions.map((candidate) => ({
          name: candidate.name,
          projectLabel: candidate.projectLabel,
          groupLabel: candidate.groupLabel
        }))
      });
      const member = addMemberWithUniqueHandle(home, channel, handle, {
        type: MEMBER_TYPE_BY_AGENT[spec.agent ?? ''] ?? 'bash',
        tmuxSession,
        agentLabel: [spec.projectLabel, spec.groupLabel, spec.name].filter(Boolean).join(' / ')
      });

      // Join notice: visible in the feed and discoverable by later reads, but
      // deliberately NOT dispatched (markSeen, no handleMessage) — adding N
      // agents must not blast N×(N-1) join prompts into terminals.
      const detail = readChannelDetail(home, channel);
      const joinNotice = await appendMessage(home, channel, {
        author: 'human',
        body: `@${member.name} joined #${channel} — ${[spec.projectLabel, spec.groupLabel, spec.name].filter(Boolean).join(' / ')} (${member.type}).`
      });
      watcher.markSeen(channel, joinNotice.file, joinNotice.message.id);

      // Onboarding briefing rides the same gated queue as channel dispatches:
      // it lands when the agent's TUI is actually ready for input.
      engine.enqueuePrompt(
        tmuxSession,
        channel,
        buildOnboardingPrompt({
          channel,
          goal: detail.goal,
          handle: member.name,
          members: detail.members,
          messageCount: detail.messages.length,
          home
        }),
        `onboard-${channel}`
      );
      engine.markIdle(tmuxSession);
      sendJson(res, 200, { ok: true, member, members: listChannelMembers(home, channel) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/queue-clear') {
      const body = await readJsonBody(req);
      engine.dropQueue(requireString(body.tmuxSession, 'tmuxSession'));
      sendJson(res, 200, { ok: true, delivery: engine.lifecycleStates() });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/member-remove') {
      const body = await readJsonBody(req);
      const channel = requireChannel(body.channel);
      const name = requireString(body.name, 'name');
      const member = listChannelMembers(home, channel).find((candidate) => candidate.name === name);
      removeMember(home, channel, name);
      if (member?.tmuxSession) {
        engine.dropQueue(member.tmuxSession);
      }
      sendJson(res, 200, { ok: true, members: listChannelMembers(home, channel) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/post') {
      const body = await readJsonBody(req);
      const channel = requireChannel(body.channel);
      const author = resolveAuthor(home, channel, body);
      const appended = await appendMessage(home, channel, {
        author,
        body: requireString(body.body, 'body'),
        threadParentId: typeof body.thread === 'string' && body.thread.length > 0 ? body.thread : undefined
      });
      engine.handleMessage({ channel, file: appended.file, message: appended.message });
      // Mark seen only after dispatch succeeds. If the engine callback throws,
      // the watcher/sweep path still sees this finalized message and retries it.
      watcher.markSeen(channel, appended.file, appended.message.id);
      sendJson(res, 200, { ok: true, id: appended.message.id, file: appended.file });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/share') {
      const body = await readJsonBody(req);
      const fromChannel = requireChannel(body.fromChannel);
      const toChannel = requireChannel(body.toChannel);
      const messageId = requireString(body.messageId, 'messageId');
      const parentId = typeof body.thread === 'string' && body.thread.length > 0 ? body.thread : '';
      if (parentId && !/^msg-[A-Za-z0-9-]+$/.test(parentId)) {
        sendJson(res, 400, { error: `invalid thread id: ${parentId}` });
        return true;
      }
      const sourceFile = parentId ? `thread-${parentId}.md` : 'root.md';
      const source = parseConversation(readFileSync(join(home, fromChannel, sourceFile), 'utf8'));
      const message = source.messages.find((candidate) => candidate.id === messageId);
      if (!message) {
        sendJson(res, 404, { error: `message ${messageId} not found in #${fromChannel}` });
        return true;
      }
      const author = resolveAuthor(home, toChannel, body);
      const shared = formatSharedMessage(message, fromChannel, typeof body.comment === 'string' ? body.comment : undefined);
      const appended = await appendMessage(home, toChannel, { author, body: shared });
      engine.handleMessage({ channel: toChannel, file: appended.file, message: appended.message });
      watcher.markSeen(toChannel, appended.file, appended.message.id);
      sendJson(res, 200, { ok: true, id: appended.message.id });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/featured') {
      const body = await readJsonBody(req);
      const action = typeof body.action === 'string' ? body.action : 'add';
      const input = {
        channel: requireChannel(body.channel),
        file: requireString(body.file, 'file'),
        id: requireString(body.id, 'id'),
        note: typeof body.note === 'string' ? body.note : undefined,
        tag: typeof body.tag === 'string' ? body.tag : undefined
      };
      if (action === 'remove') {
        removeFeatured(home, input);
      } else if (action === 'add') {
        addFeatured(home, input);
      } else {
        throw new Error(`unknown featured action: ${action}`);
      }
      sendJson(res, 200, { ok: true, items: listFeaturedItems(home) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/channels/upload') {
      const body = await readJsonBody(req);
      const channel = requireChannel(body.channel);
      const name = requireString(body.name, 'name');
      const data = requireString(body.dataBase64, 'dataBase64');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
        sendJson(res, 400, { error: `upload must be 1 byte – ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB` });
        return true;
      }
      const saved = saveChannelFile(home, channel, name, bytes);
      sendJson(res, 200, { ok: true, file: saved, markdown: `[${saved}](_files/${saved})` });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/events') {
      const filter: Record<string, unknown> = {};
      const tmuxSession = url.searchParams.get('tmuxSession');
      if (tmuxSession) { filter.tmuxSession = tmuxSession; }
      const eventChannel = url.searchParams.get('channel');
      if (eventChannel) { filter.channel = eventChannel; }
      const kind = url.searchParams.get('kind');
      if (kind) { filter.kind = kind; }
      const sinceSeq = url.searchParams.get('sinceSeq');
      if (sinceSeq) { filter.sinceSeq = Number(sinceSeq); }
      const limit = url.searchParams.get('limit');
      if (limit) { filter.limit = Number(limit); }
      sendJson(res, 200, {
        items: readDeliveryEvents(home, filter),
        latestSeq: latestEventSeq(home)
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels/export') {
      const channel = requireChannel(url.searchParams.get('channel'));
      const thread = url.searchParams.get('thread');
      const markdown = exportChannelToMarkdown(home, channel, thread ?? undefined);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${channel}${thread ? `-thread-${thread}` : ''}.md"`);
      res.end(markdown);
      return true;
    }

    sendJson(res, 404, { error: `unknown channels endpoint: ${url.pathname}` });
    return true;
  } catch {
    sendJson(res, 500, { error: 'channels request failed' });
    return true;
  }
}
