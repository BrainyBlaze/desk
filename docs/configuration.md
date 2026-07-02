---
title: "Configuration"
description: "The desk.yml manifest, per-session options, and server settings"
---

Desk's source of truth is a YAML manifest, normally stored at:

```text
~/.config/desk/desk.yml
```

Any command can use a different manifest with `--file path/to/desk.yml`.

## Top-level shape

The manifest has three top-level blocks:

- `groups`: root-level groups that are not tied to a named project
- `projects`: project-scoped groups that inherit the project's working directory
- `settings`: UI and subsystem settings

```yaml
projects:
  - id: product
    label: Product
    cwd: ~/projects/product
    order: 10
    groups:
      - id: main
        label: Main
        order: 10
        layout:
          kind: 2x2
        sessions:
          - name: main-codex
            agent: codex
            bypassPermissions: true
          - name: main-claude
            agent: claude
          - name: main-opencode
            agent: opencode

settings:
  theme: cyan-night
  editor:
    root: ~/projects/product
    autosave: after-delay
    autosaveDelayMs: 1000
  lsp:
    enabled: true
    disabledLanguages: []
    agents:
      enabled: true
  sidebars:
    agents: 280
    editor: 320
  tmux:
    statusLine: off
```

## Groups

Groups define how sessions are organized in the agent multiplexer.

```yaml
groups:
  - id: backend
    label: Backend
    order: 30
    layout:
      kind: custom
      cells: 6
    sessions:
      - name: api-codex
        agent: codex
        cwd: ~/projects/product
      - name: api-shell
        agent: bash
        cwd: ~/projects/product
```

Supported layout kinds are `1x1`, `2x2`, `3x3`, `4x4`, `linear`, and
`custom`. `linear` and `custom` layouts use `cells`, from 1 to 16, to decide
how many terminal cells the group should show.

## Sessions

Sessions are objects inside a group's `sessions` array. Every session needs a
`name`. A session also needs either:

- a supported `agent`, plus a working directory inherited from its project or
  set directly on the session with `cwd`
- or a custom `command`

```yaml
- name: api-codex
  agent: codex
  cwd: ~/projects/product
  bypassPermissions: true
```

Supported built-in agent values include:

- `codex`
- `claude`
- `opencode`
- `bash`

`resume` is optional. Omit it to let Desk start a fresh conversation and
capture a new conversation id when the agent CLI exposes one. Set it only when
you have a real agent conversation id to resume:

```yaml
- name: api-codex
  agent: codex
  cwd: ~/projects/product
  resume: 00000000-0000-0000-0000-000000000000
```

Custom commands use `command`:

```yaml
- name: server
  cwd: ~/projects/product
  command: npm run dev
```

## Projects

Projects give Desk named roots for the editor, git, GitHub, notes, and agent
working directories. Project-scoped sessions inherit `project.cwd` unless a
session overrides `cwd`.

```yaml
projects:
  - id: desk
    label: Desk
    cwd: ~/projects/desk
    groups:
      - id: main
        sessions:
          - name: desk-codex
            agent: codex
```

The UI can switch roots and open files from links, git diffs, terminal context,
or channel messages.

## Settings

Settings cover UI state and subsystem configuration:

```yaml
settings:
  theme: cyan-night
  muted: false
  editor:
    root: ~/projects/product
    autosave: after-delay
    autosaveDelayMs: 1000
  notes:
    openFiles: []
  lsp:
    enabled: true
    disabledLanguages: []
    agents:
      enabled: true
  sidebars:
    agents: 280
    editor: 320
    git: 320
    notes: 300
  tmux:
    statusLine: off
```

`lsp.enabled` controls language-server support in the editor. `lsp.agents`
controls whether managed agents receive Desk's MCP surface for language-server
features.

Desk writes manifest updates atomically so manual edits and UI edits remain
recoverable.
