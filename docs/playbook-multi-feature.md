---
title: "Run multiple features in one project"
sidebarTitle: "Parallel feature teams"
description: "Give each feature its own agent team in its own worktree, and coordinate them through one channel of supervisors so parallel work doesn't collide at integration."
---

Use this when one repository has several features that can move in parallel but
will eventually touch the same tree. The goal is real parallelism without a
merge-day pile-up — and without you becoming the message router between teams.

The core idea: **one team per feature, each isolated in its own worktree, with
only the supervisors meeting in a shared coordination channel.**

<Note>
This is the [supervised development](/playbook-supervised-development) pattern
repeated per feature, plus one coordination layer on top. The trick that makes
it scale is *isolation for the workers, a thin shared channel for the leads*:
workers never see each other's noise, and cross-feature risk is surfaced by
supervisors who summarize, not by every agent broadcasting every step.
</Note>

## Give each feature its own team and worktree

<Steps>
  <Step title="One group per feature">
    Create a group per feature — `feature-a`, `feature-b`, `feature-c` — each
    with its own agents and its own local channel for worker discussion.
  </Step>
  <Step title="One worktree per team">
    Put each team in its own git worktree so their working trees never overlap.
    Record the branch and worktree in the team channel's first message so
    ownership is unambiguous.
  </Step>
  <Step title="A supervisor per feature">
    Each team runs the supervised pattern internally: a supervisor owns that
    feature's board lane, gates, and lane assignments.
  </Step>
</Steps>

## Coordinate through one channel of supervisors

Create a single coordination channel — for example `repo-coordination` — and add
**only the feature supervisors**. This channel carries cross-feature signal, not
worker chatter:

- changed shared files and shared APIs,
- migration ordering,
- test debt and shared-suite breakage,
- release blockers and merge order.

<Warning>
Keep workers out of the coordination channel. If every agent posts every detail
there, it stops being a coordination channel and becomes noise. Supervisors
summarize their team's cross-feature impact; workers talk in their own feature
channel.
</Warning>

## Prevent the collisions before merge day

- **Shared modules get one owner.** If two features need the same module, name
  one team its owner; the other consumes it and requests changes rather than
  editing it.
- **Shared APIs get a provider and a consumer.** When two features touch the
  same interface, one team is the provider for that surface and the other the
  consumer, coordinated in the shared channel.
- **Integrate at planned windows, not at the end.** Run scheduled integration
  passes — rebase or merge rehearsal, the shared test suite, conflict review,
  and an agreed merge order — so conflicts surface early and small.

## What you get

- **Parallelism without a router.** Workers move locally in isolated worktrees;
  supervisors coordinate globally in one channel; you are not the switchboard.
- **Conflicts found at sync points, not at final merge.** Planned integration
  windows turn merge day from an event into a formality.

## Next steps

- Read [Build a feature with a supervised agent team](/playbook-supervised-development)
  for the per-feature team pattern this repeats.
- Read [Coordinate multiple projects in parallel](/playbook-multi-project) to
  extend this across separate repositories.
- Read [Configure multi-agent layouts](/guide-multi-agent-layouts) for arranging
  several teams on screen at once.
