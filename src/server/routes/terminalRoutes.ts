import type { DeskRoute } from '../plugin.js';
import type { TerminalBroker } from '../terminalBroker.js';
import { captureTmuxPane, repaintTmuxWindow, resizeTmuxWindow, scrollTmuxPane } from '../terminalBridge.js';
import { readBoundedInteger, readPositiveInteger, readRequiredString } from '../apiValidation.js';
import { daemonControl } from '../../shared/daemonControlClient.js';
import { nativeIdForTmuxSession, nativeSessionsEnabled } from '../runtime/nativeSessionControl.js';
import { readJsonBody, sendJson } from '../httpUtil.js';

export function createTerminalRoutes(terminalBroker: Pick<TerminalBroker, 'metrics'>): DeskRoute {
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/terminal-broker-metrics') {
      sendJson(res, 200, terminalBroker.metrics());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/terminal-resize') {
      const body = await readJsonBody(req);
      const session = readRequiredString(body.session, 'session');
      const cols = readPositiveInteger(body.cols, 'cols');
      const rows = readPositiveInteger(body.rows, 'rows');
      const result = resizeTmuxWindow(session, cols, rows);
      if (!result.ok) {
        sendJson(res, 500, { error: result.error });
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/terminal-repaint') {
      const body = await readJsonBody(req);
      const session = readRequiredString(body.session, 'session');
      const result = repaintTmuxWindow(session);
      sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true, skipped: result.skipped ?? false } : { error: result.error });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/terminal-scroll') {
      const body = await readJsonBody(req);
      const session = readRequiredString(body.session, 'session');
      const lines = readBoundedInteger(body.lines, 'lines', -1000, 1000);
      const result = scrollTmuxPane(session, lines, { exitCopyMode: Boolean(body.exitCopyMode) });
      sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true } : { error: result.error });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/terminal-capture') {
      const body = await readJsonBody(req);
      const session = readRequiredString(body.sessionId, 'sessionId');
      const rows = readBoundedInteger(body.rows, 'rows', 1, 2000);
      const offset = readBoundedInteger(body.offset, 'offset', 0, 5000);
      if (nativeSessionsEnabled()) {
        // Native path: the daemon's emulator is the history authority — the
        // same request shape proxies to /control/tail's ranged read; the
        // response adds totalAvailable so the client knows where the top is.
        // The wire `session` value is mixed-era until the step-4 rename.
        const result = await daemonControl('/control/tail', {
          sessionId: nativeIdForTmuxSession(session),
          rows,
          offset
        });
        if (!result.ok) {
          // Preserve the daemon's semantic statuses: unknown session is a
          // client-addressable 404, everything else (transport failure,
          // daemon error) is a 500.
          sendJson(res, result.status === 404 ? 404 : 500, { error: result.error ?? 'terminal capture failed' });
          return true;
        }
        sendJson(res, 200, { lines: result.body?.lines ?? [], totalAvailable: result.body?.totalAvailable ?? 0 });
        return true;
      }
      const result = captureTmuxPane(session, rows, offset);
      sendJson(res, result.ok ? 200 : 500, result.ok ? { lines: result.lines } : { error: result.error });
      return true;
    }

    return false;
  };
}
