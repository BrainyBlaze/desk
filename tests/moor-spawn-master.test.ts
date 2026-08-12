// #9 integration seam: supervised moor holder launch. Desk must deliver ONE
// 32-byte private launch record over an inherited fd named by
// DESK_MOOR_LAUNCH_CHANNEL (decimal fd number), close it (EOF), and set BOTH
// generation env carriers — <BASENAME>_GENERATION and DESK_SESSION_GENERATION —
// to the record's canonical decimal generation (moor private.rs:333-358).
// Verified against a real child process standing in for the moor launcher.
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESK_MOOR_LAUNCH_CHANNEL,
  DESK_SESSION_GENERATION,
  decodeMoorLaunchRecord,
  moorGenerationEnvKey
} from '../src/server/runtime/moorLaunchChannel.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';

/**
 * Fake moor launcher: reads the launch channel fd named by the selector env to
 * EOF, records what it saw (bytes + env carriers) as JSON, exits 0. Exits 1 if
 * the selector is missing or unreadable.
 */
const PROBE_SOURCE = `
const { readFileSync, writeFileSync } = require('node:fs');
const out = process.argv[2];
try {
  const selector = process.env.DESK_MOOR_LAUNCH_CHANNEL;
  const fd = Number(selector);
  const record = readFileSync(fd); // reads to EOF — hangs unless Desk closed the write side
  const generationKeys = Object.keys(process.env).filter((key) => key.endsWith('_GENERATION'));
  const environment = {};
  for (const key of generationKeys) environment[key] = process.env[key];
  writeFileSync(out, JSON.stringify({
    selector,
    recordHex: Buffer.from(record).toString('hex'),
    recordLength: record.length,
    environment
  }));
  process.exit(0);
} catch (error) {
  try { writeFileSync(out, JSON.stringify({ failed: String(error) })); } catch {}
  process.exit(1);
}
`;

interface ProbeReport {
  selector?: string;
  recordHex?: string;
  recordLength?: number;
  environment?: Record<string, string>;
  failed?: string;
}

