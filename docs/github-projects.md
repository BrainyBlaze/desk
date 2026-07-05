---
title: "GitHub Projects"
description: "Work with GitHub Projects v2 boards, tables, fields, drafts, status updates, and project items from Desk."
---

Desk includes a GitHub Projects v2 subsystem for planning work beside agents, terminals, code, Git, notes, and channels.

<Frame caption="A GitHub Projects board in Desk: project metadata, status updates, saved views, filters, grouped cards, and the active work items">
  <img src="/images/projects-board.png" alt="GitHub Projects board in Desk with project status updates, saved views, filters, grouped columns, and work-item cards" />
</Frame>

The subsystem uses the GitHub CLI:

- `gh api graphql` for Projects v2 queries and mutations
- `gh issue` and `gh pr` for issue and pull request operations

Desk does not store a separate GitHub token.

## Authentication

Authenticate the GitHub CLI first:

```bash
gh auth login
```

Projects v2 requires the `project` scope:

```bash
gh auth refresh -s project
```

When the token is missing that scope, Desk returns a scope-specific error and the UI can prompt you to refresh auth.

## Project picker

Desk lists projects visible to the authenticated account:

- viewer-owned projects
- organization projects visible to the viewer

The active project determines the board, table, fields, views, and item drawer content.

## Loading limits

Desk pages through project items and caps a board at 1000 items. If a project is truncated, the UI shows a truncated state so you know the board is not complete.

Use filters, saved views, or GitHub itself for very large project audits.

## Board view

The board groups items by a single-select or iteration field.

You can:

- switch the group-by field
- drag cards between columns
- reorder cards within a column
- show or hide archived items
- open an item drawer
- use saved GitHub view chips when the project exposes them

For iteration fields, Desk includes the active iteration and recent completed iterations.

## Table view

The table view gives a dense list with sortable columns and inline field editing.

<Frame caption="The table layout: project fields, owners, iterations, confidence values, and item status in one dense view">
  <img src="/images/projects-table.png" alt="GitHub Projects table view in Desk showing status, priority, iteration, owner, confidence, and due-date fields" />
</Frame>

Supported field edits include:

- text
- number
- date
- single-select
- iteration
- clearing a field value

Desk sends field changes through GitHub Projects GraphQL mutations.

## Filters

The filter bar supports free text and structured filters:

```text
status:done -label:bug is:open no:iteration "release blocker"
```

Supported patterns include:

- `is:issue`, `is:pr`, `is:draft`
- `is:open`, `is:closed`, `is:merged`, `is:archived`
- `assignee:<login>`
- `label:<label>`
- `repo:<owner/name>`
- `no:<field>`
- any project field by name
- negation with `-`
- quoted values

## Item drawer

Open an item to inspect and update its details.

<Frame caption="An item drawer with editable fields, rendered markdown, comments, and issue actions">
  <img src="/images/projects-item-drawer.png" alt="GitHub Projects item drawer in Desk with editable fields, a rendered definition of done, anti-gaming gate notes, comments, and issue actions" />
</Frame>

The drawer supports:

- rendered markdown body
- editable project fields
- comments
- assign-me
- close and reopen for issues and pull requests
- draft item editing
- draft-to-issue conversion
- archive and unarchive
- delete item

## Adding items

You can add an item by URL when GitHub can resolve it to an issue, pull request, or draft-compatible content.

<Frame caption="Add an issue, pull request, or draft title without leaving the Projects surface">
  <img src="/images/projects-add-item.png" alt="Add item modal in Desk Projects with an input for an issue URL, pull-request URL, or draft title" />
</Frame>

You can also create draft items directly in the project and later convert them to issues.

## Status updates

Desk supports project status updates, including create and delete operations. Status updates carry a health value such as on track, at risk, or off track, plus rendered body content.

<Frame caption="Post project health updates from the same sidebar that shows the current status history">
  <img src="/images/projects-status-update.png" alt="Post status update modal in Desk Projects with a health selector and markdown body field" />
</Frame>

## Project operations

When authorized, Desk can:

- create a project
- edit project metadata
- link a repository to a project

These operations use GitHub's Projects v2 GraphQL API and respect the authenticated account's permissions.

## Next steps

- Read [Git and GitHub operations](/github-operations) for repository, branch,
  worktree, diff, and pull-request context.
- Use [Troubleshooting and FAQ](/troubleshooting) if `gh` lacks the required
  project scope.
- Use [Channels](/channels) when project-board work needs agent discussion.
