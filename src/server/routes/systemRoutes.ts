import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveManifestPath } from '../../core/config.js';
import { listTmuxSessionsCached, loadDesk, runningSessionSet } from '../../core/runner.js';
import { normalizeAgentEventForApi } from '../agentEvents.js';
import { attentionTracker, notifyAgentSignal, type AgentEventKind } from '../attention.js';
import { initChannelsRuntime } from '../channelsApi.js';
import { readJsonBody, sendJson } from '../httpUtil.js';
import { executeKillSwitch } from '../killSwitch.js';
import type { DeskRoute } from '../plugin.js';
import {
  attemptResumeCaptureForSession,
  isValidResumeId,
  persistSessionResume
} from '../resumeCapture.js';
import { buildDeskSnapshot } from '../snapshot.js';
import { getSystemSnapshot } from '../systemSampler.js';
import { readRequiredString } from '../apiValidation.js';

interface ManagedAgentLifecycle {
  reconcile(runningSessions: Set<string>): void;
  cleanupAll(): void;
}

/**
 * The session-identity map for the pre-React localStorage migration (cutover
 * step 4): the committed tmuxSession→sessionId mappings plus the CURRENT
 * strict-manifest sessionIds (so post-cutover additions are preserved rather
 * than dropped). Read-only. Before the migration marker exists the map is
 * simply not available (409); AFTER the gate a missing or malformed map file
 * is corruption and fails closed (500) — the browser must not half-migrate.
 */
export function readSessionIdentityMap(
  manifestPath: string = resolveManifestPath()
):
  | { ok: true; payload: { version: 1; mappings: [string, string][]; sessionIds: string[] } }
  | { ok: false; status: 409 | 500; error: string; code: 'not-migrated' | 'identity-map-corrupt' } {
  const migrationRoot = join(dirname(manifestPath), '_migration', 'session-id-v1');
  if (!existsSync(join(migrationRoot, 'migration.done'))) {
    return { ok: false, status: 409, error: 'session identity migration has not committed', code: 'not-migrated' };
  }
  const mapPath = join(migrationRoot, 'session-id-map.json');
  let mappings: [string, string][];
  try {
    const parsed = JSON.parse(readFileSync(mapPath, 'utf8')) as { version?: unknown; entries?: unknown };
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(
        (entry: unknown): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )
    ) {
      return { ok: false, status: 500, error: `session identity map is malformed: ${mapPath}`, code: 'identity-map-corrupt' };
    }
    mappings = parsed.entries;
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `session identity map unreadable: ${error instanceof Error ? error.message : String(error)}`,
      code: 'identity-map-corrupt'
    };
  }
  const sessionIds = loadDesk({ manifestPath }).sessions.map((session) => session.sessionId);
  return { ok: true, payload: { version: 1, mappings, sessionIds } };
}

export function createSystemRoutes(managedAgentLsp: ManagedAgentLifecycle): DeskRoute {
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/desk') {
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/session-identity-map') {
      const result = readSessionIdentityMap();
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error, code: result.code });
        return true;
      }
      sendJson(res, 200, result.payload);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/system') {
      sendJson(res, 200, getSystemSnapshot());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pulse') {
      const running = runningSessionSet();
      managedAgentLsp.reconcile(running);
      attentionTracker.dropDead(running);
      sendJson(res, 200, {
        system: getSystemSnapshot(),
        attention: {
          sessions: attentionTracker.snapshot(),
          events: attentionTracker.listEvents(),
          unread: attentionTracker.unreadCount()
        },
        running: [...running]
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/attention') {
      sendJson(res, 200, {
        sessions: attentionTracker.snapshot(),
        events: attentionTracker.listEvents(),
        unread: attentionTracker.unreadCount()
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/attention-clear') {
      const body = await readJsonBody(req);
      attentionTracker.clear(readRequiredString(body.session, 'session'));
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/attention-read') {
      const body = await readJsonBody(req);
      if (body.clear === true) {
        attentionTracker.clearEvents();
        sendJson(res, 200, { ok: true, unread: 0 });
        return true;
      }
      attentionTracker.markEventsRead({
        all: body.all === true,
        ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
        kinds: Array.isArray(body.kinds)
          ? (body.kinds.filter((kind: unknown) =>
              kind === 'turn-complete' ||
              kind === 'approval-requested' ||
              kind === 'input-requested' ||
              kind === 'bell' ||
              kind === 'channel'
            ) as AgentEventKind[])
          : undefined
      });
      sendJson(res, 200, { ok: true, unread: attentionTracker.unreadCount() });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent-event') {
      const body = await readJsonBody(req);
      const normalized = normalizeAgentEventForApi(body);
      const session = normalized.event.session;
      if (normalized.attentionKind) {
        attentionTracker.raise(session);
        attentionTracker.pushEvent(
          session,
          normalized.attentionKind,
          typeof normalized.event.message === 'string' ? normalized.event.message.slice(0, 300) : undefined
        );
      }
      if (normalized.signalKind) {
        notifyAgentSignal(session, normalized.signalKind);
      }
      initChannelsRuntime().engine.handleAgentEvent(normalized.event);
      await attemptResumeCaptureForSession(session, () =>
        loadDesk({}).sessions.find((candidate) => candidate.tmuxSession === session)
      );
      if (typeof normalized.resumeSessionId === 'string' && isValidResumeId(normalized.resumeSessionId)) {
        await persistSessionResume(session, normalized.resumeSessionId);
      }
      sendJson(res, 200, { ok: true, kind: normalized.event.kind });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/kill-all') {
      const result = executeKillSwitch();
      managedAgentLsp.cleanupAll();
      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
