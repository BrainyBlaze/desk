import { describe, expect, it } from 'vitest';
import { deriveNoteName, isUntitledNote, noteFileName } from '../src/web/editor/noteNames';

describe('deriveNoteName', () => {
  it('takes the first non-empty line capped at 20 characters', () => {
    expect(deriveNoteName('hello world\nsecond line')).toBe('hello world');
    expect(deriveNoteName('a very long first line that keeps going')).toBe('a very long first li');
  });

  it('strips markdown lead-in markers', () => {
    expect(deriveNoteName('# My Heading')).toBe('My Heading');
    expect(deriveNoteName('- list item')).toBe('list item');
    expect(deriveNoteName('> quoted thought')).toBe('quoted thought');
  });

  it('replaces filesystem-hostile characters', () => {
    expect(deriveNoteName('foo/bar: baz?')).toBe('foo bar baz');
  });

  it('skips leading blank lines and falls back to untitled', () => {
    expect(deriveNoteName('\n\n  \nactual content here')).toBe('actual content here');
    expect(deriveNoteName('')).toBe('untitled');
    expect(deriveNoteName(undefined)).toBe('untitled');
    expect(deriveNoteName('   \n  ')).toBe('untitled');
  });

  it('never ends with trailing dots', () => {
    expect(deriveNoteName('notes...')).toBe('notes');
  });
});

describe('isUntitledNote', () => {
  it('matches untitled.md and its dedupe variants only', () => {
    expect(isUntitledNote('untitled.md')).toBe(true);
    expect(isUntitledNote('untitled-3.md')).toBe(true);
    expect(isUntitledNote('Untitled.md')).toBe(true);
    expect(isUntitledNote('untitled-notes.md')).toBe(false);
    expect(isUntitledNote('plan.md')).toBe(false);
  });
});

describe('noteFileName', () => {
  it('dedupes with -N suffixes starting at 2', () => {
    expect(noteFileName('plan', 0)).toBe('plan.md');
    expect(noteFileName('plan', 1)).toBe('plan-2.md');
    expect(noteFileName('plan', 4)).toBe('plan-5.md');
  });
});
