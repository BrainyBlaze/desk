# Fail-Closed atch Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the tested fail-closed atch liveness fix without disturbing surviving holders, recover the one live orphan safely, and resume Linux/Windows container QA under the fixed daemon.

**Architecture:** A tri-state Unix-socket probe is shared by the two existing destructive lifecycle call sites. Only `ECONNREFUSED` or `ENOENT` proves death; connection success means live, and timeout or any other error means unknown and non-destructive. Deployment restarts only the supervised terminal-daemon child, verifies socket continuity, then runs high-load verification and isolated-container QA.

**Tech Stack:** TypeScript, Node.js 22.23.1, Vitest, Unix-domain sockets, Desk terminal daemon/supervisor, Docker, Debian 12, dockur/windows Windows 11.

---

## File map

- `src/server/runtime/sessionManager.ts`: tri-state probe and the spawn/reset decisions that consume it.
- `tests/sessionManager.probe-timeout.test.ts`: regression for timeout preserving an existing rendezvous node.
- `dist/server/runtime/sessionManager.js`: generated runtime loaded by the supervised daemon; inspect but do not commit.
- `docs/superpowers/specs/2026-08-12-atch-liveness-fail-closed-design.md`: approved behavioral contract.
- `docs/superpowers/plans/2026-08-12-atch-liveness-fail-closed.md`: execution and recovery record.
- `/tmp/desk-atch-1000`: live socket/event root; observe only except for the provider reset command after the exact orphan exits.
- `/qa/LINUX2-CHECKLIST.md` inside `desk-qa-linux2`: isolated Linux manual-QA ledger.

### Task 1: Preserve the regression and prove RED

**Files:**
- Create: `tests/sessionManager.probe-timeout.test.ts`
- Inspect: `src/server/runtime/sessionManager.ts`

- [x] **Step 1: Add a focused production-path test**

  Create a real filesystem node, mock only `node:net.createConnection` so its timeout fires without `connect` or `error`, and call `SessionManager.spawnAndAttach` with `detached: true`.

- [x] **Step 2: Assert the safety contract**

  Assert the result is `{ ok: false, reason: 'spawn-failed' }` and `existsSync(sockPath)` remains `true`.

- [x] **Step 3: Run RED on the old implementation**

  Run:

  ```bash
  source /home/dev/.nvm/nvm.sh
  nvm use 22
  npm test -- --run tests/sessionManager.probe-timeout.test.ts
  ```

  Expected: one assertion failure because the old boolean timeout branch unlinks the node. Recorded evidence: `existsSync(sockPath)` was `false` at line 110.

### Task 2: Implement the minimal tri-state fix

**Files:**
- Modify: `src/server/runtime/sessionManager.ts:492`
- Modify: `src/server/runtime/sessionManager.ts:928`
- Modify: `src/server/runtime/sessionManager.ts:1084`
- Test: `tests/sessionManager.probe-timeout.test.ts`

- [x] **Step 1: Replace the boolean result with the approved type**

  ```ts
  type SocketProbeResult = 'listener' | 'dead' | 'unknown';
  ```

- [x] **Step 2: Map observations fail-closed**

  Implement `connect -> listener`, `ECONNREFUSED|ENOENT -> dead`, and timeout/every other error -> `unknown`. Use the 2 second deadline; never treat its expiry as death.

- [x] **Step 3: Guard both destructive call sites**

  Detached spawn returns `spawn-failed` for `listener` and `unknown`; provider reset returns `session-live` for `listener` and `retire-failed` for `unknown`. Only `dead` reaches `unlinkSync`.

- [x] **Step 4: Update contract comments**

  Document the tri-state safety property and attribute the directly observed recurrence only to `main-3`, keeping the wholesale root deletion separate.

- [x] **Step 5: Verify focused GREEN under Node 22**

  Run:

  ```bash
  source /home/dev/.nvm/nvm.sh
  nvm use 22
  npm test -- --run tests/sessionManager.probe-timeout.test.ts tests/sessionManager.integration.test.ts tests/spawnMaster.integration.test.ts
  npm run check
  npm run build
  git diff --check
  ```

  Expected: 11/11 focused tests pass, TypeScript and build exit 0, diff check is empty. Independently reproduced on Node `v22.23.1`.

### Task 3: Review emitted runtime and snapshot the live boundary

**Files:**
- Inspect: `dist/server/runtime/sessionManager.js`
- Inspect: `/tmp/desk-atch-1000`

- [x] **Step 1: Inspect emitted decisions**

  Verify the emitted helper defaults to 2000 ms, timeout maps to `unknown`, only the two explicit error codes map to `dead`, and both call sites guard unlink.

- [ ] **Step 2: Snapshot exact daemon and socket state**

  Record standalone PID/command, terminal-daemon PID/command, sorted visible socket names/inodes, `desk status`, and the live-orphan `main-3` holder/child commands.

- [ ] **Step 3: Confirm no editing collision**

  Run `git status --short` and confirm the only implementation changes are the designated owner's `sessionManager.ts` and timeout regression test.

### Task 4: Load the fix with one daemon-only restart

**Files:**
- Runtime: `dist/cli/main.js`
- Runtime: `dist/server/runtime/sessionManager.js`

