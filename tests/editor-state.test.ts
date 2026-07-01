import { describe, expect, it } from 'vitest';
import { closeTab, duplicateName, moveTab, openTab, tabLabels } from '../src/web/editor/editorState';

describe('openTab', () => {
  it('appends a new path and activates it', () => {
    expect(openTab(['/a'], '/a', '/b')).toEqual({ tabs: ['/a', '/b'], active: '/b' });
  });

  it('activates an already-open path without duplicating', () => {
    expect(openTab(['/a', '/b'], '/b', '/a')).toEqual({ tabs: ['/a', '/b'], active: '/a' });
  });
});

describe('closeTab', () => {
  it('activates the right neighbor, else the left, else null', () => {
    expect(closeTab(['/a', '/b', '/c'], '/b', '/b')).toEqual({ tabs: ['/a', '/c'], active: '/c' });
    expect(closeTab(['/a', '/b'], '/b', '/b')).toEqual({ tabs: ['/a'], active: '/a' });
    expect(closeTab(['/a'], '/a', '/a')).toEqual({ tabs: [], active: null });
  });

  it('keeps the active tab when closing an inactive one', () => {
    expect(closeTab(['/a', '/b'], '/a', '/b')).toEqual({ tabs: ['/a'], active: '/a' });
  });
});

describe('moveTab', () => {
  it('reorders by index', () => {
    expect(moveTab(['/a', '/b', '/c'], 0, 2)).toEqual(['/b', '/c', '/a']);
    expect(moveTab(['/a', '/b', '/c'], 2, 0)).toEqual(['/c', '/a', '/b']);
  });

  it('ignores out-of-range moves', () => {
    expect(moveTab(['/a'], 0, 5)).toEqual(['/a']);
    expect(moveTab(['/a'], 3, 0)).toEqual(['/a']);
  });
});

describe('tabLabels', () => {
  it('uses basenames, disambiguating duplicates with the parent dir', () => {
    const labels = tabLabels(['/x/src/index.ts', '/x/lib/index.ts', '/x/readme.md']);
    expect(labels.get('/x/src/index.ts')).toBe('index.ts — src');
    expect(labels.get('/x/lib/index.ts')).toBe('index.ts — lib');
    expect(labels.get('/x/readme.md')).toBe('readme.md');
  });
});

describe('duplicateName', () => {
  it('inserts -copy before the extension and counts retries', () => {
    expect(duplicateName('a.txt', 0)).toBe('a-copy.txt');
    expect(duplicateName('a.txt', 1)).toBe('a-copy-2.txt');
    expect(duplicateName('archive.tar.gz', 0)).toBe('archive.tar-copy.gz');
  });

  it('appends for dotfiles and extensionless names', () => {
    expect(duplicateName('.env', 0)).toBe('.env-copy');
    expect(duplicateName('Makefile', 0)).toBe('Makefile-copy');
    expect(duplicateName('dir', 2)).toBe('dir-copy-3');
  });
});
