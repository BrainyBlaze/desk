// desk#45 / desk#51: the session child's terminal identity and locale are
// COMPOSED by Desk, never left to inheritance. Both defects are invisible on a
// developer machine (where the operator's shell supplies both) and guaranteed
// under any daemonized deployment, which is exactly what the user-facing
// installer produces.

import { describe, expect, it } from 'vitest';
import {
  DESK_FALLBACK_LANG,
  DESK_SESSION_TERM,
  DESK_TERM_PROGRAM,
  sessionTerminalEnv
} from '../src/shared/sessionTerminalEnv.js';

describe('sessionTerminalEnv', () => {
  it('gives a daemonized child a complete terminal identity and a UTF-8 locale', () => {
    // The environment of a daemon started by systemd/docker/the installer.
    const composed = sessionTerminalEnv({ PATH: '/usr/bin', HOME: '/home/qa' });
    expect(composed).toEqual({
      TERM: DESK_SESSION_TERM,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: DESK_TERM_PROGRAM,
      TERM_PROGRAM_VERSION: '0',
      LC_TERMINAL: DESK_TERM_PROGRAM,
      LANG: DESK_FALLBACK_LANG
    });
  });

  it('never overrides what the operator already stated', () => {
    const inherited = {
      TERM: 'screen-256color',
      COLORTERM: '8bit',
      TERM_PROGRAM: 'iTerm.app',
      TERM_PROGRAM_VERSION: '3.5.0',
      LC_TERMINAL: 'iTerm2',
      LANG: 'de_DE.UTF-8'
    };
    expect(sessionTerminalEnv(inherited)).toEqual({});
  });

  it('sets TERM_PROGRAM and its version as one unit (moor spec §4.4.2)', () => {
    // The version follows the program variable, not itself: an inherited
    // version beside an absent program would make the child claim one
    // terminal at another terminal's version.
    const composed = sessionTerminalEnv({ TERM: 'xterm', TERM_PROGRAM_VERSION: '9.9.9', LANG: 'C' });
    expect(composed.TERM_PROGRAM).toBe(DESK_TERM_PROGRAM);
    expect(composed.TERM_PROGRAM_VERSION).toBe('0');
    expect(composed.TERM).toBeUndefined(); // inherited TERM is untouched
    expect(composed.LANG).toBeUndefined(); // a stated locale is untouched
  });

  it('treats the locale as a unit: any of LANG/LC_ALL/LC_CTYPE means hands off', () => {
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
      expect(sessionTerminalEnv({ [key]: 'en_US.ISO-8859-1' }).LANG).toBeUndefined();
    }
    // Only a host with no locale at all gets one — the case where readline
    // eats UTF-8 high bytes as Meta-keys and corrupts non-ASCII typing.
    expect(sessionTerminalEnv({}).LANG).toBe(DESK_FALLBACK_LANG);
  });

  it('treats an empty string as absent (a cleared variable is not a statement)', () => {
    expect(sessionTerminalEnv({ TERM: '', LANG: '' })).toMatchObject({
      TERM: DESK_SESSION_TERM,
      LANG: DESK_FALLBACK_LANG
    });
  });
});
