import { describe, expect, it } from 'vitest';
import {
  appendComposerFileLinks,
  composerDragIncludesFiles,
  composerPlainEnterShouldSend,
  composerResizeKeyDelta,
  filesFromClipboardItems
} from '../src/web/composerInput';

describe('composer input shared helpers', () => {
  it('appends uploaded file links with the same spacing rule for all composers', () => {
    expect(appendComposerFileLinks('', ['[a](_files/a.txt)'])).toBe('[a](_files/a.txt)');
    expect(appendComposerFileLinks('hello', ['[a](_files/a.txt)', '[b](_files/b.txt)'])).toBe(
      'hello [a](_files/a.txt) [b](_files/b.txt)'
    );
    expect(appendComposerFileLinks('hello ', ['[a](_files/a.txt)'])).toBe('hello [a](_files/a.txt)');
    expect(appendComposerFileLinks('hello\n', ['[a](_files/a.txt)'])).toBe('hello\n[a](_files/a.txt)');
    expect(appendComposerFileLinks('hello', [])).toBe('hello');
  });

  it('extracts only real files from clipboard items', () => {
    const file = new File(['data'], 'a.txt');
    const items = [
      { kind: 'file', getAsFile: () => file },
      { kind: 'file', getAsFile: () => null },
      { kind: 'string', getAsFile: () => null }
    ];

    expect(filesFromClipboardItems(items)).toEqual([file]);
  });

  it('uses Enter without Shift as the shared send shortcut', () => {
    expect(composerPlainEnterShouldSend('Enter', false)).toBe(true);
    expect(composerPlainEnterShouldSend('Enter', true)).toBe(false);
    expect(composerPlainEnterShouldSend('NumpadEnter', false)).toBe(false);
  });

  it('maps resize arrow keys to clamped height deltas', () => {
    expect(composerResizeKeyDelta('ArrowUp', 12)).toBe(12);
    expect(composerResizeKeyDelta('ArrowDown', 12)).toBe(-12);
    expect(composerResizeKeyDelta('PageUp', 12)).toBeNull();
  });

  it('detects file drag payloads through a shared guard', () => {
    expect(composerDragIncludesFiles(['Files', 'text/plain'])).toBe(true);
    expect(composerDragIncludesFiles(['text/plain'])).toBe(false);
  });
});
