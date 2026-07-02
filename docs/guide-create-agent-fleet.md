---
title: "Create an agent fleet"
description: "Configure projects, groups, sessions, layouts, permissions, and startup behavior for a multi-agent Desk workspace."
---

This guide builds a practical multi-agent workspace around one repository. Use
it after you have completed [Getting started](/getting-started).

## Goal

You will create:

- one project
- two groups
- Codex, Claude, OpenCode, Bash, and custom-command sessions
- a predictable layout
- a dry-run startup check

## 1. Open the manifest

Find the active manifest:

```bash
desk config
```

Open the printed `desk.yml` path in your editor.

## 2. Define a project

Use a stable project id and an absolute or home-relative cwd:

```yaml
projects:
  - id: product
    label: Product
    cwd: ~/projects/product
    groups:
      - id: main
        label: Main
        layout:
          kind: 2x2
        sessions: []
```

Desk expands `~` against the server user's home directory.

## 3. Add managed agents

Add sessions for the agents you have authenticated:

```yaml
sessions:
  - name: planner-codex
    agent: codex
    cwd: ~/projects/product
    bypassPermissions: true
  - name: implementer-claude
    agent: claude
    cwd: ~/projects/product
    bypassPermissions: true
  - name: reviewer-opencode
    agent: opencode
    cwd: ~/projects/product
    bypassPermissions: true
```

Use `bypassPermissions: false` when you want the agent CLI to ask before tools
run. For OpenCode, Desk maps that checkbox to per-session OpenCode permission
configuration.

## 4. Add support terminals

Use Bash for manual work and custom commands for long-running tools:

```yaml
  - name: shell
    agent: bash
    cwd: ~/projects/product
  - name: dev-server
    cwd: ~/projects/product
    command: npm run dev
```

Custom command sessions do not get managed-agent resume or permission behavior.

## 5. Add a second group

Groups let you switch between work modes without losing running sessions:

```yaml
      - id: review
        label: Review
        layout:
          kind: 2x2
        sessions:
          - name: review-codex
            agent: codex
            cwd: ~/projects/product
            bypassPermissions: false
          - name: review-shell
            agent: bash
            cwd: ~/projects/product
```

## 6. Dry-run and start

Check what Desk will start:

```bash
desk up --dry-run
```

Start missing sessions:

```bash
desk up
desk status
```

Expected result:

- every configured session has a matching tmux session
- the browser shows the project and groups
- managed agents start with Desk event hooks
- Bash and custom commands run in their configured cwd

## 7. Operate the fleet

Use the UI for daily work:

- switch groups from the agents sidebar
- drag sessions into cells
- use the command palette for session navigation
- restart a session when an agent CLI exits
- use [Channels](/channels) to coordinate agents through messages
- use [Operations](/operations) to inspect terminal health and attention events

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Session does not start | `cwd` is missing or invalid | Set `cwd` on the session or project |
| Agent starts in the wrong repo | Inherited project cwd is not what you expected | Set an explicit session `cwd` |
| OpenCode prompts even with bypass checked | Existing pane was started before the current config | Restart that session |
| `desk add` rejects a new agent session | CLI path requires `--resume` for managed agents | Use the UI Add Session modal or edit `desk.yml` directly |

## Next steps

- Use [Collaborate through channels](/guide-channels-collaboration) to turn the
  fleet into a shared room workflow.
- Use [Troubleshooting and FAQ](/troubleshooting) if sessions do not appear or
  agents do not emit attention events.
