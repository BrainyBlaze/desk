import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  lspStatusKey,
  setLspStatus,
  clearLspStatus,
  getLspStatus,
  subscribeLspStatus,
  resetLspStatusStore
} from '../src/web/editor/lsp/lspStatusStore.js';
import type { LspSessionStatus } from '../src/web/editor/lsp/statusSegment.js';

const ready: LspSessionStatus = { languageId: 'rust', phase: 'ready', serverName: 'rust-analyzer' };

describe('lspStatusStore', () => {
  beforeEach(() => resetLspStatusStore());

  it('returns undefined for an unknown key', () => {
    expect(getLspStatus(lspStatusKey('/repo', 'rust'))).toBeUndefined();
  });

  it('stores and reads a status by (workspaceRoot, languageId) key', () => {
    const key = lspStatusKey('/repo', 'rust');
    setLspStatus(key, ready);
    expect(getLspStatus(key)).toEqual(ready);
  });

  it('keys are collision-safe across path/language delimiters', () => {
    expect(lspStatusKey('/a', 'b/c')).not.toBe(lspStatusKey('/a/b', 'c'));
  });

  it('notifies subscribers on set and clear', () => {
    const listener = vi.fn();
    const off = subscribeLspStatus(listener);
    const key = lspStatusKey('/repo', 'rust');

    setLspStatus(key, ready);
    expect(listener).toHaveBeenCalledTimes(1);

    clearLspStatus(key);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getLspStatus(key)).toBeUndefined();

    off();
    setLspStatus(key, ready);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clearing an absent key does not notify', () => {
    const listener = vi.fn();
    subscribeLspStatus(listener);
    clearLspStatus(lspStatusKey('/repo', 'go'));
    expect(listener).not.toHaveBeenCalled();
  });
});
