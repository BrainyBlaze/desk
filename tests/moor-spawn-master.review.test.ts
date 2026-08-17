import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moorGenerationEnvKey } from '../src/server/runtime/moorLaunchChannel.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';

describe('spawnMoorMaster adversarial review', () => {
  it('preserves POSIX basename semantics for a literal backslash', () => {
    expect(moorGenerationEnvKey(String.raw`/opt/desk/moor\alias`)).toBe(
      'MOOR_ALIAS_GENERATION'
    );
  });

  it(
    'contains launch-channel errors when the executable cannot start',
    async () => {
      const { child } = spawnMoorMaster({
        binPath: join(tmpdir(), `missing-moor-${process.pid}-${Date.now()}`),
        args: [],
        generation: 2
      });

      const childError = await new Promise<NodeJS.ErrnoException>((resolve) => {
        child.once('error', (error) => resolve(error as NodeJS.ErrnoException));
      });
      expect(childError.code).toBe('ENOENT');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  );

  it('does not leak a stale generation carrier for a different invocation name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-spawn-review-'));
    try {
      const probePath = join(root, 'probe.cjs');
      const reportPath = join(root, 'report.json');
      writeFileSync(
        probePath,
        `
const { readFileSync, writeFileSync } = require('node:fs');
readFileSync(Number(process.env.MOOR_LAUNCH_CHANNEL));
writeFileSync(process.argv[2], JSON.stringify({
  ATCH_GENERATION: process.env.ATCH_GENERATION,
  APPLICATION_GENERATION: process.env.APPLICATION_GENERATION,
  MOOR_GENERATION: process.env.MOOR_GENERATION,
  MOOR_SESSION_GENERATION: process.env.MOOR_SESSION_GENERATION,
  DESK_SESSION_GENERATION: process.env.DESK_SESSION_GENERATION
}));
`
      );

      const { child } = spawnMoorMaster({
        binPath: process.execPath,
        argv0: '/opt/desk/libexec/moor',
        args: [probePath, reportPath],
        generation: 23,
        env: {
          PATH: process.env.PATH ?? '',
          ATCH_GENERATION: '99',
          APPLICATION_GENERATION: 'preserve-me'
        }
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
      expect(exitCode).toBe(0);

      const environment = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<
        string,
        string | undefined
      >;
      expect(environment).toEqual({
        APPLICATION_GENERATION: 'preserve-me',
        MOOR_GENERATION: '23',
        MOOR_SESSION_GENERATION: '23',
        DESK_SESSION_GENERATION: '23'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
