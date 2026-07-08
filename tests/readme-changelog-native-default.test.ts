import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = () => readFileSync('README.md', 'utf8');
const changelog = () => readFileSync('CHANGELOG.md', 'utf8');

describe('native UI product documentation', () => {
  it('positions native chat as the default agent surface in the README', () => {
    const source = readme();

    expect(source).toContain('Native chat UI for coding-agent fleets');
    expect(source).toContain('SDK-backed agents open in the native chat surface by default');
    expect(source).toContain('Terminal UI is available');
    expect(source).toContain('### Native agent UI');
    expect(source).toContain('switch the session to terminal UI');
    expect(source).not.toContain('New SDK-backed agents');
    expect(source).not.toContain('Terminal UI remains');
  });

  it('records the native-default product change in the changelog', () => {
    const source = changelog();

    expect(source).toContain('**Native agents — native UI is the default surface.**');
    expect(source).toMatch(/Codex, Claude, and\s+OpenCode sessions start in the native chat surface/);
    expect(source).toContain('Terminal UI is selectable per session');
    expect(source).not.toMatch(/native UI is now|New Codex|sessions now start|Terminal UI remains/);
  });
});
