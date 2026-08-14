import { dirname, join } from 'node:path';
import type { SessionSpec } from '../core/types.js';
import type {
  ClaudeContinuityAttention,
  ClaudeContinuityStatus
} from './claudeContinuityStatus.js';
import { FileProviderSessionContinuityLedger } from './runtime/providerSessionContinuityLedger.js';
import { FileProviderSessionLaunchLedger } from './runtime/providerSessionLaunchLedger.js';

interface ReadProviderSessionContinuityStatusOptions {
  ledgerPath: string;
  launchLedgerPath?: string;
}

export function readProviderSessionContinuityStatus(
  sessions: readonly SessionSpec[],
  options: ReadProviderSessionContinuityStatusOptions
): ClaudeContinuityStatus {
  let ledger: FileProviderSessionContinuityLedger | undefined;
  let launchLedger: FileProviderSessionLaunchLedger | undefined;
  try {
    ledger = new FileProviderSessionContinuityLedger(options.ledgerPath, {
      readOnly: true
    });
    const sessionsById = new Map(
      sessions.map((session) => [session.sessionId, session])
    );
    launchLedger = new FileProviderSessionLaunchLedger(
      options.launchLedgerPath ??
        join(dirname(options.ledgerPath), 'provider-session-launch.ndjson'),
      { readOnly: true }
    );
    const issues = ledger
      .projectedTransitions()
      .filter((transition) => {
        const session = sessionsById.get(transition.deskSessionId);
        if (session === undefined) return false;
        if (transition.state === 'pending') return true;
        if (transition.state === 'cancelled-by-reset') {
          return (
            launchLedger?.current(transition.deskSessionId)?.state ===
            'prepared'
          );
        }
        return session.resume !== transition.observedProviderSessionId;
      })
      .map((transition): ClaudeContinuityAttention => {
        const session = sessionsById.get(transition.deskSessionId)!;
        const providerLabel =
          transition.provider === 'codex' ? 'Codex' : 'Claude';
        if (
          transition.state === 'cancelled-by-reset' ||
          (transition.state === 'resolved' && session.resume === undefined)
        ) {
          return {
            sessionId: transition.deskSessionId,
            ...(session.profileId === undefined
              ? {}
              : { profileId: session.profileId }),
            cwd: session.cwd,
            code: 'provider-session-reset-incomplete',
            message: `${providerLabel} provider session reset was interrupted; relaunch remains blocked until the durable transition is cancelled`,
            provider: transition.provider,
            durableProviderSessionId: transition.expectedProviderSessionId,
            observedProviderSessionId: transition.observedProviderSessionId,
            action: `desk reset-provider-session ${transition.deskSessionId} --force`
          };
        }
        return {
          sessionId: transition.deskSessionId,
          ...(session.profileId === undefined
            ? {}
            : { profileId: session.profileId }),
          cwd: session.cwd,
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
    launchLedger?.close();
    ledger?.close();
  }
}