async function runProbe(
  binPath: string,
  generation: number,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<ProbeReport> {
  const root = mkdtempSync(join(tmpdir(), 'moor-spawn-'));
  try {
    const reportPath = join(root, 'report.json');
    writeFileSync(join(root, 'probe.cjs'), PROBE_SOURCE);
    const { child } = spawnMoorMaster({
      binPath: process.execPath,
      argv0: binPath,
      args: [join(root, 'probe.cjs'), reportPath],
      generation,
      env: { PATH: process.env.PATH ?? '', ...extraEnv }
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(0);
    return JSON.parse(readFileSync(reportPath, 'utf8')) as ProbeReport;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('spawnMoorMaster', () => {
  it('refuses an unsupervised generation before spawning', () => {
    for (const generation of [0, 1, 1.5, -3]) {
      expect(() =>
        spawnMoorMaster({ binPath: '/usr/bin/true', args: [], generation })
      ).toThrowError(/generation/i);
    }
  });

  it('delivers exactly one 32-byte record over the selector fd and closes it', async () => {
    const report = await runProbe('/opt/desk/libexec/moor', 7);
    expect(report.failed).toBeUndefined();
    expect(report.recordLength).toBe(32);
    const record = decodeMoorLaunchRecord(Buffer.from(report.recordHex!, 'hex'));
    expect(record.generation).toBe(7);
  });

  it('sets both generation carriers to the canonical decimal record generation', async () => {
    const report = await runProbe('/opt/desk/libexec/moor', 42);
    expect(report.environment).toMatchObject({
      [moorGenerationEnvKey('/opt/desk/libexec/moor')]: '42', // MOOR_GENERATION
      [DESK_SESSION_GENERATION]: '42'
    });
    expect(report.environment!['MOOR_GENERATION']).toBe('42');
  });

  it('derives the invocation env key from the spawned basename, not a fixed name', async () => {
    const report = await runProbe('/usr/local/bin/holderx', 9);
    expect(report.environment!['HOLDERX_GENERATION']).toBe('9');
    expect(report.environment!['MOOR_GENERATION']).toBeUndefined();
    expect(report.environment![DESK_SESSION_GENERATION]).toBe('9');
  });

  it('spawns through a real renamed symlink with matching argv0 identity', async () => {
    // The env key must match what the HOLDER derives from its own argv[0]; spawn
    // node through a differently-named symlink so basename-driven identity is real.
    const root = mkdtempSync(join(tmpdir(), 'moor-symlink-'));
    try {
      const probePath = join(root, 'probe.cjs');
      const reportPath = join(root, 'report.json');
      writeFileSync(probePath, PROBE_SOURCE);
      const linkPath = join(root, 'holderx');
      symlinkSync(process.execPath, linkPath);
      chmodSync(probePath, 0o644);
      const { child, nonce } = spawnMoorMaster({
        binPath: linkPath,
        args: [probePath, reportPath],
        generation: 11,
        env: { PATH: process.env.PATH ?? '' }
      });
      expect(nonce).toHaveLength(16);
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
      expect(exitCode).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ProbeReport;
      expect(report.environment!['HOLDERX_GENERATION']).toBe('11');
      const record = decodeMoorLaunchRecord(Buffer.from(report.recordHex!, 'hex'));
      expect(record.generation).toBe(11);
      expect(Buffer.from(record.nonce).equals(Buffer.from(nonce))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives the carrier key with EXPLICIT platform semantics, never path-shape guessing', async () => {
    const windowsPath = 'C:\\Program Files\\Desk\\moor.exe';
    // win32 semantics: Path::file_name splits both separators.
    expect(moorGenerationEnvKey(windowsPath, 'win32')).toBe('MOOR_EXE_GENERATION');
    // POSIX semantics: the same spelling is ONE legal filename.
    expect(moorGenerationEnvKey(windowsPath, 'linux')).toBe(
      'C__PROGRAM_FILES_DESK_MOOR_EXE_GENERATION'
    );
    // The spawn path uses the host platform (POSIX here): the holder would
    // derive the full-spelling key, so the carrier must match it exactly.
    const report = await runProbe(windowsPath, 13);
    expect(report.environment!['C__PROGRAM_FILES_DESK_MOOR_EXE_GENERATION']).toBe('13');
    expect(report.environment!['MOOR_EXE_GENERATION']).toBeUndefined();
  });

  it('keeps POSIX basename semantics: a literal backslash is a filename byte, not a separator', async () => {
    const report = await runProbe('/opt/desk/moor\\alias', 17);
    expect(report.environment!['MOOR_ALIAS_GENERATION']).toBe('17');
    expect(report.environment!['ALIAS_GENERATION']).toBeUndefined();
  });

  it('strips exactly the known supervision carriers and preserves application env', async () => {
    const report = await runProbe('/usr/local/bin/moor', 23, {
      ATCH_GENERATION: '99',
      MY_TOOL_GENERATION: '77',
      DESK_SESSION_GENERATION: '99',
      DESK_MOOR_LAUNCH_CHANNEL: '9'
    });
    expect(report.environment).toEqual({
      MOOR_GENERATION: '23',
      MY_TOOL_GENERATION: '77',
      DESK_SESSION_GENERATION: '23'
    });
    expect(Number.parseInt(report.selector!, 10)).toBeGreaterThanOrEqual(3);
  });

  it('names the selector fd it actually wired', async () => {
    const report = await runProbe('/opt/desk/libexec/moor', 7);
    expect(report.selector).toBeDefined();
    expect(Number.parseInt(report.selector!, 10)).toBeGreaterThanOrEqual(3);
    expect(String(Number.parseInt(report.selector!, 10))).toBe(report.selector);
  });
});
