import { describe, expect, it } from 'vitest';
import {
  appendComposerFileLinks,
  composerDragIncludesFiles,
  composerPlainEnterShouldSend,
  composerResizeKeyDelta,
  dragComposerResize,
  filesFromClipboardItems,
  finishComposerResize,
  handleComposerFileDragOver,
  handleComposerFileDrop,
  handleComposerFilePaste,
  restoreComposerTextAfterFailedSend,
  runComposerFileUpload,
  startComposerResize
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
    expect(composerPlainEnterShouldSend('Enter', false, true)).toBe(false);
  });

  it('restores a failed submitted message without overwriting text typed while it was pending', () => {
    expect(restoreComposerTextAfterFailedSend('submitted', '')).toBe('submitted');
    expect(restoreComposerTextAfterFailedSend('submitted', 'new draft')).toBe('submitted\nnew draft');
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

  it('centralizes pointer resize capture, drag, and release', () => {
    const ref = { current: null as { startY: number; startHeight: number } | null };
    const calls: string[] = [];
    const target = {
      setPointerCapture: (id: number) => calls.push(`set:${id}`),
      hasPointerCapture: (id: number) => {
        calls.push(`has:${id}`);
        return true;
      },
      releasePointerCapture: (id: number) => calls.push(`release:${id}`)
    };

    startComposerResize({ preventDefault: () => calls.push('prevent:start'), currentTarget: target, pointerId: 7, clientY: 100 }, ref, 80, () =>
      calls.push('started')
    );
    expect(ref.current).toEqual({ startY: 100, startHeight: 80 });
    expect(calls).toEqual(['prevent:start', 'set:7', 'started']);

    dragComposerResize({ preventDefault: () => calls.push('prevent:drag'), currentTarget: target, pointerId: 7, clientY: 70 }, ref, (resize, clientY) => {
      calls.push(`drag:${resize.startHeight}:${resize.startY}:${clientY}`);
    });
    finishComposerResize({ preventDefault: () => calls.push('prevent:finish'), currentTarget: target, pointerId: 7, clientY: 70 }, ref);

    expect(ref.current).toBeNull();
    expect(calls.slice(3)).toEqual(['prevent:drag', 'drag:80:100:70', 'has:7', 'release:7']);
  });

  it('uploads files through one markdown-link flow', async () => {
    const first = new File(['alpha'], 'a.txt');
    const second = new File(['beta'], 'b.txt');
    const states: boolean[] = [];
    const focus: string[] = [];
    const appended: string[][] = [];
    const uploaded: Array<{ channel: string; name: string; content: string }> = [];

    const handled = await runComposerFileUpload([first, second], {
      channel: 'uploads',
      upload: async (channel, name, content) => {
        uploaded.push({ channel, name, content });
        return { markdown: `[${name}](_files/${name})` };
      },
      setUploading: (value) => states.push(value),
      appendLinks: (links) => appended.push(links),
      onSuccess: () => focus.push('success'),
      onError: (message) => focus.push(`error:${message}`),
      focus: () => focus.push('focus')
    });

    expect(handled).toBe(true);
    expect(states).toEqual([true, false]);
    expect(uploaded).toEqual([
      { channel: 'uploads', name: 'a.txt', content: 'YWxwaGE=' },
      { channel: 'uploads', name: 'b.txt', content: 'YmV0YQ==' }
    ]);
    expect(appended).toEqual([[`[a.txt](_files/a.txt)`, `[b.txt](_files/b.txt)`]]);
    expect(focus).toEqual(['success', 'focus']);
  });

  it('keeps empty uploads as a no-op', async () => {
    const states: boolean[] = [];
    const handled = await runComposerFileUpload([], {
      channel: 'uploads',
      upload: async () => ({ markdown: 'unused' }),
      setUploading: (value) => states.push(value),
      appendLinks: () => states.push(true),
      onError: () => states.push(true),
      focus: () => states.push(true)
    });

    expect(handled).toBe(false);
    expect(states).toEqual([]);
  });

  it('centralizes drag/drop and paste file handlers', () => {
    const calls: string[] = [];
    const file = new File(['data'], 'a.txt');
    const dragOver = {
      preventDefault: () => calls.push('prevent:drag'),
      dataTransfer: { types: ['Files'], files: [file] }
    };
    const drop = {
      preventDefault: () => calls.push('prevent:drop'),
      dataTransfer: { types: ['Files'], files: [file] }
    };
    const paste = {
      preventDefault: () => calls.push('prevent:paste'),
      clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] }
    };

    expect(handleComposerFileDragOver(dragOver, (value) => calls.push(`drag:${String(value)}`))).toBe(true);
    handleComposerFileDrop(drop, (value) => calls.push(`drag:${String(value)}`), (files) => {
      calls.push(`drop:${Array.from(files).length}`);
    });
    expect(handleComposerFilePaste(paste, (files) => calls.push(`paste:${files.length}`))).toBe(true);

    expect(calls).toEqual(['prevent:drag', 'drag:true', 'prevent:drop', 'drag:false', 'drop:1', 'prevent:paste', 'paste:1']);
  });
});
