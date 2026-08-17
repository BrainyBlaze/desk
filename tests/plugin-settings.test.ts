// A plugin's durable configuration: a namespaced section of the manifest,
// with a subscription that also hears hand edits of desk.yml. These tests pin
// the three verbs, the namespacing, and the one property that makes subscribe
// trustworthy: manifest writes are atomic REPLACEMENTS, so the watch must
// survive the file's inode changing under it.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginSettingsStore, type PluginSettingsStore } from '../src/server/pluginSettings.js';
import { readManifestFile, writeManifestFile } from '../src/core/config.js';

describe('plugin settings store', () => {
  let dir: string;
  let manifestPath: string;
  let stores: PluginSettingsStore[];

  const store = (name: string): PluginSettingsStore => {
    const created = createPluginSettingsStore(name, manifestPath);
    stores.push(created);
    return created;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-plugin-settings-'));
    manifestPath = join(dir, 'desk.yml');
    writeFileSync(manifestPath, 'groups: []\n');
    stores = [];
  });

  afterEach(() => {
    for (const created of stores) {
      created.dispose();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a value through the manifest, namespaced by plugin name', () => {
    const gate = store('auth-gate');
    expect(gate.get()).toBeUndefined();
    gate.set({ allow: ['alice'] });
    expect(gate.get()).toEqual({ allow: ['alice'] });

    // On disk, in the manifest, under plugins.<name> — visible to the operator.
    expect(readFileSync(manifestPath, 'utf8')).toContain('auth-gate');
    expect(readManifestFile(manifestPath).plugins).toEqual({ 'auth-gate': { allow: ['alice'] } });

    // A fresh store over the same manifest sees it: durability, not memory.
    expect(createPluginSettingsStore('auth-gate', manifestPath).get()).toEqual({ allow: ['alice'] });
  });

  it('keeps plugin sections independent and preserves the rest of the manifest', () => {
    writeManifestFile(manifestPath, {
      settings: { theme: 'dark' },
      groups: [{ id: 'g', sessions: [] }],
      plugins: { other: { keep: true } }
    });
    store('mine').set({ peers: 2 });
    const manifest = readManifestFile(manifestPath);
    expect(manifest.plugins).toEqual({ other: { keep: true }, mine: { peers: 2 } });
    expect(manifest.settings).toEqual({ theme: 'dark' });
    expect(manifest.groups).toHaveLength(1);
  });

  it('notifies subscribers on set, once, with the new value', () => {
    const mine = store('mine');
    const heard: unknown[] = [];
    mine.subscribe((value) => heard.push(value));
    mine.set({ n: 1 });
    mine.set({ n: 1 }); // same value — no second notification
    mine.set({ n: 2 });
    expect(heard).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('hears an external atomic replacement of the manifest — the hand-edit door', async () => {
    const mine = store('mine');
    const heard: unknown[] = [];
    mine.subscribe((value) => heard.push(value));

    // Another process (or the operator's editor) replaces desk.yml atomically.
    writeManifestFile(manifestPath, { groups: [], plugins: { mine: { hand: 'edited' } } });
    await vi.waitFor(() => {
      expect(heard).toEqual([{ hand: 'edited' }]);
    });
  });

  it('does not wake a plugin for another plugin’s change', async () => {
    const mine = store('mine');
    mine.set({ stable: true });
    const heard: unknown[] = [];
    mine.subscribe((value) => heard.push(value));

    store('other').set({ churn: Math.random() });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard).toEqual([]);
  });

  it('unsubscribe stops notifications; dispose stops the watch', () => {
    const mine = store('mine');
    const heard: unknown[] = [];
    const unsubscribe = mine.subscribe((value) => heard.push(value));
    mine.set({ n: 1 });
    unsubscribe();
    mine.set({ n: 2 });
    expect(heard).toEqual([{ n: 1 }]);
    mine.dispose();
    mine.dispose(); // idempotent
  });
});
