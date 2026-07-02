---
title: "GitHub Projects"
description: "Work with GitHub Projects v2 boards, tables, fields, drafts, status updates, and project items from Desk."
---

Desk includes a GitHub Projects v2 subsystem for planning work beside agents, terminals, code, Git, notes, and channels.

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

You can also create draft items directly in the project and later convert them to issues.

## Status updates

Desk supports project status updates, including create and delete operations. Status updates carry a health value such as on track, at risk, or off track, plus rendered body content.

## Project operations

When authorized, Desk can:

- create a project
- edit project metadata
- link a repository to a project

These operations use GitHub's Projects v2 GraphQL API and respect the authenticated account's permissions.
