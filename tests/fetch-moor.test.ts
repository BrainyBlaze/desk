// Binding tests for the moor acquirer against the reviewed release contract
// (moor repo docs/release-manifest-v1.md @ b57e094): the Desk pin projection's
// exact key sets, the six literal v0.1.0 asset filenames, the production URL
// derivation, and the fail-closed download/verify/install pipeline over an
// explicit file:// fixture base (the contract's candidate-override mechanism).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MOOR_PIN_SCHEMA_VERSION,
  MOOR_RELEASE_REPOSITORY,
  MOOR_TARGETS,
  PIN_RELATIVE_PATH,
  assetUrl,
  fetchMoor,
  moorTargetTriple,
  readMoorPin
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore plain-JS module without type declarations
} from '../scripts/fetch-moor.mjs';

/** The literal v0.1.0 release asset table from the reviewed contract. */
const CONTRACT_ASSETS: Record<string, string> = {
  'x86_64-unknown-linux-musl': 'moor-0.1.0-linux-x64',
  'aarch64-unknown-linux-musl': 'moor-0.1.0-linux-arm64',
  'x86_64-apple-darwin': 'moor-0.1.0-macos-x64',
  'aarch64-apple-darwin': 'moor-0.1.0-macos-arm64',
  'x86_64-pc-windows-msvc': 'moor-0.1.0-windows-x64.exe',
  'aarch64-pc-windows-msvc': 'moor-0.1.0-windows-arm64.exe'
};

function pinFor(bytesByTarget: Record<string, Buffer>) {
  return {
    schemaVersion: MOOR_PIN_SCHEMA_VERSION,
    repository: MOOR_RELEASE_REPOSITORY,
    // desk#60: a pin states which lanes verified the candidate. These fixtures
    // exercise the full frozen matrix, so they carry the full-matrix closure.
    coverage: { requiredClosure: 'full-matrix' },
    version: 'v0.1.0',
    commit: 'b57e094'.padEnd(40, '0'),
    targets: Object.fromEntries(
      (MOOR_TARGETS as readonly string[]).map((triple) => {
        const bytes = bytesByTarget[triple] ?? Buffer.from(`binary for ${triple}`);
        return [
          triple,
          {
            asset: CONTRACT_ASSETS[triple],
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex')
          }
        ];
      })
    )
  };
}

function writeFixture(root: string, pin: unknown, bytesByTarget: Record<string, Buffer>) {
  mkdirSync(join(root, 'scripts', 'distribution'), { recursive: true });
  writeFileSync(join(root, PIN_RELATIVE_PATH), JSON.stringify(pin));
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const triple of MOOR_TARGETS as readonly string[]) {
    const bytes = bytesByTarget[triple] ?? Buffer.from(`binary for ${triple}`);
    writeFileSync(join(assets, CONTRACT_ASSETS[triple]), bytes);
  }
  return pathToFileURL(assets).href;
}

