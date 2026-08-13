// desk#60: the moor release manifest states which lanes of the frozen matrix
// actually verified the candidate (`coverage`), precisely so a narrowed closure
// can never pass for a full one. Desk consumes the PIN, not the manifest — and
// the pin had no field for that, so the guarantee died at the projection
// boundary: a pin built from a hosted-only candidate was byte-identical to one
// built from the full six-target matrix.
//
// The pin now carries coverage verbatim, its schema version moved so a pin
// written before this cannot be read as "full", and a narrowed closure is
// REFUSED unless the operator allows it explicitly and by name.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCoverageAcceptable,
  MOOR_PIN_SCHEMA_VERSION,
  MOOR_RELEASE_REPOSITORY,
  MOOR_TARGETS,
  PIN_RELATIVE_PATH,
  readMoorPin
} from '../scripts/fetch-moor.mjs';

const CONTRACT_ASSETS: Record<string, string> = {
  'x86_64-unknown-linux-musl': 'moor-x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl': 'moor-aarch64-unknown-linux-musl',
  'x86_64-apple-darwin': 'moor-x86_64-apple-darwin',
  'aarch64-apple-darwin': 'moor-aarch64-apple-darwin',
  'x86_64-pc-windows-msvc': 'moor-x86_64-pc-windows-msvc.exe',
  'aarch64-pc-windows-msvc': 'moor-aarch64-pc-windows-msvc.exe'
};

function pinWith(coverage: unknown, overrides: Record<string, unknown> = {}) {
  const pin: Record<string, unknown> = {
    schemaVersion: MOOR_PIN_SCHEMA_VERSION,
    repository: MOOR_RELEASE_REPOSITORY,
    version: 'v0.1.0',
    commit: 'b57e094'.padEnd(40, '0'),
    coverage,
    targets: Object.fromEntries(
      (MOOR_TARGETS as readonly string[]).map((triple) => {
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

function write(pin: unknown): string {
  mkdirSync(join(root, 'scripts', 'distribution'), { recursive: true });
  writeFileSync(join(root, PIN_RELATIVE_PATH), JSON.stringify(pin));
  return root;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moor-pin-coverage-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('moor pin coverage (desk#60)', () => {
  it('accepts a full-matrix pin and hands the coverage to the caller', () => {
    const pin = readMoorPin(write(pinWith({ requiredClosure: 'full-matrix' })));
    expect(pin.coverage).toEqual({ requiredClosure: 'full-matrix' });
  });

  it('carries the unverified lanes verbatim for a narrowed closure', () => {
    const unverified = [
      {
        target: 'x86_64-pc-windows-msvc',
        gate: 'compatibility',
        lane: 'windows-10-1809-x64'
      }
    ];
    const pin = readMoorPin(
      write(pinWith({ requiredClosure: 'partial', unverified }))
    );
    expect(pin.coverage.unverified).toEqual(unverified);
  });

  it('refuses a pin with no coverage at all — the shape that lost the guarantee', () => {
    expect(() => readMoorPin(write(pinWith(undefined)))).toThrow(/coverage/);
  });

  it('refuses a pin written against the pre-coverage schema version', () => {
    // The whole point of the version move: an old pin must be rejected by
    // NAME, never silently read as though its closure were full.
    expect(() =>
      readMoorPin(write(pinWith({ requiredClosure: 'full-matrix' }, { schemaVersion: 1 })))
    ).toThrow(/schemaVersion/);
  });

  it('refuses a closure label outside the ratified three', () => {
    expect(() => readMoorPin(write(pinWith({ requiredClosure: 'mostly' })))).toThrow(
      /requiredClosure/
    );
  });

  it('refuses full-matrix that still lists unverified lanes', () => {
    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'full-matrix',
            unverified: [
              { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-10-1809-x64' }
            ]
          })
        )
      )
    ).toThrow(/full-matrix/);
  });

  it('refuses a narrowed closure that names nothing — an unfalsifiable claim', () => {
    expect(() => readMoorPin(write(pinWith({ requiredClosure: 'hosted-only' })))).toThrow(
      /unverified/
    );
    expect(() =>
      readMoorPin(write(pinWith({ requiredClosure: 'partial', unverified: [] })))
    ).toThrow(/unverified/);
  });

  it('refuses an unverified entry that is not a real matrix triple', () => {
    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'partial',
            unverified: [
              { target: 'sparc-unknown-none', gate: 'compatibility', lane: 'nowhere' }
            ]
          })
        )
      )
    ).toThrow(/target/);
  });
});

describe('narrowed coverage is an operator decision (desk#60)', () => {
  const narrowed = {
    requiredClosure: 'hosted-only',
    unverified: [
      { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-10-1809-x64' },
      { target: 'x86_64-unknown-linux-musl', gate: 'compatibility', lane: 'wsl2-ubuntu-22.04-x64' }
    ]
  };

  it('refuses to install a narrowed candidate and names every unverified lane', () => {
    const pin = readMoorPin(write(pinWith(narrowed)));
    expect(() => assertCoverageAcceptable(pin, { allowNarrowed: false })).toThrow(
      /windows-10-1809-x64.*wsl2-ubuntu-22\.04-x64|wsl2-ubuntu-22\.04-x64.*windows-10-1809-x64/s
    );
  });

  it('installs a narrowed candidate only when the operator says so by name', () => {
    const pin = readMoorPin(write(pinWith(narrowed)));
    expect(() => assertCoverageAcceptable(pin, { allowNarrowed: true })).not.toThrow();
  });

  it('never gates a full-matrix candidate', () => {
    const pin = readMoorPin(write(pinWith({ requiredClosure: 'full-matrix' })));
    expect(() => assertCoverageAcceptable(pin, { allowNarrowed: false })).not.toThrow();
  });
});
