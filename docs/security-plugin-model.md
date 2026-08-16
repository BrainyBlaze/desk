---
title: "Security and plugin model"
sidebarTitle: "Security & plugins"
description: "Understand Desk's local-trust default, filesystem boundary, API surface, and extension points."
---

Desk is a single-user local-trust tool.

The stock server has no built-in authentication. Anyone who can reach the server can use the UI and API as the local operator.

## Default trust boundary

By default Desk binds to:

```text
127.0.0.1:5173
```

Keep that default.

Do not expose Desk directly on a network. If Desk runs on your own remote
development box, keep it bound to `127.0.0.1` there and reach it through SSH
port forwarding.

## What a connected client can do

A client that can reach Desk can:

- view and type into agent terminals
- start, restart, and delete configured sessions
- operate `git` and `gh` with the host user's credentials
- read and write files under the active explorer root
- use notes under `~/.config/desk/notes`
- post and read channel messages
- upload channel files
- run the emergency kill switch

Treat the Desk port as equivalent to local operator access for the selected workspace and running agent fleet.

## Filesystem boundary

The file API is constrained to the active explorer root. Desk resolves client paths and rejects path escapes.

The manifest file is a special trusted file so the UI can open it even when it is outside the explorer root.

The notes subsystem uses its own pinned root:

```text
~/.config/desk/notes
```

Pick editor roots carefully. The root you choose is the filesystem trust boundary for editor file operations.

## Channel uploads

Channel uploads are stored under the channel files directory. Desk serves uploaded files with restricted headers, including a sandboxing content security policy and forced download behavior for active content.

Treat uploaded files as untrusted, especially when they were produced by an agent.

## Emergency kill switch scope

The kill switch retires configured sessions and performs a host-wide sweep for
supported agent processes. It can terminate:

- every Moor session in the active manifest
- remaining host `codex` or `claude` processes found by process scan

The process sweep is intentionally broader than the active manifest. Use the
control only as an emergency stop.

## Plugin extension points

Desk exposes a small backend plugin interface for local embedders and
downstream builds. It is an extension surface, not a replacement for built-in
user accounts or request authentication.

A plugin can provide:

- `middleware`: Connect middleware mounted before the core `/api` router
- `routes`: extra `/api` route handlers tried after core routes and before the 404
- `upgradeGuard`: a central predicate for WebSocket upgrades
- `channels`: providers that replace or wrap parts of the Channels subsystem
- `setup`: lifecycle code that runs when Desk installs the plugin

### Channels providers

`channels` takes one provider per Channels port. Each receives the
implementation Desk would otherwise use and returns the one to use instead, so a
plugin can wrap rather than reimplement:

```js
export default {
  name: "delivery-audit",
  channels: {
    delivery: (base) => ({
      ...base,
      async send(sessionId, text) {
        auditLog(sessionId, text.length);
        return base.send(sessionId, text);
      }
    })
  }
};
```

The five ports are `store` (where conversations live and how a finalised message
is noticed), `files` (where attachments live), `router` (who a message is for),
`delivery` (what reaches an agent), and `renderer` (what an agent sees). Providers apply in plugin order, each
wrapping the previous result; a provider that returns its argument is a no-op,
and declaring none leaves Channels exactly as it ships. The contracts are in
`src/server/channels/ports.ts`.

A Channels provider is the most intrusive thing a plugin can do: it sits on the
path that types text into a live agent session. Treat it with the same care as
`upgradeGuard`.

Runtime plugin modules can export a plain plugin object:

```js
export default {
  name: "local-status",
  routes: [
    (req, res, url) => {
      if (req.method !== "GET" || url.pathname !== "/api/local-status") {
        return false;
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, user: process.env.USER ?? "local" }));
      return true;
    }
  ]
};
```

The typed helper `defineDeskPlugin` exists at `src/server/plugin.ts`. Source-backed
installs retain the application source and locked dependencies, so local
embedders can build against the same release tree.

## Runtime plugins

Set `DESK_PLUGINS` to a comma-separated list of module specifiers:

```bash
DESK_PLUGINS=/opt/desk/local-status-plugin.js desk serve
```

Each module must export either:

- a `DeskPlugin`
- a default `DeskPlugin`
- a factory that returns a `DeskPlugin`

Unset `DESK_PLUGINS` means stock local-trust behavior.

## WebSocket guards

`upgradeGuard` runs before any WebSocket bridge handles a socket. It is useful
for embedded builds that need a local runtime policy, but it does not make the
stock Desk server safe to expose publicly.

It covers:

- terminal WebSocket connections
- filesystem watch sockets
- LSP sockets

All plugin guards must allow the request. If any guard rejects, Desk closes the upgrade before the subsystem sees it.

## Embedded plugins

The private Bun build has a build-time seam for embedding plugins directly into a
downstream runtime. Desk's own runtime embeds no plugins.

Runtime `DESK_PLUGINS` works with both `desk serve` and `desk serve --dev`. The
private Bun runtime loads runtime plugins first, then appends any embedded
plugins supplied by the build.

## Error surfaces

Public API routes return JSON errors. Unexpected route failures are collapsed to terse messages instead of exposing stacks. Plugins should follow the same pattern and avoid returning secrets or stack traces.

## Next steps

- Follow [Run Desk securely](/guide-deploy-securely) for the localhost and SSH
  tunnel model.
- Read [API and runtime reference](/api-runtime-reference) for the routes that
  plugins can extend.
- Read [Troubleshooting and FAQ](/troubleshooting) for startup and connection
  symptoms.
