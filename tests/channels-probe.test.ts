import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyPaneTail,
  createSessionProbe,
  isPaneBusy,
  isPaneReadyForInput,
  tailPaneCapture
} from '../src/server/channelsProbe.js';

const sample = (name: string): string =>
  tailPaneCapture(readFileSync(new URL(`./samples/${name}`, import.meta.url), 'utf8'));

describe('channelsProbe pane classifier', () => {
  it('classifies real opencode captures by footer and left-rail composer geometry', () => {
    const idle = sample('opencode-idle.txt');
    const splashIdle = sample('opencode-splash-idle.txt');
    const working = sample('opencode-working.txt');
    const contextRichWorking = sample('opencode-glm-working.txt');

    expect(classifyPaneTail(idle)).toMatchObject({ paneState: 'ready', ready: true, working: false });
    expect(classifyPaneTail(splashIdle)).toMatchObject({ paneState: 'ready', ready: true, working: false });
    expect(classifyPaneTail(working)).toMatchObject({ paneState: 'working', ready: false, working: true });
    expect(classifyPaneTail(contextRichWorking)).toMatchObject({ paneState: 'working', ready: false, working: true });
  });

  it('classifies real Claude working affordances above the footer as working', () => {
    const workingAboveFooter = sample('claude-working-spinner-above-footer.txt');
    const workingTokenLine = sample('claude-working-token-line.txt');
    const idle = sample('claude-idle-ready.txt');

    expect(isPaneBusy(workingAboveFooter)).toBe(true);
    expect(classifyPaneTail(workingAboveFooter)).toMatchObject({ paneState: 'working', ready: false, working: true });
    expect(isPaneBusy(workingTokenLine)).toBe(true);
    expect(classifyPaneTail(workingTokenLine)).toMatchObject({ paneState: 'working', ready: false, working: true });
    expect(isPaneBusy(idle)).toBe(false);
    expect(classifyPaneTail(idle)).toMatchObject({ paneState: 'ready', ready: true, working: false });
  });

  it('vetoes the real Claude session survey menu before prompt glyph readiness', () => {
    const survey = sample('claude-survey-menu.txt');

    expect(classifyPaneTail(survey)).toMatchObject({
      paneState: 'blocked',
      blockedReason: 'selection-menu',
      ready: false,
      working: false
    });
    expect(isPaneReadyForInput(survey)).toBe(false);
  });

  it('keeps working markers footer-scoped and exposes the footer region for verify diffs', () => {
    const pane = [
      'Human message discussed esc to interrupt in scrollback.',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      '',
      '› ',
      '─────',
      '  gpt-5.5 xhigh · Context 58% used'
    ].join('\n');

    const snapshot = classifyPaneTail(pane);

    expect(snapshot.paneState).toBe('ready');
    expect(snapshot.footerRegion).not.toContain('esc to interrupt in scrollback');
    expect(snapshot.footerHash).toHaveLength(64);
  });

  it('vetoes structural approval and input menus before prompt glyph readiness', () => {
    expect(
      classifyPaneTail(['Allow command?', '› Yes', '  No'].join('\n'))
    ).toMatchObject({ paneState: 'blocked', blockedReason: 'approval', ready: false });

    expect(
      classifyPaneTail(['opencode needs input', '› Provide answer', '  Cancel'].join('\n'))
    ).toMatchObject({ paneState: 'blocked', blockedReason: 'input-requested', ready: false });

    expect(
      classifyPaneTail(['Select a model', '› gpt-5.5', '  gpt-5'].join('\n'))
    ).toMatchObject({ paneState: 'blocked', blockedReason: 'selection-menu', ready: false });
  });

  it('preserves existing predicate semantics through compatibility exports', () => {
    expect(isPaneBusy(sample('opencode-working.txt'))).toBe(true);
    expect(isPaneBusy(sample('opencode-idle.txt'))).toBe(false);
    expect(isPaneReadyForInput('❯ ')).toBe(true);
    expect(isPaneReadyForInput('› Explain this codebase\n  gpt-5.5 xhigh · Context 58% used')).toBe(true);
    expect(isPaneReadyForInput('⚠ MCP client failed to start\n⚠ startup incomplete')).toBe(false);
  });
});

describe('createSessionProbe', () => {
  it('fails closed on offline, booting, null, and empty captures', async () => {
    const offline = createSessionProbe({
      sessionRunning: () => false,
      sessionCreatedAt: async () => 1,
      capturePane: async () => '❯ ',
      bootGraceMs: 0,
      now: () => 100_000
    });
    await expect(offline.probe('tmux-a')).resolves.toMatchObject({ paneState: 'offline', ready: false });

    const booting = createSessionProbe({
      sessionRunning: () => true,
      sessionCreatedAt: async () => 100,
      capturePane: async () => '❯ ',
      bootGraceMs: 10_000,
      now: () => 101_000
    });
    await expect(booting.probe('tmux-a')).resolves.toMatchObject({ paneState: 'booting', ready: false });

    const unobservable = createSessionProbe({
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => null,
      bootGraceMs: 0,
      now: () => 100_000
    });
    await expect(unobservable.probe('tmux-a')).resolves.toMatchObject({
      paneState: 'unobservable',
      blockedReason: 'capture-failed',
      ready: false
    });

    const empty = createSessionProbe({
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => '',
      bootGraceMs: 0,
      now: () => 100_000
    });
    await expect(empty.probe('tmux-a')).resolves.toMatchObject({ paneState: 'empty-capture', ready: false });
  });

  it('deduplicates concurrent probes but allows force-fresh reads', async () => {
    let captures = 0;
    const probe = createSessionProbe({
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => {
        captures += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return '❯ ';
      },
      bootGraceMs: 0,
      now: () => 100_000,
      ttlMs: 1000
    });

    const [first, second] = await Promise.all([probe.probe('tmux-a'), probe.probe('tmux-a')]);
    expect(first).toEqual(second);
    expect(captures).toBe(1);

    await probe.probe('tmux-a');
    expect(captures).toBe(1);

    await probe.probe('tmux-a', { forceFresh: true });
    expect(captures).toBe(2);
  });

  it('clears a failed in-flight probe so a later probe can retry', async () => {
    let captures = 0;
    const probe = createSessionProbe({
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => {
        captures += 1;
        if (captures === 1) {
          throw new Error('capture exploded');
        }
        return '❯ ';
      },
      bootGraceMs: 0,
      now: () => 100_000,
      ttlMs: 1000
    });

    await expect(probe.probe('tmux-a')).rejects.toThrow('capture exploded');
    await expect(probe.probe('tmux-a')).resolves.toMatchObject({ paneState: 'ready' });
    expect(captures).toBe(2);
  });

  it('does not let an older probe overwrite a newer completed cache entry', async () => {
    let clock = 100_000;
    const captures: Array<(pane: string) => void> = [];
    const probe = createSessionProbe({
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () =>
        new Promise<string>((resolve) => {
          captures.push(resolve);
        }),
      bootGraceMs: 0,
      now: () => clock,
      ttlMs: 1000
    });

    clock = 100_000;
    const older = probe.probe('tmux-a');
    clock = 100_001;
    const newer = probe.probe('tmux-a', { forceFresh: true });
    while (captures.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    captures[1]!('❯ ');
    await expect(newer).resolves.toMatchObject({ paneState: 'ready' });
    captures[0]!('✻ Working… (esc to interrupt)');
    await expect(older).resolves.toMatchObject({ paneState: 'working' });

    clock = 100_002;
    await expect(probe.probe('tmux-a')).resolves.toMatchObject({ paneState: 'ready' });
    expect(captures).toHaveLength(2);
  });
});
