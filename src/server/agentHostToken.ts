import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Durable adapter-host auth (spec: docs/native-ui-mode-spec.md §4).
 *
 * Tokens must be verifiable after a desk-server restart, so they derive from a
 * persistent secret instead of in-memory state: token = HMAC-SHA256(secret,
 * tmuxSession + agent). Stable per session by design — the loopback socket
 * gates session identity, not replay, and the hello pid distinguishes spawns.
 */

export function resolveAgentHostSecretPath(homeDir_: string = homedir()): string {
  return join(homeDir_, '.config', 'desk', 'agent-host-secret');
}

export function getOrCreateAgentHostSecret(path: string = resolveAgentHostSecretPath()): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      return existing;
    }
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on creation; enforce on rewrite too.
  chmodSync(path, 0o600);
  return secret;
}

export function deriveAgentHostToken(secret: string, tmuxSession: string, agent: string): string {
  return createHmac('sha256', secret).update(`${tmuxSession}\n${agent}`).digest('hex');
}

export function verifyAgentHostToken(secret: string, tmuxSession: string, agent: string, token: string): boolean {
  const expected = Buffer.from(deriveAgentHostToken(secret, tmuxSession, agent), 'utf8');
  const provided = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
