import type { Connect } from 'vite';
import { ManifestMutationError } from '../core/config.js';
import { FileLockBusyError } from '../shared/fileLock.js';
import { ApiValidationError } from './apiValidation.js';
import { HttpBodyError, sendJson } from './httpUtil.js';
import type { DeskRoute } from './plugin.js';

interface DeskApiErrorResponse {
  statusCode: number;
  body: { error: string; code?: string };
}

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
      console.error('[desk-api] %s %s failed:', `${req.method ?? ''} ${req.url ?? ''}`, error);
      const mapped = mapDeskApiError(error);
      sendJson(res, mapped.statusCode, mapped.body);
    }
  };
}

function mapDeskApiError(error: unknown): DeskApiErrorResponse {
  if (error instanceof HttpBodyError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code }
    };
  }
  if (error instanceof ApiValidationError) {
    return {
      statusCode: 400,
      body: { error: error.message, code: error.code }
    };
  }
  if (error instanceof FileLockBusyError) {
    return {
      statusCode: 409,
      body: { error: 'Desk data is busy; retry the request', code: error.code }
    };
  }
  if (error instanceof ManifestMutationError) {
    return {
      statusCode: 409,
      body: { error: error.message, code: error.code }
    };
  }
  return {
    statusCode: 500,
    body: { error: 'Internal server error' }
  };
}
