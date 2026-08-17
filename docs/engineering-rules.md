# Desk Engineering Rules

These rules exist because we broke them once. Every rule below generalizes a concrete defect or duplication that the Wave 1–3 refactoring removed, or a validated lesson from working on desk. Each cites the exact finding it came from (`desk-codebase-review.md` §) or the landed fix, so the rule is never abstract advice — it is "do not regrow *this* bug".

**Audience:** every contributor to desk — human or coding agent.

**Scope discipline:** this doc contains only rules traceable to a fixed finding or a validated refactor lesson. Forward-looking ideas (new lint rules, aspirational patterns) live in a separate non-normative backlog, not here — a rule in this doc is something we have already paid for.

**How to read a rule:** each is `MUST` / `AVOID` (a gate) or `PREFER` (guidance). A rule is a **Gate** only if it has an enforcement path; otherwise it is **Guidance**. Enforcement tags:

- `[test]` — a unit/integration test guards it
- `[CI]` — CI guards it (a job, a suite, a version pin)
- `[lint]` — tsc/eslint guards it (or could, cheaply)
- `[metric]` — a runtime metric/health field exposes violations
- `[review]` — human/agent review is the only guard (Guidance unless paired with another tag)

`[server-lane]` marks a rule whose canonical case is server-side, so its
enforcement is verified against the server implementation rather than the UI.

---

## R1 — Errors are never dropped blind

The single biggest correctness theme in the review: failures dropped with zero trace. There was **no** central error surface anywhere in the repo (§6.1). We added one; use it.

- **R1.1 MUST** — a fire-and-forget promise on any state-bearing path routes through `src/web/asyncSafe.ts::fireAndForget(promise, context)`, which logs on rejection (and is the future telemetry seam). AVOID a bare `.catch(() => undefined)` that drops blind. *Why:* theme/mute/autosave/read-state persistence was failing invisibly (§6.1, §6.4.1). *Enforcement:* `[review]` + `[lint]` (a `.catch(() => undefined)` grep is a fast review aid). **Gate.**
- **R1.2 MUST** — a `catch` that deliberately must-not-crash-the-chain still emits one diagnostic line (gated behind `DESK_DEBUG` where noise matters). AVOID silent `catch(_) {}`. *Why:* `agentHooks` swallowed the attention-POST failure — the hook's entire purpose — with no trail (§6.4.3); the LSP restart failure was swallowed after a `restarting` event (§5.13). *Enforcement:* `[review]`. **Guidance.**
- **R1.3 PREFER** — one error-to-string helper, `src/web/asyncSafe.ts::toErrorMessage(err)`; do not re-inline `err instanceof Error ? err.message : String(err)` (~18 copies in App alone). *Why:* §6.4.1. *Enforcement:* `[lint]` (grep) + `[review]`. **Guidance.**
- **R1.4 MUST** — when an async result feeds UI, gate BOTH the local state update AND any parent/error callback on the request still being current (a sequence ref). AVOID calling `onError` unconditionally while the state write is guarded. *Why:* `ItemDrawer` routed a stale request's error to the parent auth-degradation path even after the user switched items (§6.4.4; the Copilot-caught guard fix). *Enforcement:* `[test]` + `[review]`. **Gate.**

## R2 — Fail closed, not open

- **R2.1 MUST** `[server-lane]` — a lock / gate / ownership / completeness check fails **closed** or exposes an explicit degraded state (`lockError`, `degraded`); it never returns "OK/owner" on an unexpected error. There is exactly **one** writer/owner of a contended resource, and a lock it cannot inspect means "not owner", not "owner". Fail open only for a *narrowly proven* benign case. *Why:* the channels owner-lock's outer `catch { return true }` turned any FS error into "this process owns dispatch" (§5.4); the concurrency review lesson is that a lock's safety is judged on the shared medium, and in-memory locks are per-instance. *Enforcement:* `[test]` (EACCES/corrupt-pid no-dispatch). **Gate.**
- **R2.2 MUST** — a completeness/validation check enumerates every required field from the frozen type and negative-tests each; a missing field reads as invalid, not OK. *Why:* checks that miss a required field read incomplete state as healthy — they fail open. *Enforcement:* `[test]` (per-field negative test). **Gate.**
- **R2.3 MUST** — a readiness/enabled flag set only on the success path is ALSO resolved on the failure path. AVOID leaving it false forever when boot fails. *Why:* `settingsLoadedRef` was set only inside `.then()`, so one failed boot fetch silently killed settings persistence for the whole session; the fix sets it (+ toast) in `.catch` (§6.4.1). *Enforcement:* `[test]` + `[review]`. **Gate.**

