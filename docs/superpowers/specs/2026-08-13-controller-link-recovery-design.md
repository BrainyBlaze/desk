# Controller-Link Recovery Without Session Retirement

## Context

Desk currently treats the close of its Moor controller/viewer connection as the
death of the supervised session. `SessionManager` calls `retire()` from the
current link's `onClose`, and retirement runs the retained `moor kill -f`
command. That implication is false: Moor deliberately disconnects an individual
controller for protocol, lease, backpressure, and transport failures without
ending the holder or its child.

The production incident exposed the shortest destructive path. The viewer lease
lasts 10 seconds and Desk emits keepalives every 3 seconds. A roughly 7--10
second Desk event-loop pause can let the lease expire. The overdue keepalive
then receives `LEASE_NOT_HELD`, Moor closes only that connection, and Desk
mistakenly retires and force-kills the still-live child. A measured daemon event
delay of 7.134 seconds and a one-second wave of thirteen exits match this path.

The invariant for this correction is:

> Losing a controller/viewer link never proves that the session, holder, or
> child ended. Link loss may detach and trigger bounded re-adoption work, but
> only explicit destructive control or positive holder absence may end Desk's
> session authority.

This design amends Desk issue 59. It preserves that issue's exit provenance,
final event-store drain, and exact-generation correction behavior.

## Goals

- Preserve a live Moor holder and child across late-keepalive refusal, EOF,
  socket error, and local controller failure.
- Re-adopt the same generation without duplicating already-delivered output.
- Resume the exact viewer lease and safely retry an ambiguous in-flight input
  when Moor still retains that lease.
- Fail visibly rather than silently losing or duplicating input when exact
  lease continuity cannot be proved.
- End authority without sending a kill when an authenticated, generation-bound
  probe positively establishes holder absence.
- Preserve explicit operator retire, restart, kill-switch, shutdown handover,
  and observed holder-exit semantics.
- Bound timers, queued input, and all stale asynchronous callbacks.

## Non-goals

- Do not change Moor's wire format, lease deadlines, or keepalive cadence.
- Do not infer holder death from a timeout, permission failure, identity
  mismatch, generation mismatch, or any other indeterminate probe.
- Do not automatically restart or allocate a successor generation after link
  loss.
- Do not replay an ambiguously sent input under a new lease epoch.
- Do not deploy or restart the live Desk until the correction passes the
  required tests and independent reviews.

## Existing Moor guarantees used by the design

Moor already defines the safe reconnect protocol:

1. `HELLO` authenticates the exact session identity and generation and returns
   the holder incarnation.
2. A reconnecting viewer sends `LEASE_REQUEST(resume)` while authenticated but
   unattached, naming the retained epoch, holder incarnation, and token.
3. A successful resume rotates the token while preserving the lease epoch.
4. The resumed connection then sends `ATTACH` without asking for a fresh lease.
5. The holder sends the ordinary terminal preamble, attach acknowledgement, and
   replay baseline.
6. An exact retry of the same input epoch, request id, and bytes returns the
   cached/in-flight result without writing the PTY twice.

Desk's wire encoder and output-cursor constructor option already model parts of
this protocol. The production client does not yet expose the reconnect snapshot,
perform the resume-before-attach sequence, or feed a prior cursor back from
`SessionManager`.

## Architecture

### 1. `MoorMasterClient`: explicit reconnect state

Add an immutable reconnect snapshot copied from client state before teardown:

```ts
interface MoorReconnectSnapshot {
  output: { sequence: bigint; incarnation: Uint8Array };
  lease?: {
    epoch: number;
    incarnation: Uint8Array;
    token: Uint8Array;
    nextRequestId: bigint;
    pendingInput?: { requestId: bigint; bytes: Uint8Array };
  };
}
```

The output sequence is the maximum of the same-incarnation incoming resume
cursor and the watermark Desk actually delivered to its emulator. It never
advances merely because bytes reached the socket decoder. Byte arrays are
copied at the boundary.

