// The terminal environment a Desk session child is entitled to (desk#45,
// desk#51). Desk composes it; it must never be left to inheritance.
//
// Under `desk serve` started from an operator's shell the child accidentally
// inherits that shell's terminal identity and locale. Under ANY daemonized
// deployment — a container, systemd, the installer's own launcher — there is
// nothing to inherit, and the child runs with no `TERM` and no locale:
//
//   - no `TERM`  → tput/curses refuse ("No value for $TERM"), readline falls
//     back to horizontal-scroll editing (desk#45);
//   - `LC_CTYPE=POSIX` → readline reads the high bytes of a UTF-8 sequence as
//     Meta-key commands, so typing any non-ASCII character corrupts the input
//     line and swallows the next one (desk#51).
//
// Both are invisible on a developer machine and guaranteed on the deployments
// the user-facing installer targets.
//
// The values are anchored to what the viewer actually is: the web terminal is
// xterm.js, so the child is told `xterm-256color` with 24-bit colour. The
// identity variables follow moor spec §4.4.2, which is why they are set as a
// PAIR: when `TERM_PROGRAM` is absent the holder asserts its own identity and
// then owns the version too (a child would otherwise claim one terminal at
// another terminal's version). Supplying the identity here also keeps §10
// capability arbitration honest — the holder stays silent on identity queries
// when the supervisor supplied the identity, so the environment is the single
// source of truth.
//
// Nothing already present is overwritten: an operator who set `TERM`,
// `TERM_PROGRAM` or any locale variable has stated an intent.

/** The terminfo entry matching the web viewer (xterm.js). */
export const DESK_SESSION_TERM = 'xterm-256color';
/** Desk's own terminal identity for §4.4.2's TERM_PROGRAM pair. */
export const DESK_TERM_PROGRAM = 'desk';
/** A UTF-8 locale every glibc (≥2.35) and musl host has. */
export const DESK_FALLBACK_LANG = 'C.UTF-8';

const LOCALE_VARS = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const;

/**
 * The terminal-identity and locale defaults for a session child, given the
 * environment it would otherwise inherit. Returns only the keys that need
 * adding, so callers can see exactly what Desk contributed.
 */
export function sessionTerminalEnv(
  inherited: NodeJS.ProcessEnv,
  options: { term?: string; termProgram?: string; termProgramVersion?: string } = {}
): NodeJS.ProcessEnv {
  const composed: NodeJS.ProcessEnv = {};
  const absent = (key: string): boolean => {
    const value = inherited[key];
    return value === undefined || value.length === 0;
  };

  if (absent('TERM')) {
    composed.TERM = options.term ?? DESK_SESSION_TERM;
  }
  if (absent('COLORTERM')) {
    composed.COLORTERM = 'truecolor';
  }
  // §4.4.2: the version follows the program variable, never itself. Set both
  // or neither — an implementation that gates each on its own presence
  // produces a child claiming one terminal at another terminal's version.
  if (absent('TERM_PROGRAM')) {
    composed.TERM_PROGRAM = options.termProgram ?? DESK_TERM_PROGRAM;
    composed.TERM_PROGRAM_VERSION = options.termProgramVersion ?? '0';
  }
  // §4.4.2: LC_TERMINAL is gated independently of that pair.
  if (absent('LC_TERMINAL')) {
    composed.LC_TERMINAL = options.termProgram ?? DESK_TERM_PROGRAM;
  }
  // A locale is a UNIT: if the host names any of the three, it has stated an
  // intent and Desk adds nothing. Only a host with no locale at all gets one.
  if (LOCALE_VARS.every((key) => absent(key))) {
    composed.LANG = DESK_FALLBACK_LANG;
  }
  return composed;
}
