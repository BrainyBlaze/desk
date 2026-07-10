import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

describe('Codex app-server generated bindings', () => {
  it('checks in the app-server request methods required by the Codex driver', async () => {
    const source = await readFile(
      new URL('../../../../src/server/agents/codexBindings/ClientRequest.ts', import.meta.url),
      'utf8'
    );

    const methods = [
      'initialize',
      'thread/start',
      'thread/resume',
      'thread/read',
      'turn/start',
      'turn/steer',
      'turn/interrupt'
    ];

    for (const method of methods) {
      expect(source).toContain(`"method": "${method}"`);
    }
  });

  it('records the Codex CLI version used to generate the checked-in bindings', async () => {
    const source = await readFile(
      new URL('../../../../src/server/agents/codexBindings/version.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain("codex-cli 0.142.5");
  });

  it('keeps handwritten driver imports behind one protocol adapter', async () => {
    const adapterUrl = new URL('../../../../src/server/agents/codexProtocol.ts', import.meta.url);
    expect(existsSync(adapterUrl)).toBe(true);
    if (!existsSync(adapterUrl)) {
      return;
    }
    const [adapter, driver] = await Promise.all([
      readFile(adapterUrl, 'utf8'),
      readFile(new URL('../../../../src/server/agents/drivers/codexDriver.ts', import.meta.url), 'utf8')
    ]);

    expect(adapter).toContain("codexBindings/ServerNotification.js");
    expect(adapter).toContain("codexBindings/v2/Thread.js");
    expect(driver).toContain("from '../codexProtocol.js'");
    expect(driver).not.toContain('codexBindings/');
  });

  it('exposes the guarded bindings generator as an npm script', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['generate:codex-bindings']).toBe('node scripts/generate-codex-bindings.mjs');
  });
});