## R3 — Surfaces tell the truth

- **R3.1 MUST** — a success toast/label renders only after confirmed success (inside `.then`), never unconditionally after a fire-and-forget. *Why:* the "Copied" toast fired even when `navigator.clipboard?.writeText(...)` short-circuited or rejected (§6.4.1). *Enforcement:* `[review]`. **Guidance.**
- **R3.2 MUST** — unknown / not-yet-loaded state renders as neutral "unknown", never as a definitive negative. *Why:* EngineConsole showed "pump down" / "0 queued" when diagnostics were simply `null` (before first load), inviting a needless rebuild — same class as the W1 warm-session honesty fix (§6.4.5). *Enforcement:* `[review]`. **Guidance.**
- **R3.3 MUST** — a displayed or persisted security/status value is the server-derived EFFECTIVE truth, never raw config or a client-claimed value; a disagreeing client value is a spoof to reject + audit. *Why:* a surface that repeats what the client claimed is not reporting security state, it is echoing it; the value a reader trusts has to be the one the server derived. *Enforcement:* `[test]` + `[review]`. **Gate.**
- **R3.4 MUST** `[server-lane]` — a state signal derives from the authoritative state machine, never from a proxy probe. Session state comes from the agent's own typed events through the canonical authority; it is never sniffed off a terminal pane. *Why:* an idle native agent was reported "blocked, message not delivered" because readiness was misclassified and a submit-verify replayed against the screen — two real bugs found in manual E2E and fixed against the FSM. The screen-sniffing path (OSC 9, BEL, pane classification) was later removed outright for the same reason, and delivery no longer consults activity at all. *Enforcement:* `[test]` (state derived from accepted facts, never from capture). **Gate.**

## R4 — Boundaries are bounded and validated

- **R4.1 MUST** — an HTTP client reader checks `response.ok` (+ content-type) BEFORE `response.json()`, via the shared `src/web/httpJson.ts` reader. AVOID parsing first and losing the real status. *Why:* three clients (api/git/projects) each `await response.json()` before the status check, so a non-JSON 502/413/timeout body threw `SyntaxError` and hid the true HTTP status (§6.4.4, §6.4.5). *Enforcement:* `[test]` + `[review]`. **Gate.**
- **R4.2 MUST** `[server-lane]` — a server body reader bounds input before allocation: `readJsonBody(req, { maxBytes })` with a conservative default, `Content-Length` preflight, destroy-on-overflow, typed 413. AVOID appending unbounded chunks then parsing. *Why:* `readJsonBody` had 50 call sites and no cap — one oversized local request could force unbounded memory growth and surface as a generic parse failure (§5.11). *Enforcement:* `[test]` (overflow + preflight). **Gate.**
- **R4.3 MUST** — every externally-influenced array/string (protocol options, command lists, markdown/text, terminal dims) has a max bound checked before allocation. *Why:* the agent-surface/broker protocol parsers were solid on shape but unbounded on size (§6.4.3 hardening). *Enforcement:* `[test]` + `[review]`. **Gate.**
- **R4.4 MUST** — a value crossing a trust boundary (localStorage, query string, an offline `--as` identity) goes through a validating reader, not an unchecked `as T` cast. *Why:* `localStorage.getItem('desk.subsystem') as Subsystem` was unvalidated next to validated `readStoredTheme/Muted/Width` (§6.4.1); offline `--as` wrote an unvalidated author identity while the online path rejects non-members (§6.4.5). *Enforcement:* `[test]` + `[review]`. **Gate.**
- **R4.5 MUST** `[server-lane]` — boundary errors preserve typed, non-collapsed, safe codes (`missing-env`, `invalid-input`, `bad-api-url`, `http-failed`, …) while redacting secrets and internals. AVOID collapsing missing-env / missing-token / bad-URL / HTTP-failure / bad-JSON into one generic error. *Why:* `callLspTool` flattened all of these into the same opaque tool error (§5.8). *Enforcement:* `[test]` (each error path yields its code) + `[review]`. **Gate.**

