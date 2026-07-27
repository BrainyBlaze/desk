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

import { buildProducerRuntime } from './producerEmit.js';

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
    // The server announcing itself is what lets a just-started session report
    // before anyone talks to it. It is a SERVER-level event and carries no
    // session id, so the endpoint registration that follows a post simply does
    // not fire here — the address is learned from the first session-scoped
    // event instead.
    case 'server.connected':
      return { type: event.type };
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
      if (sessionID) await deskRegisterEndpoint(deskServerUrl, String(sessionID));
    };

    return {
    event: async ({ event }) => {
      if (!event || typeof event.type !== 'string') return;
      // Streaming progress is a liveness beat, not a transition: it must never
      // promote a session that is blocked on an approval back to working.
      if (event.type === 'message.updated' || event.type === 'message.part.updated') {
        await deskThrottledPost({ type: event.type, sessionID: event.properties && event.properties.sessionID });
        return;
      }
      await deskPost(sliceOf(event));
      // Bind first, address second.
      await deskTrack(event.properties && event.properties.sessionID);
    },
    // OpenCode publishes no "prompt submitted" event; this hook is the typed
    // equivalent and is what opens a turn.
    "chat.message": async (hookInput) => {
      await deskPost({ type: 'hook:chat.message', sessionID: hookInput && hookInput.sessionID });
      await deskTrack(hookInput && hookInput.sessionID);
    },
    "permission.ask": async (hookInput) => {
      await deskPost({
        type: 'hook:permission.ask',
        sessionID: hookInput && hookInput.sessionID,
        permissionTitle: deskBounded(hookInput && hookInput.title)
      });
      await deskTrack(hookInput && hookInput.sessionID);
    },
    // Tool edges are INTERVAL boundaries, never throttled: a dropped edge
    // leaves an interval open or closes nothing. callID is what pairs them.
    "tool.execute.before": async (hookInput) => {
      await deskPost({
        type: 'hook:tool.execute.before',
        sessionID: hookInput && hookInput.sessionID,
        toolUseId: hookInput && hookInput.callID
      });
    },
    "tool.execute.after": async (hookInput) => {
      await deskPost({
        type: 'hook:tool.execute.after',
        sessionID: hookInput && hookInput.sessionID,
        toolUseId: hookInput && hookInput.callID
      });
    }
    };
  }
};
`;
}
