import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProfileApiError,
  createAgentProfile,
  deleteAgentProfile,
  fetchAgentProfiles,
  updateAgentProfile
} from '../src/web/api.js';

const profile = { id: 'work-codex', provider: 'codex' as const, label: 'Work Codex' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('agent profile browser API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the profile list from the pointer-only endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ profiles: [profile] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAgentProfiles()).resolves.toEqual([profile]);
    expect(fetchMock).toHaveBeenCalledWith('/api/profiles');
  });

  it('uses the create, rename, and delete route contracts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ profile, profiles: [profile] }))
      .mockResolvedValueOnce(jsonResponse({ profile: { ...profile, label: 'Primary' }, profiles: [{ ...profile, label: 'Primary' }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, profiles: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await createAgentProfile({ provider: 'codex', label: 'Work Codex' });
    await updateAgentProfile({ id: profile.id, label: 'Primary' });
    await deleteAgentProfile(profile.id);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/profiles',
      '/api/profiles/rename',
      '/api/profiles/delete'
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { provider: 'codex', label: 'Work Codex' },
      { id: 'work-codex', label: 'Primary' },
      { id: 'work-codex' }
    ]);
  });

  it('preserves typed deletion failures and the blocking session list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: 'profile work-codex is in use by build',
            code: 'profile-in-use',
            sessions: ['build']
          },
          409
        )
      )
    );

    const error = await deleteAgentProfile(profile.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentProfileApiError);
    expect(error).toMatchObject({
      message: 'profile work-codex is in use by build',
      code: 'profile-in-use',
      sessions: ['build']
    });
  });
});
