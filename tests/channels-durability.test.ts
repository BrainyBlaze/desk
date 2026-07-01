import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimDelivering,
  classifyQueueFile,
  confirmDelivered,
  DELIVERED_TTL_MS,
  ensureQueueDir,
  isDurableExt,
  listStuckItems,
  dropStuckItem,
  markStuck,
  retryStuckItem,
  revertAllDeliveringToJson,
  sweepDeliveredTtl,
  EXT_DELIVERED,
  EXT_DELIVERING,
  EXT_QUEUED,
  EXT_STUCK_PASTE,
  EXT_STUCK_SUBMIT,
  EXT_STUCK_UNOBSERVABLE,
  EXT_CONSUMED
} from '../src/server/channelsDurability.js';
import type { QueuedPrompt } from '../src/server/channelsEngine.js';

const sample = (seq: number, messageId = `msg-${seq}`): QueuedPrompt => ({
  seq,
  channel: 'ops',
  messageId,
  author: 'human',
  prompt: `prompt body ${seq}`,
  queuedAt: '2026-06-18T00:00:00.000Z',
  kind: 'message',
  file: 'root.md',
  member: 'alpha'
});

const seqFile = (seq: number, ext: string): string => `${String(seq).padStart(10, '0')}.${ext}`;

describe('channelsDurability', () => {
  let home: string;
  const tmux = 'tmux-test';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-durability-'));
    ensureQueueDir(home, tmux);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('classifyQueueFile', () => {
    it('classifies every known extension', () => {
      expect(classifyQueueFile(seqFile(1, EXT_QUEUED))).toBe(EXT_QUEUED);
      expect(classifyQueueFile(seqFile(1, EXT_DELIVERING))).toBe(EXT_DELIVERING);
      expect(classifyQueueFile(seqFile(1, EXT_DELIVERED))).toBe(EXT_DELIVERED);
      expect(classifyQueueFile(seqFile(1, EXT_STUCK_PASTE))).toBe(EXT_STUCK_PASTE);
      expect(classifyQueueFile(seqFile(1, EXT_STUCK_SUBMIT))).toBe(EXT_STUCK_SUBMIT);
      expect(classifyQueueFile(seqFile(1, EXT_STUCK_UNOBSERVABLE))).toBe(EXT_STUCK_UNOBSERVABLE);
    });

    it('classifies .consumed tombstones (restore-atomicity safeguard)', () => {
      // Consumed files are named like `<seq>.<ext>.consumed` — the tombstone
      // marker that a source was atomically claimed by restoreQueues but not
      // yet removed. classifyQueueFile treats them as re-enqueue candidates.
      expect(classifyQueueFile('0000000001.json.consumed')).toBe(EXT_CONSUMED);
      expect(classifyQueueFile('0000000001.delivering.consumed')).toBe(EXT_CONSUMED);
      expect(classifyQueueFile('0000000001.stuck-unobservable.consumed')).toBe(EXT_CONSUMED);
    });

    it('returns null for unknown / non-queue files (engine.pid, lockfile, README, etc.)', () => {
      expect(classifyQueueFile('engine.pid')).toBeNull();
      expect(classifyQueueFile('.write.lock')).toBeNull();
      expect(classifyQueueFile('README.md')).toBeNull();
      expect(classifyQueueFile('0000000001.tmp')).toBeNull();
    });
  });

  describe('isDurableExt', () => {
    it('flags delivering / delivered / stuck-* as durable (persistQueue preserves them)', () => {
      expect(isDurableExt(EXT_DELIVERING)).toBe(true);
      expect(isDurableExt(EXT_DELIVERED)).toBe(true);
      expect(isDurableExt(EXT_STUCK_PASTE)).toBe(true);
      expect(isDurableExt(EXT_STUCK_SUBMIT)).toBe(true);
      expect(isDurableExt(EXT_QUEUED)).toBe(false);
    });
  });

  describe('claimDelivering (json -> delivering)', () => {
    it('renames .json to .delivering for an existing queued item', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      claimDelivering(home, tmux, 1);
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)))).toBe(true);
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_QUEUED)))).toBe(false);
    });

    it('is idempotent — re-claiming an already-.delivering seq is a no-op', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      expect(() => claimDelivering(home, tmux, 1)).not.toThrow();
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)))).toBe(true);
    });

    it('no-ops when neither .json nor .delivering exists (already finalized)', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERED)), JSON.stringify(sample(1)));
      expect(() => claimDelivering(home, tmux, 1)).not.toThrow();
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERED)))).toBe(true);
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)))).toBe(false);
    });
  });

  describe('confirmDelivered (delivering -> delivered)', () => {
    it('renames .delivering to .delivered', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      confirmDelivered(home, tmux, 1);
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERED)))).toBe(true);
    });

    it('is idempotent — re-firing on an already-.delivered seq is a no-op', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERED)), JSON.stringify(sample(1)));
      expect(() => confirmDelivered(home, tmux, 1)).not.toThrow();
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERED)))).toBe(true);
    });

    it('no-ops when .delivering does not exist (already reverted to .json)', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      expect(() => confirmDelivered(home, tmux, 1)).not.toThrow();
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_QUEUED)))).toBe(true);
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERED)))).toBe(false);
    });
  });

  describe('markStuck (delivering -> stuck-paste / stuck-submit)', () => {
    it('renames .delivering to .stuck-paste for kind=paste', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      markStuck(home, tmux, 1, 'paste');
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_STUCK_PASTE)))).toBe(true);
    });

    it('renames .delivering to .stuck-submit for kind=submit', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      markStuck(home, tmux, 1, 'submit');
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_STUCK_SUBMIT)))).toBe(true);
    });

    it('is idempotent for both kinds', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_STUCK_PASTE)), JSON.stringify(sample(1)));
      expect(() => markStuck(home, tmux, 1, 'paste')).not.toThrow();
      expect(existsSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_STUCK_PASTE)))).toBe(true);
    });
  });

  describe('revertAllDeliveringToJson (set-revert on sendText-false)', () => {
    it('reverts EVERY .delivering file in the session dir back to .json (digest fan-out)', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      writeFileSync(join(dir, seqFile(2, EXT_DELIVERING)), JSON.stringify(sample(2)));
      writeFileSync(join(dir, seqFile(3, EXT_DELIVERING)), JSON.stringify(sample(3)));
      // An unrelated .json queued item stays put.
      writeFileSync(join(dir, seqFile(4, EXT_QUEUED)), JSON.stringify(sample(4)));
      // A .delivered file (already-finalized) stays put.
      writeFileSync(join(dir, seqFile(5, EXT_DELIVERED)), JSON.stringify(sample(5)));

      const reverted = revertAllDeliveringToJson(home, tmux);

      expect(reverted.sort((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(existsSync(join(dir, seqFile(1, EXT_QUEUED)))).toBe(true);
      expect(existsSync(join(dir, seqFile(2, EXT_QUEUED)))).toBe(true);
      expect(existsSync(join(dir, seqFile(3, EXT_QUEUED)))).toBe(true);
      expect(existsSync(join(dir, seqFile(4, EXT_QUEUED)))).toBe(true);
      expect(existsSync(join(dir, seqFile(5, EXT_DELIVERED)))).toBe(true);
      expect(existsSync(join(dir, seqFile(1, EXT_DELIVERING)))).toBe(false);
    });

    it('returns [] when the session dir does not exist', () => {
      expect(revertAllDeliveringToJson(home, 'tmux-missing')).toEqual([]);
    });

    it('is idempotent — second call finds nothing to revert', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      expect(revertAllDeliveringToJson(home, tmux)).toEqual([1]);
      expect(revertAllDeliveringToJson(home, tmux)).toEqual([]);
    });
  });

  describe('sweepDeliveredTtl', () => {
    it('removes .delivered files older than DELIVERED_TTL_MS', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_DELIVERED)), JSON.stringify(sample(1)));
      // Backdate the mtime by changing the file then asserting sweep handles it via injected now.
      const oldMtime = Date.now() - (DELIVERED_TTL_MS + 60_000);
      // readdirSync reads fresh; emulate age by injecting `now` far in the future.
      const swept = sweepDeliveredTtl(home, tmux, Date.now() + DELIVERED_TTL_MS + 60_000);
      expect(swept).toBe(1);
      expect(existsSync(join(dir, seqFile(1, EXT_DELIVERED)))).toBe(false);
      // unused-variable guard for oldMtime — kept for documentation of the timing model
      expect(oldMtime).toBeLessThan(Date.now());
    });

    it('preserves fresh .delivered files', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_DELIVERED)), JSON.stringify(sample(1)));
      const swept = sweepDeliveredTtl(home, tmux, Date.now()); // current time, file is fresh
      expect(swept).toBe(0);
      expect(existsSync(join(dir, seqFile(1, EXT_DELIVERED)))).toBe(true);
    });

    it('preserves non-.delivered files (sweep is extension-specific)', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_STUCK_PASTE)), JSON.stringify(sample(1)));
      writeFileSync(join(dir, seqFile(2, EXT_QUEUED)), JSON.stringify(sample(2)));
      const swept = sweepDeliveredTtl(home, tmux, Date.now() + DELIVERED_TTL_MS + 60_000);
      expect(swept).toBe(0);
      expect(existsSync(join(dir, seqFile(1, EXT_STUCK_PASTE)))).toBe(true);
      expect(existsSync(join(dir, seqFile(2, EXT_QUEUED)))).toBe(true);
    });
  });

  describe('listStuckItems', () => {
    it('lists stuck-paste + stuck-submit items sorted by seq, with kind discriminator', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(5, EXT_STUCK_SUBMIT)), JSON.stringify(sample(5)));
      writeFileSync(join(dir, seqFile(2, EXT_STUCK_PASTE)), JSON.stringify(sample(2)));
      writeFileSync(join(dir, seqFile(8, EXT_STUCK_PASTE)), JSON.stringify(sample(8)));
      // Non-stuck files are ignored.
      writeFileSync(join(dir, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      writeFileSync(join(dir, seqFile(9, EXT_DELIVERED)), JSON.stringify(sample(9)));

      const stuck = listStuckItems(home, tmux);
      expect(stuck.map((s) => s.seq)).toEqual([2, 5, 8]);
      expect(stuck.map((s) => s.kind)).toEqual(['paste', 'submit', 'paste']);
      expect(stuck[0]!.item.messageId).toBe('msg-2');
    });

    it('returns [] when no stuck files exist', () => {
      writeFileSync(join(home, '_engine', 'queue', tmux, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      expect(listStuckItems(home, tmux)).toEqual([]);
    });
  });

  describe('full lifecycle round-trip', () => {
    it('json -> delivering -> delivered (happy path)', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      claimDelivering(home, tmux, 1);
      confirmDelivered(home, tmux, 1);
      expect(existsSync(join(dir, seqFile(1, EXT_DELIVERED)))).toBe(true);
    });

    it('json -> delivering -> stuck-submit (paste landed, submit eaten)', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      claimDelivering(home, tmux, 1);
      markStuck(home, tmux, 1, 'submit');
      const stuck = listStuckItems(home, tmux);
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.kind).toBe('submit');
    });

    it('json -> delivering -> revert-all -> json (digest sendText failure)', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      for (const seq of [1, 2, 3]) {
        writeFileSync(join(dir, seqFile(seq, EXT_QUEUED)), JSON.stringify(sample(seq)));
        claimDelivering(home, tmux, seq);
      }
      const reverted = revertAllDeliveringToJson(home, tmux);
      expect(reverted.sort((a, b) => a - b)).toEqual([1, 2, 3]);
      for (const seq of [1, 2, 3]) {
        expect(existsSync(join(dir, seqFile(seq, EXT_QUEUED)))).toBe(true);
        expect(existsSync(join(dir, seqFile(seq, EXT_DELIVERING)))).toBe(false);
      }
    });
  });

  describe('stuck-unobservable retry behavior', () => {
    it('classifyQueueFile + isDurableExt recognize stuck-unobservable', () => {
      expect(classifyQueueFile(seqFile(1, EXT_STUCK_UNOBSERVABLE))).toBe(EXT_STUCK_UNOBSERVABLE);
      expect(isDurableExt(EXT_STUCK_UNOBSERVABLE)).toBe(true);
    });

    it('markStuck(unobservable) renames delivering -> stuck-unobservable (idempotent)', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_DELIVERING)), JSON.stringify(sample(1)));
      markStuck(home, tmux, 1, 'unobservable');
      expect(existsSync(join(dir, seqFile(1, EXT_STUCK_UNOBSERVABLE)))).toBe(true);
      expect(existsSync(join(dir, seqFile(1, EXT_DELIVERING)))).toBe(false);
      markStuck(home, tmux, 1, 'unobservable'); // re-fire is a no-op, never throws
      expect(existsSync(join(dir, seqFile(1, EXT_STUCK_UNOBSERVABLE)))).toBe(true);
    });

    it('listStuckItems includes unobservable with its kind discriminator', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(3, EXT_STUCK_UNOBSERVABLE)), JSON.stringify(sample(3)));
      writeFileSync(join(dir, seqFile(1, EXT_STUCK_PASTE)), JSON.stringify(sample(1)));
      const stuck = listStuckItems(home, tmux);
      expect(stuck.map((s) => s.seq)).toEqual([1, 3]);
      expect(stuck.map((s) => s.kind)).toEqual(['paste', 'unobservable']);
    });
  });

  describe('retryStuckItem (stuck-* -> json: operator force-deliver + live unobservable retry)', () => {
    it('reverts any stuck-* extension back to json', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      for (const ext of [EXT_STUCK_PASTE, EXT_STUCK_SUBMIT, EXT_STUCK_UNOBSERVABLE]) {
        const seq = ext === EXT_STUCK_PASTE ? 1 : ext === EXT_STUCK_SUBMIT ? 2 : 3;
        writeFileSync(join(dir, seqFile(seq, ext)), JSON.stringify(sample(seq)));
        expect(retryStuckItem(home, tmux, seq)).toBe(true);
        expect(existsSync(join(dir, seqFile(seq, EXT_QUEUED)))).toBe(true);
        expect(existsSync(join(dir, seqFile(seq, ext)))).toBe(false);
      }
    });

    it('is idempotent: already-json returns true, missing seq returns false', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_QUEUED)), JSON.stringify(sample(1)));
      expect(retryStuckItem(home, tmux, 1)).toBe(true); // already queued
      expect(retryStuckItem(home, tmux, 99)).toBe(false); // no file for this seq
    });
  });

  describe('dropStuckItem (operator drop over a durable stuck file)', () => {
    it('unlinks any stuck-* extension and returns true; false when none', () => {
      const dir = join(home, '_engine', 'queue', tmux);
      writeFileSync(join(dir, seqFile(1, EXT_STUCK_UNOBSERVABLE)), JSON.stringify(sample(1)));
      expect(dropStuckItem(home, tmux, 1)).toBe(true);
      expect(existsSync(join(dir, seqFile(1, EXT_STUCK_UNOBSERVABLE)))).toBe(false);
      expect(dropStuckItem(home, tmux, 1)).toBe(false); // already gone
    });
  });
});
