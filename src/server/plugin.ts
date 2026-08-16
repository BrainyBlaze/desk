// Desk's public extension API.
//
// A `DeskPlugin` lets an embedder customize the Desk backend from the OUTSIDE —
// without forking or patching this repo. Plugins are composed in at assembly
// time (see `pluginLoader.ts` + the `DESK_PLUGINS` env, or by passing them
// programmatically to `installDeskApi(host, { plugins })`). With no plugins,
// Desk runs exactly as it always has: a single-user, local-trust tool.
//
// A plugin can contribute four things, in increasing order of intrusiveness:
//   - `middleware` — connect middlewares mounted BEFORE the core `/api` router
//     (auth gates, request logging, CORS, …);
//   - `routes` — extra `/api` handlers ("ручки"), tried AFTER the core routes
//     and BEFORE the 404;
//   - `upgradeGuard` — a predicate consulted ONCE for every WebSocket upgrade
//     (terminal / terminal-broker / fs-watch / lsp alike); if any plugin's guard
//     rejects, the socket is closed before any bridge sees it;
//   - `channels` — replace or wrap a part of the Channels subsystem: where
//     conversations live, who a message is for, what reaches an agent, or what
//     an agent sees.
//
// This is intentionally a small, generic surface: Desk core knows nothing about
// who its embedders are or what they gate on.
import type { IncomingMessage, ServerResponse, Server as NodeHttpServer } from 'node:http';
import type { Connect } from 'vite';
import type {
  AgentDelivery,
  ChannelFiles,
  ChannelStore,
  ChannelViews,
  MessageRouter,
  PromptRenderer
} from './channels/ports.js';

/**
 * An extra `/api` route ("ручка"). Inspect the request; return `true` (or a
 * promise of `true`) once you have written the response and handled it, or
 * `false`/`undefined` to let Desk keep matching (ultimately a 404).
 */
export type DeskRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => boolean | void | Promise<boolean | void>;

/** Context handed to a plugin's `setup()` at install time. */
export interface DeskPluginContext {
  /** The Node http server (present in dev/preview/standalone; `null` in tests without one). */
  httpServer: NodeHttpServer | null;
  /** Register a callback to run when the server closes. */
  onClose(fn: () => void): void;
}

/**
 * Replace or wrap parts of the Channels subsystem.
 *
 * Each provider receives a FACTORY for the implementation Desk would otherwise
 * use, and returns the one to use instead. A plugin that wraps calls the
 * factory and delegates to it — log every delivery, mirror a store, prefix a
 * prompt — without reimplementing behaviour it does not care about. A plugin
 * that replaces outright never calls it, and Desk never builds the stock
 * implementation: no channels home is created for a store that lives in a
 * database, no watcher is started for a store that pushes its own changes.
 *
 * Providers apply in plugin order, each wrapping the previous result. The
 * factory is memoised, so calling it twice yields the same instance.
 *
 * A plugin whose provider returns `base()` unchanged is a no-op, and a
 * subsystem with no providers behaves exactly as it always has.
 */
export interface ChannelsProviders {
  /** Where conversations live and how a finalised message is noticed. */
  store?: (base: () => ChannelStore) => ChannelStore;
  /** Where attachments live. Separate from the store: bytes, not conversation. */
  files?: (base: () => ChannelFiles) => ChannelFiles;
  /** Where saved view filters live. Operator preference, not channel data. */
  views?: (base: () => ChannelViews) => ChannelViews;
  /** Who a message is for. Pure: given a message and a roster, name the recipients. */
  router?: (base: () => MessageRouter) => MessageRouter;
  /** What reaches an agent: send, states, probe, submit. */
  delivery?: (base: () => AgentDelivery) => AgentDelivery;
  /** What an agent sees: the turn prompt, the digest, the briefing, the check-in. */
  renderer?: (base: () => PromptRenderer) => PromptRenderer;
}

export interface DeskPlugin {
  /** Stable identifier, e.g. `"auth-gate"`. Used in errors/logs. */
  name: string;
  /** Connect middlewares mounted before the core `/api` router. */
  middleware?: Connect.NextHandleFunction[];
  /** Extra `/api` routes, tried after the core routes and before the 404. */
  routes?: DeskRoute[];
  /**
   * Gate every WebSocket upgrade. ALL plugins' guards must return `true` or the
   * upgrade is rejected with `401`. Runs once, centrally — bridges stay
   * auth-agnostic.
   */
  upgradeGuard?: (req: IncomingMessage) => boolean;
  /** Replace or wrap parts of the Channels subsystem. */
  channels?: ChannelsProviders;
  /** Lifecycle hook run once at install; an optional returned fn runs on close. */
  setup?(ctx: DeskPluginContext): void | (() => void);
}

/** Identity helper for authoring a plugin with full type-checking. */
export function defineDeskPlugin(plugin: DeskPlugin): DeskPlugin {
  return plugin;
}
