import type { DeskSessionView } from '../ui/model.js';

/**
 * Stable identity key for TerminalSurface's socket-lifecycle effect.
 *
 * The effect must re-run (clear the terminal, resubscribe the broker, repaint
 * the banner) ONLY when something it actually depends on changes — the session's
 * tmux target, its run state, or the name/cwd it prints. It must NOT re-run when
 * an unrelated mutation (booting a different session, a layout change, a reorder)
 * ships a fresh snapshot whose session objects have new identities but identical
 * content. Keying the effect on the session OBJECT did exactly that: every
 * mutation reflashed and resubscribed every mounted terminal, dropping local
 * scrollback/selection — the "flaky rendering" the pulse path already avoids via
 * identity preservation (see pulse.ts). This derives the same stability from the
 * concrete fields the effect reads.
 *
 * If the effect starts reading another `session` field, add it here.
 */

// NUL separator: cwd/name/tmuxSession can contain spaces, so a printable
// separator would let ["a b","c"] and ["a","b c"] collide. NUL cannot appear in
// any of them, so the joined key is unambiguous. A real key always carries 3
// separators, so the zero-separator "none" sentinel can never collide with one.
const SEP = String.fromCharCode(0);

export function terminalSessionKey(session: DeskSessionView | undefined): string {
  if (!session) {
    return 'none';
  }
  return [session.spec.tmuxSession, session.state, session.spec.name, session.spec.cwd].join(SEP);
}
