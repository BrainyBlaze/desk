import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DeskRoute } from './plugin.js';

export const UPLOADS_MOUNT = '/api/uploads';

interface MfupLike {
  handle(req: IncomingMessage, res: ServerResponse, url?: string): Promise<boolean>;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
}

export interface UploadsApi {
  route: DeskRoute;
  attach(httpServer: NodeHttpServer | null): void;
  dispose(): Promise<void>;
}

const MAX_UPLOAD_BYTES = 32 * 2 ** 30;
const MAX_UPLOAD_FILES = 200_000;

function authorizeSession(meta: unknown): {
  baseDir: string;
  targetDir: string;
  maxTotalBytes: number;
  maxFiles: number;
  context: Record<string, unknown>;
} | null {
  const shape = meta as { root?: unknown; dirPath?: unknown } | undefined;
  const root = typeof shape?.root === 'string' ? shape.root : null;
  const dirPath = typeof shape?.dirPath === 'string' ? shape.dirPath : null;
  if (!root || !dirPath || !isAbsolute(root) || !isAbsolute(dirPath)) {
    return null;
  }
  const resolvedRoot = resolve(root);
  const resolvedDir = resolve(dirPath);
  const rel = relative(resolvedRoot, resolvedDir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  try {
    if (!statSync(resolvedDir).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    baseDir: resolvedDir,
    targetDir: '.',
    maxTotalBytes: MAX_UPLOAD_BYTES,
    maxFiles: MAX_UPLOAD_FILES,
    context: { root: resolvedRoot }
  };
}

export function createUploadsApi(): UploadsApi {
  let mfup: MfupLike | null = null;
  let disposed = false;
  let upgradable = false;
  let detachUpgrade: (() => void) | null = null;
  const ready = (async () => {
    try {
      const { createMfup } = await import('@mfup/server');
      const stagingBase = join(homedir(), '.local', 'share', 'desk', 'uploads');
      mkdirSync(stagingBase, { recursive: true });
      mfup = createMfup({
        baseDir: stagingBase,
        store: 'memory',
        basePath: UPLOADS_MOUNT,
        authorize: (req) => authorizeSession(req.meta)
      }) as MfupLike;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[desk-uploads] streaming uploads disabled (${message}); the legacy upload path remains active`);
    }
  })();

  return {
    route: async (req, res, url) => {
      if (url.pathname !== UPLOADS_MOUNT && !url.pathname.startsWith(`${UPLOADS_MOUNT}/`)) {
        return false;
      }
      await ready;
      if (!mfup || !upgradable) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'streaming uploads unavailable' }));
        return true;
      }
      return mfup.handle(req, res);
    },
    attach(httpServer) {
      if (!httpServer) {
        return;
      }
      upgradable = true;
      void ready.then(() => {
        if (!mfup || disposed) {
          return;
        }
        const instance = mfup;
        const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
          if (socket.destroyed) {
            return;
          }
          instance.upgrade(req, socket, head);
        };
        httpServer.on('upgrade', onUpgrade);
        detachUpgrade = () => httpServer.off('upgrade', onUpgrade);
      });
    },
    async dispose() {
      disposed = true;
      await ready;
      detachUpgrade?.();
      detachUpgrade = null;
      await mfup?.close();
    }
  };
}
