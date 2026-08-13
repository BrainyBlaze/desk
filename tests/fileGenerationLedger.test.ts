// Durable generation-ledger store conformance (spec §4.8.1). The fence-critical
// property must survive a daemon RESTART, not just a delete+recreate in memory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerationLedger } from '../src/shared/controlPlane/index.js';
import { FileGenerationLedgerStore } from '../src/server/runtime/fileGenerationLedger.js';

describe('durable generation ledger — survives restart (§4.8.1)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genled-'));
    path = join(dir, 'generations.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('allocates monotonically and persists to disk', () => {
    const store = new FileGenerationLedgerStore(path);
    const led = new GenerationLedger(store);
    expect(led.allocate('s1')).toBe(2);
    expect(led.allocate('s1')).toBe(3);
    store.close();
  });

  it('THE restart property: a fresh store recovers the max and continues higher', () => {
    const s1 = new FileGenerationLedgerStore(path);
    const l1 = new GenerationLedger(s1);
    l1.allocate('web-1'); // gen 2 (OB-18: 1 reserved for unsupervised)
    l1.allocate('web-1'); // gen 3
    l1.allocate('other'); // gen 2
    s1.close();

    // "daemon restart": a brand-new store instance replays the durable log.
    const s2 = new FileGenerationLedgerStore(path);
    const l2 = new GenerationLedger(s2);
    expect(l2.current('web-1')).toBe(3); // recovered, not reset
    expect(l2.allocate('web-1')).toBe(4); // continues higher — fence stays sound
    expect(l2.current('other')).toBe(2);
    s2.close();
  });

  it('a reused sessionId after restart never resets generation (fence-critical)', () => {
    const s1 = new FileGenerationLedgerStore(path);
    new GenerationLedger(s1).allocate('reused'); // gen 2, session then deleted
    s1.close();
    const s2 = new FileGenerationLedgerStore(path);
    expect(new GenerationLedger(s2).allocate('reused')).toBe(3); // NOT reset to the fresh-lineage 2
    s2.close();
  });

  it('repairs a torn final line before append so a second restart cannot reissue', () => {
    const s1 = new FileGenerationLedgerStore(path);
    new GenerationLedger(s1).allocate('s1'); // gen 2 (durable)
    s1.close();
    // simulate a crash that left a partial JSON line at the tail:
    appendFileSync(path, '{"s":"s1","g":3'); // no closing brace / newline
    const s2 = new FileGenerationLedgerStore(path);
    // The torn line is ignored and removed before the next append.
    expect(new GenerationLedger(s2).current('s1')).toBe(2);
    expect(new GenerationLedger(s2).allocate('s1')).toBe(3);
    s2.close();

    const s3 = new FileGenerationLedgerStore(path);
    expect(new GenerationLedger(s3).allocate('s1')).toBe(4);
    s3.close();
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('fails closed on malformed interior records instead of understating the fence', () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ s: 's1', g: 1 }),
        '{"s":"s1","g":',
        JSON.stringify({ s: 's1', g: 5 }),
        ''
      ].join('\n')
    );

    expect(() => new FileGenerationLedgerStore(path)).toThrow(/corrupt generation ledger/);
  });

  it('preserves a complete final record that is missing only its newline', () => {
    writeFileSync(path, JSON.stringify({ s: 's1', g: 4 }));

    const s1 = new FileGenerationLedgerStore(path);
    expect(new GenerationLedger(s1).allocate('s1')).toBe(5);
    s1.close();

    const s2 = new FileGenerationLedgerStore(path);
    expect(new GenerationLedger(s2).allocate('s1')).toBe(6);
    s2.close();
  });

  it('the monotonic guard refuses a lowering write across instances', () => {
    const s1 = new FileGenerationLedgerStore(path);
    s1.write('s1', 5);
    s1.close();
    const s2 = new FileGenerationLedgerStore(path);
    s2.write('s1', 3); // stale — ignored
    expect(s2.read('s1')).toBe(5);
    s2.close();
  });
});
