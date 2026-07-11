# AGENTS.md — instructions for coding agents working on Desk

You are a coding agent contributing to Desk. Follow these operational rules. They are not suggestions — each one generalizes a real defect this codebase already fixed. The canonical, fully-cited rule set is **[docs/engineering-rules.md](docs/engineering-rules.md)**; this file is the operational subset you must apply on every change. For local setup, the verification gate, and the pull-request flow, see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Before you write code

- **Reproduce first.** Reproduce the bug in the user's *actual* preconditions (unread channel, long history, mid-scroll) — not the happy path you would build for. "Verified" on a happy path while the user's real scenario stays broken is a failure. (**R11.1**)
- **Read the rules doc** for the area you're touching. Every rule cites the finding it came from, so you can see the exact bug you must not regrow.

## When adding a feature similar to an existing one

> **Extract on the second use, not the third.** If a new feature needs functionality similar to something that already exists, do NOT copy-paste. In the same change: (1) build the new component, (2) refactor the existing one, (3) lift the shared capability into a shared layer both consume.
>
> *Example:* the agent-side chat should gain the file-link handling the Channels chat already has by moving Channels' implementation into a shared layer both surfaces use — not by re-implementing it agent-side.

This is **R8.4**. Its counterweight is **R8.2**: extract only the genuinely shared capability; if the two uses diverge materially, share the true common core and let each keep its specifics — do not force one leaky abstraction. The `useSubsystemData` hook was investigated and *declined* for exactly this reason.

## Non-negotiable code rules (summary — full text in the rules doc)

- **Errors never drop blind** — route fire-and-forget through `src/web/asyncSafe.ts`; a must-not-throw `catch` still emits one diagnostic line. (**R1**)
- **Fail closed** — a lock/gate/completeness check you can't resolve reads as "not-ok/degraded", never "ok". (**R2**)
- **Surfaces tell the truth** — show success only after success; render unknown as unknown; displayed security/status is the server-derived effective value, never client-claimed. (**R3**)
- **Bound and validate boundaries** — check `response.ok` before `response.json()`; cap request bodies and protocol input *before allocation*; validate anything crossing a trust boundary; keep typed, non-collapsed error codes. (**R4**)
- **Persistence is atomic and guarded** — atomic temp+rename writes, parse-or-default, per-path lock + collision-proof temp names. (**R5**)
- **Shell + untrusted rendering audited once** — one `shellQuote` in `src/shared/shell.ts`, never a raw `${var}` in a shell string, array-arg spawns only, XSS-safe markdown config. (**R6**)
- **React lifecycle** — no side effects in a render body or `setState` updater; an effect gated on a condition lists it in deps; comment every `exhaustive-deps` disable; protect optimistic state from background polls. (**R7**)
- **Type discipline** — zero `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, zero production `as any`. (**R10.1**)
- **Contract honesty** — when behavior changes, update the header/comment/docs; no diagnostic field that always returns empty. (**R10.2**)

## Verification gate (run before every push)

```bash
nvm use 22          # CI runs Node v22.23.1 — a newer local Node hides node-22-only failures
npm run check       # tsc --noEmit
npx vitest run      # full suite
```

- **CI parity before push.** Reproduce any CI failure in CI's exact environment — the exact Node version (**v22.23.1**) AND the exact harness (worker-thread/tsx module resolution differs across Node majors) — fix, confirm green locally, THEN push. Never push-and-see. (**R11.2**)
- **After `build:ui`, run `npm run build`** — `vite emptyOutDir` wipes the linked CLI. (**R11.3**)

## Working alongside other agents

- **Shared-checkout safety.** `git status` before editing any shared working tree. A file changing between two of your reads is a collision alarm — stop and reconcile. (**R11.4**)
- **Don't be a colliding hand.** When several agents are fixing one contended resource (a port, an instance, a shared file), designate ONE owner and get out. A supervisor verifies; it does not co-edit. (**R11.4**)
- Keep commits authored by the human; never add AI/co-author trailers.
- Post outcomes to the shared channel: what you did, the evidence, and who acts next.

## Layout

- `src/core` (kernel; never imports `web`/`server`) · `src/server` · `src/web` · `src/shared` (pure) · `docs/`
- Layering is enforced by convention (**R9.1**); import cycles, generated-binding isolation, and retired-terminal absence are enforced by the architecture test (**R9.2/R9.3/R9.4**).
