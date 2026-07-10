import type { Connect } from 'vite';
import { sendJson } from './httpUtil.js';
import type { DeskRoute } from './plugin.js';

export function createDeskApiMiddleware(routes: DeskRoute[]): Connect.NextHandleFunction {
  return async (req, res, next) => {
    try {
      if (!req.url?.startsWith('/api/')) {
        next();
        return;
      }

      const url = new URL(req.url, 'http://desk.local');
      for (const route of routes) {
        if (await route(req, res, url)) {
          return;
        }
      }
      sendJson(res, 404, { error: `unknown API route ${url.pathname}` });
    } catch (error) {
      console.error(`[desk-api] ${req.method ?? ''} ${req.url ?? ''} failed:`, error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
