import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { readManifestFile, resolveManifestPath, updateManifestFile } from '../../core/config.js';
import { collectSessions } from '../../core/manifest.js';
import { isProfileProvider, isValidProfileId, profileRoot } from '../../shared/agentProfiles.js';
import type { AgentProfile, DeskManifest, ProfileProvider } from '../../core/types.js';
import { ApiValidationError, readRequiredString } from '../apiValidation.js';
import { readJsonBody, sendJson } from '../httpUtil.js';
import type { DeskRoute } from '../plugin.js';

/**
 * Agent profile routes: pointers only. Desk creates and destroys the
 * credential DIRECTORY and never reads, writes, or serves its contents — the
 * provider CLI is the sole writer of what lives inside.
 */
export function createProfileRoutes(): DeskRoute {
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/profiles') {
      sendJson(res, 200, { profiles: listProfiles() });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/profiles') {
      const body = await readJsonBody(req);
      const provider = readProvider(body.provider);
      const label = readLabel(body.label);
      const created = await addProfile(provider, label);
      sendJson(res, 200, { profile: created, profiles: listProfiles() });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/profiles/rename') {
      const body = await readJsonBody(req);
      const id = readProfileId(body.id);
      const label = readLabel(body.label);
      const renamed = await renameProfile(id, label);
      if (!renamed) {
        sendJson(res, 404, { error: `unknown profile ${id}`, code: 'unknown-profile' });
        return true;
      }
      sendJson(res, 200, { profile: renamed, profiles: listProfiles() });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/profiles/delete') {
      const body = await readJsonBody(req);
      const id = readProfileId(body.id);
      const result = await deleteProfile(id);
      if (!result.ok) {
        sendJson(res, result.status, {
          error: result.error,
          code: result.code,
          ...(result.sessions ? { sessions: result.sessions } : {})
        });
        return true;
      }
      sendJson(res, 200, { ok: true, profiles: listProfiles() });
      return true;
    }

    return false;
  };
}

function listProfiles(): AgentProfile[] {
  return readManifestFile(resolveManifestPath()).profiles ?? [];
}

function readProvider(value: unknown): ProfileProvider {
  if (!isProfileProvider(value)) {
    throw new ApiValidationError('provider must be claude or codex');
  }
  return value;
}

function readProfileId(value: unknown): string {
  const id = readRequiredString(value, 'id');
  if (!isValidProfileId(id)) {
    throw new ApiValidationError('id is not a valid profile id');
  }
  return id;
}

/** Labels are operator text: bounded, single-line, non-empty (R4.3). */
function readLabel(value: unknown): string {
  const label = readRequiredString(value, 'label').trim();
  if (label === '' || label.length > 64) {
    throw new ApiValidationError('label must be 1-64 characters');
  }
  if (/[\x00-\x1F\x7F]/.test(label)) {
    throw new ApiValidationError('label must not contain control characters');
  }
  return label;
}

/**
 * Mint an id from the label, create the 0700 directory, then record the
 * pointer. The directory is created BEFORE the manifest entry so a crash
 * leaves an unreferenced directory (harmless, reused on retry) rather than a
 * manifest entry pointing at nothing, which would fail the next launch closed.
 */
async function addProfile(provider: ProfileProvider, label: string): Promise<AgentProfile> {
  const manifestPath = resolveManifestPath();
  const existing = readManifestFile(manifestPath).profiles ?? [];
  const id = mintProfileId(label, new Set(existing.map((profile) => profile.id)));
  mkdirSync(profileRoot(id, homedir()), { recursive: true, mode: 0o700 });

  const profile: AgentProfile = { id, provider, label };
  await updateManifestFile(manifestPath, (manifest) => ({
    ...manifest,
    profiles: [...(manifest.profiles ?? []), profile]
  }));
  return profile;
}

async function renameProfile(id: string, label: string): Promise<AgentProfile | null> {
  let renamed: AgentProfile | null = null;
  await updateManifestFile(resolveManifestPath(), (manifest) => {
    const profiles = manifest.profiles ?? [];
    if (!profiles.some((profile) => profile.id === id)) {
      return null;
    }
    const next = profiles.map((profile) => (profile.id === id ? { ...profile, label } : profile));
    renamed = next.find((profile) => profile.id === id) ?? null;
    return { ...manifest, profiles: next };
  });
  return renamed;
}

type DeleteResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string; code: string; sessions?: string[] };

/**
 * Deleting a profile removes its directory — the one destructive act Desk
 * performs on credential storage. It is refused while any session still
 * references the profile (R2 fail closed): removing it would leave that
 * session unlaunchable, and the operator should see WHICH sessions block it.
 * Desk never calls a provider logout; it only drops its own copy.
 */
async function deleteProfile(id: string): Promise<DeleteResult> {
  const manifestPath = resolveManifestPath();
  const manifest = readManifestFile(manifestPath);
  if (!(manifest.profiles ?? []).some((profile) => profile.id === id)) {
    return { ok: false, status: 404, error: `unknown profile ${id}`, code: 'unknown-profile' };
  }
  const users = sessionsUsingProfile(manifest, id);
  if (users.length > 0) {
    return {
      ok: false,
      status: 409,
      error: `profile ${id} is in use by ${users.join(', ')}`,
      code: 'profile-in-use',
      sessions: users
    };
  }
  await updateManifestFile(manifestPath, (current) => ({
    ...current,
    profiles: (current.profiles ?? []).filter((profile) => profile.id !== id)
  }));
  rmSync(profileRoot(id, homedir()), { recursive: true, force: true });
  return { ok: true };
}

export function sessionsUsingProfile(manifest: DeskManifest, id: string): string[] {
  return collectSessions(manifest)
    .filter((session) => session.profileId === id)
    .map((session) => session.name);
}

/** Derive a valid, collision-free profile id from an operator label. */
export function mintProfileId(label: string, taken: ReadonlySet<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (base === '' || !/^[a-z]/.test(base)) {
    base = `p-${base}`.replace(/-$/, '');
  }
  if (base.length < 3) {
    base = `${base}-x`;
  }
  base = base.slice(0, 64).replace(/-$/, '');
  if (!taken.has(base) && isValidProfileId(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate) && isValidProfileId(candidate)) {
      return candidate;
    }
  }
}
