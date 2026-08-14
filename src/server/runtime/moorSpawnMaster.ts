// Supervised moor holder launch (#9, moor private.rs + unix.rs launch
// channel). Desk delivers exactly one 32-byte private launch record over an
// inherited fd named by the invocation-derived <BASENAME>_LAUNCH_CHANNEL
// selector (decimal fd number, spec §10.1.1), closes it (EOF), and sets BOTH
// moor generation carriers — the invocation-derived <BASENAME>_GENERATION and
// the fixed child-visible MOOR_SESSION_GENERATION (§10.1) — to the record's
// canonical decimal generation. The holder validates all three against each
// other and strips them; a missing selector means unsupervised generation 1
// (OB-18), so every carrier here is load-bearing. Desk's OWN
// DESK_SESSION_GENERATION is set from the same source value but is opaque
// application env to moor: never validated or stripped by the holder, it
// rides through to the session child for Desk's hooks/agent-host fencing.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import {
  DESK_SESSION_GENERATION,
  MOOR_SESSION_GENERATION,
  encodeMoorLaunchRecord,
  moorGenerationEnvKey,
  moorLaunchChannelEnvKey
} from './moorLaunchChannel.js';
import { sessionTerminalEnv } from '../../shared/sessionTerminalEnv.js';
import { DESK_PROVIDER_LAUNCH_PROOF } from '../../shared/providerSessionIdentity.js';

export interface MoorSpawnOptions {
  binPath: string;
  args: string[];
  /** Ledger-allocated supervised generation (>= 2, OB-18). */
  generation: number;
  /**
   * Override for the child's argv[0]. The generation env key derives from the
   * INVOKED basename — it must match what the holder sees as its own argv[0].
   */
  argv0?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  providerLaunchProof?: string;
  detached?: boolean;
}

export interface MoorSpawnResult {
  child: ChildProcess;
  /** The 16-byte launch nonce written into the record. */
  nonce: Uint8Array;
}

/** The record channel is the first fd after stdio — stable because we wire stdio ourselves. */
const LAUNCH_CHANNEL_FD = 3;

/**
 * The exact supervision carriers Desk itself has ever set. A stale one from an
 * earlier launch under a different invocation name is a conflicting generation
 * authority and must never survive into the child (no-legacy rule) — but
 * unrelated application environment (any other `*_GENERATION`) is not ours to
 * strip.
 */
const SUPERVISION_CARRIERS = [
  'ATCH_GENERATION',
  'MOOR_GENERATION',
  'MOOR_LAUNCH_CHANNEL',
  MOOR_SESSION_GENERATION,
  DESK_SESSION_GENERATION,
  DESK_PROVIDER_LAUNCH_PROOF,
  // The pre-decoupling Desk-branded selector name: no live producer sets it
  // anymore, but an inherited stale one is still a conflicting authority.
  'DESK_MOOR_LAUNCH_CHANNEL'
];

function withoutStaleCarriers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of SUPERVISION_CARRIERS) delete clean[key];
  return clean;
}

export function spawnMoorMaster(options: MoorSpawnOptions): MoorSpawnResult {
  if (process.platform === 'win32') {
    // Windows moor parses the selector as the lowercase-hex value of the
    // actual inherited pipe HANDLE (windows.rs), which Node cannot name for
    // an fd-numbered stdio slot. Fail closed rather than mis-launch; the
    // Windows launcher seam ships with the moor #4 Windows conformance lane.
    throw new Error(
      'MOOR_WINDOWS_LAUNCH_UNSUPPORTED: supervised Windows launch requires the native inherited-handle launcher seam'
    );
  }
  const nonce = randomBytes(16);
  // Encodes AND validates: integer generation in 2..=u32::MAX, nonzero nonce.
  const record = encodeMoorLaunchRecord(options.generation, nonce);
  const invoked = options.argv0 ?? options.binPath;
  const generationValue = String(options.generation);

  const inherited = withoutStaleCarriers(options.env ?? process.env);
  const child = spawn(options.binPath, options.args, {
    ...(options.argv0 === undefined ? {} : { argv0: options.argv0 }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: options.detached ?? false,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    env: {
      ...inherited,
      // The terminal identity and locale the session child is entitled to
      // (desk#45, desk#51). The holder passes application environment through
      // unchanged (§4.7), so this is the one place that can compose it for
      // EVERY session kind. Only absent keys are filled in.
      ...sessionTerminalEnv(inherited),
      ...(options.providerLaunchProof === undefined
        ? {}
        : { [DESK_PROVIDER_LAUNCH_PROOF]: options.providerLaunchProof }),
      [moorLaunchChannelEnvKey(invoked)]: String(LAUNCH_CHANNEL_FD),
      [moorGenerationEnvKey(invoked)]: generationValue,
      [MOOR_SESSION_GENERATION]: generationValue,
      [DESK_SESSION_GENERATION]: generationValue
    }
  });

  // Exactly one record, then EOF: the holder reads a fixed 32 bytes and treats
  // anything else (short read, trailing bytes, open channel) as fail-closed.
  // The channel's stream errors are CONTAINED: a child that never started
  // (ENOENT) collapses the pipe and would otherwise emit an uncaught EPIPE —
  // the launch failure itself surfaces through the child's 'error'/exit path.
  const channel = child.stdio[LAUNCH_CHANNEL_FD] as Writable;
  channel.on('error', () => undefined);
  channel.end(record);
  return { child, nonce };
}
