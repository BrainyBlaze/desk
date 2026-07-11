# Contributing to Desk

Thanks for working on Desk. This guide covers how to set up, change, and ship code here. The engineering rules that keep the codebase healthy live in **[docs/engineering-rules.md](docs/engineering-rules.md)** — read it before your first change; it is the canonical source and every rule cites the real defect it prevents.

## Setup

```bash
nvm use 22          # Desk's CI runs Node v22.23.1 — match it locally
npm ci
npm run build       # build:ui then the CLI (see the build note below)
```

- **Node version matters.** CI pins **Node v22.23.1**. A newer local Node can pass tests that fail on CI (module-resolution and worker-thread behavior differ across majors). Always `nvm use 22` before you verify. (Rule **R11.2**.)
- **After `npm run build:ui`, run `npm run build`.** `vite emptyOutDir` wipes `dist/`, including the linked CLI. (Rule **R11.3**.)

## The verification gate

Every change must pass, locally, on Node 22, before you push:

```bash
npm run check       # tsc --noEmit
npx vitest run      # the full suite
```

Never push-and-see. Reproduce any CI failure in CI's exact environment first, fix it, confirm green locally, then push. (Rule **R11.2**.)

## The one rule to internalize first

> **Extract on the second use, not the third.** When a new feature needs functionality similar to something that already exists, do not copy-paste it. In the *same* change: build the new component, refactor the existing one, and lift the shared capability into a shared layer both consume.
>
> *Example:* the agent-side chat should gain the file-link handling the Channels chat already has by moving Channels' implementation into a shared layer both use — not by re-implementing it. Copy-paste-and-diverge is how spaghetti forms.

This is rule **R8.4**. It is the proactive form of the deduplication work (`src/shared/shell.ts`, `useSidebar`) that this codebase already paid for as cleanup — apply it forward and you never accrue the debt. The counterweight is **R8.2**: extract only the genuinely shared capability; if two uses diverge materially, share the true common core and let each keep its specifics rather than forcing one leaky abstraction.

## The rules at a glance

Full text, rationale, and enforcement for each is in [docs/engineering-rules.md](docs/engineering-rules.md).

- **R1** Errors are never dropped blind — route fire-and-forget through `asyncSafe.ts`; no silent `catch(_){}`.
- **R2** Fail closed, not open — locks/gates/completeness checks fail closed or expose a degraded state.
- **R3** Surfaces tell the truth — success shown only after success; unknown renders as unknown; displayed security values are server-derived.
- **R4** Boundaries are bounded and validated — check `response.ok` before parse; cap request bodies and protocol input before allocation; validate values crossing a trust boundary; preserve typed error codes.
- **R5** Persistence is atomic and guarded — atomic writes, parse-or-default, per-path lock + collision-proof temp names.
- **R6** Shell + untrusted rendering are audited once — one `shellQuote`, never raw `${var}` in a shell string, array-arg spawns, XSS-safe markdown.
- **R7** React lifecycle discipline — no side effects in render/updaters; effects list their conditions; comment every `exhaustive-deps` disable; protect optimistic state from polls.
- **R8** Complexity is decomposed into testable units — extract God-functions; **R8.4** extract-on-second-use; don't force abstractions where uses diverge.
- **R9** Architecture hygiene — clean layering, no source cycles, isolated generated code, no dead legacy paths.
- **R10** Type discipline + contract honesty — zero `@ts-ignore`/prod `as any`; update the contract when behavior changes.
- **R11** Process — reproduce first (in the user's real preconditions), CI parity before push, shared-checkout safety.

## Pull requests

- Land each change behind a test (the suite is strong; use it). (Rule **R11.1**.)
- Keep commits authored by you; do not add AI/co-author trailers.
- CI must be green (test, validate, build, CodeQL) before review.
- Desk is licensed **BSL 1.1**; by contributing you agree your contribution is licensed under the same terms.

## Where things live

- `src/core` — kernel (manifest, config, agent hooks); never imports `web`/`server`.
- `src/server` — dev/standalone server, channels engine, LSP bridge, agent drivers.
- `src/web` — React UI (agent surface, editor, channels, git, projects).
- `src/shared` — pure, dependency-free utilities shared across layers.
- `docs/` — long-form docs, including `engineering-rules.md`.
