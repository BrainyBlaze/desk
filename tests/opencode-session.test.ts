import { describe, expect, it } from 'vitest';
import {
  isOpencodeSessionId,
  parseOpencodeSessionList,
  pickOpencodeCaptureResumeSession,
  pickOpencodeResumeSession
} from '../src/server/opencodeSession.js';

describe('isOpencodeSessionId', () => {
  it('accepts a real ses_ id (base62, shell-safe)', () => {
    expect(isOpencodeSessionId('ses_12a31855dffeHTCs6tcfOmsddP')).toBe(true);
  });
  it('rejects a UUID (that is codex/claude, not opencode)', () => {
    expect(isOpencodeSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
  });
  it('rejects empty / wrong prefix / shell-unsafe chars', () => {
    expect(isOpencodeSessionId('')).toBe(false);
    expect(isOpencodeSessionId('abc123')).toBe(false);
    expect(isOpencodeSessionId('ses_')).toBe(false);
    expect(isOpencodeSessionId('ses_abc; rm -rf /')).toBe(false);
    expect(isOpencodeSessionId('ses_abc$(whoami)')).toBe(false);
    expect(isOpencodeSessionId('ses_abc def')).toBe(false);
  });
});

describe('parseOpencodeSessionList', () => {
  const SAMPLE = JSON.stringify([
    { id: 'ses_aaa', title: 'one', created: 1000, updated: 1500, projectId: 'global', directory: '/p/a' },
    { id: 'ses_bbb', title: 'two', created: 2000, updated: 2000, projectId: 'global', directory: '/p/b' }
  ]);

  it('parses a valid session-list JSON array', () => {
    const out = parseOpencodeSessionList(SAMPLE);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'ses_aaa', directory: '/p/a', created: 1000, updated: 1500 });
  });
  it('tolerates surrounding log noise around the JSON array', () => {
    const noisy = `INFO starting\n${SAMPLE}\nINFO done\n`;
    expect(parseOpencodeSessionList(noisy)).toHaveLength(2);
  });
  it('returns [] on empty / non-JSON / no array', () => {
    expect(parseOpencodeSessionList('')).toEqual([]);
    expect(parseOpencodeSessionList('not json')).toEqual([]);
    expect(parseOpencodeSessionList('{"id":"ses_x"}')).toEqual([]);
  });
  it('skips entries missing required fields or with an invalid id', () => {
    const mixed = JSON.stringify([
      { id: 'ses_ok', directory: '/p', created: 1, updated: 2 },
      { id: 'not-a-ses', directory: '/p', created: 1, updated: 2 },
      { title: 'no id', directory: '/p', created: 1, updated: 2 },
      { id: 'ses_nodir', created: 1, updated: 2 }
    ]);
    const out = parseOpencodeSessionList(mixed);
    expect(out.map((s) => s.id)).toEqual(['ses_ok']);
  });
});

describe('pickOpencodeResumeSession', () => {
  const sessions = [
    { id: 'ses_old', title: '', created: 1000, updated: 1000, projectId: 'global', directory: '/proj' },
    { id: 'ses_new', title: '', created: 5000, updated: 6000, projectId: 'global', directory: '/proj' },
    { id: 'ses_other', title: '', created: 5000, updated: 5000, projectId: 'global', directory: '/elsewhere' }
  ];

  it('lazy resume (no sinceMs): returns the most-recently-updated session for the directory', () => {
    expect(pickOpencodeResumeSession(sessions, { directory: '/proj' })?.id).toBe('ses_new');
  });
  it('lazy resume: null when no session matches the directory', () => {
    expect(pickOpencodeResumeSession(sessions, { directory: '/nope' })).toBeNull();
  });
  it('capture (sinceMs): returns the single session created since launch in that dir', () => {
    // only ses_new (created 5000) is >= 4000 in /proj
    expect(pickOpencodeResumeSession(sessions, { directory: '/proj', sinceMs: 4000 })?.id).toBe('ses_new');
  });
  it('capture: FAIL CLOSED (null) when >1 session was created since launch in that dir (ambiguous)', () => {
    const ambiguous = [
      { id: 'ses_a', title: '', created: 5000, updated: 5000, projectId: 'global', directory: '/proj' },
      { id: 'ses_b', title: '', created: 5100, updated: 5100, projectId: 'global', directory: '/proj' }
    ];
    expect(pickOpencodeResumeSession(ambiguous, { directory: '/proj', sinceMs: 4000 })).toBeNull();
  });
  it('capture (sinceMs): returns a single pre-existing session updated since launch', () => {
    const resumedExisting = [
      { id: 'ses_old', title: '', created: 1000, updated: 2000, projectId: 'global', directory: '/proj' },
      { id: 'ses_current', title: '', created: 2000, updated: 7000, projectId: 'global', directory: '/proj' }
    ];
    expect(pickOpencodeResumeSession(resumedExisting, { directory: '/proj', sinceMs: 4000 })?.id).toBe(
      'ses_current'
    );
  });
  it('capture: FAIL CLOSED (null) when >1 pre-existing session was updated since launch', () => {
    const ambiguous = [
      { id: 'ses_a', title: '', created: 1000, updated: 5000, projectId: 'global', directory: '/proj' },
      { id: 'ses_b', title: '', created: 2000, updated: 5100, projectId: 'global', directory: '/proj' }
    ];
    expect(pickOpencodeResumeSession(ambiguous, { directory: '/proj', sinceMs: 4000 })).toBeNull();
  });
  it('capture: null when no session was created since launch (not created yet)', () => {
    expect(pickOpencodeResumeSession(sessions, { directory: '/proj', sinceMs: 9999 })).toBeNull();
  });
});

describe('pickOpencodeCaptureResumeSession', () => {
  const sessions = [
    { id: 'ses_old', title: '', created: 1000, updated: 1000, projectId: 'global', directory: '/proj' },
    { id: 'ses_new', title: '', created: 5000, updated: 6000, projectId: 'global', directory: '/proj' },
    { id: 'ses_other', title: '', created: 5000, updated: 5000, projectId: 'global', directory: '/elsewhere' }
  ];

  it('fails closed when capture has no launch timestamp or persisted launch metadata', () => {
    expect(pickOpencodeCaptureResumeSession(sessions, { directory: '/proj' })).toBeNull();
  });

  it('uses a persisted launch resume id only when it belongs to the same cwd', () => {
    expect(
      pickOpencodeCaptureResumeSession(sessions, {
        directory: '/proj',
        launchResumeId: 'ses_new'
      })?.id
    ).toBe('ses_new');
    expect(
      pickOpencodeCaptureResumeSession(sessions, {
        directory: '/proj',
        launchResumeId: 'ses_other'
      })
    ).toBeNull();
  });
});
