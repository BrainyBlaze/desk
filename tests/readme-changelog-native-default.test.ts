import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = () => readFileSync('README.md', 'utf8');
const changelog = () => readFileSync('CHANGELOG.md', 'utf8');

describe('native UI product documentation', () => {
  it('positions terminal cells as the default and native chat as the opt-in surface', () => {
    const source = readme();

    expect(source).toContain('Native chat UI for coding-agent fleets');
    expect(source).toContain('Sessions open in durable terminal cells by default');
    expect(source).toContain('### Native agent UI');
    expect(source).toContain('switch the session to terminal UI');
    // The code resolves an omitted uiMode to terminal for every agent
    // (resolveSessionUiMode); the README must not drift back to claiming a
    // native default.
    expect(source).not.toContain('native chat surface by default');
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
