import { listTmuxSessionsCached, loadDesk } from '../../core/runner.js';
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

export function createSystemRoutes(managedAgentLsp: ManagedAgentLifecycle): DeskRoute {
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/desk') {
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/system') {
      sendJson(res, 200, getSystemSnapshot());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pulse') {
      const running = listTmuxSessionsCached();
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