`attach()` accepts an optional lease snapshot. After `HELLO_ACK`:

- a matching holder incarnation attempts `LEASE_REQUEST(resume)` before
  `ATTACH`;
- `LEASE_RESULT(resumed)` installs the rotated token and sends `ATTACH` with
  the fresh-lease bit clear;
- a refused resume or changed incarnation sends the ordinary `ATTACH` with a
  fresh viewer-lease request;
- a fresh grant creates a new lease epoch; a busy refusal produces an attached
  observer;
- no replay or input is released before the terminal-state preamble drains and
  the attach is generation/owner fenced.

On an exact lease resume, the client restores `nextRequestId` and the prior
pending input. After adoption completes it retries that pending tuple byte for
byte. On a fresh grant, changed incarnation, or observer result, it discards the
ambiguous prior pending request and reports that loss of proof to
`SessionManager`; it never reissues those bytes under a new epoch.

Suppressed replay records at or below the reconnect cursor are still fully
validated. Once observed, the client cumulatively acknowledges them even though
it does not deliver them again. This prevents a lost old acknowledgement from
pinning already-consumed retained output forever.

### 2. `SessionManager`: one recovery slot per generation

Replace the current link with an identity-bound recovery slot when the current
link closes unexpectedly. The slot stores:

- session id, exact generation, and the existing spawn/restore owner token;
- the newest immutable Moor reconnect snapshot;
- current geometry;
- a compact browser-input queue containing only bytes never sent to Moor;
- a monotonically increasing recovery episode and at most one unref'd timer;
- a latest resize to apply after viewer-lease acquisition.

The close callback first verifies that the closing link is still current, that
the owner token is unchanged, and that the core still has that exact live
generation. It then replaces only the link, deletes stale live-wire status,
marks holder liveness indeterminate, and starts recovery. It does not call
`beginRetire`, `retire`, `terminate`, the detached kill command, or generation
allocation.

Every asynchronous result is fenced by recovery-slot identity, episode, owner
token, generation, and live-session state. Explicit retirement deletes the
owner token and recovery slot before closing any link, so the resulting close
cannot start recovery. Daemon shutdown clears the master map before closing
links and likewise creates no recovery work.

### 3. Recovery state machine

Each episode performs a bounded authenticated probe:

- **authenticated-live:** attach the exact generation using the saved output
  cursor and lease snapshot. Publish the new link only after terminal preamble
  drain and `markRunning`. A successful resume retains input continuity. A
  fresh grant accepts only never-sent queued input. A busy result installs an
  observer and continues bounded fresh-lease attempts without reattaching or
  replaying the terminal baseline again.
- **positively absent:** clear the exact generation's link/status/kill record,
  record `confirmed-holder-absence` through the core, and let the existing
  issue-59 transition hook perform the final lifecycle-store drain. No
  terminate or kill command runs. A stale rendezvous node is left for the
  existing next-provision cleanup fence.
- **indeterminate:** preserve the runtime, holder, child, detached kill record,
  terminal screen, and event observer. Retry without destructive action.

Recovery attempts are immediate, then 100, 250, 500, 1,000, and at most 2,000
milliseconds apart. Attempts may continue indefinitely while evidence remains
indeterminate, because an elapsed timeout cannot prove death. The resource
bound is one small slot and one unref'd timer per live generation, not a maximum
duration after which Desk guesses.

An observed Moor lifecycle exit remains stronger than recovery. Once the core
has exited the generation, a pending or closing recovery episode only removes
its own link/timer state; it neither re-adopts nor rewrites provenance.

### 4. Input truth during recovery

Input must never disappear behind an apparently live terminal.

- Browser input not yet sent to Moor may queue while re-adoption is in flight.
  The queue is FIFO, at most 64 KiB total, and at most 10 seconds old, matching
  the browser reconnect bounds. The newest resize replaces the prior pending
  resize.
