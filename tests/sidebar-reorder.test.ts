import { describe, expect, it } from 'vitest';
import { computeReorder, getReorderData, setReorderData, REORDER_MIME } from '../src/web/sidebarReorder.js';

class FakeDataTransfer {
  private store = new Map<string, string>();
  setData(type: string, data: string): void {
    this.store.set(type, data);
  }
  getData(type: string): string {
    return this.store.get(type) ?? '';
  }
}

describe('computeReorder', () => {
  it('moves a later item before an earlier target', () => {
    expect(computeReorder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves an earlier item before a later target', () => {
    expect(computeReorder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('returns the same reference (no-op) when dragged equals target', () => {
    const ids = ['a', 'b', 'c'];
    expect(computeReorder(ids, 'b', 'b')).toBe(ids);
  });

  it('returns the same reference when an id is missing', () => {
    const ids = ['a', 'b', 'c'];
    expect(computeReorder(ids, 'z', 'b')).toBe(ids);
    expect(computeReorder(ids, 'a', 'z')).toBe(ids);
  });
});

describe('reorder dataTransfer', () => {
  it('round-trips a payload through the dedicated MIME', () => {
    const dt = new FakeDataTransfer();
    setReorderData(dt, { kind: 'session', projectId: 'p', groupId: 'g', id: 's' });
    expect(dt.getData(REORDER_MIME)).toContain('session');
    expect(getReorderData(dt)).toEqual({ kind: 'session', projectId: 'p', groupId: 'g', id: 's' });
  });

  it('returns null for an absent or malformed payload', () => {
    expect(getReorderData(new FakeDataTransfer())).toBeNull();
    const bad = new FakeDataTransfer();
    bad.setData(REORDER_MIME, '{not json');
    expect(getReorderData(bad)).toBeNull();
    const wrongKind = new FakeDataTransfer();
    wrongKind.setData(REORDER_MIME, JSON.stringify({ kind: 'bogus', id: 'x' }));
    expect(getReorderData(wrongKind)).toBeNull();
  });
});
