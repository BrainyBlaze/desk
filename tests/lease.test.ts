// Controller / resize lease conformance (spec §7.5/§7.9).

import { describe, expect, it } from 'vitest';
import {
  canControl,
  claim,
  createLeaseState,
  heartbeat,
  isFencedEpoch,
  release,
  sweepTtl
} from '../src/shared/lease/index.js';

const T0 = 1_000_000;

describe('lease — claim / grant / handoff (§7.9)', () => {
  it('grants an unheld lease and bumps the epoch (handoff from no-one)', () => {
    const s = createLeaseState();
    const r = claim(s, 'connA', false, T0, 900n);
    expect(r.granted).toBe(true);
    if (r.granted) {
      expect(r.epoch).toBe(1);
      expect(r.ackOffset).toBe(900n);
      expect(r.demoted).toBeNull();
    }
    expect(canControl(s, 'connA')).toBe(true);
    expect(canControl(s, 'connB')).toBe(false);
  });

  it('denies a normal claim while another conn holds it', () => {
    const s = createLeaseState();
    claim(s, 'connA', false, T0, 0n);
    const r = claim(s, 'connB', false, T0 + 1, 0n);
    expect(r.granted).toBe(false);
    if (!r.granted) {
      expect(r.reason).toBe('held');
      expect(r.owner).toBe('connA');
    }
    expect(canControl(s, 'connA')).toBe(true); // A keeps control
  });

  it('a forced claim demotes the current owner and bumps the epoch', () => {
    const s = createLeaseState();
    claim(s, 'connA', false, T0, 0n);
    const r = claim(s, 'connB', true, T0 + 1, 1500n);
    expect(r.granted).toBe(true);
    if (r.granted) {
      expect(r.demoted).toBe('connA'); // A gets a controller{released} event
      expect(r.epoch).toBe(2); // handoff → epoch bumped
      expect(r.ackOffset).toBe(1500n); // B must catch up to here
    }
    expect(canControl(s, 'connB')).toBe(true);
    expect(canControl(s, 'connA')).toBe(false);
  });

  it('a re-claim by the same owner does NOT bump the epoch (no handoff)', () => {
    const s = createLeaseState();
    const a1 = claim(s, 'connA', false, T0, 0n);
    const a2 = claim(s, 'connA', false, T0 + 5, 0n);
    expect(a1.granted && a2.granted && a1.epoch === a2.epoch).toBe(true);
  });
});

describe('lease — release + TTL auto-release (§7.9)', () => {
  it('release frees the lease; a later claim re-grants and bumps epoch', () => {
    const s = createLeaseState();
    claim(s, 'connA', false, T0, 0n); // epoch 1
    expect(release(s, 'connB')).toBe(false); // only the owner can release
    expect(release(s, 'connA')).toBe(true);
    expect(canControl(s, 'connA')).toBe(false);
    const r = claim(s, 'connB', false, T0 + 10, 0n);
    expect(r.granted && r.epoch === 2).toBe(true);
  });

  it('a lapsed heartbeat auto-releases the owner on TTL sweep', () => {
    const s = createLeaseState();
    claim(s, 'connA', false, T0, 0n);
    expect(sweepTtl(s, T0 + 10_000, 15_000)).toBeNull(); // within TTL
    heartbeat(s, 'connA', T0 + 14_000); // owner still alive
    expect(sweepTtl(s, T0 + 20_000, 15_000)).toBeNull(); // refreshed, still within
    const reclaimed = sweepTtl(s, T0 + 40_000, 15_000); // now lapsed
    expect(reclaimed).toBe('connA');
    expect(s.ownerConn).toBeNull();
  });
});

describe('lease — epoch fencing (§7.7/§7.9)', () => {
  it('a reply carrying a stale lease_epoch is fenced', () => {
    const s = createLeaseState();
    claim(s, 'connA', false, T0, 0n); // epoch 1
    claim(s, 'connB', true, T0 + 1, 0n); // forced → epoch 2
    expect(isFencedEpoch(s, 1)).toBe(true); // old owner's in-flight reply dropped
    expect(isFencedEpoch(s, 2)).toBe(false); // current epoch accepted
  });
});
