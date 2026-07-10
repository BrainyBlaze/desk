import { describe, expect, it } from 'vitest';
import { shellQuote } from '../src/shared/shell';

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes with the \'\\\'\' idiom', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('renders shell metacharacters literally (no expansion)', () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote('`whoami`')).toBe("'`whoami`'");
    expect(shellQuote('a b; c && d | e')).toBe("'a b; c && d | e'");
  });

  it('handles the empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('is idempotent-safe for values that look like an injection break-out', () => {
    // A resume-id-style value trying to break out of a double-quoted context stays inert.
    expect(shellQuote('"; $(id) #')).toBe("'\"; $(id) #'");
  });
});
