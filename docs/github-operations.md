# Git and GitHub operations

Desk includes a Git subsystem for day-to-day repository work and GitHub-aware
operations. It uses the host `git` and `gh` commands rather than bundling its
own Git implementation.

## Repository discovery

Desk discovers repositories under the active editor root and presents a
searchable repository picker. Nested dependency directories and vendored roots
are skipped so the picker stays focused on working repositories.

## Changes

The Changes view supports:

- staged, unstaged, untracked, and conflicted files
- one-click stage and unstage
- discard operations with confirmation
- commit and amend
- pull, push, fetch, and publish
- ahead/behind indicators

## History

The History view shows a commit graph with branch, tag, and HEAD markers. Each
commit can expand to show changed files and open diffs.

## Branches and worktrees

Desk supports common branch and worktree operations:

- checkout local or remote branches
- delete branches
- open existing worktrees
- compare branches without changing the working tree

## Diffs

Diffs open in Monaco diff tabs. Desk supports worktree, index, and commit diff
modes so the operator can inspect changes before staging, committing, or
discarding.

## GitHub integration

When `gh` is authenticated, Desk can show GitHub repository and pull request
context for the current branch. Operations degrade gracefully when `gh` is not
available.
