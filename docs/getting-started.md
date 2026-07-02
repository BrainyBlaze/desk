---
title: "Getting started"
description: "Install Desk, start the server, and launch your first agent session"
---

## Requirements

Desk requires:

- Node.js 20 or newer
- npm
- tmux
- git
- A C/C++ build toolchain for `node-pty`

Optional but commonly used tools:

- `gh` for GitHub repository, pull request, and Projects features
- Claude Code, OpenAI Codex, and/or OpenCode for managed agent sessions
- Language servers such as TypeScript Language Server or Pyright for LSP
  features

## Install from source

```bash
git clone https://github.com/BrainyBlaze/desk.git
cd desk
npm install
npm run build
npm link
```

The linked command exposes `desk` on your PATH.

## Start Desk

```bash
desk serve
```

By default the server binds to `127.0.0.1:5173`. Open that URL in a browser to
use the workspace.

## Authenticate external tools

Desk calls the agent and developer tools already installed on the host. If a
tool needs an account, sign in through that tool's normal flow:

```bash
codex
claude
opencode
gh auth login
```

For GitHub Projects, the GitHub CLI token needs the `project` scope:

```bash
gh auth refresh -s project
```

## Create sessions

Use the Add Session modal or edit the manifest directly. A session has:

- an id
- an agent type such as `codex`, `claude`, `opencode`, or `bash`
- a working directory
- optional resume metadata
- optional permission-bypass settings for supported agent CLIs

When a session starts, Desk creates or reuses a deterministic tmux session and
attaches the browser terminal through Desk's terminal broker.

## Bring a fleet up

Use the UI **Up** control or the CLI:

```bash
desk up
desk status
```

`desk up` starts missing sessions from the manifest. It does not replace
running sessions.