## R5 — Persistence is atomic and guarded

- **R5.1 MUST** — a write to a user/config file is atomic (temp + `renameSync`), reusing the shared helpers (`fsOps.ts::writeFileAtomic`/`writeFileAtomicCreate` server-side; the `config.ts` temp+rename pattern for the manifest; `agentHooks` now uses `writeJsonIfChanged`). AVOID a bare `writeFileSync` a crash can truncate. *Why:* `agentHooks` wrote the user's `~/.claude/settings.json` / `~/.codex/hooks.json` non-atomically (§6.4.3). *Enforcement:* `[review]` + `[test]`. **Gate.**
- **R5.2 MUST** — a `JSON.parse` of on-disk/user content is parse-or-default, never an unguarded parse that one hand-edited typo aborts a whole flow. *Why:* `readJsonObject` did `JSON.parse(readFileSync(...))` with no try/catch, so a typo aborted all of `installAgentHooks` (§6.4.3). *Enforcement:* `[review]`. **Guidance.**
- **R5.3 MUST** `[server-lane]` — concurrent read-modify-write uses a per-path lock AND a collision-proof temp name (random suffix, e.g. `${path}.tmp-${pid}-${randomUUID()}`, NOT `${pid}-${Date.now()}` which collides for two same-ms writes). Judge lock correctness on the SHARED MEDIUM, not an in-memory object. *Why:* the manifest read-modify-write was last-writer-wins with a same-ms-colliding temp name (§6.4.3); the fix is `withFileLock` + `randomUUID` temp in `config.ts` over `src/shared/fileLock.ts`. *Enforcement:* `[test]` (the `config-concurrency` suite: concurrent writers, collision-proof temp) `[CI]`. **Gate.**
- **R5.4 MUST** `[server-lane]` — a durable state change is accepted only after both its content and the directory entry that names it are durable. Atomic rename alone is not durable acceptance. *Why:* the provider-session transition ledger could durably authorize a rebind while the corresponding manifest replacement had only been renamed, allowing power loss to restore the old binding beside a resolved transition. *Enforcement:* `[test]` (`config-manifest-durability`: temp inode sync precedes rename; parent-directory sync follows it) + `[review]`. **Gate.**

## R6 — Shell + untrusted rendering are audited once

- **R6.1 MUST** — shell-escaping lives in exactly one place, `src/shared/shell.ts::shellQuote`; no byte-identical copies. *Why:* `shellQuote` was byte-identical in 4 files — a fix in one would silently miss the other three, a real security-divergence class (§3.2). *Enforcement:* `[lint]` (dup-hash) + `[review]`. **Gate.**
- **R6.2 MUST** — never interpolate a raw `${var}` into a shell string; every interpolation goes through the audited quoter, including diagnostic `printf`s. *Why:* `buildClaudeResumeCommand` quoted `resume` for `--resume` but interpolated it raw into a diagnostic `printf`, so a resume id with `$(...)`/backtick/`"` broke out (§6.4.3). *Enforcement:* `[review]`. **Guidance.**
- **R6.3 MUST** — process spawns use array args; never `shell: true`; never string interpolation into a command. *Why:* standing invariant validated across CLI + server (§5.0, §6 CLI positives) — keep it true. *Enforcement:* `[lint]` (grep `shell: true`) + `[review]`. **Gate.**
- **R6.4 MUST** — untrusted markdown/HTML stays XSS-safe: react-markdown without `rehype-raw`, `urlTransform` stripping `javascript:`/`data:`/`vbscript:`, external links `rel="noreferrer noopener"`, Mermaid `securityLevel: 'strict'` + DOMPurify, katex `trust: false`. *Why:* three markdown surfaces (Channel/Markdown/Item) were audited clean on exactly these properties (§288/§294/§301) — regressions here are XSS. *Enforcement:* `[test]` + `[review]`. **Gate.**

