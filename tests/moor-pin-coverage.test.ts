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
  MOOR_DEFERRED_TRIPLES,
  NARROWED_COVERAGE_FLAG,
  parseFetchMoorArgs,
  fetchMoor,
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

// Workflow 31750058794, immutable artifact 9200843447 at f1bd230bdaf0a7a476f4069a95a2cee77996ab48.
// Keep this literal so Desk's own deferred-triple constant cannot make the witness self-confirming.
const AUTHORITATIVE_HOSTED_ONLY_COVERAGE = {
  requiredClosure: 'hosted-only',
  unverified: [
    {
      target: 'x86_64-pc-windows-msvc',
      gate: 'compatibility',
      lane: 'windows-10-1809-x64'
    },
    {
      target: 'x86_64-pc-windows-msvc',
      gate: 'compatibility',
      lane: 'windows-server-2019-x64'
    },
    {
      target: 'x86_64-pc-windows-msvc',
      gate: 'native-conformance',
      lane: 'windows-10-1809-x64'
    },
    {
      target: 'x86_64-pc-windows-msvc',
      gate: 'native-conformance',
      lane: 'windows-server-2019-x64'
    },
    {
      target: 'x86_64-unknown-linux-musl',
      gate: 'compatibility',
      lane: 'wsl1-ubuntu-22.04-x64'
    },
    {
      target: 'x86_64-unknown-linux-musl',
      gate: 'compatibility',
      lane: 'wsl2-ubuntu-22.04-x64'
    }
  ]
} as const;

function pinWith(coverage: unknown, overrides: Record<string, unknown> = {}) {
  const pin: Record<string, unknown> = {
    schemaVersion: MOOR_PIN_SCHEMA_VERSION,
    repository: MOOR_RELEASE_REPOSITORY,
    version: 'v0.1.0',
    commit: 'f1bd230bdaf0a7a476f4069a95a2cee77996ab48',
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
  return writeSource(JSON.stringify(pin));
}

function writeSource(source: string): string {
  mkdirSync(join(root, 'scripts', 'distribution'), { recursive: true });
  writeFileSync(join(root, PIN_RELATIVE_PATH), source);
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

  it('diagnoses a REAL legacy v1 pin as predating coverage', () => {
    // A genuine pre-coverage pin carries the old version AND no coverage at
    // all. Reporting that as a key-set mismatch hides the one fact that
    // matters, so the version is diagnosed before the key set.
    const legacy = pinWith(undefined, { schemaVersion: 1 });
    expect(() => readMoorPin(write(legacy))).toThrow(/predates release coverage/);
  });

  it('refuses a closure label outside the ratified three', () => {
    expect(() => readMoorPin(write(pinWith({ requiredClosure: 'mostly' })))).toThrow(
      /requiredClosure/
    );
  });

  it.each([
    ['literal', '"requiredClosure":"hosted-only","requiredClosure":"full-matrix"'],
    ['escaped', '"required\\u0043losure":"hosted-only","requiredClosure":"full-matrix"']
  ])('refuses %s duplicate coverage discriminators before JSON parsing can collapse them', (_label, duplicate) => {
    const source = JSON.stringify(pinWith({ requiredClosure: 'full-matrix' })).replace(
      '"requiredClosure":"full-matrix"',
      duplicate
    );
    expect(() => readMoorPin(writeSource(source))).toThrow(/duplicate JSON key: requiredClosure/);
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

  it('refuses a real target paired with an invented gate or lane', () => {
    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'partial',
            unverified: [
              { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-11-x64' }
            ]
          })
        )
      )
    ).toThrow(/not one of the deferred triples/);
  });

  it('refuses a duplicated unverified lane', () => {
    const entry = {
      target: 'x86_64-pc-windows-msvc',
      gate: 'compatibility',
      lane: 'windows-10-1809-x64'
    };
    expect(() =>
      readMoorPin(write(pinWith({ requiredClosure: 'partial', unverified: [entry, entry] })))
    ).toThrow(/more than once/);
  });

  it('refuses unverified lanes that are not in canonical ascending order', () => {
    const [first, second] = MOOR_DEFERRED_TRIPLES;
    const parse = (triple: string) => {
      const [target, gate, lane] = triple.split('/');
      return { target, gate, lane };
    };
    expect(() =>
      readMoorPin(
        write(pinWith({ requiredClosure: 'partial', unverified: [parse(second), parse(first)] }))
      )
    ).toThrow(/ascend canonically/);
  });

  it('refuses a label that contradicts how much is actually missing', () => {
    const parse = (triple: string) => {
      const [target, gate, lane] = triple.split('/');
      return { target, gate, lane };
    };
    // hosted-only claims the WHOLE deferred set is missing; one entry is not.
    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'hosted-only',
            unverified: [parse(MOOR_DEFERRED_TRIPLES[0])]
          })
        )
      )
    ).toThrow(/contradicts its own list/);
    // partial claims a proper subset; all six is not a proper subset.
    expect(() =>
      readMoorPin(
        write(
          pinWith({
            requiredClosure: 'partial',
            unverified: MOOR_DEFERRED_TRIPLES.map(parse)
          })
        )
      )
    ).toThrow(/contradicts its own list/);
  });

  it('preserves the authoritative hosted-only candidate coverage verbatim', () => {
    const pin = readMoorPin(write(pinWith(AUTHORITATIVE_HOSTED_ONLY_COVERAGE)));
    expect(pin.coverage).toEqual(AUTHORITATIVE_HOSTED_ONLY_COVERAGE);
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
    ).toThrow(/not one of the deferred triples/);
  });
});

