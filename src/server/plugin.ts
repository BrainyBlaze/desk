// Desk's public extension API.
//
// A `DeskPlugin` lets an embedder customize the Desk backend from the OUTSIDE —
// without forking or patching this repo. Plugins are composed in at assembly
// time (see `pluginLoader.ts` + the `DESK_PLUGINS` env, or by passing them
// programmatically to `installDeskApi(host, { plugins })`). With no plugins,
// Desk runs exactly as it always has: a single-user, local-trust tool.
//
// A plugin can contribute three things, in increasing order of intrusiveness:
//   - `middleware` — connect middlewares mounted BEFORE the core `/api` router
//     (auth gates, request logging, CORS, …);
//   - `routes` — extra `/api` handlers ("ручки"), tried AFTER the core routes
//     and BEFORE the 404;
//   - `upgradeGuard` — a predicate consulted ONCE for every WebSocket upgrade
//     (terminal / terminal-broker / fs-watch / lsp alike); if any plugin's guard
//     rejects, the socket is closed before any bridge sees it.
//
// This is intentionally a small, generic surface: Desk core knows nothing about
// who its embedders are or what they gate on.
import type { IncomingMessage, ServerResponse, Server as NodeHttpServer } from 'node:http';
import type { Connect } from 'vite';

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
  /** Lifecycle hook run once at install; an optional returned fn runs on close. */
  setup?(ctx: DeskPluginContext): void | (() => void);
}

/** Identity helper for authoring a plugin with full type-checking. */
export function defineDeskPlugin(plugin: DeskPlugin): DeskPlugin {
  return plugin;
}
