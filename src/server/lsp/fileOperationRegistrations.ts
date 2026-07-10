export type FileOperationRegistrationAction = 'register' | 'unregister' | 'clear';

export type FileOperationMethod =
  | 'workspace/didCreateFiles'
  | 'workspace/didRenameFiles'
  | 'workspace/didDeleteFiles'
  | 'workspace/willCreateFiles'
  | 'workspace/willRenameFiles'
  | 'workspace/willDeleteFiles';

export type FileOperationCapabilityKey =
  | 'didCreate'
  | 'didRename'
  | 'didDelete'
  | 'willCreate'
  | 'willRename'
  | 'willDelete';

export interface FileOperationFilter {
  scheme?: 'file';
  pattern: {
    glob: string;
    matches?: 'file' | 'folder';
    options?: { ignoreCase?: true };
  };
}

export interface FileOperationRegistration {
  id: string;
  method: FileOperationMethod;
  filters: FileOperationFilter[];
}

export interface FileOperationRegistrationEvent {
  sessionId: string;
  action: FileOperationRegistrationAction;
  registrations: FileOperationRegistration[];
}

export type FileOperationRegistrationRequest =
  | { handled: false }
  | {
      handled: true;
      action: Exclude<FileOperationRegistrationAction, 'clear'>;
      registrations: FileOperationRegistration[];
    };

const METHOD_TO_CAPABILITY: Record<FileOperationMethod, FileOperationCapabilityKey> = {
  'workspace/didCreateFiles': 'didCreate',
  'workspace/didRenameFiles': 'didRename',
  'workspace/didDeleteFiles': 'didDelete',
  'workspace/willCreateFiles': 'willCreate',
  'workspace/willRenameFiles': 'willRename',
  'workspace/willDeleteFiles': 'willDelete'
};

const CAPABILITY_KEYS: FileOperationCapabilityKey[] = [
  'didCreate',
  'didRename',
  'didDelete',
  'willCreate',
  'willRename',
  'willDelete'
];

export function fileOperationCapabilityKey(method: FileOperationMethod): FileOperationCapabilityKey {
  return METHOD_TO_CAPABILITY[method];
}

export function parseFileOperationRegistrationRequest(
  method: string,
  params: unknown
): FileOperationRegistrationRequest {
  if (method === 'client/registerCapability') {
    const registrations = readRegistrationArray(params, 'registrations');
    if (!registrations || !registrations.every((registration) => isSupportedMethod(registration.method))) {
      return { handled: false };
    }
    return {
      handled: true,
      action: 'register',
      registrations: registrations.map(sanitizeRegistration).filter((value): value is FileOperationRegistration => Boolean(value))
    };
  }

  if (method === 'client/unregisterCapability') {
    const unregisterations = readRegistrationArray(params, 'unregisterations');
    if (!unregisterations || !unregisterations.every((registration) => isSupportedMethod(registration.method))) {
      return { handled: false };
    }
    return {
      handled: true,
      action: 'unregister',
      registrations: unregisterations
        .map(sanitizeUnregistration)
        .filter((value): value is FileOperationRegistration => Boolean(value))
    };
  }

  return { handled: false };
}

export function mergeFileOperationCapabilities(
  staticCapabilities: Record<string, unknown>,
  dynamicRegistrations: Iterable<FileOperationRegistration>
): Record<string, unknown> {
  const mergedFilters = new Map<FileOperationCapabilityKey, unknown[]>();
  const staticFileOperations = asRecord(asRecord(staticCapabilities.workspace)?.fileOperations);
  for (const key of CAPABILITY_KEYS) {
    const filters = asRecord(staticFileOperations?.[key])?.filters;
    if (Array.isArray(filters) && filters.length > 0) {
      mergedFilters.set(key, [...filters]);
    }
  }
  for (const registration of dynamicRegistrations) {
    const key = fileOperationCapabilityKey(registration.method);
    const filters = mergedFilters.get(key) ?? [];
    filters.push(...registration.filters.map(toEffectiveFilter));
    mergedFilters.set(key, filters);
  }

  if (mergedFilters.size === 0) {
    return staticCapabilities;
  }

  const workspace = asRecord(staticCapabilities.workspace);
  const fileOperations: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    const filters = mergedFilters.get(key);
    if (filters && filters.length > 0) {
      fileOperations[key] = { filters };
    }
  }

  return {
    ...staticCapabilities,
    workspace: {
      ...(workspace ?? {}),
      fileOperations
    }
  };
}

function readRegistrationArray(params: unknown, key: 'registrations' | 'unregisterations'): Record<string, unknown>[] | undefined {
  const value = asRecord(params)?.[key];
  return Array.isArray(value) && value.every(isRecord) ? value : undefined;
}

function sanitizeRegistration(registration: Record<string, unknown>): FileOperationRegistration | undefined {
  if (typeof registration.id !== 'string' || !isSupportedMethod(registration.method)) {
    return undefined;
  }
  const filters = asRecord(registration.registerOptions)?.filters;
  if (!Array.isArray(filters)) {
    return undefined;
  }
  const sanitized = filters.map(sanitizeFilter).filter((filter): filter is FileOperationFilter => Boolean(filter));
  if (sanitized.length === 0) {
    return undefined;
  }
  return { id: registration.id, method: registration.method, filters: sanitized };
}

function sanitizeUnregistration(registration: Record<string, unknown>): FileOperationRegistration | undefined {
  if (typeof registration.id !== 'string' || !isSupportedMethod(registration.method)) {
    return undefined;
  }
  return { id: registration.id, method: registration.method, filters: [] };
}

function sanitizeFilter(value: unknown): FileOperationFilter | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.scheme !== undefined && value.scheme !== 'file') {
    return undefined;
  }
  const pattern = asRecord(value.pattern);
  if (!pattern || typeof pattern.glob !== 'string') {
    return undefined;
  }
  if (pattern.matches !== undefined && pattern.matches !== 'file' && pattern.matches !== 'folder') {
    return undefined;
  }
  const options = asRecord(pattern.options);
  const sanitizedPattern: FileOperationFilter['pattern'] = {
    glob: pattern.glob,
    ...(pattern.matches === 'file' || pattern.matches === 'folder' ? { matches: pattern.matches } : {}),
    ...(options?.ignoreCase === true ? { options: { ignoreCase: true } } : {})
  };
  return {
    ...(value.scheme === 'file' ? { scheme: 'file' as const } : {}),
    pattern: sanitizedPattern
  };
}

function toEffectiveFilter(filter: FileOperationFilter): Record<string, unknown> {
  return {
    ...(filter.scheme ? { scheme: filter.scheme } : {}),
    pattern: {
      glob: filter.pattern.glob,
      ...(filter.pattern.matches ? { matches: filter.pattern.matches } : {}),
      ...(filter.pattern.options?.ignoreCase === true ? { options: { ignoreCase: true } } : {})
    }
  };
}

function isSupportedMethod(value: unknown): value is FileOperationMethod {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(METHOD_TO_CAPABILITY, value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(asRecord(value));
}
