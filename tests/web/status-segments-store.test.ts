import { describe, expect, it, vi } from 'vitest';
import { getStatusSegments, publishStatus, subscribeStatus } from '../../src/web/statusSegments';

describe('statusSegments store republish semantics', () => {
  it('notifies and swaps segments when only the onClick handler changed (same text/tone/hint)', () => {
    const scope = 'test-onclick-change';
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const notify = vi.fn();
    const unsub = subscribeStatus(notify);
    try {
      publishStatus(scope, [{ key: 'k', text: 'same', tone: 'ok', hint: 'h', onClick: fn1 }]);
      expect(getStatusSegments(scope)[0]!.onClick).toBe(fn1);
      notify.mockClear();

      // Same visible text/tone/hint, NEW handler — must NOT be deduped away.
      publishStatus(scope, [{ key: 'k', text: 'same', tone: 'ok', hint: 'h', onClick: fn2 }]);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(getStatusSegments(scope)[0]!.onClick).toBe(fn2);

      // Invoking the current segment's handler runs the NEW closure, not the stale one.
      getStatusSegments(scope)[0]!.onClick!();
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(fn1).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it('still dedups an identical republish (stable handler identity, no notify)', () => {
    const scope = 'test-dedup-identical';
    const onClick = vi.fn();
    publishStatus(scope, [{ key: 'k', text: 'same', tone: 'ok', hint: 'h', onClick }]);
    const notify = vi.fn();
    const unsub = subscribeStatus(notify);
    try {
      publishStatus(scope, [{ key: 'k', text: 'same', tone: 'ok', hint: 'h', onClick }]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});