## R7 — React lifecycle discipline

- **R7.1 MUST** — no side effect (WebSocket / fetch / subscription) in a render body or a `setState` updater; move it into an effect or event handler. *Why:* a WebSocket built in the editor render body could leak under StrictMode double-render (§6.4.2); git `toggleCommitExpanded` fired a fetch inside a `setState` updater → double fetch (§6.4.4). *Enforcement:* `[review]`. **Guidance.**
- **R7.2 MUST** — an effect gated on a condition lists that condition in its deps; a value read but omitted goes stale. *Why:* the editor disk-watch subscribe effect omitted `active`, so the watcher (created lazily only when active) never attached — external file changes went undetected for any session not booted with the editor active (§6.4.2). *Enforcement:* `[lint]` (`react-hooks/exhaustive-deps`) + `[test]`. **Gate.**
- **R7.3 MUST** — every `react-hooks/exhaustive-deps` suppression carries a one-line reason comment. *Why:* 20+ suppressions are individually legitimate but opaque; the load-bearing one (MessageList deliberately excludes `newDividerId`) is the actual fix for the "re-anchor on every read" bug and must not be "corrected" (§6.2). *Enforcement:* `[lint]` (disable-without-comment) + `[review]`. **Gate.**
- **R7.4 MUST** — optimistic UI state is protected from background polls (gate the poll on `opBusy`/in-flight); concurrent mutations on one resource sequence into one op. *Why:* the projects poll clobbered optimistic board state mid-drag (card snap-back), and `dropOnCard` fired two concurrent `runOp`s racing to a stale column (§6.4.4). *Enforcement:* `[test]` + `[review]`. **Gate.**
- **R7.5 PREFER** — state-driven DOM over manual `classList` / `getBoundingClientRect` mutation that bypasses React. *Why:* App drove `sidebarAnimating` via direct `classList` + rect resync, fragile coupling to DOM ids and react-resizable-panels internals (§6.4.1). *Enforcement:* `[review]`. **Guidance.**

## R8 — Complexity is decomposed into testable units

- **R8.1 PREFER** — behavior-neutral decomposition: lift React glue into plain controllers/hooks/routers that node tests can exercise. A God-function is refactored by extraction, not left in one module. *Why:* `App` was cyclomatic 575 in one function / 256 KB; this cycle extracted `usePulse`, a map-driven `ModalRouter` (replacing the 190-line `renderModal` ladder), and `*Impl` components (5556 → ~3951 lines), each verified by tsc + the full suite + a circular-import grep (§2, §8.3). *Enforcement:* `[test]` (extracted units) + `[review]`. **Guidance.**
- **R8.2 MUST** — introduce a shared abstraction only when the copies are semantically identical; do NOT force one where subsystems materially diverge. *Why:* `useSidebar` collapse-persistence and `shellQuote` were real duplication and were deduped; but a unified `useSubsystemData` hook was investigated and DECLINED because the four subsystems diverge on generation-counter vs identity-keyed staleness, poll cadence/gating, and report-vs-count surfaces — a forced hook would be a leaky net-loss abstraction (§3, §8.3). *Enforcement:* `[review]`. **Guidance.**
- **R8.3 MUST** — when logic IS duplicated, a fix is applied to every copy — or better, dedup first so there is one copy to fix. *Why:* the shellQuote divergence class (§3.2). *Enforcement:* `[review]`. **Guidance.**
- **R8.4 MUST** — extract on the **second** use, not the third. When a new feature needs functionality similar to an existing component, do NOT copy-paste it. In the *same* change: (1) build the new component, (2) refactor the existing one, (3) lift the shared capability into a shared layer that both consume. *Why:* copy-paste-and-diverge is exactly how the shellQuote (§3.2) and sidebar (§3.1) spaghetti formed; done proactively on the second use, extraction prevents the divergence class before it starts — this is the same discipline that produced `src/shared/shell.ts` and `useSidebar`, applied *forward* instead of as cleanup. *Example (@human):* the agent-side chat should gain the file-link handling the Channels chat already has by lifting Channels' implementation into a shared layer both surfaces use — not by re-implementing it agent-side. *Balance:* R8.2 still governs — extract only the genuinely-shared capability; if the two uses diverge materially, share the true common core and let each keep its specifics, rather than forcing one leaky abstraction. *Enforcement:* `[review]`. **Guidance.**

