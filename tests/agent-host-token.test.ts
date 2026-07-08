import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deriveAgentHostToken,
  getOrCreateAgentHostSecret,
  verifyAgentHostToken
} from '../src/server/agentHostToken';

const dir = mkdtempSync(join(tmpdir(), 'desk-host-secret-'));
const secretPath = join(dir, 'nested', 'agent-host-secret');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('agent host token', () => {
  it('creates the secret once with owner-only permissions and returns it stably', () => {
    const first = getOrCreateAgentHostSecret(secretPath);
    const second = getOrCreateAgentHostSecret(secretPath);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('derives deterministic per-session tokens that differ across sessions and agents', () => {
    const secret = getOrCreateAgentHostSecret(secretPath);
    const token = deriveAgentHostToken(secret, 'agentdesk-alpha-main-chat-00000000', 'claude');
    expect(token).toBe(deriveAgentHostToken(secret, 'agentdesk-alpha-main-chat-00000000', 'claude'));
    expect(token).not.toBe(deriveAgentHostToken(secret, 'agentdesk-alpha-main-other-00000000', 'claude'));
    expect(token).not.toBe(deriveAgentHostToken(secret, 'agentdesk-alpha-main-chat-00000000', 'codex'));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies matching tokens and rejects wrong or malformed ones without throwing', () => {
    const secret = getOrCreateAgentHostSecret(secretPath);
    const token = deriveAgentHostToken(secret, 's1', 'claude');
    expect(verifyAgentHostToken(secret, 's1', 'claude', token)).toBe(true);
    expect(verifyAgentHostToken(secret, 's1', 'codex', token)).toBe(false);
    expect(verifyAgentHostToken(secret, 's2', 'claude', token)).toBe(false);
    expect(verifyAgentHostToken(secret, 's1', 'claude', 'nope')).toBe(false);
    expect(verifyAgentHostToken(secret, 's1', 'claude', '')).toBe(false);
  });
});
