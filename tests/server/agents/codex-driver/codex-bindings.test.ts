import { describe, expect, it } from 'vitest';
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
});