## R9 — Architecture hygiene (enforced)

- **R9.1 MUST** — layering holds: `core` never imports `web`/`server`; `web` never imports `server`; `shared` is pure. Zero violations is the standing bar. *Why:* the God-file problem is intra-file complexity, not tangled cross-module deps — which is only true because layering is clean (§6.0). *Enforcement:* `[review]` (there is no layer-check lint/CI rule today — the architecture test covers cycles/binding-isolation/retired-terminal, not layering; a layer-check is a backlog item). **Guidance.**
- **R9.2 MUST** `[server-lane]` — no source dependency cycles; even a type-only cycle encodes wrong ownership, so relocate the shared type (`QueuedPrompt` → `channels/protocol/delivery`, `AgentHostEnv` → `agents/host/types`). *Why:* two server cycles were type-only (erased at runtime) but still misplaced ownership (§5.5). *Enforcement:* `[lint]` (cycle check, generated code excluded) + `[CI]`. **Gate.**
- **R9.3 MUST** `[server-lane]` — generated code (`codexBindings/**`) is isolated behind a barrel/adapter, excluded from health/dead-code/file-count metrics, and regenerable via the checked-in `generate:codex-bindings` script. *Why:* 655 generated stubs distorted metrics and the depth-12 dependency chain, and `package.json` had no regeneration script (§4, §5.6). *Enforcement:* `[test]` (generator tests + isolation) + `[review]`. **Gate.** *Backlog:* a CI step that regenerates and diffs to catch drift is not yet automated — add it separately before treating drift as a gate.
- **R9.4 MUST** `[server-lane]` — no dead legacy path running beside its replacement; remove it, or quarantine it with parity tests + a documented reason. *Why:* the legacy `/ws/terminal` bridge still ran beside `/ws/terminal-broker` though the client uses only the broker (§5.7). *Enforcement:* `[review]` + `[test]` (parity if quarantined). **Gate.**

## R10 — Type discipline + contract honesty

