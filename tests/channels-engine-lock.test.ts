import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelsEngine,
  defaultPidAlive,
  defaultPidStateReader,
  parseLinuxPidStat,
  type ChannelsEngineOptions
} from '../src/server/channelsEngine.js';
import { startChannelsOwner } from './helpers/channels-owner-process.js';

const CHANNELS_ENGINE_SOURCE = pathToFileURL(resolve(process.cwd(), 'src/server/channelsEngine.ts')).href;

const LOCK_CONTENDER_SOURCE = `
import { existsSync, writeFileSync } from 'node:fs';
import { ChannelsEngine } from '${CHANNELS_ENGINE_SOURCE}';

const [home, role, pidRaw, attemptPath, heldPath, releasePath, resultPath] = process.argv.slice(2);
const pid = Number(pidRaw);
const starttimes = new Map([[100, 1_001n], [200, 2_000n], [300, 3_000n]]);
const waitCell = new Int32Array(new SharedArrayBuffer(4));

writeFileSync(attemptPath, 'attempted');
try {
  const engine = new ChannelsEngine({
    home,
    pid,
    pumpIntervalMs: 1_000_000,
    sendText: async () => true,
    capturePane: async () => null,
    sendEnter: async () => true,
    pidScopeReader: () => ({
      bootId: '11111111-1111-4111-8111-111111111111',
      pidNamespaceDev: 4n,
      pidNamespaceIno: 1_001n
    }),
    pidAlive: () => true,
    pidStateReader: () => 'S',
    pidStarttimeReader: (probedPid) => {
      if (role === 'contender') writeFileSync(heldPath, 'entered-critical-section');
      if (role === 'first' && probedPid === 100) {
        writeFileSync(heldPath, 'held');
        const deadline = Date.now() + 20_000;
        while (!existsSync(releasePath)) {
          if (Date.now() >= deadline) throw new Error('timed out waiting to release the first contender');
          Atomics.wait(waitCell, 0, 0, 5);
        }
      }
      return starttimes.get(probedPid) ?? null;
    }
  });
  try {
    writeFileSync(resultPath, JSON.stringify({ passive: engine.passive, lockError: engine.lockError }));
  } finally {
    engine.dispose();
  }
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
}
`;

const MODULE_RELOAD_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';

const [home, resultPath] = process.argv.slice(2);
const options = {
  home,
  pid: 200,
  pumpIntervalMs: 1_000_000,
  sendText: async () => true,
  capturePane: async () => null,
  sendEnter: async () => true,
  pidScopeReader: () => ({
    bootId: '11111111-1111-4111-8111-111111111111',
    pidNamespaceDev: 4n,
    pidNamespaceIno: 1_001n
  }),
  pidStarttimeReader: () => null
};

const firstModule = await import('${CHANNELS_ENGINE_SOURCE}?incarnation-reload=first');
const first = new firstModule.ChannelsEngine(options);
const firstRecord = readFileSync(home + '/_engine/engine.pid', 'utf8');
first.dispose();

const secondModule = await import('${CHANNELS_ENGINE_SOURCE}?incarnation-reload=second');
const second = new secondModule.ChannelsEngine(options);
try {
  writeFileSync(resultPath, JSON.stringify({
    distinctModules: firstModule.ChannelsEngine !== secondModule.ChannelsEngine,
    firstPassive: first.passive,
    firstError: first.lockError ?? null,
    secondPassive: second.passive,
    secondError: second.lockError ?? null,
    firstRecord,
    secondRecord: readFileSync(home + '/_engine/engine.pid', 'utf8')
  }));
} finally {
  second.dispose();
}
`;

const DISTINCT_PROCESS_INCARNATION_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ChannelsEngine } from '${CHANNELS_ENGINE_SOURCE}';

const [role, home, peerHome, heldPath, releasePath, resultPath] = process.argv.slice(2);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const create = (targetHome) => new ChannelsEngine({
  home: targetHome,
  pid: 200,
  pumpIntervalMs: 1_000_000,
  sendText: async () => true,
  capturePane: async () => null,
  sendEnter: async () => true,
  pidScopeReader: () => null,
  pidAlive: () => true,
  pidStateReader: () => null,
  pidStarttimeReader: () => null
});

if (role === 'owner') {
  const owner = create(home);
  writeFileSync(resultPath, JSON.stringify({
    passive: owner.passive,
    lockError: owner.lockError ?? null,
    record: readFileSync(home + '/_engine/engine.pid', 'utf8')
  }));
  writeFileSync(heldPath, 'held');
  const deadline = Date.now() + 20_000;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for release');
    Atomics.wait(waitCell, 0, 0, 5);
  }
  owner.dispose();
} else {
  const own = create(home);
  const ownRecord = readFileSync(home + '/_engine/engine.pid', 'utf8');
  const contender = create(peerHome);
  try {
    writeFileSync(resultPath, JSON.stringify({
      ownPassive: own.passive,
      ownError: own.lockError ?? null,
      ownRecord,
      contenderPassive: contender.passive,
      contenderError: contender.lockError ?? null,
      ownerRecordAfter: readFileSync(peerHome + '/_engine/engine.pid', 'utf8')
    }));
  } finally {
    contender.dispose();
    own.dispose();
  }
}
`;

const DISTINCT_PROCESS_SCOPE_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ChannelsEngine } from '${CHANNELS_ENGINE_SOURCE}';

const [role, home, heldPath, releasePath, resultPath, forbiddenProbePath] = process.argv.slice(2);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const owner = role === 'owner';
const scope = owner
  ? {
      bootId: '11111111-1111-4111-8111-111111111111',
      pidNamespaceDev: 4n,
      pidNamespaceIno: 1_001n
    }
  : {
      bootId: '11111111-1111-4111-8111-111111111111',
      pidNamespaceDev: 4n,
      pidNamespaceIno: 2_002n
    };
const forbiddenProbe = (kind) => {
  if (!owner) writeFileSync(forbiddenProbePath, kind);
};
const engine = new ChannelsEngine({
  home,
  pid: 200,
  pumpIntervalMs: 1_000_000,
  sendText: async () => true,
  capturePane: async () => null,
  sendEnter: async () => true,
  pidScopeReader: () => scope,
  pidAlive: () => {
    forbiddenProbe('liveness');
    return true;
  },
  pidStateReader: () => {
    forbiddenProbe('state');
    return 'S';
  },
  pidStarttimeReader: () => {
    forbiddenProbe('starttime');
    return owner ? 100n : 200n;
  }
});

