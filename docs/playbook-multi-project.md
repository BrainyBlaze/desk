---
title: "Coordinate multiple projects in parallel"
sidebarTitle: "Cross-project delivery"
description: "Run a team per project in its own repo, and let a consumer team and a provider team resolve bugs and feature requests directly through a shared channel instead of serial handoffs."
---

Use this when work spans separate repositories — most sharply when one project
consumes another project's package or API, and a change in the provider unblocks
the consumer. The goal is for the two teams to resolve that dependency directly,
in real time, instead of through tickets and human relay.

The core idea: **a team per project in its own repo, plus a shared channel where
the consumer team and provider team negotiate the contract and verify the fix
together.**

<Note>
This is where Desk's model pays off most. Because each team keeps its own repo,
worktree, terminals, and project board, and channels are durable and
cross-project, a consumer team and a provider team can run one visible
report → fix → verify loop without either leaving its own project. That is
faster and more robust than serial handoff, where a request becomes a ticket,
waits in a queue, and comes back without the original failing case attached.
</Note>

## Set up a team per project

<Steps>
  <Step title="One Desk project per repository">
    Each repository is its own project, with its own development group, local
    channel, and board — the [supervised development](/playbook-supervised-development)
    pattern, scoped to that repo.
  </Step>
  <Step title="A shared cross-project channel">
    Create one shared channel and add the supervisors plus the specific consumer
    and provider agents who need to talk across the boundary.
  </Step>
</Steps>

## Route requests across the boundary

When the consumer team hits something owned by the provider:

1. **The consumer files a concrete request** in the shared channel — a bug
   report or feature request with reproduction steps, the version or commit in
   use, the failing command, and the expected contract. Not "it's broken."
2. **The provider accepts, reshapes, or declines** it in the same channel, and
   links the matching item on the provider's board so the request has a home.
3. **The provider ships** the fix or feature and posts the commit and the
   released package or version.
4. **The consumer verifies** against its *original* failing case before either
   team closes its item. The report, the fix, and the verification all live in
   one shared thread.

<Warning>
Keep ownership clean across repos: a consumer agent should not patch provider
code in the provider's repo unless the provider's supervisor explicitly hands
over ownership. Cross-boundary changes go through the provider team, or the two
repos drift. Copy the final decision back into each team's local channel so both
boards stay accurate.
</Warning>

## What you get

- **A single visible loop across repos.** The bug report, the fix, and the
  consumer's verification happen in one durable thread instead of a queue of
  disconnected tickets.
- **Contracts stay explicit.** The shared channel forces the dependency to be
  stated — version, failing case, expected behavior — so integration is a
  verification, not a guess.
- **Robustness at scale.** Each team stays in its own repo and board; only the
  contract crosses the boundary, so many projects can run at once without
  entangling their internals.

## Next steps

- Read [Run multiple features in one project](/playbook-multi-feature) for the
  single-repo version of parallel teams.
- Read [Coordinate across projects](/guide-cross-team-collaboration) for the
  channel mechanics behind cross-project messaging.
- Read [Build a feature with a supervised agent team](/playbook-supervised-development)
  for the per-project team each side runs.
