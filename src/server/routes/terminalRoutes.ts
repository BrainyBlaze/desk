import type { DeskRoute } from '../plugin.js';
import { readBoundedInteger, readRequiredString } from '../apiValidation.js';
import { daemonControl } from '../../shared/daemonControlClient.js';
import { readJsonBody, sendJson } from '../httpUtil.js';

/**
 * Terminal REST surface. One route remains after the cutover: the frozen
 * scrollback capture, proxying the daemon emulator's ranged history. Resize,
 * repaint, and scroll were legacy bridge concepts — the browser terminal talks
 * to the daemon directly over /ws/terminal for everything live.
 */
export function createTerminalRoutes(): DeskRoute {
  return async (req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/api/terminal-capture') {
      const body = await readJsonBody(req);
      const sessionId = readRequiredString(body.sessionId, 'sessionId');
      const rows = readBoundedInteger(body.rows, 'rows', 1, 2000);
      const offset = readBoundedInteger(body.offset, 'offset', 0, 5000);
      const result = await daemonControl('/control/tail', { sessionId, rows, offset });
      if (!result.ok) {
        // Preserve the daemon's semantic statuses: unknown session is a
        // client-addressable 404, everything else (transport failure, daemon
        // error) is a 500.
        sendJson(res, result.status === 404 ? 404 : 500, { error: result.error ?? 'terminal capture failed' });
        return true;
      }
      sendJson(res, 200, { lines: result.body?.lines ?? [], totalAvailable: result.body?.totalAvailable ?? 0 });
      return true;
    }

    return false;
  };
}