describe('moor acquirer × reviewed release contract (b57e094)', () => {
  it('accepts the contract pin projection and derives the production URL exactly', () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-pin-'));
    try {
      writeFixture(root, pinFor({}), {});
      const pin = readMoorPin(root);
      for (const triple of MOOR_TARGETS as readonly string[]) {
        // Production: ${repository}/releases/download/${version}/${asset}.
        expect(assetUrl(pin, triple, undefined)).toBe(
          `${MOOR_RELEASE_REPOSITORY}/releases/download/v0.1.0/${CONTRACT_ASSETS[triple]}`
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps every supported host to a contract target and fails closed elsewhere', () => {
    expect(moorTargetTriple({ platform: 'linux', arch: 'x64' })).toBe('x86_64-unknown-linux-musl');
    expect(moorTargetTriple({ platform: 'linux', arch: 'arm64' })).toBe('aarch64-unknown-linux-musl');
    expect(moorTargetTriple({ platform: 'darwin', arch: 'x64' })).toBe('x86_64-apple-darwin');
    expect(moorTargetTriple({ platform: 'darwin', arch: 'arm64' })).toBe('aarch64-apple-darwin');
    expect(moorTargetTriple({ platform: 'win32', arch: 'x64' })).toBe('x86_64-pc-windows-msvc');
    expect(moorTargetTriple({ platform: 'win32', arch: 'arm64' })).toBe('aarch64-pc-windows-msvc');
    expect(() => moorTargetTriple({ platform: 'freebsd', arch: 'x64' })).toThrow(/unsupported platform/);
    expect(() => moorTargetTriple({ platform: 'linux', arch: 'ia32' })).toThrow(/unsupported CPU/);
  });

  it('DEFAULT attestation passes on an argv0-sensitive real binary: staging must use the canonical basename (desk#40)', async () => {
    // No injected attest — the default probe runs the staged file. The moor
    // spec (§3) answers `<invoked-basename> <version>`, so staging under any
    // name but `moor` (e.g. `moor.tmp-<pid>`) would answer the wrong string
    // and reject every real asset.
    const root = mkdtempSync(join(tmpdir(), 'moor-argv0-'));
    try {
      const triple = 'x86_64-unknown-linux-musl';
      const bytes = Buffer.from('#!/bin/sh\nprintf \'%s 0.1.0\\n\' "$(basename "$0")"\n');
      const baseUrl = writeFixture(root, pinFor({ [triple]: bytes }), { [triple]: bytes });
      const result = await fetchMoor({ root, triple, baseUrl });
      expect(result).toMatchObject({ triple, version: 'v0.1.0' });
      expect(readFileSync(join(root, 'libexec', 'moor'))).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('downloads, verifies, installs atomically, and attests over the candidate override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-fetch-'));
    try {
      const triple = 'x86_64-unknown-linux-musl';
      const bytes = Buffer.from('real holder bytes for the fixture');
      const baseUrl = writeFixture(root, pinFor({ [triple]: bytes }), { [triple]: bytes });
      const attested: string[] = [];
      const result = await fetchMoor({
        root,
        triple,
        baseUrl,
        attest: (path: string) => {
          attested.push(path);
          return { ok: true };
        }
      });
      expect(result).toMatchObject({ triple, version: 'v0.1.0' });
      expect(readFileSync(join(root, 'libexec', 'moor'))).toEqual(bytes);
      // Attestation ran against the STAGED file, before promotion.
      expect(attested).toHaveLength(1);
      expect(attested[0]).not.toBe(join(root, 'libexec', 'moor'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects digest and size mismatches without leaving a partial install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-bad-'));
    try {
      const triple = 'x86_64-unknown-linux-musl';
      const bytes = Buffer.from('actual bytes');
      const pin = pinFor({ [triple]: bytes });
      // Pin claims different bytes than the fixture serves.
      (pin.targets as Record<string, { sha256: string }>)[triple].sha256 = 'c'.repeat(64);
      const baseUrl = writeFixture(root, pin, { [triple]: bytes });
      await expect(
        fetchMoor({ root, triple, baseUrl, attest: () => ({ ok: true }) })
      ).rejects.toThrow(/digest mismatch/);
      expect(existsSync(join(root, 'libexec', 'moor'))).toBe(false);

      const sizePin = pinFor({ [triple]: bytes });
      (sizePin.targets as Record<string, { size: number }>)[triple].size = bytes.length + 1;
      writeFileSync(join(root, PIN_RELATIVE_PATH), JSON.stringify(sizePin));
      await expect(
        fetchMoor({ root, triple, baseUrl, attest: () => ({ ok: true }) })
      ).rejects.toThrow(/size mismatch/);
      expect(existsSync(join(root, 'libexec', 'moor'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a failed attestation aborts before promotion (no libexec/moor appears)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-attest-'));
    try {
      const triple = 'x86_64-unknown-linux-musl';
      const bytes = Buffer.from('imposter bytes');
      const baseUrl = writeFixture(root, pinFor({ [triple]: bytes }), { [triple]: bytes });
      await expect(
        fetchMoor({ root, triple, baseUrl, attest: () => ({ ok: false, reason: 'wrong answer' }) })
      ).rejects.toThrow(/failed attestation/);
      expect(existsSync(join(root, 'libexec', 'moor'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on an unpinned tree and on hostile pin mutations', () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-hostile-'));
    try {
      expect(() => readMoorPin(root)).toThrow(/no pinned moor release/);
      const good = pinFor({});
      const mutations: Array<[string, (pin: Record<string, unknown>) => void]> = [
        ['extra top-level key', (p) => { p.mirror = 'https://evil'; }],
        ['missing commit', (p) => { delete p.commit; }],
        // Relative to the supported version, so this case keeps its meaning
        // the next time the pin schema moves (it moved to 2 for desk#60).
        ['wrong schemaVersion', (p) => { p.schemaVersion = MOOR_PIN_SCHEMA_VERSION + 1; }],
        ['foreign repository', (p) => { p.repository = 'https://github.com/evil/moor'; }],
        ['noncanonical version', (p) => { p.version = '0.1.0'; }],
        ['rc version', (p) => { p.version = 'v0.1.0-rc1'; }],
        ['missing target', (p) => { delete (p.targets as Record<string, unknown>)['x86_64-apple-darwin']; }],
        ['seventh target', (p) => { (p.targets as Record<string, unknown>)['x86_64-unknown-linux-gnu'] = (p.targets as Record<string, unknown>)['x86_64-unknown-linux-musl']; }],
        ['extra target key', (p) => { ((p.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin']).url = 'x'; }],
        ['traversal asset', (p) => { ((p.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin']).asset = '../../etc/passwd'; }],
        ['whitespace asset', (p) => { ((p.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin']).asset = 'moor bin'; }],
        ['zero size', (p) => { ((p.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin']).size = 0; }],
        ['short sha', (p) => { ((p.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin']).sha256 = 'ab'; }]
      ];
      for (const [label, mutate] of mutations) {
        const bad = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
        mutate(bad);
        mkdirSync(join(root, 'scripts', 'distribution'), { recursive: true });
        writeFileSync(join(root, PIN_RELATIVE_PATH), JSON.stringify(bad));
        expect(() => readMoorPin(root), label).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restricts the override base to https/file and production to https', () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-proto-'));
    try {
      writeFixture(root, pinFor({}), {});
      const pin = readMoorPin(root);
      expect(() => assetUrl(pin, 'x86_64-apple-darwin', 'http://mirror.example')).toThrow(
        /https:\/\/ or file:\/\//
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
