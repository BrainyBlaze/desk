---
title: "Configuration"
description: "The desk.yml manifest, per-session options, layouts, and persisted settings."
---

Desk's source of truth is a YAML manifest. The default path is:

```text
~/.config/desk/desk.yml
```

Most UI actions that create, edit, reorder, resize, or delete workspace objects write back to this file atomically.

Use a different manifest with `--file`:

```bash
desk --file ./desk.yml status
```

## Top-level shape

The manifest has three top-level blocks:

- `groups`: root-level agent groups that are not tied to a project
- `projects`: named work roots with their own groups and sessions
- `settings`: UI and subsystem state

```yaml
groups:
  - id: scratch
    label: Scratch
    order: 20
    layout:
      kind: linear
      cells: 2
    sessions:
      - name: scratch-shell
        agent: bash
        cwd: ~/projects/product

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
  muted: false
  editor:
    root: ~/projects/product
    autosave: after-delay
    autosaveDelayMs: 1000
  lsp:
    enabled: true
    disabledLanguages: []
    agents:
      enabled: true
  tmux:
    statusLine: off
```

## Projects

Projects give Desk named working roots. Project-scoped sessions inherit `project.cwd` unless the session overrides `cwd`.

```yaml
projects:
  - id: desk
    label: Desk
    cwd: ~/projects/desk
    order: 10
    groups:
      - id: main
        label: Main
        sessions:
          - name: desk-codex
            agent: codex
```

The editor, Git, GitHub, Projects, notes links, terminal context actions, and channel file links can all jump through these roots.

## Groups and layouts

Groups organize sessions in the agents multiplexer.

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

Supported layout kinds:

- `1x1`
- `2x2`
- `3x3`
- `4x4`
- `linear`
- `custom`

`linear` and `custom` use `cells` from 1 to 16.

Desk also persists split sizes when you drag-resize cells:

```yaml
layout:
  kind: custom
  cells: 4
  sizes:
    rows: [55, 45]
    cols:
      - [50, 50]
      - [35, 65]
```

The UI writes `order` on projects, groups, and sessions when you drag-reorder the tree.

## Sessions

A session needs a `name` and either a built-in `agent` or a custom `command`.

```yaml
- name: api-codex
  agent: codex
  cwd: ~/projects/product
  bypassPermissions: true
```

Built-in agent values:

- `codex`
- `claude`
- `opencode`
- `bash`

For project sessions, `cwd` is optional because the project root is inherited. Root-level groups need `cwd` unless the session uses a command that handles its own directory.

### UI mode

`uiMode` selects how a session renders: `native` (the agent chat surface) or
`terminal` (the CLI's own TUI in a terminal cell). Codex, Claude, and OpenCode
sessions resolve to `native` when the field is omitted; write
`uiMode: terminal` to keep a session on the raw TUI. Bash and custom-command
sessions are always terminal — declaring `uiMode: native` on them is a
manifest error.

```yaml
- name: api-codex
  agent: codex
  cwd: ~/projects/product

- name: raw-tui
  agent: claude
  cwd: ~/projects/product
  uiMode: terminal
```

The session edit modal switches a live session between modes; the switch
restarts the agent process and carries the captured resume id across, so the
conversation continues in the other surface. A session with no captured resume
id asks for confirmation first, because switching starts it fresh.

### Resume metadata

`resume` is optional in YAML. Omit it to let Desk start a fresh conversation and capture a resume id when the agent CLI exposes one.

```yaml
- name: api-codex
  agent: codex
  cwd: ~/projects/product
  resume: 00000000-0000-0000-0000-000000000000
```

Desk validates known resume id formats before persisting them. Codex and Claude use UUID-like ids. OpenCode uses `ses_...` ids.

When Desk captures a fresh resume id, it also pins the current `tmuxSession` in the manifest so the running pane is not orphaned by a later deterministic-name change.

### Permission bypass

`bypassPermissions` controls supported agent CLIs:

```yaml
- name: main-opencode
  agent: opencode
  bypassPermissions: false
```

For Codex and Claude, Desk passes the agent's dangerous bypass flag when enabled. For OpenCode, Desk sets per-session `OPENCODE_CONFIG_CONTENT` so `permission["*"]` is `allow` when enabled and `ask` when disabled.

### Custom commands

Custom commands bypass built-in agent launch logic.

```yaml
- name: server
  cwd: ~/projects/product
  command: npm run dev
```

Desk still runs the command inside tmux and exposes it through the terminal broker, but it does not provide agent-specific resume, bypass, or attention hooks unless the command emits compatible terminal notifications.

## Settings

Settings cover UI state and subsystem configuration:

```yaml
settings:
  theme: cyan-night
  muted: false
  editor:
    root: ~/projects/product
    openFiles: []
    activeFile: ~/projects/product/src/index.ts
    autosave: after-delay
    autosaveDelayMs: 1000
  notes:
    openFiles: []
    activeFile: ~/.config/desk/notes/idea.md
  lsp:
    enabled: true
    disabledLanguages: []
    agents:
      enabled: true
    maxSessions: 4
    startupTimeoutMs: 5000
  sidebars:
    agents: 280
    editor: 320
    git: 320
    notes: 300
    projects: 360
    channels: 360
  tmux:
    statusLine: off
```

### Editor settings

`settings.editor.root` is the active workspace root for the editor and Git subsystems.

Autosave modes:

- `off`: save with keyboard or UI commands
- `after-delay`: save after `autosaveDelayMs`
- `on-focus-change`: save when editor focus leaves the file

`autosaveDelayMs` is clamped by the server to a safe range.

### Notes settings

Notes always live in `~/.config/desk/notes`. The notes settings block stores open files and the active note; it does not change the notes root.

### LSP settings

LSP support is default-off. Enable it explicitly:

```yaml
settings:
  lsp:
    enabled: true
    disabledLanguages:
      - rust
    agents:
      enabled: true
```

Desk detects languages under the active editor root. `disabledLanguages` is the normal user control for turning off a detected language.

Advanced fields such as `serverCommands`, `maxSessions`, and `startupTimeoutMs` override the built-in language server behavior. See [IDE and LSP](/ide-and-lsp) and [Agent integrations](/agent-integrations) before changing them.

### tmux settings

```yaml
settings:
  tmux:
    statusLine: off
```

`statusLine: off` makes Desk set `tmux status off` on managed sessions. YAML's bare `off` may parse as boolean `false`; Desk accepts both forms.

## Atomic writes

Desk writes manifest updates through a temporary file and rename. If you edit the manifest by hand while the UI is open, refresh the UI after saving so later UI edits do not overwrite your manual change.

## Next steps

- Read [Workspace model](/concepts-workspace-model) for the mental model behind
  projects, groups, sessions, and tmux names.
- Build a larger manifest with [Create an agent fleet](/guide-create-agent-fleet).
- Use [Troubleshooting and FAQ](/troubleshooting) if a configured session does
  not appear or start.
