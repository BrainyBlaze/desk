import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('agent profiles UI contract', () => {
  const appSource = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  const apiSource = readFileSync(new URL('../src/web/api.ts', import.meta.url), 'utf8');
  const profilesSettingsUrl = new URL('../src/web/AgentProfilesSettings.tsx', import.meta.url);
  const profilesSettingsSource = existsSync(fileURLToPath(profilesSettingsUrl))
    ? readFileSync(profilesSettingsUrl, 'utf8')
    : '';

  it('adds a Profiles settings section backed by the typed profile API', () => {
    expect(appSource).toContain("id: 'profiles'");
    expect(appSource).toContain('<AgentProfilesSettings');
    expect(appSource).toContain('onProfilesChange={setAgentProfiles}');
    expect(apiSource).toMatch(/export async function fetchAgentProfiles/);
    expect(apiSource).toMatch(/export async function createAgentProfile/);
    expect(apiSource).toMatch(/export async function updateAgentProfile/);
    expect(apiSource).toMatch(/export async function deleteAgentProfile/);
  });

  it('keeps account status honest when the server has not verified it', () => {
    expect(profilesSettingsSource).toContain('Account status unavailable');
    expect(profilesSettingsSource).not.toContain('Connected account');
  });

  it('resets an incompatible profile when the agent or command changes', () => {
    expect(appSource).toContain('profileId: profileMatchesAgent');
    expect(appSource).toContain("profileId: command.trim() === '' ? form.profileId : ''");
  });
});
