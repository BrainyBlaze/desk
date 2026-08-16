import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { lockSync } from 'proper-lockfile';

// Three refresh intervals per staleness window: one missed heartbeat (a GC
// pause, an I/O stall — both observed on this machine under a 2 GiB daemon)
// must not hand the home to a contender that happens to knock in that gap.
const OWNER_UPDATE_MS = 1_000;
const OWNER_STALE_MS = 3_000;

export interface ChannelsRuntimeOwner {
  release(): void;
}

export interface AcquireChannelsRuntimeOwnerOptions {
  /**
   * What to do when the live lease is destroyed from under this owner (an
   * operator wiping `_engine`, a filesystem fault, a foreign tool). Ownership
   * cannot be honestly continued — another server may already hold the home —
   * and the library's default would throw from inside its refresh timer as an
   * unhandled exception with no server name and no explanation. The default
   * here is a NAMED loud exit: log why, then exit non-zero, so the operator
   * learns what stopped the server. Injectable so a runtime host can choose
   * to fail Channels closed instead of the whole process.
   */
  onLeaseLost?: (diagnostic: string, cause: Error) => void;
}

export function acquireChannelsRuntimeOwner(
  home: string,
  options: AcquireChannelsRuntimeOwnerOptions = {}
): ChannelsRuntimeOwner {
  const engineDir = join(home, '_engine');
  mkdirSync(engineDir, { recursive: true });

  // The retired engine's pid record. It removed this file only on its
  // crash-reclaim path — an orderly stop left it behind — and nothing else
  // in Desk (installer, scripts, runtime) touches it, so the remedy has to
  // name the file itself. Under the lease scheme it carries no authority; it
  // is refused rather than silently deleted so the operator learns that a
  // pre-lease server ran here and confirms none is still running.
  const obsoleteOwnershipPath = join(engineDir, 'engine.pid');
  if (existsSync(obsoleteOwnershipPath)) {
    throw new Error(
      `obsolete Channels ownership artifact at ${obsoleteOwnershipPath}: a Desk server older than the ownership lease ran here. Stop every Desk server for this home, delete ${obsoleteOwnershipPath}, then restart.`
    );
  }

  const leasePath = join(engineDir, 'server-owner.lease');
  let released = false;
  let releaseLease: () => void;
  try {
    releaseLease = lockSync(engineDir, {
      lockfilePath: leasePath,
      realpath: false,
      retries: 0,
      stale: OWNER_STALE_MS,
      update: OWNER_UPDATE_MS,
      onCompromised: (cause) => {
        released = true;
        const diagnostic = `Channels ownership lease at ${leasePath} was lost while this server held it (${cause.message}); another Desk server may now own ${home}. Stopping.`;
        (options.onLeaseLost ?? exitOnLeaseLost)(diagnostic, cause);
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKED') {
      throw new Error(`another Desk server owns Channels at ${home}`);
    }
    throw error;
  }

  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseLease();
    }
  };
}

function exitOnLeaseLost(diagnostic: string): void {
  process.stderr.write(`${diagnostic}\n`);
  process.exit(3);
}
