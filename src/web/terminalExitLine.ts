import type { MoorExitOutcome } from '../shared/controlPlane/contract.js';

/**
 * Signal numbers that mean the same thing on every POSIX platform the holder
 * can run on (fixed by tradition since V7 and identical on Linux, macOS and
 * the BSDs). The browser cannot know the holder's OS, so any number outside
 * this set — 7, 10, 12 and the real-time range differ between Linux and the
 * BSD family — is printed as the number alone rather than a guessed name.
 */
const PORTABLE_SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM'
};

/**
 * The line a terminal surface prints when its session ends — one honest
 * sentence per moor ending. The tagged outcome arrives on the EXIT frame
 * exactly as moor reported it, and this is the only place it becomes text:
 * an `unknown` ending is stated as unknown, never rendered as a code, and a
 * signalled ending is never folded into 128+signal.
 */
export function describeSessionExit(outcome: MoorExitOutcome): string {
  switch (outcome.kind) {
    case 'exited':
      return `[session exited ${outcome.code}]`;
    case 'signalled': {
      const name = PORTABLE_SIGNAL_NAMES[outcome.signal];
      return name === undefined
        ? `[session signalled ${outcome.signal}]`
        : `[session signalled ${outcome.signal} (${name})]`;
    }
    case 'terminated':
      return `[session terminated (${outcome.method}) code ${outcome.code}]`;
    case 'unknown':
      return '[session ended: unknown]';
  }
}
