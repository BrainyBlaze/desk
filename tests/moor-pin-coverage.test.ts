import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchMoor,
  MOOR_PIN_SCHEMA_VERSION,
  MOOR_RELEASE_REPOSITORY,
  MOOR_TARGETS,
  parseFetchMoorArgs,
  PIN_RELATIVE_PATH,
  readMoorPin
} from '../scripts/fetch-moor.mjs';

const CONTRACT_ASSETS: Record<string, string> = {
  'x86_64-unknown-linux-musl': 'moor-0.1.0-linux-x64',
  'aarch64-unknown-linux-musl': 'moor-0.1.0-linux-arm64',
  'x86_64-apple-darwin': 'moor-0.1.0-macos-x64',
  'aarch64-apple-darwin': 'moor-0.1.0-macos-arm64'
};

function pinWith(coverage: unknown, overrides: Record<string, unknown> = {}) {
  const pin: Record<string, unknown> = {
    schemaVersion: MOOR_PIN_SCHEMA_VERSION,
    repository: MOOR_RELEASE_REPOSITORY,
    version: 'v0.1.0',
    commit: '526cbb2df57a61240d8a6c135b55888716cf32c9',
    coverage,
    targets: Object.fromEntries(
      MOOR_TARGETS.map((triple) => {
        const bytes = Buffer.from(`binary for ${triple}`);
        return [
          triple,
          {
            asset: CONTRACT_ASSETS[triple],
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex')
          }
        ];
      })
    ),
    ...overrides
  };
  if (coverage === undefined) delete pin.coverage;
  return pin;
}

let root: string;

function writeSource(source: string): string {
  mkdirSync(join(root, 'scripts', 'distribution'), { recursive: true });
  writeFileSync(join(root, PIN_RELATIVE_PATH), source);
  return root;
}

function write(pin: unknown): string {
  return writeSource(JSON.stringify(pin));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moor-pin-coverage-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Moor pin closure', () => {
  it('binds the consumer to the exact four-target matrix', () => {
    expect(MOOR_TARGETS).toEqual([
      'x86_64-unknown-linux-musl',
      'aarch64-unknown-linux-musl',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin'
    ]);
  });

  it('accepts full-matrix coverage', () => {
    const pin = readMoorPin(write(pinWith({ requiredClosure: 'full-matrix' })));
    expect(pin.coverage).toEqual({ requiredClosure: 'full-matrix' });
  });

  it('refuses a pin with no coverage', () => {
    expect(() => readMoorPin(write(pinWith(undefined)))).toThrow(/coverage/);
  });

  it('diagnoses a legacy v1 pin as predating coverage', () => {
    expect(() =>
      readMoorPin(write(pinWith(undefined, { schemaVersion: 1 })))
    ).toThrow(/predates release coverage/);
  });

  it('refuses every closure label except full-matrix', () => {
    expect(() =>
      readMoorPin(write(pinWith({ requiredClosure: 'partial' })))
    ).toThrow(/requiredClosure/);
  });

  it('refuses secondary coverage fields, including a narrowed shape', () => {
    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'full-matrix',
            unverified: []
          })
        )
      )
    ).toThrow(/exactly \[requiredClosure\]/);

    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'partial',
            unverified: []
          })
        )
      )
    ).toThrow(/exactly \[requiredClosure\]|requiredClosure/);
  });

  it.each([
    ['literal', '"requiredClosure":"partial","requiredClosure":"full-matrix"'],
    ['escaped', '"required\\u0043losure":"partial","requiredClosure":"full-matrix"']
  ])('refuses %s duplicate coverage discriminators', (_label, duplicate) => {
    const source = JSON.stringify(pinWith({ requiredClosure: 'full-matrix' })).replace(
      '"requiredClosure":"full-matrix"',
      duplicate
    );
    expect(() => readMoorPin(writeSource(source))).toThrow(/duplicate JSON key: requiredClosure/);
  });
});

describe('fetch CLI closure', () => {
  it('has no approval flags', () => {
    expect(parseFetchMoorArgs([])).toEqual({});
  });

  it.each([
    ['--allow-narrowed-coverage'],
    ['--allow-narrowed'],
    ['--force']
  ])('refuses the retired or unknown argument %s', (argument) => {
    expect(() => parseFetchMoorArgs([argument])).toThrow(/unknown argument/);
  });
});

describe('release builder closure', () => {
  it('accepts a full four-target pin', async () => {
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    expect(() => validateMoorPin(pinWith({ requiredClosure: 'full-matrix' }))).not.toThrow();
  });

  it('rejects a legacy pin', async () => {
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    expect(() =>
      validateMoorPin({
        schemaVersion: 1,
        repository: MOOR_RELEASE_REPOSITORY,
        version: 'v0.1.0',
        commit: 'b'.repeat(40),
        targets: {}
      })
    ).toThrow(/predates release coverage/);
  });

  it('rejects a narrowed pin', async () => {
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    expect(() =>
      validateMoorPin(
        pinWith({
          requiredClosure: 'partial',
          unverified: []
        })
      )
    ).toThrow(/full-matrix/);
  });
});

describe('pin version grammar', () => {
  it('refuses a version component with a leading zero', async () => {
    write(pinWith({ requiredClosure: 'full-matrix' }, { version: 'v01.2.3' }));
    await expect(fetchMoor({ root })).rejects.toThrow(/canonical tag/);
  });

  it('accepts canonical zero components before attempting acquisition', async () => {
    write(pinWith({ requiredClosure: 'full-matrix' }, { version: 'v0.1.0' }));
    await expect(
      fetchMoor({ root, baseUrl: `file://${join(root, 'missing')}` })
    ).rejects.toThrow(/ENOENT/);
  });
});
