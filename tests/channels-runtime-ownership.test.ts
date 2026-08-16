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

  it('names the loss when the live lease is destroyed from under the owner, instead of dying in a timer', async () => {
    // A lease that vanishes from under a live owner (an operator wiping
    // `_engine`, a filesystem fault, a foreign tool) is a compromised
    // ownership: the library's default is to THROW from inside its refresh
    // timer — an unhandled exception with no server name and no explanation.
    // The designed behaviour is a named, loud exit: the process ends with a
    // diagnostic that says the Channels ownership lease was lost, so the
    // operator learns why the server stopped instead of finding a bare
    // ECOMPROMISED in a crash log.
    const owner = startChannelsRuntimeOwner(home);
    await owner.ready;
    rmSync(join(home, '_engine'), { recursive: true, force: true });
    const result = await owner.exit;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Channels ownership lease .* was lost/);
    expect(result.stderr).toContain(home);
    // The successor is not blocked by the dead owner.
    expect(() => initChannelsRuntime({ home })).not.toThrow();
  }, 15_000);

  it('fails directly when an obsolete ownership artifact reaches the runtime boundary, naming the real remedy', () => {
    const engineDir = join(home, '_engine');
    mkdirSync(engineDir, { recursive: true });
    const artifact = join(engineDir, 'engine.pid');
    writeFileSync(artifact, '123\n456\n');

    // The refusal must tell the operator what to actually DO. The retired
    // engine only removed this file on its crash-reclaim path — an orderly
    // stop leaves it behind — and no installer or script touches it, so a
    // remedy that points at "the installer" points at a mechanism that does
    // not exist. The honest remedy is the file itself: stop every Desk
    // server for this home, delete the artifact, restart. Nothing else reads
    // it, and it carries no authority under the lease scheme.
    let message = '';
    try {
      initChannelsRuntime({ home });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/obsolete Channels ownership artifact/);
    expect(message).toMatch(/stop every Desk server for this home/i);
    // The instruction itself must name the file to delete — not merely the
    // "artifact at <path>" prefix, which would survive a remedy that forgot
    // the path.
    expect(message).toContain(`delete ${artifact}`);
    expect(message).not.toMatch(/installer/);
  });
});
