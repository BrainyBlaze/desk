# Fail-Closed atch Socket Liveness

**Status:** Approved by the operator on 2026-08-12 (`proceed with A`).

## Context

Desk uses a Unix-domain socket pathname as the rendezvous for each detached
atch holder. Before reclaiming an existing pathname, `SessionManager` probes
it with `node:net.createConnection`.

The existing boolean probe collapses every non-successful connection attempt
into "no listener." In particular, its 250 ms timeout returns `false`. The
spawn path then unlinks the pathname as a tombstone. Under host load, a live
holder can miss that deadline; unlinking its bound pathname leaves the holder
and agent alive but makes the session permanently unreachable by name.

This behavior was directly reproduced on the re-provisioned `main-3` session:
the holder remained alive and listening on the deleted Unix-socket inode while
Desk reported the session missing. A focused regression test also drives the
real `SessionManager.spawnAndAttach` preflight and proves that the old code
deletes an existing rendezvous node when the probe times out.

This is a confirmed secondary incident mechanism. It does not explain the
separate 18:26 deletion and recreation of the entire socket root, including
logs and event files. That wholesale event remains a distinct forensic issue.

## Goals

- Make uncertainty non-destructive: timeout and unexpected probe failures
  must never authorize unlinking a socket pathname.
- Preserve automatic recovery for a socket tombstone whose owner is proven
  gone.
- Apply the same liveness semantics at both destructive call sites.
- Keep the change small enough to validate and load through one controlled
  terminal-daemon restart.

## Non-goals

- Explaining or fixing the wholesale socket-root deletion.
- Changing generation-ledger or event-file authority.
- Replacing atch with Moor as part of this incident hotfix.
- Broad session-lifecycle refactoring or retry-policy changes.

## Design

### Tri-state probe

Replace the boolean probe with:

```ts
type SocketProbeResult = 'listener' | 'dead' | 'unknown';
```

The mapping is deliberately narrow:

| Observation | Result | Destructive action allowed? |
| --- | --- | --- |
| Connection succeeds | `listener` | No |
| Error code is `ECONNREFUSED` or `ENOENT` | `dead` | Yes, subject to the existing serialized lifecycle |
| Timeout | `unknown` | No |
| Any other error | `unknown` | No |

The timeout budget becomes 2 seconds to align with the established liveness
deadline and reduce false indeterminate results. The safety property does not
depend on that duration: a timeout of any length remains `unknown`.

### Spawn preflight

For a detached spawn with an existing socket pathname:

- `listener`: return `spawn-failed` without allocating a generation or
  modifying the pathname.
- `unknown`: return `spawn-failed` with the same non-destructive behavior.
- `dead`: retain the existing tombstone-reclaim path, then continue spawning.

The existing per-session serialized lifecycle remains the race-closing owner
inside Desk. The private socket root and current `ENOENT` handling remain
unchanged.

### Provider-session reset

After the existing awaited retirement step, if the socket pathname remains:

- `listener`: return `session-live`.
- `unknown`: return `retire-failed` with an indeterminate-liveness diagnostic.
- `dead`: remove the tombstone and continue the reset transaction.

This keeps reset fail-closed and prevents it from becoming a second route for
destructive timeout handling.

### Contract comments

Update the helper documentation and call-site comments to state the tri-state
contract explicitly. Incident attribution must mention only the directly
observed per-socket `main-3` recurrence and must not claim that this mechanism
caused the wholesale root deletion.

## Verification

The focused regression test must:

1. Create a real filesystem node at the configured socket path.
2. Exercise the real detached `SessionManager.spawnAndAttach` path.
3. Mock only `node:net.createConnection` so the socket times out without a
   `connect` or `error` event.
4. Assert `spawn-failed` and assert that the filesystem node still exists.

TDD evidence must show the assertion failing on the old implementation because
the node was deleted, then passing on the tri-state implementation. Existing
session-manager integration coverage must remain green. Before loading the
fix, run the TypeScript check, build, diff check, and inspect the emitted daemon
code for the same mappings at both call sites.

The full Node 22 suite runs immediately after the controlled restart, not
before it: a high-load full run against the still-vulnerable in-memory daemon
could reproduce the production failure while the fix exists only on disk.

## Deployment and recovery

1. Record focused GREEN/check/build/dist evidence without restarting anything.
2. Restart exactly the terminal daemon through its existing supervisor; do not
   perform a broad Desk shutdown or restart holders.
3. Confirm the daemon PID changed and every currently visible socket remains
   attachable.
4. Run the full Node 22 suite while monitoring socket-path continuity.
5. Treat `main-3` specially: its current holder and agent are alive behind a
   deleted pathname, so never boot it concurrently. Retire that exact orphan
   only after its persisted conversation identity is verified, then resume the
   same conversation once.
6. Reconcile original/replacement duplicates one identity at a time. Never
   infer that an invisible holder is dead merely from a missing pathname.

Rollback is a source/build rollback plus another controlled daemon restart.
Rollback must not restore the vulnerable daemon while lifecycle requests or a
high-load verification run are active.
