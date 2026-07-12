import { describe, expect, it } from 'vitest';
import { reconcileInitialSetting } from '../src/web/initialSettingsReconcile.js';

describe('reconcileInitialSetting', () => {
  it('adopts the server value when the user did not edit during the request', () => {
    expect(reconcileInitialSetting('server', 'cached', false)).toEqual({
      value: 'server',
      adoptServer: true,
      persistCurrent: false
    });
  });

  it('keeps and persists the current value after any user edit during the request', () => {
    expect(reconcileInitialSetting('stale-server', 'user-choice', true)).toEqual({
      value: 'user-choice',
      adoptServer: false,
      persistCurrent: true
    });
  });

  it('keeps the current value without persisting when the server omitted the setting', () => {
    expect(reconcileInitialSetting(undefined, 'cached', false)).toEqual({
      value: 'cached',
      adoptServer: false,
      persistCurrent: false
    });
  });
});
