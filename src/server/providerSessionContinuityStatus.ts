import { dirname } from 'node:path';
import type { SessionSpec } from '../core/types.js';
import type {
  ClaudeContinuityAttention,
  ClaudeContinuityStatus
} from './claudeContinuityStatus.js';
import { FileProviderSessionContinuityLedger } from './runtime/providerSessionContinuityLedger.js';

interface ReadProviderSessionContinuityStatusOptions {
  ledgerPath: string;
}

export function readProviderSessionContinuityStatus(
  sessions: readonly SessionSpec[],
  options: ReadProviderSessionContinuityStatusOptions
): ClaudeContinuityStatus {
  let ledger: FileProviderSessionContinuityLedger | undefined;
  try {
    ledger = new FileProviderSessionContinuityLedger(options.ledgerPath, {
      readOnly: true
    });
    const sessionsById = new Map(
      sessions.map((session) => [session.sessionId, session])
    );
    const issues = ledger
      .projectedTransitions()
      .filter((transition) => transition.state === 'pending')
      .map((transition): ClaudeContinuityAttention => {
        const session = sessionsById.get(transition.deskSessionId);
        const providerLabel =
          transition.provider === 'codex' ? 'Codex' : 'Claude';
        return {
          sessionId: transition.deskSessionId,
          ...(session?.profileId === undefined
            ? {}
            : { profileId: session.profileId }),
          cwd: session?.cwd ?? dirname(options.ledgerPath),
          code: 'provider-session-rebind-required',
          message: `${providerLabel} provider session changed; relaunch is blocked until the durable binding is explicitly rebound`,
          provider: transition.provider,
          durableProviderSessionId: transition.expectedProviderSessionId,
          observedProviderSessionId: transition.observedProviderSessionId,
          action: `desk rebind-provider-session ${transition.deskSessionId} --to ${transition.observedProviderSessionId} --force`
        };
      });
    return { issues };
  } catch {
    return {
      issues: [
        {
          sessionId: 'provider-session-continuity',
          cwd: dirname(options.ledgerPath),
          code: 'continuity-store-corrupt',
          message:
            'Provider session continuity status is unreadable; relaunch remains blocked until the private store is repaired'
        }
      ]
    };
  } finally {
    ledger?.close();
  }
}
