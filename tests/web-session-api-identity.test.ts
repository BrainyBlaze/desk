import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelsEvents,
  channelsMemberAdd,
  channelsQueueClear
} from '../src/web/channels/channelsClient.js';

const apiSource = readFileSync(new URL('../src/web/api.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
const engineConsoleSource = readFileSync(new URL('../src/web/channels/EngineConsole.tsx', import.meta.url), 'utf8');
const terminalSource = readFileSync(new URL('../src/web/TerminalSurface.tsx', import.meta.url), 'utf8');

function exportedFunctionSource(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const exportedEnd = source.indexOf(`export async function ${nextName}`, start + 1);
  const end = exportedEnd >= 0 ? exportedEnd : source.indexOf(`function ${nextName}`, start + 1);
  expect(start, `${name} export`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} export`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('browser session request identity', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes the channels event filter as sessionId', async () => {
    const readEvents = channelsEvents as unknown as (filter: { sessionId: string }) => Promise<unknown>;
    await readEvents({ sessionId: 'sess-7' });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('sessionId=sess-7');
    expect(url).not.toContain('tmuxSession');
  });

  it('serializes channel member and queue commands as sessionId', async () => {
    await channelsMemberAdd('desk', 'sess-7');
    await channelsQueueClear('sess-7');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      channel: 'desk',
      sessionId: 'sess-7'
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ sessionId: 'sess-7' });
  });

  it('types every workspace mutation boundary with sessionId', () => {
    const deleteSource = exportedFunctionSource(apiSource, 'deleteProjectSession', 'restartProjectSession');
    const restartSource = exportedFunctionSource(apiSource, 'restartProjectSession', 'setSessionUiMode');
    const modeSource = exportedFunctionSource(apiSource, 'setSessionUiMode', 'moveProjectSession');

    for (const source of [deleteSource, restartSource, modeSource]) {
      expect(source).toContain('sessionId');
      expect(source).not.toContain('tmuxSession');
    }
    expect(appSource).not.toContain('tmuxSession: session.spec.tmuxSession');
    expect(appSource).toContain('sessionId: session.spec.sessionId');
  });

  it('uses sessionId for engine actions and frozen terminal history', () => {
    const captureSource = exportedFunctionSource(apiSource, 'captureTerminal', 'postSnapshot');

    expect(engineConsoleSource).not.toContain('tmuxSession');
    expect(captureSource).toContain('sessionId');
    expect(captureSource).not.toContain('session: string');
    expect(terminalSource).toContain('sessionId: activeSession.spec.sessionId');
  });
});
