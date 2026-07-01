import { describe, expect, it } from 'vitest';
import { getEditorRoot, publishEditorRoot, subscribeEditorRoot } from '../src/web/editorRoot.js';

describe('editorRoot store', () => {
  it('publishes the latest root and notifies subscribers', () => {
    let calls = 0;
    const unsubscribe = subscribeEditorRoot(() => {
      calls += 1;
    });
    publishEditorRoot('/tmp/a');
    expect(getEditorRoot()).toBe('/tmp/a');
    expect(calls).toBe(1);
    publishEditorRoot('/tmp/b');
    expect(getEditorRoot()).toBe('/tmp/b');
    expect(calls).toBe(2);
    unsubscribe();
  });

  it('ignores republishing the current root (no notification churn)', () => {
    publishEditorRoot('/tmp/same');
    let calls = 0;
    const unsubscribe = subscribeEditorRoot(() => {
      calls += 1;
    });
    publishEditorRoot('/tmp/same');
    expect(calls).toBe(0);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeEditorRoot(() => {
      calls += 1;
    });
    unsubscribe();
    publishEditorRoot('/tmp/after-unsub');
    expect(calls).toBe(0);
  });
});
