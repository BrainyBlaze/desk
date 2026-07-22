import { describe, expect, it, vi } from 'vitest';
import { installDeskApi } from '../../src/server/vitePlugin.js';

describe('Desk API cutover gate', () => {
  it('fails before registering middleware when production migration fails', () => {
    const use = vi.fn();
    const failure = new Error('migration refused');

    expect(() => installDeskApi(
      { httpServer: null, middlewares: { use } },
      { runCutoverMigration: () => { throw failure; } }
    )).toThrow(failure);

    expect(use).not.toHaveBeenCalled();
  });
});
