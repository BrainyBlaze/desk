import { mkdtempSync, readFileSync, rmSync, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManifestRepository,
  type ManifestRepository,
  type PluginSettingsStore
} from '../src/server/pluginSettings.js';
import { readManifestFile, writeManifestFile } from '../src/core/config.js';

describe('process manifest repository and plugin settings views', () => {
  let dir: string;
  let manifestPath: string;
  let repository: ManifestRepository;
  let stores: PluginSettingsStore[];

  const store = (name: string): PluginSettingsStore => {
    const created = repository.pluginSettings(name);
    stores.push(created);
    return created;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-plugin-settings-'));
    manifestPath = join(dir, 'desk.yml');
    writeFileSync(manifestPath, 'groups: []\n');
    repository = createManifestRepository(manifestPath);
    stores = [];
  });

  afterEach(() => {
    for (const created of stores) {
      created.dispose();
    }
    repository.dispose();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a value through one typed manifest projection', () => {
    const gate = store('auth-gate');
    expect(gate.state()).toMatchObject({ status: 'ready', value: undefined });
    gate.set({ allow: ['alice'] });
    expect(gate.get()).toEqual({ allow: ['alice'] });

    expect(readFileSync(manifestPath, 'utf8')).toContain('auth-gate');
    expect(readManifestFile(manifestPath).plugins).toEqual({ 'auth-gate': { allow: ['alice'] } });
    expect(repository.pluginSettings('auth-gate').get()).toEqual({ allow: ['alice'] });
  });

  it('keeps plugin sections independent and preserves the rest of the manifest', () => {
    writeManifestFile(manifestPath, {
      settings: { theme: 'dark' },
      groups: [{ id: 'g', sessions: [] }],
      plugins: { other: { keep: true } }
    });
    repository.refresh();

    store('mine').set({ peers: 2 });
    const manifest = readManifestFile(manifestPath);
    expect(manifest.plugins).toEqual({ other: { keep: true }, mine: { peers: 2 } });
    expect(manifest.settings).toEqual({ theme: 'dark' });
    expect(manifest.groups).toHaveLength(1);
  });

  it('notifies value subscribers only when that plugin section changes', () => {
    const mine = store('mine');
    const heard: unknown[] = [];
    mine.subscribe((value) => heard.push(value));
    mine.set({ n: 1 });
    mine.set({ n: 1 });
    store('other').set({ churn: true });
    mine.set({ n: 2 });

    expect(heard).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('isolates a failing plugin listener from sibling subscribers and writers', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mine = store('mine');
    const heard: unknown[] = [];
    mine.subscribe(() => {
      throw new Error('listener failed');
    });
    mine.subscribe((value) => heard.push(value));

    expect(() => mine.set({ durable: true })).not.toThrow();
    expect(heard).toEqual([{ durable: true }]);
    expect(report).toHaveBeenCalledOnce();
  });

  it('hears an external atomic replacement through the shared directory watcher', async () => {
    const mine = store('mine');
    const heard: unknown[] = [];
    mine.subscribe((value) => heard.push(value));

    writeManifestFile(manifestPath, { groups: [], plugins: { mine: { hand: 'edited' } } });
    await vi.waitFor(() => {
      expect(heard).toEqual([{ hand: 'edited' }]);
    });
  });

  it('publishes manifest corruption as an explicit error and recovers after repair', async () => {
    const mine = store('mine');
    const states: ReturnType<typeof mine.state>[] = [];
    mine.subscribeState((state) => states.push(state));

    writeFileSync(manifestPath, 'groups: [\n');
    await vi.waitFor(() => {
      expect(mine.state()).toMatchObject({ status: 'error' });
    });
    expect(() => mine.get()).toThrow('desk manifest unavailable');

    writeManifestFile(manifestPath, { groups: [], plugins: { mine: { repaired: true } } });
    await vi.waitFor(() => {
      expect(mine.state()).toMatchObject({
        status: 'ready',
        value: { repaired: true }
      });
    });
    expect(states.some((state) => state.status === 'error')).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: 'ready', value: { repaired: true } });
  });

  it('creates one watcher for every plugin view in the repository', () => {
    repository.dispose();
    const close = vi.fn();
    const watcher = {
      close,
      on: vi.fn().mockReturnThis(),
      unref: vi.fn()
    } as unknown as FSWatcher;
    const watchDirectory = vi.fn(() => watcher);
    repository = createManifestRepository(manifestPath, { watchDirectory });

    store('one').subscribe(() => undefined);
    store('two').subscribeState(() => undefined);

    expect(watchDirectory).toHaveBeenCalledOnce();
    repository.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops value notifications and view disposal is idempotent', () => {
    const mine = store('mine');
    const heard: unknown[] = [];
    const unsubscribe = mine.subscribe((value) => heard.push(value));
    mine.set({ n: 1 });
    unsubscribe();
    mine.set({ n: 2 });
    expect(heard).toEqual([{ n: 1 }]);
    mine.dispose();
    mine.dispose();
  });
});
