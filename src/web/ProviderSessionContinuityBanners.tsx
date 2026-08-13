import { Copy, TriangleAlert } from 'lucide-react';
import type { ClaudeContinuityAttention } from '../server/claudeContinuityStatus.js';

interface ProviderSessionContinuityBannersProps {
  issues: readonly ClaudeContinuityAttention[];
  onCopyAction: (action: string) => void;
}

interface ProviderRebindIssue extends ClaudeContinuityAttention {
  code: 'provider-session-rebind-required';
  provider: 'claude' | 'codex';
  durableProviderSessionId: string;
  observedProviderSessionId: string;
  action: string;
}

function isProviderRebindIssue(
  issue: ClaudeContinuityAttention
): issue is ProviderRebindIssue {
  return (
    issue.code === 'provider-session-rebind-required' &&
    (issue.provider === 'claude' || issue.provider === 'codex') &&
    typeof issue.durableProviderSessionId === 'string' &&
    typeof issue.observedProviderSessionId === 'string' &&
    typeof issue.action === 'string'
  );
}

export function ProviderSessionContinuityBanners({
  issues,
  onCopyAction
}: ProviderSessionContinuityBannersProps): JSX.Element | null {
  const rebindIssues = issues.filter(isProviderRebindIssue);
  if (rebindIssues.length === 0) return null;

  return (
    <div
      className="providerContinuityBanners"
      aria-label="Provider session continuity blockers"
    >
      {rebindIssues.map((issue) => {
        const providerLabel = issue.provider === 'codex' ? 'Codex' : 'Claude';
        return (
          <div
            key={issue.sessionId}
            className="providerContinuityBanner"
            data-provider={issue.provider}
            role="alert"
          >
            <TriangleAlert size={15} aria-hidden="true" />
            <div className="providerContinuityBannerBody">
              <strong>{providerLabel} relaunch blocked</strong>
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
              aria-label={`Copy ${providerLabel} rebind command`}
              title={`Copy ${providerLabel} rebind command`}
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
