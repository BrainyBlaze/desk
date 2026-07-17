import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createChannel,
  listChannelMembers,
  updateMemberRole,
  updateMemberSupervisor
} from '../src/server/channelsStore.js';

describe('updateMemberSupervisor', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-supe-store-'));
    createChannel(home, 'ops', 'goal');
    addMember(home, 'ops', { name: 'supe', type: 'claude-code', tmuxSession: 'agentdesk-x-main-supe' });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('sets supervisor + timer and persists them to the manifest file', () => {
    const updated = updateMemberSupervisor(home, 'ops', 'supe', true, 7);
    expect(updated).toMatchObject({ name: 'supe', supervisor: true, supervisorMaxIdleMinutes: 7 });
    const manifestPath = join(home, 'ops', '_members', 'supe.md');
    const on = readFileSync(manifestPath, 'utf-8');
    expect(on).toContain('supervisor: true');
    expect(on).toContain('supervisorMaxIdleMinutes: 7');
  });

  it('defaults max-idle to 3 minutes when enabling with an omitted timer', () => {
    const updated = updateMemberSupervisor(home, 'ops', 'supe', true);
    expect(updated?.supervisorMaxIdleMinutes).toBe(3);
    const listed = listChannelMembers(home, 'ops').find((member) => member.name === 'supe');
    expect(listed?.supervisorMaxIdleMinutes).toBe(3);
  });

  it('clears supervisor keys when the flag is toggled off', () => {
    updateMemberSupervisor(home, 'ops', 'supe', true, 5);
    const cleared = updateMemberSupervisor(home, 'ops', 'supe', false);
    expect(cleared?.supervisor).toBeUndefined();
    expect(cleared?.supervisorMaxIdleMinutes).toBeUndefined();
    const on = readFileSync(join(home, 'ops', '_members', 'supe.md'), 'utf-8');
    expect(on).not.toContain('supervisor:');
    expect(on).not.toContain('supervisorMaxIdleMinutes:');
  });

  it('preserves an existing role and functions when toggling supervisor', () => {
    updateMemberRole(home, 'ops', 'supe', 'auditor', 'watch the pipeline');
    updateMemberSupervisor(home, 'ops', 'supe', true, 4);
    const listed = listChannelMembers(home, 'ops').find((member) => member.name === 'supe');
    expect(listed).toMatchObject({
      role: 'auditor',
      functions: 'watch the pipeline',
      supervisor: true,
      supervisorMaxIdleMinutes: 4
    });
  });

  it('returns undefined for an unknown member without touching the disk', () => {
    const result = updateMemberSupervisor(home, 'ops', 'ghost', true, 3);
    expect(result).toBeUndefined();
    expect(listChannelMembers(home, 'ops').map((m) => m.name).sort()).toEqual(['human', 'supe']);
  });
});

describe('updateMemberRole preserves supervisor fields', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-supe-role-'));
    createChannel(home, 'ops', 'goal');
    addMember(home, 'ops', { name: 'supe', type: 'claude-code', tmuxSession: 'agentdesk-x-main-supe' });
    updateMemberSupervisor(home, 'ops', 'supe', true, 6);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('rewriting role does not silently drop supervisor / max-idle', () => {
    updateMemberRole(home, 'ops', 'supe', 'lead', 'coordinate work');
    const listed = listChannelMembers(home, 'ops').find((member) => member.name === 'supe');
    expect(listed).toMatchObject({
      role: 'lead',
      functions: 'coordinate work',
      supervisor: true,
      supervisorMaxIdleMinutes: 6
    });
  });

  it('clearing role does not silently drop supervisor / max-idle', () => {
    updateMemberRole(home, 'ops', 'supe', undefined, undefined);
    const listed = listChannelMembers(home, 'ops').find((member) => member.name === 'supe');
    expect(listed?.role).toBeUndefined();
    expect(listed?.functions).toBeUndefined();
    expect(listed?.supervisor).toBe(true);
    expect(listed?.supervisorMaxIdleMinutes).toBe(6);
  });
});