try {
  writeFileSync(resultPath, JSON.stringify({
    passive: engine.passive,
    lockError: engine.lockError ?? null,
    record: readFileSync(home + '/_engine/engine.pid', 'utf8')
  }));
  if (owner) {
    writeFileSync(heldPath, 'held');
    const deadline = Date.now() + 20_000;
    while (!existsSync(releasePath)) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for release');
      Atomics.wait(waitCell, 0, 0, 5);
    }
  }
} finally {
  engine.dispose();
}
`;

const LINUX_BOOT_A = '11111111-1111-4111-8111-111111111111';
const LINUX_BOOT_B = '22222222-2222-4222-8222-222222222222';
const NONCE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function linuxScope(
  bootId = LINUX_BOOT_A,
  pidNamespaceDev = 4n,
  pidNamespaceIno = 1_001n
): { bootId: string; pidNamespaceDev: bigint; pidNamespaceIno: bigint } {
  return { bootId, pidNamespaceDev, pidNamespaceIno };
}

function scopedPidRecord(options: {
  pid?: number;
  nonce?: string;
  scope?: ReturnType<typeof linuxScope>;
  starttime?: bigint;
} = {}): string {
  const pid = options.pid ?? 100;
  const nonce = options.nonce ?? NONCE_A;
  const scope = options.scope ?? linuxScope();
  const starttime = options.starttime === undefined ? '' : `starttime=${options.starttime}\n`;
  return (
    `desk-engine-lock-v1\npid=${pid}\nnonce=${nonce}\n` +
    `linux_boot_id=${scope.bootId}\n` +
    `linux_pidns_dev=${scope.pidNamespaceDev}\n` +
    `linux_pidns_ino=${scope.pidNamespaceIno}\n` +
    starttime
  );
}

interface VersionedPidRecord {
  pid: number;
  nonce: string;
  scope?: ReturnType<typeof linuxScope>;
  starttime?: bigint;
}

function parseVersionedPidRecord(content: string): VersionedPidRecord | null {
  const match =
    /^desk-engine-lock-v1\npid=([1-9]\d*)\nnonce=([0-9a-f]{32})\n(?:linux_boot_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\nlinux_pidns_dev=(0|[1-9]\d*)\nlinux_pidns_ino=([1-9]\d*)\n(?:starttime=(0|[1-9]\d*)\n)?)?$/.exec(content);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    nonce: match[2],
    ...(match[3] === undefined
      ? {}
      : {
          scope: linuxScope(match[3], BigInt(match[4]), BigInt(match[5]))
        }),
    ...(match[6] === undefined ? {} : { starttime: BigInt(match[6]) })
  };
}

interface RunningWorker {
  child: ChildProcess;
  exit: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function startLockWorker(workerPath: string, args: string[]): RunningWorker {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    exit: new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolveExit({ code, stdout, stderr }));
    })
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  return true;
}

function procStat(
  state: string,
  starttime: number | string,
  pid: number | string = 4242,
  totalFields = 52
): string {
  const fields4ThroughEnd = Array.from({ length: Math.max(totalFields - 3, 0) }, () => '0');
  if (totalFields >= 22) {
    fields4ThroughEnd[18] = String(starttime);
  }
  return `${pid} (desk worker ) helper) ${state}${
    fields4ThroughEnd.length > 0 ? ` ${fields4ThroughEnd.join(' ')}` : ''
  }`;
}

const MALFORMED_PROC_STATS: ReadonlyArray<readonly [string, string]> = [
  ['scientific start time', procStat('S', '1e3')],
  ['hexadecimal start time', procStat('S', '0x2a')],
  ['plus-signed start time', procStat('S', '+42')],
  ['zero-padded start time', procStat('S', '042')],
  ['negative start time', procStat('S', '-42')],
  ['out-of-range start time', procStat('S', '18446744073709551616')],
  ['leading-whitespace start time', procStat('S', ' 42')],
  ['trailing-whitespace start time', procStat('S', '42 ')],
  ['missing pid', procStat('S', 42).replace(/^4242 /, '')],
  ['missing parenthesized comm', procStat('S', 42).replace('(desk worker ) helper)', 'desk-worker')],
  ['wrong pid prefix', procStat('S', 42, 4243)],
  ['zero-padded pid prefix', procStat('S', 42, '04242')],
  ['plus-signed pid prefix', procStat('S', 42, '+4242')],
  ['unsafe-integer pid prefix', procStat('S', 42, '9007199254740992')],
  ['record truncated after field 22', procStat('S', 42, 4242, 22)],
  ['non-numeric trailing field', `${procStat('S', 42)} private-tail`],
  ['double field separator', procStat('S', 42).replace(' S ', ' S  ')],
  ['tab field separator', procStat('S', 42).replace(' S ', '\tS ')]
];

function createEngine(home: string, overrides: Partial<ChannelsEngineOptions> = {}): ChannelsEngine {
  return new ChannelsEngine({
    home,
    pid: 200,
    pumpIntervalMs: 1_000_000,
    sendText: async () => true,
    capturePane: async () => null,
    sendEnter: async () => true,
    pidScopeReader: () => linuxScope(),
    ...overrides
  });
}

function createProductionEngine(home: string): ChannelsEngine {
  return new ChannelsEngine({
    home,
    pumpIntervalMs: 1_000_000,
    sendText: async () => true,
    capturePane: async () => null,
    sendEnter: async () => true
  });
}

function waitForLinuxProcessState(pid: number, expected: string, timeoutMs: number): string | null {
  const deadline = Date.now() + timeoutMs;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  do {
    const probe = defaultPidStateReader(pid);
    if (probe.status === 'known' && probe.value === expected) {
      return probe.value;
    }
    Atomics.wait(waitCell, 0, 0, 5);
  } while (Date.now() < deadline);
  return null;
}

describe('channels engine process identity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('parses process state and start time after the final comm parenthesis', () => {
    expect(parseLinuxPidStat(`${procStat('Z', 98_765)}\n`, 4242)).toEqual({
      state: 'Z',
      starttime: 98_765n
    });
  });

  it.runIf(process.platform === 'linux')('accepts the complete live procfs record grammar', () => {
    const parsed = parseLinuxPidStat(
      readFileSync(`/proc/${process.pid}/stat`, 'utf8'),
      process.pid
    );
    expect(parsed).toMatchObject({ state: expect.stringMatching(/^[A-Za-z]$/) });
    expect(typeof parsed?.starttime).toBe('bigint');
  });

  it.each([
    ['missing comm terminator', '4242 desk R 0 0'],
    ['missing start time', '4242 (desk) R 0 0'],
    ['invalid process state', procStat('ZZ', 98_765)],
    ['unknown one-byte process state', procStat('?', 98_765)],
    ['invalid start time', procStat('R', Number.NaN)],
    ['fractional start time', procStat('R', 1.5)],
    ...MALFORMED_PROC_STATS
  ])('rejects malformed Linux stat content: %s', (_label, content) => {
    expect(parseLinuxPidStat(content, 4242)).toBeNull();
  });

  it('preserves a permission-denied liveness probe as an unknown result', () => {
    const denied = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw denied;
    });

    expect(defaultPidAlive(4242)).toEqual({
      status: 'unknown',
      diagnostic: 'channels engine ownership: process liveness probe failed (EPERM)'
    });
  });

  it('reports a successful liveness probe as positively alive', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(defaultPidAlive(4242)).toEqual({ status: 'alive' });
  });

  it('treats ESRCH as proof that a pid is dead', () => {
    const missing = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw missing;
    });

    expect(defaultPidAlive(4242)).toEqual({ status: 'dead' });
  });

  it('preserves non-Linux process identity as an actionable unknown result', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    try {
      expect(defaultPidStateReader(4242)).toEqual({
        status: 'unknown',
        diagnostic:
          'channels engine ownership: process identity availability failed (UNSUPPORTED_PLATFORM)'
      });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('channels engine owner lock', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-engine-lock-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps an unknown current identity active across a same-process rebuild', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const options = { pidStarttimeReader: () => null };
    const first = createEngine(home, options);
    let second: ChannelsEngine | undefined;
    try {
      const firstRecord = readFileSync(lockPath, 'utf8');
      first.dispose();
      second = createEngine(home, options);

      expect({
        firstPassive: first.passive,
        firstError: first.lockError,
        secondPassive: second.passive,
        secondError: second.lockError,
        record: parseVersionedPidRecord(firstRecord),
        recordStable: readFileSync(lockPath, 'utf8') === firstRecord
      }).toEqual({
        firstPassive: false,
        firstError:
          'channels engine ownership: process identity availability failed (UNAVAILABLE)',
        secondPassive: false,
        secondError:
          'channels engine ownership: process identity availability failed (UNAVAILABLE)',
        record: {
          pid: 200,
          nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
          scope: linuxScope()
        },
        recordStable: true
      });
    } finally {
      second?.dispose();
      first.dispose();
    }
  });

  it('keeps a normal known identity active across dispose and rebuild', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const options = { pidStarttimeReader: () => 99n };
    const first = createEngine(home, options);
    let second: ChannelsEngine | undefined;
    try {
      const firstRecord = readFileSync(lockPath, 'utf8');
      first.dispose();
      second = createEngine(home, options);

      expect(first.passive).toBe(false);
      expect(first.lockError).toBeUndefined();
      expect(parseVersionedPidRecord(firstRecord)).toMatchObject({
        pid: 200,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        starttime: 99n
      });
      expect(second.passive).toBe(false);
      expect(second.lockError).toBeUndefined();
      expect(readFileSync(lockPath, 'utf8')).toBe(firstRecord);
    } finally {
      second?.dispose();
      first.dispose();
    }
  });

  it('keeps a matching nonce passive when its recorded PID namespace is not comparable', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const first = createEngine(home, {
      pidScopeReader: () => linuxScope(LINUX_BOOT_A, 4n, 1_001n),
      pidStarttimeReader: () => 99n
    });
    let second: ChannelsEngine | undefined;
    try {
      const record = readFileSync(lockPath, 'utf8');
      first.dispose();
      second = createEngine(home, {
        pidScopeReader: () => linuxScope(LINUX_BOOT_A, 4n, 2_002n),
        pidStarttimeReader: () => 99n
      });

      expect(first.passive).toBe(false);
      expect(second.passive).toBe(true);
      expect(second.passiveOwnerPid).toBe(200);
      expect(second.lockError).toBe(
        'channels engine ownership: process scope validation failed (NONCOMPARABLE_SCOPE)'
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      second?.dispose();
      first.dispose();
    }
  });

  it('keeps a matching same-pid OS identity passive when the nonce differs', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const options = {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 99n
    };
    const first = createEngine(home, options);
    first.dispose();
    const firstRecord = readFileSync(lockPath, 'utf8');
    const parsed = parseVersionedPidRecord(firstRecord);
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error('expected the initial versioned ownership record');
    const replacementNonce = `${parsed.nonce[0] === 'a' ? 'b' : 'a'}${parsed.nonce.slice(1)}`;
    const foreignRecord = firstRecord.replace(`nonce=${parsed.nonce}`, `nonce=${replacementNonce}`);
    writeFileSync(lockPath, foreignRecord);

    const contender = createEngine(home, options);
    try {
      expect(contender.passive).toBe(true);
      expect(contender.passiveOwnerPid).toBe(200);
      expect(contender.lockError).toBeUndefined();
      expect(readFileSync(lockPath, 'utf8')).toBe(foreignRecord);
    } finally {
      contender.dispose();
    }
  });

  it.runIf(process.platform === 'linux')(
    'keeps a default proc read error active and diagnosed across a rebuild',
    () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const originalReadFileSync = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
        if (path === '/proc/200/stat') {
          throw Object.assign(new Error('sensitive proc failure'), { code: 'EIO' });
        }
        return originalReadFileSync(path, options as never);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();

      const first = createEngine(home);
      let second: ChannelsEngine | undefined;
      try {
        const firstRecord = originalReadFileSync(lockPath, 'utf8');
        first.dispose();
        second = createEngine(home);

        expect({
          firstPassive: first.passive,
          firstError: first.lockError,
          secondPassive: second.passive,
          secondError: second.lockError,
          record: parseVersionedPidRecord(firstRecord),
          recordStable: originalReadFileSync(lockPath, 'utf8') === firstRecord
        }).toEqual({
          firstPassive: false,
          firstError: 'channels engine ownership: process identity read failed (EIO)',
          secondPassive: false,
          secondError: 'channels engine ownership: process identity read failed (EIO)',
          record: {
            pid: 200,
            nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
            scope: linuxScope()
          },
          recordStable: true
        });
      } finally {
        second?.dispose();
        first.dispose();
      }
    }
  );

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 18_446_744_073_709_551_616n])(
    'keeps an invalid current identity %s active via nonce and reports validation',
    (invalidStarttime) => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const options = { pidStarttimeReader: () => invalidStarttime };
      const first = createEngine(home, options);
      let second: ChannelsEngine | undefined;
      try {
        const firstRecord = readFileSync(lockPath, 'utf8');
        first.dispose();
        second = createEngine(home, options);

        expect(first.passive).toBe(false);
        expect(first.lockError).toBe(
          'channels engine ownership: process identity validation failed (INVALID_STARTTIME)'
        );
        expect(parseVersionedPidRecord(firstRecord)).toMatchObject({
          pid: 200,
          nonce: expect.stringMatching(/^[0-9a-f]{32}$/)
        });
        expect(parseVersionedPidRecord(firstRecord)?.starttime).toBeUndefined();
        expect(second.passive).toBe(false);
        expect(second.lockError).toBe(first.lockError);
        expect(readFileSync(lockPath, 'utf8')).toBe(firstRecord);
      } finally {
        second?.dispose();
        first.dispose();
      }
    }
  );

  it('reuses the process incarnation across distinct module instances', async () => {
    const workerPath = join(home, 'module-reload.mjs');
    const resultPath = join(home, 'module-reload-result.json');
    writeFileSync(workerPath, MODULE_RELOAD_SOURCE);

    const worker = startLockWorker(workerPath, [home, resultPath]);
    const result = await worker.exit;
    expect(result, result.stderr || result.stdout).toMatchObject({ code: 0 });
    const witness = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      distinctModules: boolean;
      firstPassive: boolean;
      firstError: string | null;
      secondPassive: boolean;
      secondError: string | null;
      firstRecord: string;
      secondRecord: string;
    };

    expect({
      distinctModules: witness.distinctModules,
      firstPassive: witness.firstPassive,
      firstError: witness.firstError,
      secondPassive: witness.secondPassive,
      secondError: witness.secondError,
      firstRecord: parseVersionedPidRecord(witness.firstRecord),
      recordStable: witness.secondRecord === witness.firstRecord
    }).toEqual({
      distinctModules: true,
      firstPassive: false,
      firstError:
        'channels engine ownership: process identity availability failed (UNAVAILABLE)',
      secondPassive: false,
      secondError:
        'channels engine ownership: process identity availability failed (UNAVAILABLE)',
      firstRecord: {
        pid: 200,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        scope: linuxScope()
      },
      recordStable: true
    });
  }, 20_000);

  it('never shares an incarnation nonce with a separate process using the same pid', async () => {
    const contenderHome = mkdtempSync(join(tmpdir(), 'desk-engine-incarnation-peer-'));
    mkdirSync(join(contenderHome, '_engine'), { recursive: true });
    const workerPath = join(home, 'distinct-process-incarnation.mjs');
    const heldPath = join(home, 'owner-held');
    const releasePath = join(home, 'owner-release');
    const ownerResultPath = join(home, 'owner-result.json');
    const contenderResultPath = join(home, 'contender-result.json');
    writeFileSync(workerPath, DISTINCT_PROCESS_INCARNATION_SOURCE);

    const owner = startLockWorker(workerPath, [
      'owner',
      home,
      contenderHome,
      heldPath,
      releasePath,
      ownerResultPath
    ]);
    let contender: RunningWorker | undefined;
    try {
      expect(await waitForFile(heldPath, 5_000)).toBe(true);
      expect(await waitForFile(ownerResultPath, 5_000)).toBe(true);
      contender = startLockWorker(workerPath, [
        'contender',
        contenderHome,
        home,
        heldPath,
        releasePath,
        contenderResultPath
      ]);
      const contenderExit = await contender.exit;
      expect(contenderExit, contenderExit.stderr || contenderExit.stdout).toMatchObject({ code: 0 });

      const ownerResult = JSON.parse(readFileSync(ownerResultPath, 'utf8')) as {
        passive: boolean;
        lockError: string | null;
        record: string;
      };
      const contenderResult = JSON.parse(readFileSync(contenderResultPath, 'utf8')) as {
        ownPassive: boolean;
        ownError: string | null;
        ownRecord: string;
        contenderPassive: boolean;
        contenderError: string | null;
        ownerRecordAfter: string;
      };
      const ownerRecord = parseVersionedPidRecord(ownerResult.record);
      const ownRecord = parseVersionedPidRecord(contenderResult.ownRecord);

      expect(ownerResult.passive).toBe(false);
      expect(ownerResult.lockError).toBe(
        'channels engine ownership: process scope availability failed (UNAVAILABLE)'
      );
      expect(contenderResult.ownPassive).toBe(false);
      expect(contenderResult.ownError).toBe(
        'channels engine ownership: process scope availability failed (UNAVAILABLE)'
      );
      expect(ownerRecord).toMatchObject({ pid: 200, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
      expect(ownRecord).toMatchObject({ pid: 200, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
      expect(ownRecord?.nonce).not.toBe(ownerRecord?.nonce);
      expect(contenderResult.contenderPassive).toBe(true);
      expect(contenderResult.contenderError).toBe(
        'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
      );
      expect(contenderResult.ownerRecordAfter).toBe(ownerResult.record);
      writeFileSync(releasePath, 'release');
      const ownerExit = await owner.exit;
      expect(ownerExit, ownerExit.stderr || ownerExit.stdout).toMatchObject({ code: 0 });
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, 'release');
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      if (contender?.child.exitCode === null) contender.child.kill('SIGKILL');
      await Promise.allSettled([owner.exit, ...(contender ? [contender.exit] : [])]);
      rmSync(contenderHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a real same-pid contender in a different PID namespace passive without local pid probes', async () => {
    const workerPath = join(home, 'distinct-process-scope.mjs');
    const heldPath = join(home, 'scope-owner-held');
    const releasePath = join(home, 'scope-owner-release');
    const ownerResultPath = join(home, 'scope-owner-result.json');
    const contenderResultPath = join(home, 'scope-contender-result.json');
    const forbiddenProbePath = join(home, 'scope-contender-probed-local-pid');
    writeFileSync(workerPath, DISTINCT_PROCESS_SCOPE_SOURCE);

    const owner = startLockWorker(workerPath, [
      'owner',
      home,
      heldPath,
      releasePath,
      ownerResultPath,
      forbiddenProbePath
    ]);
    let contender: RunningWorker | undefined;
    try {
      expect(await waitForFile(heldPath, 5_000)).toBe(true);
      expect(await waitForFile(ownerResultPath, 5_000)).toBe(true);
      const ownerWitness = JSON.parse(readFileSync(ownerResultPath, 'utf8')) as {
        passive: boolean;
        lockError: string | null;
        record: string;
      };
      expect(ownerWitness.passive).toBe(false);
      expect(ownerWitness.lockError).toBeNull();
      expect(ownerWitness.record).toMatch(
        /^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\nlinux_boot_id=11111111-1111-4111-8111-111111111111\nlinux_pidns_dev=4\nlinux_pidns_ino=1001\nstarttime=100\n$/
      );

      contender = startLockWorker(workerPath, [
        'contender',
        home,
        heldPath,
        releasePath,
        contenderResultPath,
        forbiddenProbePath
      ]);
      const contenderExit = await contender.exit;
      expect(contenderExit, contenderExit.stderr || contenderExit.stdout).toMatchObject({ code: 0 });
      const contenderWitness = JSON.parse(readFileSync(contenderResultPath, 'utf8')) as {
        passive: boolean;
        lockError: string | null;
        record: string;
      };
      expect(contenderWitness).toEqual({
        passive: true,
        lockError:
          'channels engine ownership: process scope validation failed (NONCOMPARABLE_SCOPE)',
        record: ownerWitness.record
      });
      expect(existsSync(forbiddenProbePath)).toBe(false);
      expect(readFileSync(join(home, '_engine', 'engine.pid'), 'utf8')).toBe(ownerWitness.record);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, 'release');
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      if (contender?.child.exitCode === null) contender.child.kill('SIGKILL');
      await Promise.allSettled([owner.exit, ...(contender ? [contender.exit] : [])]);
    }
  }, 20_000);

  it.runIf(process.platform === 'linux')(
    'refuses a live versioned owner then reclaims its actual zombie process record',
    async () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const owner = startChannelsOwner(home);
      let contender: ChannelsEngine | undefined;
      let successor: ChannelsEngine | undefined;
      try {
        const witness = await owner.ready;
        const acquired = parseVersionedPidRecord(witness.record);
        expect(acquired).toMatchObject({
          pid: witness.pid,
          nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
          scope: expect.any(Object)
        });
        expect(typeof acquired?.starttime).toBe('bigint');

        contender = createProductionEngine(home);
        expect(contender.passive).toBe(true);
        expect(contender.passiveOwnerPid).toBe(witness.pid);
        expect(readFileSync(lockPath, 'utf8')).toBe(witness.record);
        contender.dispose();
        contender = undefined;

        expect(owner.child.kill('SIGKILL')).toBe(true);
        expect(waitForLinuxProcessState(witness.pid, 'Z', 5_000)).toBe('Z');

        successor = createProductionEngine(home);
        expect(successor.passive).toBe(false);
        const rewritten = parseVersionedPidRecord(readFileSync(lockPath, 'utf8'));
        expect(rewritten).toMatchObject({
          pid: process.pid,
          nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
          scope: expect.any(Object)
        });
        expect(typeof rewritten?.starttime).toBe('bigint');
        const ownerExit = await owner.exit;
        expect(ownerExit).toMatchObject({ code: null, signal: 'SIGKILL' });
      } finally {
        contender?.dispose();
        successor?.dispose();
        if (owner.child.exitCode === null && owner.child.signalCode === null) {
          owner.child.kill('SIGKILL');
        }
        await owner.exit;
      }
    },
    20_000
  );

  it.runIf(process.platform === 'linux')(
    'keeps an actual zombie legacy record passive because its recorded scope is unknown',
    async () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const owner = startChannelsOwner(home, 'legacy-two-line');
      let contender: ChannelsEngine | undefined;
      let successor: ChannelsEngine | undefined;
      try {
        const witness = await owner.ready;
        expect(witness.record).toMatch(new RegExp(`^${witness.pid}\\n[0-9]+\\n$`));

        contender = createProductionEngine(home);
        expect(contender.passive).toBe(true);
        expect(contender.passiveOwnerPid).toBe(witness.pid);
        contender.dispose();
        contender = undefined;

        expect(owner.child.kill('SIGKILL')).toBe(true);
        expect(waitForLinuxProcessState(witness.pid, 'Z', 5_000)).toBe('Z');

        successor = createProductionEngine(home);
        expect(successor.passive).toBe(true);
        expect(successor.passiveOwnerPid).toBe(witness.pid);
        expect(successor.lockError).toBe(
          'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
        );
        expect(readFileSync(lockPath, 'utf8')).toBe(witness.record);
        expect(await owner.exit).toMatchObject({ code: null, signal: 'SIGKILL' });
      } finally {
        contender?.dispose();
        successor?.dispose();
        if (owner.child.exitCode === null && owner.child.signalCode === null) {
          owner.child.kill('SIGKILL');
        }
        await owner.exit;
        rmSync(lockPath, { force: true });
      }
    },
    20_000
  );

  it.runIf(process.platform === 'linux')(
    'reclaims a real acquired record when the recorded pid has been recycled',
    async () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const owner = startChannelsOwner(home);
      let successor: ChannelsEngine | undefined;
      try {
        const witness = await owner.ready;
        const recorded = parseVersionedPidRecord(witness.record);
        expect(typeof recorded?.starttime).toBe('bigint');
        await owner.release();

        successor = new ChannelsEngine({
          home,
          pumpIntervalMs: 1_000_000,
          sendText: async () => true,
          capturePane: async () => null,
          sendEnter: async () => true,
          pidAlive: () => true,
          pidStateReader: () => 'S',
          pidStarttimeReader: (pid) =>
            pid === witness.pid ? (recorded?.starttime ?? 0n) + 1n : 9_999n
        });

        expect(successor.passive).toBe(false);
        expect(parseVersionedPidRecord(readFileSync(lockPath, 'utf8'))).toMatchObject({
          pid: process.pid,
          starttime: 9_999n
        });
      } finally {
        successor?.dispose();
        if (owner.child.exitCode === null && owner.child.signalCode === null) {
          await owner.release();
        }
      }
    },
    20_000
  );

  it('reclaims a foreign nonce after an exact-scope starttime mismatch', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord({ starttime: 18_446_744_073_709_551_615n }));

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: (pid) =>
        pid === 100 ? 18_446_744_073_709_551_614n : 18_446_744_073_709_551_613n
    });
    try {
      expect(engine.passive).toBe(false);
      expect(engine.lockError).toBeUndefined();
      expect(readFileSync(lockPath, 'utf8')).toMatch(
        /^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\nlinux_boot_id=11111111-1111-4111-8111-111111111111\nlinux_pidns_dev=4\nlinux_pidns_ino=1001\nstarttime=18446744073709551613\n$/
      );
    } finally {
      engine.dispose();
    }
  });

  it('keeps a boot-mismatched foreign owner passive and never probes the local pid', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = scopedPidRecord({ starttime: 42n });
    writeFileSync(lockPath, record);
    const localPidProbe = vi.fn(() => {
      throw new Error('must not inspect a non-comparable pid');
    });

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(LINUX_BOOT_B),
      pidAlive: localPidProbe,
      pidStateReader: localPidProbe,
      pidStarttimeReader: localPidProbe
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (NONCOMPARABLE_SCOPE)'
      );
      expect(localPidProbe).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a PID-namespace-mismatched foreign owner passive and never probes the local pid', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = scopedPidRecord({ starttime: 42n });
    writeFileSync(lockPath, record);
    const localPidProbe = vi.fn(() => {
      throw new Error('must not inspect a non-comparable pid');
    });

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(LINUX_BOOT_A, 4n, 9_999n),
      pidAlive: localPidProbe,
      pidStateReader: localPidProbe,
      pidStarttimeReader: localPidProbe
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (NONCOMPARABLE_SCOPE)'
      );
      expect(localPidProbe).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it.each([
    [
      'terminal state',
      {
        pidAlive: () => true,
        pidStateReader: () => 'Z',
        pidStarttimeReader: (pid: number) => (pid === 100 ? 42n : 99n)
      }
    ],
    [
      'local ESRCH',
      {
        pidAlive: () => false,
        pidStateReader: () => null,
        pidStarttimeReader: (pid: number) => (pid === 100 ? 42n : 99n)
      }
    ],
    [
      'local starttime mismatch',
      {
        pidAlive: () => true,
        pidStateReader: () => 'S',
        pidStarttimeReader: () => 99n
      }
    ]
  ])('never reclaims a legacy record from namespace-local %s evidence', (_label, evidence) => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = '100\n42\n';
    writeFileSync(lockPath, record);

    const engine = createEngine(home, evidence);
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a matching live same-pid legacy owner passive', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = '200\n42\n';
    writeFileSync(lockPath, record);

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(200);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a terminal legacy record passive without consulting local scope or pid probes', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = '100\n42\n';
    writeFileSync(lockPath, record);
    const forbiddenScopeProbe = vi.fn(() => {
      throw new Error('must not infer legacy scope from the current process');
    });
    const forbiddenPidProbe = vi.fn(() => {
      throw new Error('must not inspect a pid without current scope');
    });

    const engine = createEngine(home, {
      pidScopeReader: forbiddenScopeProbe,
      pidAlive: forbiddenPidProbe,
      pidStateReader: forbiddenPidProbe,
      pidStarttimeReader: forbiddenPidProbe
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
      );
      expect(forbiddenScopeProbe).not.toHaveBeenCalled();
      expect(forbiddenPidProbe).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a live legacy owner passive without using an unreadable start time', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = '100\n42\n';
    writeFileSync(lockPath, record);
    const starttimeProbe = vi.fn(() => null);

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: starttimeProbe
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
      );
      expect(starttimeProbe).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it.each([
    ['terminal state', { pidStateReader: () => 'Z', pidAlive: () => true }],
    ['ESRCH', { pidStateReader: () => 'S', pidAlive: () => false }]
  ])('allows same-scope %s evidence to reclaim a scope-only record', (_label, evidence) => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord());

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      ...evidence,
      pidStarttimeReader: () => 99n
    });
    try {
      expect(engine.passive).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a nonce-backed initial claim and HMR rebuild active when scope is unavailable', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const starttimeProbe = vi.fn(() => {
      throw new Error('starttime must not be read without a comparable scope');
    });
    const options = {
      pidScopeReader: () => null,
      pidStarttimeReader: starttimeProbe
    };
    const first = createEngine(home, options);
    let second: ChannelsEngine | undefined;
    try {
      const record = readFileSync(lockPath, 'utf8');
      first.dispose();
      second = createEngine(home, options);

      expect(first.passive).toBe(false);
      expect(second.passive).toBe(false);
      expect(first.lockError).toBe(
        'channels engine ownership: process scope availability failed (UNAVAILABLE)'
      );
      expect(second.lockError).toBe(first.lockError);
      expect(record).toMatch(/^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\n$/);
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
      expect(starttimeProbe).not.toHaveBeenCalled();
    } finally {
      second?.dispose();
      first.dispose();
    }
  });

  it('accepts a complete canonical scope-only record as a passive live owner', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = scopedPidRecord();
    writeFileSync(lockPath, record);

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 99n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBeUndefined();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('compares a canonical unsigned starttime without Number precision loss', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const exactStarttime = 18_446_744_073_709_551_615n;
    const record = scopedPidRecord({ starttime: exactStarttime });
    writeFileSync(lockPath, record);

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => exactStarttime
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBeUndefined();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it.each([
    [
      'starttime without scope',
      `desk-engine-lock-v1\npid=100\nnonce=${NONCE_A}\nstarttime=42\n`
    ],
    [
      'boot id without namespace',
      `desk-engine-lock-v1\npid=100\nnonce=${NONCE_A}\nlinux_boot_id=${LINUX_BOOT_A}\n`
    ],
    [
      'namespace device without inode',
      `desk-engine-lock-v1\npid=100\nnonce=${NONCE_A}\nlinux_boot_id=${LINUX_BOOT_A}\nlinux_pidns_dev=4\n`
    ],
    [
      'namespace inode without device',
      `desk-engine-lock-v1\npid=100\nnonce=${NONCE_A}\nlinux_boot_id=${LINUX_BOOT_A}\nlinux_pidns_ino=1001\n`
    ],
    [
      'uppercase boot id',
      scopedPidRecord({
        scope: linuxScope('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase())
      })
    ],
    [
      'zero-padded namespace device',
      scopedPidRecord().replace('linux_pidns_dev=4', 'linux_pidns_dev=04')
    ],
    [
      'zero namespace inode',
      scopedPidRecord().replace('linux_pidns_ino=1001', 'linux_pidns_ino=0')
    ],
    [
      'out-of-range namespace device',
      scopedPidRecord().replace('linux_pidns_dev=4', 'linux_pidns_dev=18446744073709551616')
    ],
    [
      'out-of-range namespace inode',
      scopedPidRecord().replace(
        'linux_pidns_ino=1001',
        'linux_pidns_ino=18446744073709551616'
      )
    ],
    [
      'out-of-range starttime',
      scopedPidRecord({ starttime: 42n }).replace(
        'starttime=42',
        'starttime=18446744073709551616'
      )
    ],
    [
      'starttime before namespace',
      `desk-engine-lock-v1\npid=100\nnonce=${NONCE_A}\nstarttime=42\nlinux_boot_id=${LINUX_BOOT_A}\nlinux_pidns_dev=4\nlinux_pidns_ino=1001\n`
    ]
  ])('rejects malformed dependent Linux ownership identity: %s', (_label, record) => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, record);

    const engine = createEngine(home, {
      pidScopeReader: () => linuxScope(),
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: pidfile validation failed (INVALID_RECORD)'
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a foreign owner passive when the current scope probe throws', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = scopedPidRecord({ starttime: 42n });
    writeFileSync(lockPath, record);
    const localPidProbe = vi.fn(() => {
      throw new Error('must not inspect a pid without current scope');
    });

    const engine = createEngine(home, {
      pidScopeReader: () => {
        throw Object.assign(new Error('private scope failure'), { code: 'EACCES' });
      },
      pidAlive: localPidProbe,
      pidStateReader: localPidProbe,
      pidStarttimeReader: localPidProbe
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope probe failed (EACCES)'
      );
      expect(engine.lockError).not.toContain('private scope failure');
      expect(localPidProbe).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it.runIf(process.platform === 'linux')(
    'keeps an initial claim active and nonce-only when Linux boot identity cannot be read',
    () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const originalReadFileSync = fs.readFileSync;
      let pidStatRead = false;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
        if (path === '/proc/sys/kernel/random/boot_id') {
          throw Object.assign(new Error('private boot failure'), { code: 'EIO' });
        }
        if (path === '/proc/200/stat') {
          pidStatRead = true;
          return procStat('S', 99, 200);
        }
        return originalReadFileSync(path, options as never);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();

      const engine = createEngine(home, { pidScopeReader: undefined });
      try {
        expect(engine.passive).toBe(false);
        expect(engine.lockError).toBe(
          'channels engine ownership: linux boot identity read failed (EIO)'
        );
        expect(engine.lockError).not.toContain('private boot failure');
        expect(readFileSync(lockPath, 'utf8')).toMatch(
          /^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\n$/
        );
        expect(pidStatRead).toBe(false);
      } finally {
        engine.dispose();
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps an initial claim active and nonce-only when Linux boot identity is malformed',
    () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const originalReadFileSync = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
        if (path === '/proc/sys/kernel/random/boot_id') return 'PRIVATE MALFORMED BOOT CONTENT\n';
        return originalReadFileSync(path, options as never);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();

      const engine = createEngine(home, { pidScopeReader: undefined });
      try {
        expect(engine.passive).toBe(false);
        expect(engine.lockError).toBe(
          'channels engine ownership: linux boot identity validation failed (INVALID_BOOT_ID)'
        );
        expect(engine.lockError).not.toContain('PRIVATE MALFORMED BOOT CONTENT');
        expect(readFileSync(lockPath, 'utf8')).toMatch(
          /^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\n$/
        );
      } finally {
        engine.dispose();
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps an initial claim active and nonce-only when Linux PID namespace stat fails',
    () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const originalStatSync = fs.statSync;
      vi.spyOn(fs, 'statSync').mockImplementation(((path, options) => {
        if (path === '/proc/self/ns/pid') {
          throw Object.assign(new Error('private namespace failure'), { code: 'EIO' });
        }
        return originalStatSync(path, options as never);
      }) as typeof fs.statSync);
      syncBuiltinESMExports();

      const engine = createEngine(home, { pidScopeReader: undefined });
      try {
        expect(engine.passive).toBe(false);
        expect(engine.lockError).toBe(
          'channels engine ownership: linux pid namespace read failed (EIO)'
        );
        expect(engine.lockError).not.toContain('private namespace failure');
        expect(readFileSync(lockPath, 'utf8')).toMatch(
          /^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\n$/
        );
      } finally {
        engine.dispose();
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps an initial claim active and nonce-only when Linux PID namespace stat is malformed',
    () => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const originalStatSync = fs.statSync;
      vi.spyOn(fs, 'statSync').mockImplementation(((path, options) => {
        if (path === '/proc/self/ns/pid') {
          return {
            dev: 4n,
            ino: 0n,
            isFile: () => true
          } as never;
        }
        return originalStatSync(path, options as never);
      }) as typeof fs.statSync);
      syncBuiltinESMExports();

      const engine = createEngine(home, { pidScopeReader: undefined });
      try {
        expect(engine.passive).toBe(false);
        expect(engine.lockError).toBe(
          'channels engine ownership: linux pid namespace validation failed (INVALID_PID_NAMESPACE)'
        );
        expect(readFileSync(lockPath, 'utf8')).toMatch(
          /^desk-engine-lock-v1\npid=200\nnonce=[0-9a-f]{32}\n$/
        );
      } finally {
        engine.dispose();
      }
    }
  );

  it.each([
    ['duplicate pid', 'desk-engine-lock-v1\npid=100\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['duplicate nonce', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['out-of-order fields', 'desk-engine-lock-v1\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\npid=100\n'],
    ['unknown field', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nprivate=1\n'],
    ['missing header', 'pid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['missing pid', 'desk-engine-lock-v1\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['missing nonce', 'desk-engine-lock-v1\npid=100\n'],
    ['zero pid', 'desk-engine-lock-v1\npid=0\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['zero-padded pid', 'desk-engine-lock-v1\npid=0100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['unsafe pid', 'desk-engine-lock-v1\npid=9007199254740992\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['missing final newline', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['extra final newline', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n'],
    ['CRLF separators', 'desk-engine-lock-v1\r\npid=100\r\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n'],
    ['trailing bytes', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nprivate'],
    ['uppercase nonce', 'desk-engine-lock-v1\npid=100\nnonce=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'],
    ['short nonce', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['long nonce', 'desk-engine-lock-v1\npid=100\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['starttime before nonce', 'desk-engine-lock-v1\npid=100\nstarttime=42\nnonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
    ['duplicate starttime', `${scopedPidRecord({ starttime: 42n })}starttime=42\n`],
    [
      'zero-padded starttime',
      scopedPidRecord({ starttime: 42n }).replace('starttime=42', 'starttime=042')
    ],
    [
      'plus-signed starttime',
      scopedPidRecord({ starttime: 42n }).replace('starttime=42', 'starttime=+42')
    ],
    [
      'scientific starttime',
      scopedPidRecord({ starttime: 42n }).replace('starttime=42', 'starttime=1e3')
    ]
  ])('rejects malformed versioned ownership records: %s', (_label, content) => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, content);

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: pidfile validation failed (INVALID_RECORD)'
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(content);
    } finally {
      engine.dispose();
    }
  });

  it.each([
    [
      'without Linux scope',
      `desk-engine-lock-v1\npid=100\nnonce=${NONCE_A}\n`,
      'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
    ],
    ['with Linux scope', scopedPidRecord(), undefined],
    ['with Linux scope and start time', scopedPidRecord({ starttime: 42n }), undefined]
  ])('accepts a canonical versioned ownership record %s', (_label, content, lockError) => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, content);

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(lockError);
      expect(readFileSync(lockPath, 'utf8')).toBe(content);
    } finally {
      engine.dispose();
    }
  });

  it.each(['100\n', '100\n42\n', '100\n042\n'])(
    'retains backward-compatible legacy numeric ownership record %j',
    (content) => {
      const lockPath = join(home, '_engine', 'engine.pid');
      writeFileSync(lockPath, content);
      const engine = createEngine(home, {
        pidAlive: () => true,
        pidStateReader: () => 'S',
        pidStarttimeReader: () => 42n
      });
      try {
        expect(engine.passive).toBe(true);
        expect(engine.lockError).toBe(
          'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
        );
        expect(readFileSync(lockPath, 'utf8')).toBe(content);
      } finally {
        engine.dispose();
      }
    }
  );

  it('finishes a short pidfile write before exposing a single active owner', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalWriteSync = fs.writeSync;
    const requestedRanges: Array<{ offset: number; length: number }> = [];
    let claimWrite = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      const offset = typeof data === 'string' ? 0 : Number(args[0] ?? 0);
      const length =
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : Number(args[1] ?? data.byteLength - offset);
      requestedRanges.push({ offset, length });
      if (claimWrite++ === 0) {
        return typeof data === 'string'
          ? originalWriteSync(fd, data.slice(0, 5))
          : originalWriteSync(fd, data, offset, 5, null);
      }
      return Reflect.apply(originalWriteSync, fs, [fd, data, ...args]);
    }) as typeof fs.writeSync);
    const fsync = vi.spyOn(fs, 'fsyncSync');
    syncBuiltinESMExports();

    const first = createEngine(home, {
      pid: 200,
      pidStarttimeReader: () => 99n
    });
    let second: ChannelsEngine | undefined;
    try {
      const firstLock = readFileSync(lockPath, 'utf8');
      second = createEngine(home, {
        pid: 300,
        pidAlive: () => true,
        pidStateReader: () => 'S',
        pidStarttimeReader: (pid) => (pid === 200 ? 99n : 123n)
      });
      expect(first.passive).toBe(false);
      expect(second.passive).toBe(true);
      expect([first, second].filter((engine) => !engine.passive)).toHaveLength(1);
      expect(parseVersionedPidRecord(firstLock)).toMatchObject({
        pid: 200,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        starttime: 99n
      });
      expect(readFileSync(lockPath, 'utf8')).toBe(firstLock);
      expect(requestedRanges).toEqual([
        { offset: 0, length: Buffer.byteLength(firstLock) },
        { offset: 5, length: Buffer.byteLength(firstLock) - 5 }
      ]);
      expect(fsync).toHaveBeenCalledTimes(1);
    } finally {
      second?.dispose();
      first.dispose();
    }
  });

  it('removes its incomplete claim and stays passive when a later write fails', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalWriteSync = fs.writeSync;
    const privateMarker = 'PRIVATE_WRITE_CONTENT';
    let claimWrite = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (claimWrite++ === 0) {
        return typeof data === 'string'
          ? originalWriteSync(fd, data.slice(0, 5))
          : originalWriteSync(fd, data, Number(args[0] ?? 0), 5, null);
      }
      throw Object.assign(new Error(`${privateMarker}:${'x'.repeat(30_000)}`), { code: 'EIO' });
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe('channels engine ownership: pidfile write failed (EIO)');
      expect(engine.lockError).not.toContain(privateMarker);
      expect(engine.lockError?.length).toBeLessThan(160);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('rejects a zero-progress pidfile write and removes the empty claim', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    vi.spyOn(fs, 'writeSync').mockReturnValue(0);
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: pidfile write failed (INVALID_PROGRESS)'
      );
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('never removes a replacement that appears after its short write fails', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalWriteSync = fs.writeSync;
    let claimWrite = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (claimWrite++ === 0) {
        return typeof data === 'string'
          ? originalWriteSync(fd, data.slice(0, 5))
          : originalWriteSync(fd, data, Number(args[0] ?? 0), 5, null);
      }
      unlinkSync(lockPath);
      writeFileSync(lockPath, '777\n88\n');
      throw Object.assign(new Error('write failed after replacement'), { code: 'EIO' });
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe('channels engine ownership: pidfile write failed (EIO)');
      expect(readFileSync(lockPath, 'utf8')).toBe('777\n88\n');
    } finally {
      engine.dispose();
    }
  });

  it('distinguishes replacement inode identities above the safe-integer range', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalFstatSync = fs.fstatSync;
    const originalLstatSync = fs.lstatSync;
    const originalWriteSync = fs.writeSync;
    const highIdentity = 9_007_199_254_740_992n;
    let claimWrite = 0;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
      const stat = originalFstatSync(fd, options as never);
      return options?.bigint
        ? Object.assign(stat, { dev: highIdentity, ino: highIdentity })
        : Object.assign(stat, { dev: Number(highIdentity), ino: Number(highIdentity) });
    }) as typeof fs.fstatSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path, options?: { bigint?: boolean }) => {
      const stat = originalLstatSync(path, options as never);
      return options?.bigint
        ? Object.assign(stat, { dev: highIdentity, ino: highIdentity + 1n })
        : Object.assign(stat, {
            dev: Number(highIdentity),
            ino: Number(highIdentity + 1n)
          });
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (claimWrite++ === 0) {
        return typeof data === 'string'
          ? originalWriteSync(fd, data.slice(0, 5))
          : originalWriteSync(fd, data, Number(args[0] ?? 0), 5, null);
      }
      unlinkSync(lockPath);
      writeFileSync(lockPath, 'desk-');
      throw Object.assign(new Error('write failed after same-prefix replacement'), { code: 'EIO' });
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe('channels engine ownership: pidfile write failed (EIO)');
      expect(readFileSync(lockPath, 'utf8')).toBe('desk-');
    } finally {
      engine.dispose();
    }
  });

  it('reports a bounded cleanup diagnostic when an incomplete claim cannot be inspected', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalWriteSync = fs.writeSync;
    let claimWrite = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (claimWrite++ === 0) {
        return typeof data === 'string'
          ? originalWriteSync(fd, data.slice(0, 5))
          : originalWriteSync(fd, data, Number(args[0] ?? 0), 5, null);
      }
      throw Object.assign(new Error('write failed'), { code: 'EIO' });
    }) as typeof fs.writeSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('private cleanup detail'), { code: 'EACCES' });
    });
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe('channels engine ownership: pidfile reclaim failed (EACCES)');
      expect(engine.lockError).not.toContain('private cleanup detail');
      expect(readFileSync(lockPath, 'utf8')).toBe('desk-');
    } finally {
      engine.dispose();
    }
  });

  it('retries an interrupted pidfile write without exposing a partial claim', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalWriteSync = fs.writeSync;
    let attempts = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (attempts++ === 0) {
        throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
      }
      return Reflect.apply(originalWriteSync, fs, [fd, data, ...args]);
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(false);
      expect(attempts).toBe(2);
      expect(parseVersionedPidRecord(readFileSync(lockPath, 'utf8'))).toMatchObject({
        pid: 200,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        starttime: 99n
      });
    } finally {
      engine.dispose();
    }
  });

  it('removes its claim and stays passive when pidfile fsync fails', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('sync failed'), { code: 'EIO' });
    });
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe('channels engine ownership: pidfile sync failed (EIO)');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('does not become active when closing its durable pidfile claim fails', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const originalCloseSync = fs.closeSync;
    const originalWriteSync = fs.writeSync;
    let claimFd: number | undefined;
    let injectedCloseFailure = false;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      claimFd = fd;
      return Reflect.apply(originalWriteSync, fs, [fd, data, ...args]);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      originalCloseSync(fd);
      if (fd === claimFd && !injectedCloseFailure) {
        injectedCloseFailure = true;
        throw Object.assign(new Error('close failed'), { code: 'EIO' });
      }
    });
    syncBuiltinESMExports();

    const engine = createEngine(home, { pidStarttimeReader: () => 99n });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe('channels engine ownership: pidfile close failed (EIO)');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('completes a bounded contender as passive while the first process still holds acquisition', async () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const workerPath = join(home, 'lock-contender.mjs');
    const releasePath = join(home, 'release-first');
    const firstAttemptPath = join(home, 'first-attempt');
    const firstHeldPath = join(home, 'first-held');
    const firstResultPath = join(home, 'first-result.json');
    const contenderAttemptPath = join(home, 'contender-attempt');
    const contenderHeldPath = join(home, 'contender-held');
    const contenderResultPath = join(home, 'contender-result.json');
    const staleRecord = scopedPidRecord({ starttime: 1_000n });
    writeFileSync(lockPath, staleRecord);
    writeFileSync(workerPath, LOCK_CONTENDER_SOURCE);

    const first = startLockWorker(workerPath, [
      home,
      'first',
      '200',
      firstAttemptPath,
      firstHeldPath,
      releasePath,
      firstResultPath
    ]);
    let contender: RunningWorker | undefined;
    try {
      expect(await waitForFile(firstAttemptPath, 5_000)).toBe(true);
      expect(await waitForFile(firstHeldPath, 5_000)).toBe(true);
      contender = startLockWorker(workerPath, [
        home,
        'contender',
        '300',
        contenderAttemptPath,
        contenderHeldPath,
        releasePath,
        contenderResultPath
      ]);
      expect(await waitForFile(contenderAttemptPath, 5_000)).toBe(true);
      expect(await waitForFile(contenderResultPath, 5_000)).toBe(true);

      const contenderResult = JSON.parse(readFileSync(contenderResultPath, 'utf8')) as {
        passive: boolean;
        lockError?: string;
      };
      expect(contenderResult).toEqual({
        passive: true,
        lockError: 'channels engine ownership: acquisition mutex failed (FILE_LOCK_BUSY)'
      });
      expect(existsSync(contenderHeldPath)).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(staleRecord);

      const contenderExit = await contender.exit;
      expect(contenderExit, contenderExit.stderr || contenderExit.stdout).toMatchObject({ code: 0 });
      writeFileSync(releasePath, 'release');

      const firstExit = await first.exit;
      expect(firstExit, firstExit.stderr || firstExit.stdout).toMatchObject({ code: 0 });
      const firstResult = JSON.parse(readFileSync(firstResultPath, 'utf8')) as { passive: boolean };
      const witness = {
        firstPassive: firstResult.passive,
        contenderPassive: contenderResult.passive,
        activeCount: [firstResult, contenderResult].filter((result) => !result.passive).length,
        finalLock: parseVersionedPidRecord(readFileSync(lockPath, 'utf8'))
      };

      expect(witness).toEqual({
        firstPassive: false,
        contenderPassive: true,
        activeCount: 1,
        finalLock: {
          pid: 200,
          nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
          scope: linuxScope(),
          starttime: 2000n
        }
      });
    } finally {
      if (!existsSync(releasePath)) {
        writeFileSync(releasePath, 'release');
      }
      for (const worker of [first, contender]) {
        if (worker?.child.exitCode === null) {
          worker.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled([first.exit, ...(contender ? [contender.exit] : [])]);
    }
  }, 20_000);

  it('bounds and redacts an oversized pidfile read error', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const privateMarker = 'PRIVATE_PIDFILE_CONTENT';
    writeFileSync(lockPath, '100\n42\n');
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
      if (path === lockPath) {
        throw Object.assign(
          new Error(`${privateMarker}:${lockPath}:${'x'.repeat(30_000)}`),
          { code: 'EIO' }
        );
      }
      return originalReadFileSync(path, options as never);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError?.length).toBeLessThan(160);
      expect(engine.lockError).toBe('channels engine ownership: pidfile read failed (EIO)');
      expect(engine.lockError).not.toContain(privateMarker);
      expect(engine.lockError).not.toContain(lockPath);
      expect(originalReadFileSync(lockPath, 'utf8')).toBe('100\n42\n');
    } finally {
      engine.dispose();
    }
  });

  it.each(['EPERM', 'EIO'])('keeps a liveness %s ambiguity passive with an exact diagnostic', (code) => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord({ starttime: 42n }));
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
      if (path === '/proc/100/stat') {
        return procStat('S', 42, 100);
      }
      return originalReadFileSync(path, options as never);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('sensitive operating-system detail'), { code });
    });

    const engine = createEngine(home);
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        `channels engine ownership: process liveness probe failed (${code})`
      );
      expect(engine.lockError).not.toContain('sensitive operating-system detail');
    } finally {
      engine.dispose();
    }
  });

  it('keeps an unreadable Linux process identity passive with an exact diagnostic', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord({ starttime: 42n }));
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
      if (path === '/proc/100/stat') {
        throw Object.assign(new Error('sensitive proc path detail'), { code: 'EIO' });
      }
      return originalReadFileSync(path, options as never);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    vi.spyOn(process, 'kill').mockReturnValue(true);

    const engine = createEngine(home);
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process identity read failed (EIO)'
      );
      expect(engine.lockError).not.toContain('sensitive proc path detail');
    } finally {
      engine.dispose();
    }
  });

  it('keeps an invalid Linux process identity passive with an exact diagnostic', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord({ starttime: 42n }));
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
      if (path === '/proc/100/stat') {
        return 'private malformed process content';
      }
      return originalReadFileSync(path, options as never);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    vi.spyOn(process, 'kill').mockReturnValue(true);

    const engine = createEngine(home);
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(engine.lockError).toBe(
        'channels engine ownership: process identity validation failed (INVALID_PROC_STAT)'
      );
      expect(engine.lockError).not.toContain('private malformed process content');
    } finally {
      engine.dispose();
    }
  });

  it.each(MALFORMED_PROC_STATS)(
    'never reclaims a live owner from malformed Linux stat content: %s',
    (_label, content) => {
      const lockPath = join(home, '_engine', 'engine.pid');
      const holderStat = content.replace(/^4242/, '100');
      const record = scopedPidRecord({ starttime: 42n });
      writeFileSync(lockPath, record);
      const originalReadFileSync = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
        if (path === '/proc/100/stat') {
          return holderStat;
        }
        return originalReadFileSync(path, options as never);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      vi.spyOn(process, 'kill').mockReturnValue(true);

      const engine = createEngine(home);
      try {
        expect(engine.passive).toBe(true);
        expect(engine.passiveOwnerPid).toBe(100);
        expect(engine.lockError).toBeDefined();
        expect(engine.lockError ?? '').toContain('process identity validation failed');
        expect(engine.lockError ?? '').not.toContain(holderStat);
        expect(readFileSync(lockPath, 'utf8')).toBe(record);
      } finally {
        engine.dispose();
      }
    }
  );

  it.each([
    ['zombie', 'Z'],
    ['dead', 'X'],
    ['dead (lowercase kernel state)', 'x']
  ])('reclaims a matching owner identity whose process is %s', (_label, state) => {
    writeFileSync(join(home, '_engine', 'engine.pid'), scopedPidRecord({ starttime: 42n }));
    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => state,
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('rewrites a recycled same-pid lock with the current process identity', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord({ pid: 200, starttime: 42n }));

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'R',
      pidStarttimeReader: () => 99n
    });
    try {
      expect(engine.passive).toBe(false);
      expect(parseVersionedPidRecord(readFileSync(lockPath, 'utf8'))).toMatchObject({
        pid: 200,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        starttime: 99n
      });
    } finally {
      engine.dispose();
    }
  });

  it('fails closed when a recorded same-pid identity cannot be read', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = scopedPidRecord({ pid: 200, starttime: 42n });
    writeFileSync(lockPath, record);

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'R',
      pidStarttimeReader: () => null
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(200);
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('keeps a live one-line legacy owner passive without recyclable identity evidence', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, '200\n');

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 99n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(200);
      expect(engine.lockError).toBe(
        'channels engine ownership: process scope validation failed (MISSING_LOCK_SCOPE)'
      );
    } finally {
      engine.dispose();
    }
  });

  it('keeps a genuine live matching owner passive', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    const record = scopedPidRecord({ starttime: 42n });
    writeFileSync(lockPath, record);

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      engine.dispose();
    }
  });

  it('reclaims an unrelated live process that recycled the recorded pid', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, scopedPidRecord({ starttime: 42n }));

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'S',
      pidStarttimeReader: (pid) => (pid === 100 ? 77n : 99n)
    });
    try {
      expect(engine.passive).toBe(false);
      expect(parseVersionedPidRecord(readFileSync(lockPath, 'utf8'))).toMatchObject({
        pid: 200,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        starttime: 99n
      });
    } finally {
      engine.dispose();
    }
  });

  it('reclaims a dead pid when process state is unavailable', () => {
    writeFileSync(join(home, '_engine', 'engine.pid'), scopedPidRecord({ starttime: 42n }));

    const engine = createEngine(home, {
      pidAlive: () => false,
      pidStateReader: () => null,
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('fails closed when process state and start time are unavailable', () => {
    writeFileSync(join(home, '_engine', 'engine.pid'), scopedPidRecord({ starttime: 42n }));

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => null,
      pidStarttimeReader: () => null
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
    } finally {
      engine.dispose();
    }
  });

  it('fails closed with a diagnostic when the process-state probe throws', () => {
    writeFileSync(join(home, '_engine', 'engine.pid'), scopedPidRecord({ starttime: 42n }));

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => {
        throw new Error('proc denied');
      },
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: process state probe failed (UNKNOWN)'
      );
      expect(engine.lockError).not.toContain('proc denied');
    } finally {
      engine.dispose();
    }
  });

  it('keeps a fresh legacy one-line lock passive when identity is unavailable', () => {
    writeFileSync(join(home, '_engine', 'engine.pid'), '100\n');

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => null,
      pidStarttimeReader: () => null
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
    } finally {
      engine.dispose();
    }
  });

  it('never steals an aged legacy one-line lock from a pid confirmed live', () => {
    const lockPath = join(home, '_engine', 'engine.pid');
    writeFileSync(lockPath, '100\n');
    const old = new Date(Date.now() - 31_000);
    utimesSync(lockPath, old, old);

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => null,
      pidStarttimeReader: () => null
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.passiveOwnerPid).toBe(100);
      expect(readFileSync(lockPath, 'utf8')).toBe('100\n');
    } finally {
      engine.dispose();
    }
  });

  it('never age-steals a pre-existing acquisition mutex and fails closed with a typed error', () => {
    const mutexPath = join(home, '_engine', 'engine.pid.acquire.lock');
    mkdirSync(mutexPath);
    const old = new Date(0);
    utimesSync(mutexPath, old, old);

    const engine = createEngine(home, {
      pidStarttimeReader: () => 99n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toMatch(/FILE_LOCK_BUSY/);
      expect(existsSync(mutexPath)).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it.each([
    ['invalid pid', 'not-a-pid\n'],
    ['invalid start time', '100\nnot-a-start-time\n'],
    ['out-of-range legacy start time', '100\n18446744073709551616\n'],
    ['extra content', '100\n42\nuntrusted\n']
  ])('fails closed with a diagnostic for a corrupt lock record: %s', (_label, content) => {
    writeFileSync(join(home, '_engine', 'engine.pid'), content);

    const engine = createEngine(home, {
      pidAlive: () => true,
      pidStateReader: () => 'R',
      pidStarttimeReader: () => 42n
    });
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: pidfile validation failed (INVALID_RECORD)'
      );
    } finally {
      engine.dispose();
    }
  });

  it('fails closed when lock storage cannot be prepared', () => {
    const blockedHome = join(home, 'not-a-directory');
    writeFileSync(blockedHome, 'occupied');

    const engine = createEngine(blockedHome);
    try {
      expect(engine.passive).toBe(true);
      expect(engine.lockError).toBe(
        'channels engine ownership: lock storage preparation failed (ENOTDIR)'
      );
    } finally {
      engine.dispose();
    }
  });
});
