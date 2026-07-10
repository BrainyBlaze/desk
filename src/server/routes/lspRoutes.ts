import { sendJson } from '../httpUtil.js';
import type { DeskRoute } from '../plugin.js';

interface LspRoutesOptions {
  httpEndpoint: { handleNodeRequest: DeskRoute };
  languageDetector: {
    detect(input: { root: string; refresh: boolean }): Promise<unknown>;
  };
}

export function createLspRoutes(options: LspRoutesOptions): DeskRoute {
  return async (req, res, url) => {
    if (await options.httpEndpoint.handleNodeRequest(req, res, url)) {
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/lsp/detected-languages') {
      try {
        const result = await options.languageDetector.detect({
          root: url.searchParams.get('root') ?? '',
          refresh: url.searchParams.get('refresh') === '1'
        });
        sendJson(res, 200, result);
      } catch {
        sendJson(res, 400, { error: 'invalid root' });
      }
      return true;
    }

    return false;
  };
}
