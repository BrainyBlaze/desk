import { isAbsolute, relative, resolve } from 'node:path';
import { ApiValidationError } from './apiValidation.js';

/**
 * Resolve a client-supplied path and require it to live inside the explorer
 * root. Defends the fs API against `../` escapes; the root itself is the
 * trust boundary (the user picks it explicitly in the UI).
 */
export function resolveFsPath(raw: unknown, root: string, trustedFiles: readonly string[] = []): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiValidationError('path must be a non-empty string');
  }
  const resolvedRoot = resolve(root);
  const resolved = resolve(raw);
  // Exact-match allowance for server-owned files (the desk manifest): they are
  // already read/written by other endpoints, so editing them through the fs
  // API does not widen the trust boundary even when they sit outside the root.
  if (trustedFiles.some((file) => resolve(file) === resolved)) {
    return resolved;
  }
  const rel = relative(resolvedRoot, resolved);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new ApiValidationError(`path escapes the explorer root: ${raw}`);
  }
  return resolved;
}
