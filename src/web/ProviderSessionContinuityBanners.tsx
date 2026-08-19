import { Copy, TriangleAlert } from 'lucide-react';
import type { ClaudeContinuityAttention } from '../server/claudeContinuityStatus.js';
import {
  isProviderSessionProvider,
  type ProviderSessionProvider
} from '../shared/providerSessionIdentity.js';

interface ProviderSessionContinuityBannersProps {
  issues: readonly ClaudeContinuityAttention[];
  onCopyAction: (action: string) => void;
}

interface ProviderContinuityActionIssue extends ClaudeContinuityAttention {
  code:
    | 'provider-session-rebind-required'
    | 'provider-session-reset-incomplete';
  provider: ProviderSessionProvider;
  durableProviderSessionId: string;
  observedProviderSessionId: string;
  action: string;
}

function isProviderContinuityActionIssue(
  issue: ClaudeContinuityAttention
): issue is ProviderContinuityActionIssue {
  return (
    (issue.code === 'provider-session-rebind-required' ||
      issue.code === 'provider-session-reset-incomplete') &&
    issue.provider !== undefined &&
    isProviderSessionProvider(issue.provider) &&
    typeof issue.durableProviderSessionId === 'string' &&
    typeof issue.observedProviderSessionId === 'string' &&
    typeof issue.action === 'string'
  );
}

export function ProviderSessionContinuityBanners({
  issues,
  onCopyAction
}: ProviderSessionContinuityBannersProps): JSX.Element | null {
  const actionableIssues = issues.filter(isProviderContinuityActionIssue);
  if (actionableIssues.length === 0) return null;

  return (
    <div
      className="providerContinuityBanners"
      aria-label="Provider session continuity blockers"
    >
      {actionableIssues.map((issue) => {
        const providerLabel =
          issue.provider.charAt(0).toUpperCase() + issue.provider.slice(1);
        const actionLabel =
          issue.code === 'provider-session-reset-incomplete'
            ? 'reset'
            : 'rebind';
        return (
          <div
            key={issue.sessionId}
            className="providerContinuityBanner"
            data-provider={issue.provider}
            role="alert"
          >
            <TriangleAlert size={15} aria-hidden="true" />
            <div className="providerContinuityBannerBody">
              <strong>
                {issue.code === 'provider-session-reset-incomplete'
                  ? `${providerLabel} reset interrupted`
                  : `${providerLabel} relaunch blocked`}
              </strong>
              <span>{issue.message}</span>
              <small>
                Durable <code>{issue.durableProviderSessionId}</code>; observed{' '}
                <code>{issue.observedProviderSessionId}</code>
              </small>
              <code className="providerContinuityAction">{issue.action}</code>
            </div>
            <button
              type="button"
              className="providerContinuityCopy"
              aria-label={`Copy ${providerLabel} ${actionLabel} command`}
              title={`Copy ${providerLabel} ${actionLabel} command`}
              onClick={() => onCopyAction(issue.action)}
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
