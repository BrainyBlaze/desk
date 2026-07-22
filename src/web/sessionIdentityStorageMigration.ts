export const SESSION_IDENTITY_STORAGE_MARKER = 'desk.sessionIdentityMigration.v1';

const ACTIVE_SESSION_KEY = 'desk.activeSession';
const CELL_ASSIGNMENTS_KEY = 'desk.cellAssignments';
const CELL_ACTIVE_SESSIONS_KEY = 'desk.cellActiveSessions';
const AGENT_RECENTS_KEY = 'desk.agentRecents';

export interface SessionIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionIdentityMapPayload {
  version: 1;
  mappings: Array<[string, string]>;
  sessionIds: string[];
}

export type SessionIdentityFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function migrateBrowserSessionIdentity(
  storage: SessionIdentityStorage = globalThis.localStorage,
  fetchImpl: SessionIdentityFetch = (input, init) => globalThis.fetch(input, init)
): Promise<void> {
  if (storage.getItem(SESSION_IDENTITY_STORAGE_MARKER) === '1') {
    return;
  }
  const response = await fetchImpl('/api/session-identity-map', {
    headers: { accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`session identity map request failed (${response.status})`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('invalid session identity map');
  }
  migrateSessionIdentityStorage(storage, parseSessionIdentityMap(payload));
}

export function parseSessionIdentityMap(value: unknown): SessionIdentityMapPayload {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.mappings) || !Array.isArray(value.sessionIds)) {
    throw new Error('invalid session identity map');
  }

  const legacyIds = new Set<string>();
  const mappings: Array<[string, string]> = [];
  for (const entry of value.mappings) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      typeof entry[1] !== 'string' ||
      entry[1].length === 0 ||
      legacyIds.has(entry[0])
    ) {
      throw new Error('invalid session identity map');
    }
    legacyIds.add(entry[0]);
    mappings.push([entry[0], entry[1]]);
  }

  const sessionIds: string[] = [];
  const seenSessionIds = new Set<string>();
  for (const sessionId of value.sessionIds) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || seenSessionIds.has(sessionId)) {
      throw new Error('invalid session identity map');
    }
    seenSessionIds.add(sessionId);
    sessionIds.push(sessionId);
  }
  return { version: 1, mappings, sessionIds };
}

export function migrateSessionIdentityStorage(
  storage: SessionIdentityStorage,
  payload: SessionIdentityMapPayload
): void {
  if (storage.getItem(SESSION_IDENTITY_STORAGE_MARKER) === '1') {
    return;
  }

  const currentSessionIds = new Set(payload.sessionIds);
  const legacyToSessionId = new Map(payload.mappings);
  const resolveIdentity = (value: string): string | undefined => {
    if (currentSessionIds.has(value)) {
      return value;
    }
    const mapped = legacyToSessionId.get(value);
    return mapped && currentSessionIds.has(mapped) ? mapped : undefined;
  };

  const activeSession = storage.getItem(ACTIVE_SESSION_KEY);
  if (activeSession !== null) {
    const migrated = resolveIdentity(activeSession);
    if (migrated) {
      storage.setItem(ACTIVE_SESSION_KEY, migrated);
    } else {
      storage.removeItem(ACTIVE_SESSION_KEY);
    }
  }

  migrateJsonStorage(storage, CELL_ASSIGNMENTS_KEY, (value) =>
    migrateNestedRecord(value, (sessions) => {
      const migrated: Record<string, unknown> = {};
      for (const [identity, assignment] of Object.entries(sessions)) {
        if (currentSessionIds.has(identity)) {
          migrated[identity] = assignment;
        }
      }
      for (const [identity, assignment] of Object.entries(sessions)) {
        if (currentSessionIds.has(identity)) {
          continue;
        }
        const sessionId = resolveIdentity(identity);
        if (sessionId && !Object.hasOwn(migrated, sessionId)) {
          migrated[sessionId] = assignment;
        }
      }
      return migrated;
    })
  );

  migrateJsonStorage(storage, CELL_ACTIVE_SESSIONS_KEY, (value) =>
    migrateNestedRecord(value, (cells) => {
      const migrated: Record<string, unknown> = {};
      for (const [cellId, identity] of Object.entries(cells)) {
        const sessionId = typeof identity === 'string' ? resolveIdentity(identity) : undefined;
        if (sessionId) {
          migrated[cellId] = sessionId;
        }
      }
      return migrated;
    })
  );

  migrateJsonStorage(storage, AGENT_RECENTS_KEY, (value) => {
    if (!Array.isArray(value)) {
      return [];
    }
    const migrated: string[] = [];
    const seen = new Set<string>();
    for (const identity of value) {
      const sessionId = typeof identity === 'string' ? resolveIdentity(identity) : undefined;
      if (sessionId && !seen.has(sessionId)) {
        seen.add(sessionId);
        migrated.push(sessionId);
      }
    }
    return migrated;
  });

  storage.setItem(SESSION_IDENTITY_STORAGE_MARKER, '1');
}

function migrateJsonStorage(
  storage: SessionIdentityStorage,
  key: string,
  migrate: (value: unknown) => unknown
): void {
  const raw = storage.getItem(key);
  if (raw === null) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(migrate(parsed)));
}

function migrateNestedRecord(
  value: unknown,
  migrateInner: (value: Record<string, unknown>) => Record<string, unknown>
): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }
  const migrated: Record<string, Record<string, unknown>> = {};
  for (const [outerKey, inner] of Object.entries(value)) {
    if (isRecord(inner)) {
      migrated[outerKey] = migrateInner(inner);
    }
  }
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