- **R10.1 MUST** — zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` and zero production `as any` (test doubles only). *Why:* this is currently true repo-wide (§6.0, §6.3) — it is a hard gate to keep, not a goal to reach. *Enforcement:* `[lint]` (grep in CI) + `[CI]`. **Gate.**
- **R10.2 MUST** `[server-lane]` — when behavior changes, the contract changes with it: update the file header/comment/docs, and split genuinely distinct contracts into named strategies tested separately. No diagnostic field that always returns empty while comments claim otherwise. *Why:* the channels file header still described signal-gated queues while `drain()` force-delivers (§5.2), and `blockedItems()` returned `[]` while diagnostics still exposed `blockedItemCount` (§5.3). *Enforcement:* `[test]` (each strategy) + `[review]`. **Gate.**
- **R10.3 MUST** — README/docs describe the product AS IT IS (present tense); only the changelog speaks in deltas ("new / now / remains"). *Why:* docs written as deltas age into nonsense — "now supports X" tells a new reader nothing about what the product does today, and nobody knows when it stops being new. *Enforcement:* `[review]`. **Guidance.**

## R11 — Process: how we change desk safely

- **R11.1 MUST** — reproduce first, in the USER'S actual preconditions (unread / long-history / mid-scroll), not the happy path; land each change behind a test. *Why:* "verified" was claimed twice on a caught-up channel while the operator's unread channel stayed broken; the review's whole premise is "land each behind the existing tests" (§8.5). *Enforcement:* `[review]` + `[test]`. **Gate.**
- **R11.2 MUST** — CI parity before push: reproduce a CI failure in CI's EXACT environment locally, verify green, THEN push — never push-and-see. Parity means the exact Node version (desk CI = node **v22.23.1**; local defaults to node 25 → `nvm use 22`) AND the exact harness behavior (worker_threads/tsx module resolution differs across Node majors — a passing `npx vitest` on node 25 hid a deterministic node-22 failure). *Why:*— this exact gap produced a red-CI push cycle; the fix required matching v22.23.1 and the worker/thread harness, not just the command. *Enforcement:* `[CI]` (the pin) + `[review]`. **Gate.**
- **R11.3 MUST** — after `npm run build:ui`, run `npm run build` — `vite emptyOutDir` wipes `dist/` including the npm-linked global CLI. *Why:* the linked `desk` command resolves into `dist/cli/main.js`, so a UI build deletes the CLI out from under the shell that just ran it; the next `desk` invocation fails for a reason that looks nothing like "I built the UI". *Enforcement:* `[review]`. **Guidance.**
- **R11.4 MUST** — shared-checkout safety: `git status` before editing any shared working tree; a file changing between two reads is a collision alarm; when several agents touch one contended resource, designate ONE owner and get out (a supervisor verifies, it does not co-edit). *Why:* two agents editing one working tree overwrote each other's uncommitted work, and a background automation committed a tree mid-edit. *Enforcement:* `[review]`. **Guidance.**

---

## Appendix — traceability

| Rule | Source finding | Landed fix (evidence) |
|---|---|---|
| R1.1/R1.3 | §6.1 no central error helper | `src/web/asyncSafe.ts` (`fireAndForget`, `toErrorMessage`) |
| R1.4 | §6.4.4 ItemDrawer | `ItemDrawer.tsx` onError gated on request seq |
| R2.1 | §5.4 owner-lock fail-open | `channels/runtimeOwner` lease + fail-closed |
| R2.3 | §6.4.1 settings deadlock | ref resolved in `.catch` |
| R3.4 | channels×native E2E bugs | `channelsDeliveryStrategy.ts` broker-FSM readiness |
| R4.1 | §6.4.4/§6.4.5 readJson | `src/web/httpJson.ts` |
| R4.2 | §5.11 readJsonBody | `httpUtil.ts` maxBytes + 413 |
| R4.5 | §5.8 collapsed LSP errors | typed error codes in `deskLspMcp` |
| R5.1/R5.2 | §6.4.3 agentHooks | `writeJsonIfChanged` + guarded parse |
| R5.3 | §6.4.3 manifest lock | `config.ts` `withFileLock` + `randomUUID` temp; `config-concurrency` suite |
| R5.4 | provider-session rebind durability gap | `config.ts` durable manifest replacement; `config-manifest-durability` suite |
| R6.1/R6.2 | §3.2/§6.4.3 shell | `src/shared/shell.ts::shellQuote` |
| R7.2 | §6.4.2 disk-watch | `active` added to subscribe deps |
| R8.1 | §2/§8.3 God-file | `usePulse`, `ModalRouter`, `*Impl` extraction |
| R9.1 | §6.0 clean layering | 0 layer violations |
| R10.1 | §6.0/§6.3 type discipline | 0 ts-ignore / 0 prod as-any |
| R11.2 | CI/local runtime drift | CI pin node 22; `config-concurrency` node-22 fix |
