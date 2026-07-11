import type { DeskRoute } from '../plugin.js';
import type { TerminalBroker } from '../terminalBroker.js';
import { captureTmuxPane, repaintTmuxWindow, resizeTmuxWindow, scrollTmuxPane } from '../terminalBridge.js';
import { readBoundedInteger, readPositiveInteger, readRequiredString } from '../apiValidation.js';
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
      const session = readRequiredString(body.session, 'session');
      const rows = readBoundedInteger(body.rows, 'rows', 1, 2000);
      const offset = readBoundedInteger(body.offset, 'offset', 0, 5000);
      const result = captureTmuxPane(session, rows, offset);
      sendJson(res, result.ok ? 200 : 500, result.ok ? { lines: result.lines } : { error: result.error });
      return true;
    }

    return false;
  };
}
