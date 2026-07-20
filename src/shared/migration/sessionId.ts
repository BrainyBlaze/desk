// Identity migration — sessionId grammar + minting (spec §10). Pure module.
// sessionId replaces tmuxSession as the durable per-session identity. Grammar:
// `^[a-z][a-z0-9-]{2,63}$` — starts with a letter, 3–64 chars, lowercase
// alnum + dash. Globally unique within a per-user runtime; collision → reject.

export const SESSION_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** Assert grammar + uniqueness at create; a collision is a hard reject (§10). */
export function assertMintable(id: string, taken: ReadonlySet<string>): { ok: true } | { ok: false; reason: 'grammar' | 'collision' } {
  if (!isValidSessionId(id)) return { ok: false, reason: 'grammar' };
  if (taken.has(id)) return { ok: false, reason: 'collision' };
  return { ok: true };
}

/**
 * Derive a valid, unique sessionId from a human name, deduping against `taken`.
 * Slugs to grammar (lowercase, non-alnum→dash, collapse/trim dashes, ensure a
 * leading letter, pad to the 3-char minimum), clamps to 64, and appends a
 * numeric suffix on collision while preserving the grammar and length bound.
 */
export function mintSessionId(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (base === '' || !/^[a-z]/.test(base)) base = `s-${base}`.replace(/-$/, '');
  if (base.length < 3) base = `${base}-x`.slice(0, 64);
  base = base.slice(0, 64).replace(/-$/, '');
  if (!taken.has(base) && isValidSessionId(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate) && isValidSessionId(candidate)) return candidate;
  }
}

/**
 * Validate global uniqueness across a migrated set (§10 phase 4). Returns the
 * first duplicate so the migration can abort BEFORE commit (fail-closed).
 */
export function checkGlobalUniqueness(ids: readonly string[]): { ok: true } | { ok: false; duplicate: string } {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return { ok: false, duplicate: id };
    seen.add(id);
  }
  return { ok: true };
}
