import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireAndForget, toErrorMessage } from '../../src/web/asyncSafe';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toErrorMessage', () => {
  it('extracts Error.message and stringifies non-errors', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('plain')).toBe('plain');
    expect(toErrorMessage(42)).toBe('42');
  });
});

describe('fireAndForget', () => {
  it('logs a warning with the context and error when the promise rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fireAndForget(Promise.reject(new Error('nope')), 'save theme');
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('save theme');
    expect(warn.mock.calls[0]![0]).toContain('nope');
  });

  it('does not log and does not throw when the promise resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => fireAndForget(Promise.resolve(1), 'ok path')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });
});
