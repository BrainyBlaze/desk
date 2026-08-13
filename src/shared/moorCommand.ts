// The moor child command for a session — ONE implementation shared by the
// server's native session control and the core runner lifecycle, so both
// sides quote through the single audited shellQuote (R6.1) and can never
// drift on the launch shape. Structural param on purpose: shared stays free
// of core type imports.

import { shellQuote } from './shell.js';

/**
 * Run the session's command in its cwd. A command-less session falls back
 * to the login shell. Matches
 * the proven canary form `sh -c bash`. The cwd is escaped through the single
 * audited quoter; the command is the session's own shell command, run as-is.
 */
export function moorCommandFor(spec: { command?: string; cwd?: string }): string[] {
  const command = (spec.command ?? '').trim();
  const cd = spec.cwd ? `cd ${shellQuote(spec.cwd)} || exit 1\n` : '';
  const run = command.length > 0 ? command : '"${SHELL:-bash}"';
  return ['sh', '-c', `${cd}${run}`];
}
