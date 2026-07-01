import { describe, expect, it } from 'vitest';
import { patchViewLiveness } from '../src/web/pulse.js';
import { buildDeskViewModel } from '../src/ui/model.js';
import type { SessionSpec } from '../src/core/types.js';

function spec(name: string, groupId: string, tmuxSession: string): SessionSpec {
  return {
    name,
    groupId,
    groupLabel: groupId,
    cwd: '/tmp',
    command: 'bash',
    tmuxSession,
    projectId: 'proj',
    projectLabel: 'proj',
    projectCwd: '/tmp'
  } as SessionSpec;
}

function buildView(running: string[]): ReturnType<typeof buildDeskViewModel> {
  return buildDeskViewModel(
    [spec('a', 'g1', 't-a'), spec('b', 'g1', 't-b'), spec('c', 'g2', 't-c')],
    new Set(running)
  );
}

describe('patchViewLiveness', () => {
  it('returns the identical view object when nothing changed', () => {
    const view = buildView(['t-a', 't-b']);
    expect(patchViewLiveness(view, new Set(['t-a', 't-b']))).toBe(view);
  });

  it('flips a dead session to missing and recounts group/project/totals', () => {
    const view = buildView(['t-a', 't-b', 't-c']);
    const patched = patchViewLiveness(view, new Set(['t-a', 't-c']));
    expect(patched).not.toBe(view);
    const g1 = patched.groups.find((group) => group.groupId === 'g1')!;
    expect(g1.sessions.find((s) => s.spec.tmuxSession === 't-b')?.state).toBe('missing');
    expect(g1.running).toBe(1);
    expect(g1.missing).toBe(1);
    expect(patched.totals.running).toBe(2);
    expect(patched.totals.missing).toBe(1);
    expect(patched.projects[0].running).toBe(2);
  });

  it('preserves identity of untouched sessions and groups', () => {
    const view = buildView(['t-a', 't-b', 't-c']);
    const patched = patchViewLiveness(view, new Set(['t-a', 't-c']));
    const beforeG1 = view.groups.find((group) => group.groupId === 'g1')!;
    const afterG1 = patched.groups.find((group) => group.groupId === 'g1')!;
    const beforeG2 = view.groups.find((group) => group.groupId === 'g2')!;
    const afterG2 = patched.groups.find((group) => group.groupId === 'g2')!;
    // untouched group: same object; touched group: same untouched session
    expect(afterG2).toBe(beforeG2);
    expect(afterG1).not.toBe(beforeG1);
    expect(afterG1.sessions.find((s) => s.spec.tmuxSession === 't-a')).toBe(
      beforeG1.sessions.find((s) => s.spec.tmuxSession === 't-a')
    );
  });

  it('keeps projects[].groups aliased to the flat groups list', () => {
    const view = buildView(['t-a', 't-b', 't-c']);
    const patched = patchViewLiveness(view, new Set([]));
    for (const project of patched.projects) {
      for (const group of project.groups) {
        expect(patched.groups.find((candidate) => candidate.id === group.id)).toBe(group);
      }
    }
  });

  it('revives a missing session back to running', () => {
    const view = buildView(['t-a']);
    const patched = patchViewLiveness(view, new Set(['t-a', 't-b', 't-c']));
    expect(patched.totals.running).toBe(3);
    expect(patched.totals.missing).toBe(0);
    expect(patched.groups.every((group) => group.missing === 0)).toBe(true);
  });
});
