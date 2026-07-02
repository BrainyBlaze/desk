---
title: "GitHub Projects"
description: "GitHub Projects boards inside the workspace"
---

Desk includes a GitHub Projects v2 subsystem for planning and coordination
inside the same workspace as agents, code, terminals, and channels.

## Authentication

GitHub Projects uses the GitHub CLI. Authenticate first:

```bash
gh auth login
gh auth refresh -s project
```

## Project picker

Desk can list projects from the authenticated user and organizations visible to
that account. The project picker switches the active Projects workspace.

## Board view

The board view supports kanban-style project work:

- group cards by a single-select or iteration field
- drag cards between columns
- reorder cards within a column
- inspect and edit item metadata

## Table view

The table view provides a dense, sortable project list with inline field
editing for supported GitHub Project fields.

## Item drawer

Project items open in a drawer with:

- markdown body rendering
- editable fields
- comments
- close and reopen actions
- assign-me actions
- draft item editing and conversion
- archive and delete operations

## Filtering

The filter bar accepts GitHub-style filters such as:

```text
status:done -label:bug is:open no:iteration
```

Use filters to narrow large projects without leaving Desk.
