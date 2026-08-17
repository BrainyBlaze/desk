import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileGenerationLedgerStore } from '../src/server/runtime/fileGenerationLedger.js';

describe('file generation ledger OB-18 adversarial review', () => {
  it('rejects an out-of-u32 generation during durable replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'generation-replay-review-'));
    try {
      const path = join(root, 'generation.ndjson');
      writeFileSync(path, '{"s":"s1","g":4294967296}\n');
      expect(() => new FileGenerationLedgerStore(path)).toThrow(
        /invalid generation record/i
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-u32 generation before appending it', () => {
    const root = mkdtempSync(join(tmpdir(), 'generation-write-review-'));
    const store = new FileGenerationLedgerStore(join(root, 'generation.ndjson'));
    try {
      expect(() => store.write('s1', 0x1_0000_0000)).toThrow(/generation/i);
      expect(store.read('s1')).toBe(0);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
