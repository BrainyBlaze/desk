// §10 store transforms (cutover 3a) — the pure, additive, side-effect-free
// exports the production migration gate invokes before createDeskServices.
// Convention (matches shared/migration): re-key via the canonical
// tmuxSession→sessionId map; unmapped entries are REPORTED, never silently
// lost; policy belongs to the gate.

import { describe, expect, it } from 'vitest';
import { migrateResumeCaptureStore, type PendingResumeCapture } from '../../src/core/resumeCaptureState.js';
import { migrateDeliveryEventLine } from '../../src/server/channelsEvents.js';
import { migrateMemberManifestContent } from '../../src/server/channelsProtocol.js';

const MAP = new Map([
  ['agentdesk-desk-main-codex-a159d2bf', 'codex-2'],
  ['agentdesk-canary-shell-002e06d4', 'shell']
]);

describe('migrateResumeCaptureStore', () => {
  const capture = (tmuxSession: string): PendingResumeCapture => ({
    tmuxSession,
    agent: 'codex',
    cwd: '/w',
    sinceMs: 100,
    deadlineMs: 200,
    launchResumeId: 'r-1'
  });

  it('re-keys mapped entries to sessionId and preserves every field', () => {
    const result = migrateResumeCaptureStore([capture('agentdesk-canary-shell-002e06d4')], MAP);
    expect(result.items).toEqual([
      { sessionId: 'shell', agent: 'codex', cwd: '/w', sinceMs: 100, deadlineMs: 200, launchResumeId: 'r-1' }
    ]);
    expect(result.dropped).toEqual([]);
  });

  it('reports unmapped entries instead of silently losing them', () => {
    const gone = capture('agentdesk-gone-xyz');
    const result = migrateResumeCaptureStore([gone, capture('agentdesk-canary-shell-002e06d4')], MAP);
    expect(result.dropped).toEqual([gone]);
    expect(result.items).toHaveLength(1);
  });

  it('omits an absent launchResumeId rather than writing undefined', () => {
    const { launchResumeId: _omit, ...bare } = capture('agentdesk-canary-shell-002e06d4');
    const result = migrateResumeCaptureStore([bare], MAP);
    expect('launchResumeId' in result.items[0]).toBe(false);
  });
});

describe('migrateDeliveryEventLine', () => {
  it('renames tmuxSession to sessionId with the mapped value, preserving all other fields', () => {
    const line = JSON.stringify({ seq: 7, at: 't', tmuxSession: 'agentdesk-canary-shell-002e06d4', kind: 'queued', channel: 'desk' });
    const result = migrateDeliveryEventLine(line, MAP);
    expect(result.kind).toBe('migrated');
    if (result.kind === 'migrated') {
      expect(JSON.parse(result.line)).toEqual({ seq: 7, at: 't', kind: 'queued', channel: 'desk', sessionId: 'shell' });
    }
  });

  it('passes through channel-level events and blank lines unchanged', () => {
    const channelLine = JSON.stringify({ seq: 1, at: 't', kind: 'queued', channel: 'desk' });
    expect(migrateDeliveryEventLine(channelLine, MAP)).toEqual({ kind: 'unchanged', line: channelLine });
    expect(migrateDeliveryEventLine('', MAP)).toEqual({ kind: 'unchanged', line: '' });
  });

  it('classifies an unmapped tmuxSession (reported, line untouched)', () => {
    const line = JSON.stringify({ seq: 2, at: 't', tmuxSession: 'agentdesk-gone-xyz', kind: 'queued' });
    expect(migrateDeliveryEventLine(line, MAP)).toEqual({ kind: 'unmapped', line, tmuxSession: 'agentdesk-gone-xyz' });
  });

  it('classifies malformed lines without throwing (streaming safety)', () => {
    expect(migrateDeliveryEventLine('{not json', MAP).kind).toBe('malformed');
    expect(migrateDeliveryEventLine('[1,2]', MAP).kind).toBe('malformed');
  });
});

describe('migrateMemberManifestContent', () => {
  it('re-keys the tmux: line to session: and leaves everything else byte-identical', () => {
    const content = [
      '---',
      'name: codex',
      'type: codex-cli',
      'status: active',
      'joined: 2026-01-01',
      'tmux: agentdesk-desk-main-codex-a159d2bf',
      'role: reviewer',
      'functions: cross-review, verification',
      '---'
    ].join('\n');
    const result = migrateMemberManifestContent(content, MAP);
    expect(result.migrated).toBe(true);
    expect(result.unmapped).toEqual([]);
    expect(result.content).toBe(content.replace('tmux: agentdesk-desk-main-codex-a159d2bf', 'session: codex-2'));
  });

  it('leaves an unmapped tmux: line in place and reports it', () => {
    const content = 'name: ghost\ntmux: agentdesk-gone-xyz\n';
    const result = migrateMemberManifestContent(content, MAP);
    expect(result.migrated).toBe(false);
    expect(result.unmapped).toEqual(['agentdesk-gone-xyz']);
    expect(result.content).toBe(content);
  });

  it('is a no-op for human members without a tmux line', () => {
    const content = 'name: human\ntype: human\n';
    expect(migrateMemberManifestContent(content, MAP)).toEqual({ content, migrated: false, unmapped: [] });
  });
});
