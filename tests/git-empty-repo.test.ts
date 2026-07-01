import { describe, expect, it } from 'vitest';
import { NO_COMMITS_STDERR } from '../src/server/gitApi';

// Real stderr captured from git 2.x against a freshly-inited repo (unborn
// HEAD) for each command shape desk runs — the wording differs per shape.
const UNBORN_HEAD_MESSAGES = [
  // git log --branches --remotes --tags HEAD (repo-wide history)
  "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:",
  // git log --follow HEAD -- file (per-file history)
  "fatal: bad revision 'HEAD'",
  // git diff -U0 HEAD -- file (gutter hunks)
  "fatal: bad revision 'HEAD'",
  // git log with implicit HEAD
  "fatal: your current branch 'master' does not have any commits yet",
  // older gits with implicit HEAD
  'fatal: bad default revision'
];

describe('NO_COMMITS_STDERR', () => {
  it('matches every unborn-HEAD spelling git produces', () => {
    for (const message of UNBORN_HEAD_MESSAGES) {
      expect(message).toMatch(NO_COMMITS_STDERR);
    }
  });

  it('does not swallow unrelated git failures', () => {
    expect('fatal: not a git repository (or any of the parent directories): .git').not.toMatch(NO_COMMITS_STDERR);
    expect('fatal: unable to access remote').not.toMatch(NO_COMMITS_STDERR);
    expect('error: pathspec did not match any file(s) known to git').not.toMatch(NO_COMMITS_STDERR);
  });
});