- Queue overflow, age expiry, a fresh lease replacing an ambiguous pending
  request, or permanent observer state sends the existing
  `BpError.STALE_LEASE` to each affected browser channel. No bytes are silently
  dropped or replayed into an unrelated lease.
- Control-plane input (reserved surface zero) is not deferred: the daemon
  control endpoint returns a typed non-ok result while no proven viewer lease
  can accept it.
- An already-sent pending request is retried only after exact same-incarnation,
  same-epoch lease resume. Never-sent queued input can be sent after either a
  resumed or fresh grant.

The manager/runtime send boundary therefore returns a small disposition rather
than optional chaining into a missing link. `TerminalWsRouter` maps a valid
channel with no accepted lease to `STALE_LEASE`; it continues using
`BAD_CHANNEL` only for an invalid channel.

### 5. Interaction with issue 58 and successor spawn

Recovery never calls `prepareSpawn` and never archives or mutates stable Moor
stores. Issue 58 remains exclusively on the successor-spawn path: after an
explicit or observed predecessor ending, the next durable generation archives
validated predecessor evidence before `moor start` performs its cleanup.

The two changes share `SessionManager` and `terminalDaemon` but have disjoint
state transitions. Integration order is issue 58 first, then issue 59, followed
by combined crash/reconnect tests.

## Failure handling

- Identity/generation/incarnation contradiction: indeterminate and retry; never
  adopt, retire, unlink, or kill.
- Resume refusal: fall back to fresh attach, but never retry the old ambiguous
  input under the new epoch.
- Fresh lease busy: remain an observer, continue output, refuse or boundedly
  queue input, and retry only the standalone fresh viewer-lease request.
- Replay cursor ahead of the authenticated incarnation high-water: fail that
  attach closed and retain recovery.
- Attach/preamble/emulator failure: close only that candidate connection and
  retain recovery.
- Positive `ENOENT`/`ECONNREFUSED` from the exact identity probe: confirmed
  absence, authority ends without kill.
- Close/error while an explicit retire is in progress: the missing owner token
  prevents recovery; the existing confirmed-kill path remains authoritative.
- Any queue-expiry notification failure is diagnostic but cannot authorize
  destructive session action.

## Test strategy

Strict RED-to-GREEN tests precede production edits.

1. Cross-component late-keepalive reproduction: granted lease, fake event-loop
   advance past expiry, Moor `LEASE_NOT_HELD`, connection close. Assert the
   holder/child remain, generation stays live/indeterminate, no retire and no
   kill command, then exact re-adoption succeeds.
2. Generic EOF and socket-error variants prove the same no-kill invariant.
3. Same-incarnation output cursor suppresses already-delivered replay, delivers
   each new record once, and cumulatively acknowledges the validated cursor.
4. Same-epoch viewer lease resume rotates the token, preserves the next request
   id, and retries one exact pending input without a second PTY write.
5. Changed incarnation, expired lease, bad token, and busy-owner cases prove
   that ambiguous sent input is not replayed and input failure is visible.
6. Browser input during recovery is FIFO/bounded/age-bounded; control input is
   immediately non-ok without a lease.
7. Positive absence ends exact-generation authority, records
   `confirmed-holder-absence`, drains late lifecycle evidence, and invokes no
   terminate/kill path.
8. Indeterminate probes retry with capped backoff and preserve every
   session/holder record.
9. Explicit operator retire/restart/kill-switch still terminate and confirm the
   exact generation; shutdown release/close still creates no recovery.
10. Late results from old episodes and an observed exit cannot mutate or attach
    a successor generation.
11. Existing issue-59 provenance, observer, event-feed, journal, compaction,
    daemon-control, and real-path suites remain green.

After focused tests and `npm run check`, run the single authorized full Node
22.23.1 suite, then fresh independent spec-compliance and code-quality reviews.
The live Desk update happens only from the reviewed integration commit. Before
the required controlled restart, capture the active-session inventory and
announce the restart; after restart, prove each surviving holder is re-adopted
at the same generation and run the late-keepalive manual witness.
