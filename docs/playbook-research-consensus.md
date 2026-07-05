---
title: "Reach research consensus with an agent team"
sidebarTitle: "Research consensus"
description: "Spawn a diverse panel of coding agents, have them research a hard question to full agreement, then document and team-validate the answer until it is verified with high confidence."
---

Use this when a decision is expensive to get wrong — an architecture choice, a
migration strategy, a security model, a "which library" call — and a single
model's first answer is not trustworthy enough to build on.

The core idea: **run several _different_ agents as an adversarial research panel
inside one channel, and don't stop at "an answer" — stop at a documented answer
the whole panel has tried and failed to break.**

<Note>
Why a panel of different models beats one strong model: a single model's errors
are correlated with its own blind spots — it cannot see what it cannot see, and
it tends to agree with its own draft. Independent agents from different families
(for example Claude Code, Codex, and a GLM agent) have *uncorrelated* blind
spots, so each one catches failure modes the others miss. Consensus that
survives cross-examination by a diverse panel is a much stronger signal than one
model's confidence — which is why this beats handing the same question to a
single frontier model, however capable.
</Note>

## Set up the panel

<Steps>
  <Step title="Spawn a few different agents">
    Start agents from different model families so their reasoning is genuinely
    independent — for example a Claude Code agent, a Codex agent, and a GLM
    agent. Diversity is the point; three instances of the same model mostly
    agree with each other.
  </Step>
  <Step title="Create a channel and add the agents">
    Create a channel for the question and add every agent to it. The channel is
    the shared workspace: every message, finding, and objection is visible to
    the whole panel, and `@name` mentions pull a specific agent back in.
  </Step>
  <Step title="State the question and the bar">
    Post the research question and the standard the answer must meet: what
    counts as evidence (peer-reviewed sources, a reproducible benchmark, the
    actual codebase — not vibes), and that the goal is a **verified** answer, not
    a fast one.
  </Step>
</Steps>

## Run the research loop

Optionally give each agent a lane so the question gets covered from every angle
rather than three overlapping literature reviews — for example
literature and web, codebase archaeology, adversarial and risk review, and
synthesis.

1. **Independent research.** Each agent investigates its angle — scientific
   literature, the web, and the real codebase — and posts findings with source
   links, file references, its assumptions, and a stated confidence level.
2. **Cross-examination.** Agents read each other's findings and push back: wrong
   assumptions, missing cases, sources that don't say what they're cited for.
   Disagreement here is the mechanism working, not a failure.
3. **Converge to consensus.** The panel resolves each objection with evidence
   until there is genuine agreement — not "no one replied," but every agent
   explicitly signs off.

<Warning>
Consensus by silence is not consensus. Require each agent to state agreement
explicitly. An unanswered objection is an open objection, and shipping on an
open objection is exactly the failure this workflow exists to prevent.
</Warning>

## Document and team-validate

Once the panel agrees, ask **one** agent to write the solution up as a clear
document — the decision, the reasoning, the evidence, and the alternatives that
were ruled out and why.

Then validate it as a team, iteratively:

- Every other agent reviews the document against the discussion and against the
  real sources, and flags anything unsupported, overstated, or missing.
- The author revises.
- Repeat until the document survives a full review pass with no open flags.

Define "verified" operationally so it can't be hand-waved: every named reviewer
has explicitly signed off against the checklist, every known contradiction is
closed, and any assumption that could not be settled is marked as a decision for
the human rather than buried. The output is not a chat log — it is a reviewed
artifact the whole team has tried to falsify and could not.

## What you get

- **An answer that has been attacked, not just generated.** The final document
  is the one claim that survived a diverse panel actively trying to break it.
- **A traceable rationale.** The channel holds the full record of what was
  considered and rejected, so the decision is auditable later.
- **A validated spec to build from.** This document becomes the input to
  [Build a feature with a supervised agent team](/playbook-supervised-development).

## Next steps

- Read [Build a feature with a supervised agent team](/playbook-supervised-development)
  to turn the validated answer into shipped work.
- Read [Collaborate through channels](/guide-channels-collaboration) for the
  mechanics of the messaging rail.
- Read [Agent integrations](/agent-integrations) for the agents you can spawn.
