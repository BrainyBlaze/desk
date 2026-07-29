// The OpenCode plugin, emitted as JavaScript.
//
// Emitted rather than shipped as a static file so it shares ONE producer
// runtime with the Claude/Codex hook shim (R8.4): identity, sequencing, the
// bounded POST, and the heartbeat window are the parts that must not drift
// between the two artifacts, and a second hand-maintained copy of them is
// exactly the divergence no test on either side would catch.
//
// The plugin observes and reports. What an observation MEANS is decided by
// `opencodeFacts`, on the server, under test — never here, inside the agent
// process where no Desk test can reach.

import {
  buildProducerRuntime,
  OPENCODE_PROVIDER_SESSION_ENV_VAR
} from './producerEmit.js';

/**
 * Source of `plugin/desk-attention.js` in the Desk-owned OpenCode config dir.
 *
 * Event names come from the `Event` union the plugin's `event` hook actually
 * receives, not from the published docs — the docs name events
 * (`permission.asked`, `question.asked`) that the union does not contain, and
 * arms matching them never run.
 */
export function buildOpencodeAttentionPlugin(): string {
  return `// Desk agent-state bridge for OpenCode. GENERATED — edit
// src/core/agentState/opencodeProducer.ts, not this file.
${buildProducerRuntime()}
deskUseProvider('opencode');

/** The bounded slice for one event; undefined means Desk does not act on it. */
function sliceOf(event) {
  const properties = event.properties || {};
  switch (event.type) {
    case 'session.status':
      return {
        type: event.type,
        sessionID: properties.sessionID,
        status: {
          type: properties.status && properties.status.type,
          attempt: properties.status && properties.status.attempt,
          message: deskBounded(properties.status && properties.status.message)
        }
      };
    // OpenCode's own session.created / session.deleted are NOT observed: they
    // describe sessions internal to OpenCode (one Desk session hosts many),
    // and Desk's lifecycle belongs to the daemon that owns the process.
    case 'session.idle':
      return { type: event.type, sessionID: properties.sessionID };
    case 'session.error': {
      const error = properties.error || {};
      const data = error.data || {};
      return {
        type: event.type,
        sessionID: properties.sessionID,
        error: {
          name: error.name,
          message: deskBounded(data.message),
          isRetryable: data.isRetryable,
          statusCode: data.statusCode
        }
      };
    }
    case 'permission.updated':
      return { type: event.type, sessionID: properties.sessionID, permissionTitle: deskBounded(properties.title) };
    case 'permission.replied':
      return { type: event.type, sessionID: properties.sessionID };
    default:
      return undefined;
  }
}

export default {
  id: "desk-attention",
  // PluginModule.server is the hook slot the loader reads; \`tui\` is typed
  // \`never\` in @opencode-ai/plugin, so lifecycle hooks placed under it are
  // dropped.
  server: async (input) => {
    // The plugin is handed its server URL at load and Desk has no other way to
    // learn it. Registering it is what makes reconciliation after a restart
    // possible at all — without an address there is nobody to ask, and the
    // session would stay unknown until its agent happened to act again.
    const deskServerUrl = input && input.serverUrl ? String(input.serverUrl) : undefined;
    let deskTrackedProviderSession =
      typeof process.env.${OPENCODE_PROVIDER_SESSION_ENV_VAR} === 'string' &&
      process.env.${OPENCODE_PROVIDER_SESSION_ENV_VAR}.trim()
        ? process.env.${OPENCODE_PROVIDER_SESSION_ENV_VAR}.trim()
        : undefined;
    let deskBootstrapAccepted = false;
    let deskBootstrapInFlight;

    const deskEnsureBound = async () => {
      if (deskBootstrapAccepted) return true;
      if (!deskBootstrapInFlight) {
        deskBootstrapInFlight = deskPost({ type: 'hook:plugin.loaded' })
          .then((accepted) => {
            deskBootstrapAccepted = accepted;
            return accepted;
          })
          .finally(() => {
            deskBootstrapInFlight = undefined;
          });
      }
      return deskBootstrapInFlight;
    };

    /**
     * Registration happens AFTER the first accepted observation, never before.
     *
     * The intake binds a producer identity when it accepts that producer's
     * first canonical event; an endpoint arriving earlier names an identity
     * the daemon has never seen and is refused as unregistered. Registering at
     * load therefore could not succeed — it only looked like it did, because a
     * failed registration is silent by design.
     */
    const deskTrack = async (sessionID) => {
      const candidate =
        typeof sessionID === 'string' && sessionID.trim()
          ? sessionID.trim()
          : undefined;
      if (!candidate) return false;
      if (!(await deskEnsureBound())) return false;
      if (!(await deskRegisterEndpoint(deskServerUrl, candidate))) return false;
      deskTrackedProviderSession = candidate;
      return true;
    };
    const deskMatchesTrackedSession = (sessionID) =>
      typeof sessionID === 'string' &&
      sessionID === deskTrackedProviderSession;

    // Announce the plugin the moment it comes up, so the producer is BOUND
    // before anyone talks to this OpenCode. Binding is the precondition for
    // attaching an endpoint to it at all; a session that never gets bound can
    // never be polled, and so can never be recovered by anything but its own
    // next action.
    //
    // A beat, never an activity claim: the plugin can load while a turn is
    // running, and calling that idle would paint a busy agent free. deskPost is
    // best effort, so a Desk that is down cannot stop OpenCode from starting.
    await deskEnsureBound();
    if (deskTrackedProviderSession) {
      await deskTrack(deskTrackedProviderSession);
    }

    return {
    event: async ({ event }) => {
      if (!event || typeof event.type !== 'string') return;
      const eventSessionID = event.properties && event.properties.sessionID;
      // Streaming progress is a liveness beat, not a transition: it must never
      // promote a session that is blocked on an approval back to working.
      if (event.type === 'message.updated' || event.type === 'message.part.updated') {
        if (
          !deskMatchesTrackedSession(eventSessionID) ||
          !(await deskTrack(eventSessionID))
        ) return;
        await deskThrottledPost({ type: event.type, sessionID: eventSessionID });
        return;
      }
      const observation = sliceOf(event);
      if (
        !observation ||
        !deskMatchesTrackedSession(eventSessionID) ||
        !(await deskTrack(eventSessionID))
      ) return;
      await deskPost(observation);
    },
    // OpenCode publishes no "prompt submitted" event; this hook is the typed
    // equivalent and is what opens a turn.
    "chat.message": async (hookInput) => {
      if (!(await deskTrack(hookInput && hookInput.sessionID))) return;
      await deskPost({ type: 'hook:chat.message', sessionID: hookInput && hookInput.sessionID });
    },
    "permission.ask": async (hookInput) => {
      const sessionID = hookInput && hookInput.sessionID;
      if (
        !deskMatchesTrackedSession(sessionID) ||
        !(await deskTrack(sessionID))
      ) return;
      await deskPost({
        type: 'hook:permission.ask',
        sessionID,
        permissionTitle: deskBounded(hookInput && hookInput.title)
      });
    },
    // Tool edges are INTERVAL boundaries, never throttled: a dropped edge
    // leaves an interval open or closes nothing. callID is what pairs them.
    "tool.execute.before": async (hookInput) => {
      const sessionID = hookInput && hookInput.sessionID;
      if (
        !deskMatchesTrackedSession(sessionID) ||
        !(await deskTrack(sessionID))
      ) return;
      await deskPost({
        type: 'hook:tool.execute.before',
        sessionID,
        toolUseId: hookInput && hookInput.callID
      });
    },
    "tool.execute.after": async (hookInput) => {
      const sessionID = hookInput && hookInput.sessionID;
      if (
        !deskMatchesTrackedSession(sessionID) ||
        !(await deskTrack(sessionID))
      ) return;
      await deskPost({
        type: 'hook:tool.execute.after',
        sessionID,
        toolUseId: hookInput && hookInput.callID
      });
    }
    };
  }
};
`;
}
