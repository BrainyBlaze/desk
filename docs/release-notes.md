---
title: "Release notes"
description: "Source-derived release notes for Desk."
---

This page summarizes the repository changelog. The source of truth is
`CHANGELOG.md` in the Desk repository.

## Unreleased

## 0.3.0 — source-backed CLI distribution

- The curl installer now installs the complete `desk` CLI on supported macOS
  and glibc Linux x64/arm64 hosts, including WSL.
- Plain `desk serve` launches the private compiled Bun runtime. `desk serve
  --dev` explicitly launches Vite; both modes fail without fallback.
- Releases publish source, install-manifest, and checksum assets instead of a
  separate public server executable.
- The installer provisions and rechecks required host packages, owns pinned Node
  22.23.1/npm 10.9.8 and Bun 1.3.14 toolchains, validates archives before safe
  extraction, and builds in an isolated staging instance.
- Install, upgrade, explicit downgrade, same-version repair, rollback, two-
  instance retention, launcher ownership, PATH ordering, and uninstall are
  lock-protected and fail closed.
- The Docker image now uses the full CLI, defaults to `desk serve`, and retains
  the opt-in Vite mode.

### Channels reliability and operations

- Pane capture now waits for process `close` instead of `exit`, preventing
  truncated captures from misclassifying ready agents.
- Channel engine tmux spawns have bounded timeouts and watchdog recovery for
  stale drain locks.
- The channels header includes a diagnostics and recovery drawer with live pane
  classification, queue inspection, force-deliver, mark-idle, drop-queue,
  drain-ready, and engine rebuild actions.
- Notification delivery is operator-forced and idempotent: delivery no longer
  depends on stale busy flags, and stale `.delivering` artifacts are reconciled.
- Agent event and hook plumbing now covers Claude, Codex, and OpenCode
  lifecycle, prompt, stop, approval, delivery-ack, and status evidence.
- `desk channels read` supports `--message <msg-id>`, and generated delivery
  prompts include both one-message and full-conversation read commands.
- Channel viewport, read-state, action-panel navigation, modals, picker
  filters, delivery diagnosis, and regression coverage were expanded.

### LSP integration

- Desk now includes the shared LSP runtime, HTTP/WebSocket/MCP surfaces,
  Monaco wiring, server/session pool, diagnostics, completion, hover, rename,
  file-operation services, safe workspace edit application, capability tokens,
  and managed-agent LSP wiring.
- TypeScript LSP support is detected automatically when the local project has
  the server dependency available.

## 0.1.0 — 2026-06-12

First public release.

Included:

- manifest-driven tmux terminal sessions
- durable browser reattach behavior
- automatic conversation id harvesting for managed agents
- per-group terminal layouts and scrollback capture
- Monaco editor tabs, file watching, workspace search, and editor save safety
- Git and GitHub operations through local `git` and `gh`
- GitHub Projects v2 board and table workflows
- local markdown notes
- markdown-backed channels with mentions, threads, uploads, onboarding
  briefings, and CLI access
- turn-complete and approval notifications
- 12 UI themes, sound effects, mobile drawers, and emergency kill switch
- localhost binding, local-trust security model, path-fenced filesystem API,
  and sandboxed uploads

## Next steps

- Read [Operations](/operations) for runtime behavior behind these changes.
- Read [Channels protocol](/channels-protocol) for the current delivery engine.
- Read [IDE and LSP](/ide-and-lsp) for the current language-server surface.
