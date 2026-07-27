import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENCODE_EVENT_TYPES } from '../../src/core/agentState/opencodeFacts.js';

/**
 * Drift canary for the pinned OpenCode event union.
 *
 * Desk does not depend on the OpenCode SDK, so the union is pinned in source.
 * A pin with no canary rots silently: upstream renames an event, the adapter
 * stops producing facts, and every affected session quietly reads `unknown`
 * with nothing to explain why. This test reads the SDK when one is installed
 * locally and fails the moment the pin and reality diverge.
 *
 * It skips where no SDK is present (CI, fresh checkouts) — the pin remains the
 * contract, this is the tripwire.
 */
const CANDIDATE_TYPE_PATHS = [
  join(homedir(), '.opencode', 'node_modules', '@opencode-ai', 'sdk', 'dist', 'gen', 'types.gen.d.ts'),
  join(homedir(), '.config', 'desk', 'opencode', 'node_modules', '@opencode-ai', 'sdk', 'dist', 'gen', 'types.gen.d.ts')
];

function installedTypesPath(): string | undefined {
  return CANDIDATE_TYPE_PATHS.find((path) => existsSync(path));
}

/** The `type` literal of every member of the SDK's `Event` union. */
function installedEventTypes(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const union = /export type Event = ([^;]+);/.exec(source);
  if (!union) {
    throw new Error(`no Event union found in ${path}`);
  }
  const members = union[1].split('|').map((name) => name.trim());
  const types = members.map((member) => {
    const declaration = new RegExp(`export type ${member} = \\{\\s*type: "([^"]+)"`).exec(source);
    if (!declaration) {
      throw new Error(`no type literal found for ${member}`);
    }
    return declaration[1];
  });
  return [...new Set(types)].sort();
}

describe('pinned OpenCode event union matches the installed SDK', () => {
  const path = installedTypesPath();

  it.skipIf(!path)('has not drifted', () => {
    expect(installedEventTypes(path as string)).toEqual([...OPENCODE_EVENT_TYPES]);
  });

  it('names where the pin came from, so a future reader can re-derive it', () => {
    expect(CANDIDATE_TYPE_PATHS.every((candidate) => candidate.includes('@opencode-ai/sdk'))).toBe(true);
  });
});
