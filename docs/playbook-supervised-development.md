---
title: "Build a feature with a supervised agent team"
sidebarTitle: "Supervised development"
description: "Turn a validated spec into shipped work with a team of agents, one acting as supervisor who owns the GitHub Projects board, enforces the gates, and keeps lanes from colliding."
---

Use this once you have a spec worth building — ideally one that already survived
[research consensus](/playbook-research-consensus). The goal is to ship it with a
team of agents that move in parallel without stepping on each other, under a
supervisor who keeps quality and progress honest.

The core idea: **one agent supervises, the rest execute in separate lanes, and a
real project board plus explicit gates keep the work legible and the quality
enforceable.**

<Note>
Why a supervised team beats an autonomous loop: a single agent in a RALF or
goal-driven loop grades its own work and defines its own "done," so it drifts,
declares victory early, and games its own success criteria — nobody is checking.
A supervisor is an *external* checker: a different agent that owns the
definition of done, refuses work that games the gates, and holds the board as
the single source of truth. Add parallel lanes (many agents working at once
instead of one loop iterating) and diverse cross-review, and you get both higher
quality *and* higher throughput than a solo loop.
</Note>

## Set up the team

<Steps>
  <Step title="Create a group and spawn the agents">
    Create a group for the feature and spawn the agents that will build it.
    A group keeps the team's terminals together as one working unit.
  </Step>
  <Step title="Create a channel and introduce the goal">
    Create the team channel, add every agent, and post the goal: the validated
    spec, the definition of done, and the quality bar.
  </Step>
  <Step title="Assign the supervisor">
    Name one agent supervisor. The supervisor does not take a build lane —
    its job is to run the board and the gates (see below).
  </Step>
</Steps>

## The supervisor's job

The supervisor owns coordination so the builders can focus on building. It:

- **Owns the GitHub Projects board.** It drives the board through Desk's GitHub
  Projects UI — backed by `gh` and the GitHub GraphQL API (see
  [GitHub Projects](/github-projects)) — so the board, not the chat, is the
  authoritative state of the work. A workable column set:
  Spec approved → Worktree ready → Implementation → Tests → Review →
  Integration → Docs → Human review.
- **Enforces the gates.** Definition of done, anti-gaming checks, quality bars,
  and any feature-specific gates. Work that games a gate (green tests that don't
  test anything, a "done" card with no evidence) is bounced back.
- **Keeps the work moving and un-collided.** It confirms each builder has a
  distinct lane, unblocks stalls, and resolves overlap before two agents touch
  the same surface.

## The builders' job

The other agents pick their lanes and execute:

- Each agent claims a lane — a distinct slice of the work with no file overlap
  with another lane — and takes the matching card on the board.
- Agents do the work, then report progress to the supervisor and the team in the
  channel, with evidence (tests, output, a driven end-to-end check), not just
  "done."
- When lanes must touch the same code, they coordinate in the channel first
  rather than racing — one owner per contended surface.

<Warning>
The failure mode to avoid is two agents fixing the same thing at once. Lanes
plus a supervisor who watches for overlap are what prevent the thrash. When in
doubt, one agent owns a surface and the others stay out of it.
</Warning>

## Decide when to involve the human

Set the escalation cadence up front so the team knows when to pull you in:

- **Checkpoint mode** — the team pauses for your review after every milestone
  (a card reaching done, a gate passed). Higher oversight, best for
  high-stakes or early-trust work.
- **Autonomous mode** — the team runs to the goal on its own and only surfaces
  you on a blocker or when the feature is complete. Higher throughput, best once
  the gates and the supervisor have earned trust.

State which mode is in effect in the channel so every agent applies the same
rule. Useful escalation triggers even in autonomous mode: the spec is accepted,
the first end-to-end test goes green, a public API changes, anything touching
security or permissions, and a merge candidate is ready.

## What you get

- **Quality that is enforced, not self-declared.** An external supervisor and
  real gates catch the drift and gate-gaming that unsupervised loops cannot see
  in themselves.
- **Throughput from real parallelism.** Independent lanes advance at once
  instead of one loop iterating sequentially.
- **A legible project.** The board is the source of truth, so state, ownership,
  and progress are visible at a glance — to the agents and to you.

## Next steps

- Read [GitHub Projects](/github-projects) for the board the supervisor drives.
- Read [Run multiple features in one project](/playbook-multi-feature) to scale
  this to several features at once.
- Read [Review agent work with git](/guide-git-review) for verifying what the
  team produced.
