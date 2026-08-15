import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initChannelsRuntime,
  resetChannelsRuntime
} from '../src/server/channelsApi.js';
import { startChannelsRuntimeOwner } from './helpers/channels-runtime-owner-process.js';

describe('Channels runtime ownership', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-channels-runtime-owner-'));
    resetChannelsRuntime();
  });

  afterEach(() => {
    resetChannelsRuntime();
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects a second live Desk runtime instead of serving passively', async () => {
    const owner = startChannelsRuntimeOwner(home);
    await owner.ready;
    try {
      expect(() => initChannelsRuntime({ home })).toThrow(
        /another Desk server owns Channels/
      );
    } finally {
      await owner.release();
    }
  });

  it('releases ownership on orderly shutdown without a persistent pid record', async () => {
    const owner = startChannelsRuntimeOwner(home);
    await owner.ready;

    expect(existsSync(join(home, '_engine', 'engine.pid'))).toBe(false);
    await owner.release();

    expect(() => initChannelsRuntime({ home })).not.toThrow();
  });

  it('recovers ownership after a killed runtime without parsing process identity', async () => {
    const owner = startChannelsRuntimeOwner(home);
    await owner.ready;
    owner.child.kill('SIGKILL');
    await owner.exit;

    expect(existsSync(join(home, '_engine', 'engine.pid'))).toBe(false);
    const leasePath = join(home, '_engine', 'server-owner.lease');
    expect(existsSync(leasePath)).toBe(true);
    utimesSync(leasePath, new Date(0), new Date(0));
    expect(() => initChannelsRuntime({ home })).not.toThrow();
  });

  it('fails directly when an obsolete ownership artifact reaches the runtime boundary', () => {
    const engineDir = join(home, '_engine');
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(join(engineDir, 'engine.pid'), '123\n456\n');

    expect(() => initChannelsRuntime({ home })).toThrow(
      /obsolete Channels ownership artifact/
    );
  });
});
