import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { lockSync } from 'proper-lockfile';

const OWNER_STALE_MS = 2_000;
const OWNER_UPDATE_MS = 1_000;

export interface ChannelsRuntimeOwner {
  release(): void;
}

export function acquireChannelsRuntimeOwner(home: string): ChannelsRuntimeOwner {
  const engineDir = join(home, '_engine');
  mkdirSync(engineDir, { recursive: true });

  const obsoleteOwnershipPath = join(engineDir, 'engine.pid');
  if (existsSync(obsoleteOwnershipPath)) {
    throw new Error(
      `obsolete Channels ownership artifact at ${obsoleteOwnershipPath}; stop Desk and run the current installer before restarting`
    );
  }

  const leasePath = join(engineDir, 'server-owner.lease');
  let releaseLease: () => void;
  try {
    releaseLease = lockSync(engineDir, {
      lockfilePath: leasePath,
      realpath: false,
      retries: 0,
      stale: OWNER_STALE_MS,
      update: OWNER_UPDATE_MS
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKED') {
      throw new Error(`another Desk server owns Channels at ${home}`);
    }
    throw error;
  }

  let released = false;
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