- [ ] **Step 1: Signal only the exact supervised daemon child**

  Resolve the current PID from the child of `/home/dev/projects/desk/desk/libexec/desk-standalone`, validate its command is `node .../dist/cli/main.js terminal-daemon`, then send that exact PID `SIGTERM`. Do not signal the standalone server, atch holders, or agent children.

- [ ] **Step 2: Wait on conditions, not time alone**

  Poll until the old daemon PID exits, a different child PID appears, and `http://127.0.0.1:5178/control/health` reports ready. Fail closed if no healthy replacement appears within the supervisor's 15 second probe window.

- [ ] **Step 3: Verify continuity**

  Compare the sorted visible socket set and inode map with the snapshot. Run `desk status` and a non-mutating capture for every session that was visible before restart. `main-3` is expected to remain missing while its orphan holder remains alive.

- [ ] **Step 4: Post the restart evidence**

  Report old/new daemon PIDs, health result, reattach count/log line, socket diff, and any capture failure before touching `main-3` or starting heavy tests.

### Task 5: Run high-load verification under the fixed daemon

**Files:**
- Test: repository-wide test suite
- Observe: `/tmp/desk-atch-1000`

- [ ] **Step 1: Start socket continuity monitoring**

  Capture the visible socket set before and after the run and keep a lightweight inotify/poll log of deletes/moves during it.

- [ ] **Step 2: Run the full CI-parity suite**

  ```bash
  source /home/dev/.nvm/nvm.sh
  nvm use 22
  npx vitest run
  ```

  Expected: zero failures. This deliberately runs only after the fixed daemon is live.

- [ ] **Step 3: Reverify runtime continuity**

  Require the same socket set/inodes, healthy daemon, and successful captures. Any socket deletion pauses Docker QA and returns to incident diagnosis.

- [ ] **Step 4: Commit the hotfix**

  ```bash
  git add src/server/runtime/sessionManager.ts tests/sessionManager.probe-timeout.test.ts
  git commit -m "fix: fail closed on indeterminate socket liveness"
  ```

  Do not stage unrelated changes or generated `dist` files.

### Task 6: Recover `main-3` without a second writer

**Files:**
- Config identity: `/home/dev/.config/desk/desk.yml:364`
- Persisted conversation: Codex thread `019e35f7-4523-7f70-8f6a-ef9745824e72`

- [ ] **Step 1: Revalidate the orphan identity**

  Confirm holder PID/child ancestry, launch generation 19, exact resume ID, recent persisted rollout, and missing pathname. Abort if any identity differs.

- [ ] **Step 2: Retire only the exact orphan holder**

  Send `SIGTERM` to the validated atch holder, wait for holder and child to exit, and verify the writer lock is released. Do not delete its pathname manually; it is already absent.

- [ ] **Step 3: Reset and resume exactly once**

  Use the built provider-session reset command for `main-3` with force only after every old process is gone, then invoke the single-session restart API with the configured session ID. Never use broad `desk up`.

- [ ] **Step 4: Verify continuity**

  Require a new visible `main-3.sock`, exact configured resume ID in the child command, `desk status` running, successful capture, and no active-writer error.

### Task 7: Resume isolated Docker QA

**Files:**
- Inspect/update in QA workspace: `/qa/LINUX2-CHECKLIST.md` inside `desk-qa-linux2`
- Candidate assets: `/qa/desk-assets` and `/qa/moor-assets` inside `desk-qa-linux2`
- Windows shared staging: `/shared` inside `desk-qa-win11`

- [ ] **Step 1: Declare rehearsal versus release-candidate evidence**

  The existing Linux install is `desk v0.4.0-qa1` at Desk `8edb41d` plus a local QA pin and Moor `237a62c`; it is not the unfrozen official six-target candidate. Continue it as rehearsal evidence only and do not label it a formal release PASS.

- [ ] **Step 2: Finish Linux functional/restart coverage**

  Against `127.0.0.1:15173`, verify installed Desk/Moor provenance, browser creation and interaction, channels delivery, Desk-only restart reattachment, container stop/start restoration, downtime catch-up, lease race, alt-screen/Unicode/resize, holder-death honesty, socket-root refusal, event-store disk pressure, channel load, and soak deltas. Record exact commands, screenshots/logs, and findings in the isolated QA ledger; never modify the host Desk runtime from the container.

- [ ] **Step 3: Establish Windows readiness**

  Verify SSH on `127.0.0.1:12225`, Windows version/architecture, clean user profile, and shared candidate checksums before installation. If SSH is not ready, use the web console at `127.0.0.1:18011` only to diagnose guest setup; do not claim the lane started.

- [ ] **Step 4: Run Windows install/manual matrix when assets are frozen**

  Copy only checksum-verified six-target candidate assets through `/shared`, run the user-facing installer in PowerShell, then repeat terminal create/input/resize/detach, channels, Desk restart, and guest reboot restoration. Keep this lane pending until Moor #27/#28 and the official manifest are green.

- [ ] **Step 5: Publish bounded evidence**

  Report rehearsal results separately from formal release results, file every reproducible defect with exact Desk/Moor SHAs and artifacts, and keep merge/tag HOLD until the complete matrix passes.
