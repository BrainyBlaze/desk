import { describe, expect, it } from 'vitest';
import {
  SESSION_IDENTITY_STORAGE_MARKER,
  migrateBrowserSessionIdentity,
  migrateSessionIdentityStorage,
  type SessionIdentityStorage
} from '../src/web/sessionIdentityStorageMigration.js';

class MemoryStorage implements SessionIdentityStorage {
  readonly writes: Array<{ key: string; value?: string }> = [];
  readonly #values = new Map<string, string>();

  constructor(initial: Record<string, string>) {
    for (const [key, value] of Object.entries(initial)) {
      this.#values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
    this.writes.push({ key, value });
  }

  removeItem(key: string): void {
    this.#values.delete(key);
    this.writes.push({ key });
  }
}

class FailingStorage extends MemoryStorage {
  constructor(initial: Record<string, string>, private readonly failingKey: string) {
    super(initial);
  }

  override setItem(key: string, value: string): void {
    if (key === this.failingKey) {
      throw new Error('write failed');
    }
    super.setItem(key, value);
  }
}

describe('session identity storage migration', () => {
  it('migrates every persisted session reference and writes its marker last', () => {
    const storage = new MemoryStorage({
      'desk.activeSession': 'legacy-alpha',
      'desk.cellAssignments': JSON.stringify({
        group: {
          'legacy-alpha': 2,
          'session-beta': 1,
          orphan: 3
        }
      }),
      'desk.cellActiveSessions': JSON.stringify({
        group: {
          'group:cell-1': 'legacy-alpha',
          'group:cell-2': 'session-beta',
          'group:cell-3': 'orphan'
        }
      }),
      'desk.agentRecents': JSON.stringify(['legacy-alpha', 'session-beta', 'legacy-alpha', 'orphan'])
    });

    migrateSessionIdentityStorage(storage, {
      version: 1,
      mappings: [['legacy-alpha', 'session-alpha']],
      sessionIds: ['session-alpha', 'session-beta']
    });

    expect(storage.getItem('desk.activeSession')).toBe('session-alpha');
    expect(JSON.parse(storage.getItem('desk.cellAssignments') ?? 'null')).toEqual({
      group: {
        'session-alpha': 2,
        'session-beta': 1
      }
    });
    expect(JSON.parse(storage.getItem('desk.cellActiveSessions') ?? 'null')).toEqual({
      group: {
        'group:cell-1': 'session-alpha',
        'group:cell-2': 'session-beta'
      }
    });
    expect(JSON.parse(storage.getItem('desk.agentRecents') ?? 'null')).toEqual(['session-alpha', 'session-beta']);
    expect(storage.getItem(SESSION_IDENTITY_STORAGE_MARKER)).toBe('1');
    expect(storage.writes.at(-1)).toEqual({ key: SESSION_IDENTITY_STORAGE_MARKER, value: '1' });
  });

  it('does not touch storage after the migration marker exists', () => {
    const storage = new MemoryStorage({
      [SESSION_IDENTITY_STORAGE_MARKER]: '1',
      'desk.activeSession': 'session-alpha'
    });

    migrateSessionIdentityStorage(storage, {
      version: 1,
      mappings: [],
      sessionIds: ['session-alpha']
    });

    expect(storage.writes).toEqual([]);
  });

  it('fetches the committed identity map before migrating browser storage', async () => {
    const storage = new MemoryStorage({ 'desk.activeSession': 'legacy-alpha' });
    const requests: string[] = [];

    await migrateBrowserSessionIdentity(storage, async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          version: 1,
          mappings: [['legacy-alpha', 'session-alpha']],
          sessionIds: ['session-alpha']
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    expect(requests).toEqual(['/api/session-identity-map']);
    expect(storage.getItem('desk.activeSession')).toBe('session-alpha');
    expect(storage.getItem(SESSION_IDENTITY_STORAGE_MARKER)).toBe('1');
  });

  it('fails closed without writing when the endpoint payload is malformed', async () => {
    const storage = new MemoryStorage({ 'desk.activeSession': 'legacy-alpha' });

    await expect(
      migrateBrowserSessionIdentity(
        storage,
        async () => new Response(JSON.stringify({ version: 2, mappings: [], sessionIds: [] }), { status: 200 })
      )
    ).rejects.toThrow('invalid session identity map');

    expect(storage.getItem('desk.activeSession')).toBe('legacy-alpha');
    expect(storage.getItem(SESSION_IDENTITY_STORAGE_MARKER)).toBeNull();
    expect(storage.writes).toEqual([]);
  });

  it('keeps an already-migrated assignment when a legacy key resolves to the same session', () => {
    const storage = new MemoryStorage({
      'desk.cellAssignments': JSON.stringify({
        group: {
          'session-alpha': 9,
          'legacy-alpha': 2
        }
      })
    });

    migrateSessionIdentityStorage(storage, {
      version: 1,
      mappings: [['legacy-alpha', 'session-alpha']],
      sessionIds: ['session-alpha']
    });

    expect(JSON.parse(storage.getItem('desk.cellAssignments') ?? 'null')).toEqual({
      group: { 'session-alpha': 9 }
    });
  });

  it('leaves the marker absent and preserves the source value when a storage write fails', () => {
    const original = JSON.stringify({ group: { 'legacy-alpha': 2 } });
    const storage = new FailingStorage({ 'desk.cellAssignments': original }, 'desk.cellAssignments');

    expect(() =>
      migrateSessionIdentityStorage(storage, {
        version: 1,
        mappings: [['legacy-alpha', 'session-alpha']],
        sessionIds: ['session-alpha']
      })
    ).toThrow('write failed');

    expect(storage.getItem('desk.cellAssignments')).toBe(original);
    expect(storage.getItem(SESSION_IDENTITY_STORAGE_MARKER)).toBeNull();
  });
});