describe('narrowed coverage is an operator decision (desk#60)', () => {
  // Two of the six deferred lanes missing is a proper subset: `partial`.
  const narrowed = {
    requiredClosure: 'partial',
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

  it('refuses the authoritative hosted-only candidate unless explicitly approved', () => {
    const pin = readMoorPin(write(pinWith(AUTHORITATIVE_HOSTED_ONLY_COVERAGE)));
    let diagnostic = '';
    try {
      assertCoverageAcceptable(pin, { allowNarrowed: false });
    } catch (error) {
      diagnostic = String(error);
    }

    expect(diagnostic).toContain('not full-matrix');
    for (const entry of AUTHORITATIVE_HOSTED_ONLY_COVERAGE.unverified) {
      expect(diagnostic).toContain(`${entry.target}/${entry.gate}/${entry.lane}`);
    }
    expect(() => assertCoverageAcceptable(pin, { allowNarrowed: true })).not.toThrow();
  });

  it('never gates a full-matrix candidate', () => {
    const pin = readMoorPin(write(pinWith({ requiredClosure: 'full-matrix' })));
    expect(() => assertCoverageAcceptable(pin, { allowNarrowed: false })).not.toThrow();
  });
});

describe('approval is a command-line decision only (desk#60)', () => {
  it('does not approve anything by default', () => {
    expect(parseFetchMoorArgs([])).toEqual({ allowNarrowedCoverage: false });
  });

  it('approves a narrowed candidate only through the spelled-out flag', () => {
    expect(parseFetchMoorArgs([NARROWED_COVERAGE_FLAG])).toEqual({
      allowNarrowedCoverage: true
    });
  });

  it('refuses an unknown argument instead of ignoring it', () => {
    // A silently dropped flag is how an operator believes they approved
    // something they did not.
    expect(() => parseFetchMoorArgs(['--allow-narrowed'])).toThrow(/unknown argument/);
    expect(() => parseFetchMoorArgs([NARROWED_COVERAGE_FLAG, '--force'])).toThrow(
      /unknown argument/
    );
  });

  it('cannot be approved by an environment variable', () => {
    // The env opt-in was replaced deliberately: a variable set once in a shell
    // profile turns a deliberate decision into a permanent default.
    process.env.DESK_MOOR_ALLOW_NARROWED_COVERAGE = '1';
    try {
      const pin = readMoorPin(
        write(
          pinWith({
            requiredClosure: 'partial',
            unverified: [
              { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-10-1809-x64' }
            ]
          })
        )
      );
      expect(() => assertCoverageAcceptable(pin)).toThrow(/not full-matrix/);
    } finally {
      delete process.env.DESK_MOOR_ALLOW_NARROWED_COVERAGE;
    }
  });
});

describe('the release builder refuses a pin that cannot state its closure (desk#60)', () => {
  it('rejects a true legacy v1 pin instead of publishing from it', async () => {
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    const legacy = {
      schemaVersion: 1,
      repository: MOOR_RELEASE_REPOSITORY,
      version: 'v0.1.0',
      commit: 'b'.repeat(40),
      targets: {}
    };
    // By NAME, not a generic key-set complaint: the builder claims this
    // diagnostic, so the test must hold it to exactly that claim.
    expect(() => validateMoorPin(legacy)).toThrow(/predates release coverage/);
  });

  it('refuses to publish the authoritative hosted-only candidate', async () => {
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    // A developer may install a narrowed candidate deliberately; end users must
    // never receive one baked into a release asset.
    const narrowed = pinWith(AUTHORITATIVE_HOSTED_ONLY_COVERAGE);
    expect(() => validateMoorPin(narrowed)).toThrow(/full-matrix/);
  });
});

describe('the public fetch path refuses fail-open approval (desk#60)', () => {
  const narrowed = {
    requiredClosure: 'partial',
    unverified: [
      { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-10-1809-x64' }
    ]
  };

  it('refuses a repeated approval flag rather than collapsing it to one', async () => {
    // Verified ad hoc during implementation, which protects nothing: a witness
    // that is not committed cannot fail when someone relaxes the parser.
    expect(() =>
      parseFetchMoorArgs([NARROWED_COVERAGE_FLAG, NARROWED_COVERAGE_FLAG])
    ).toThrow(/at most once/);
  });

  it.each([['false'], [1], [{}], [[]]])(
    'refuses %s as programmatic approval through the public fetchMoor entry',
    async (value) => {
      write(pinWith(narrowed));
      await expect(
        fetchMoor({ root, allowNarrowedCoverage: value as never })
      ).rejects.toThrow(/literal boolean/);
    }
  );

  it('still refuses the authoritative hosted-only candidate when approval is absent', async () => {
    write(pinWith(AUTHORITATIVE_HOSTED_ONLY_COVERAGE));
    await expect(fetchMoor({ root })).rejects.toThrow(/not full-matrix/);
  });
});
