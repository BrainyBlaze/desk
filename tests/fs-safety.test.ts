import { describe, expect, it } from 'vitest';
import { resolveFsPath } from '../src/server/fsSafety';

describe('resolveFsPath', () => {
  const root = '/workspace/projects';

  it('accepts a path inside the root', () => {
    expect(resolveFsPath('/workspace/projects/desk/src', root)).toBe('/workspace/projects/desk/src');
  });

  it('accepts the root itself', () => {
    expect(resolveFsPath('/workspace/projects', root)).toBe('/workspace/projects');
  });

  it('normalizes .. segments that stay inside the root', () => {
    expect(resolveFsPath('/workspace/projects/desk/../desk/src', root)).toBe('/workspace/projects/desk/src');
  });

  it('rejects .. escapes', () => {
    expect(() => resolveFsPath('/workspace/projects/../.ssh/id_rsa', root)).toThrow(/escapes/);
  });

  it('rejects sibling directories that share a name prefix with the root', () => {
    expect(() => resolveFsPath('/workspace/projectsx/file', root)).toThrow(/escapes/);
  });

  it('rejects paths outside the root entirely', () => {
    expect(() => resolveFsPath('/etc/passwd', root)).toThrow(/escapes/);
  });

  it('rejects empty and non-string paths', () => {
    expect(() => resolveFsPath('', root)).toThrow(/non-empty/);
    expect(() => resolveFsPath(undefined, root)).toThrow(/non-empty/);
    expect(() => resolveFsPath('   ', root)).toThrow(/non-empty/);
  });
});

describe('resolveFsPath trusted files', () => {
  const root = '/workspace/projects';
  const manifest = '/workspace/.config/desk/desk.yml';

  it('allows an exact trusted file outside the root', () => {
    expect(resolveFsPath(manifest, root, [manifest])).toBe(manifest);
  });

  it('matches trusted files after normalization', () => {
    expect(resolveFsPath('/workspace/.config/desk/../desk/desk.yml', root, [manifest])).toBe(manifest);
  });

  it('does not extend trust to siblings of a trusted file', () => {
    expect(() => resolveFsPath('/workspace/.config/desk/other.yml', root, [manifest])).toThrow(/escapes/);
  });

  it('does not extend trust to children of a trusted path', () => {
    expect(() => resolveFsPath(`${manifest}/nested`, root, [manifest])).toThrow(/escapes/);
  });

  it('still rejects unrelated escapes when trusted files are supplied', () => {
    expect(() => resolveFsPath('/etc/passwd', root, [manifest])).toThrow(/escapes/);
  });
});
