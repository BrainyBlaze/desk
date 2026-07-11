// Desk attention bridge for OpenCode.
// Posts typed lifecycle events to Desk. Terminal OSC/BEL is deliberately not
// used as delivery authority; liveness is Desk-side and events are best-effort.

async function post(kind, extra = {}) {
  const session = process.env.DESK_TMUX_SESSION;
  if (!session) return;
  // Bound the POST so a half-open / stalled server cannot hang the awaited event hook
  // (the sibling agentHooks shim bounds its fetch the same way).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${process.env.DESK_API || "http://127.0.0.1:5173"}/api/agent-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        schemaVersion: 2,
        kind,
        session,
        agent: process.env.DESK_AGENT || "opencode",
        ts: new Date().toISOString(),
        ...extra,
      }),
    });
  } catch (_) {
    // Hook delivery must never break the agent session.
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  id: "desk-attention",
  // PluginModule.server is the hook slot the loader reads; `tui` is typed
  // `never` in @opencode-ai/plugin, so lifecycle hooks placed under it are
  // dropped.
  server: async () => ({
    event: async ({ event }) => {
      if (!event || typeof event.type !== "string") return;
      switch (event.type) {
        case "session.idle":
          await post("session-idle");
          break;
        case "session.status":
          await post("session-status", { status: String(event.status || "") });
          break;
        case "permission.asked":
          await post("approval-requested");
          break;
        case "question.asked":
          await post("input-requested");
          break;
        case "session.error":
          await post("stop-failure");
          break;
      }
    },
    "permission.ask": async () => {
      await post("approval-requested");
    },
  }),
};
