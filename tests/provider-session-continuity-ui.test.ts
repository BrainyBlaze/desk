import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeContinuityAttention } from '../src/server/claudeContinuityStatus.js';
import { ProviderSessionContinuityBanners } from '../src/web/ProviderSessionContinuityBanners.js';

const CODEX_OLD = '11111111-1111-4111-8111-111111111111';
const CODEX_NEW = '22222222-2222-4222-8222-222222222222';
const CLAUDE_OLD = '33333333-3333-4333-8333-333333333333';
const CLAUDE_NEW = '44444444-4444-4444-8444-444444444444';

function issue(
  provider: 'claude' | 'codex',
  sessionId: string,
  durableProviderSessionId: string,
  observedProviderSessionId: string
): ClaudeContinuityAttention {
  const label = provider === 'codex' ? 'Codex' : 'Claude';
  return {
    sessionId,
    cwd: `/workspace/${sessionId}`,
    code: 'provider-session-rebind-required',
    message: `${label} provider session changed; relaunch is blocked until the durable binding is explicitly rebound`,
    provider,
    durableProviderSessionId,
    observedProviderSessionId,
    action: `desk rebind-provider-session ${sessionId} --to ${observedProviderSessionId} --force`
  };
}

function resetIssue(
  provider: 'claude' | 'codex',
  sessionId: string,
  durableProviderSessionId: string,
  observedProviderSessionId: string
): ClaudeContinuityAttention {
  const label = provider === 'codex' ? 'Codex' : 'Claude';
  return {
    sessionId,
    cwd: `/workspace/${sessionId}`,
    code: 'provider-session-reset-incomplete',
    message: `${label} provider session reset was interrupted; relaunch remains blocked until the durable transition is cancelled`,
    provider,
    durableProviderSessionId,
    observedProviderSessionId,
    action: `desk reset-provider-session ${sessionId} --force`
  };
}

describe('provider session continuity App banners', () => {
  it('renders equivalent actionable Codex and Claude relaunch blockers', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderSessionContinuityBanners, {
        issues: [
          issue('codex', 'codex-agent', CODEX_OLD, CODEX_NEW),
          issue('claude', 'claude-agent', CLAUDE_OLD, CLAUDE_NEW),
          resetIssue('codex', 'codex-reset', CODEX_OLD, CODEX_NEW),
          {
            sessionId: 'claude-memory',
            cwd: '/workspace/memory',
            code: 'claude-memory-conflicts',
            message: 'one memory conflict'
          }
        ],
        onCopyAction: vi.fn()
      })
    );

    expect(html).toContain('data-provider="codex"');
    expect(html).toContain('data-provider="claude"');
    expect(html).toContain('Codex relaunch blocked');
    expect(html).toContain('Claude relaunch blocked');
    expect(html).toContain('Codex reset interrupted');
    expect(html).toContain(CODEX_OLD);
    expect(html).toContain(CLAUDE_OLD);
    expect(html).toContain(
      `desk rebind-provider-session codex-agent --to ${CODEX_NEW} --force`
    );
    expect(html).toContain(
      `desk rebind-provider-session claude-agent --to ${CLAUDE_NEW} --force`
    );
    expect(html).toContain('aria-label="Copy Codex rebind command"');
    expect(html).toContain('aria-label="Copy Claude rebind command"');
    expect(html).toContain(
      'desk reset-provider-session codex-reset --force'
    );
    expect(html).toContain('aria-label="Copy Codex reset command"');
    expect(html).not.toContain('one memory conflict');

    const appSource = readFileSync(
      new URL('../src/web/App.tsx', import.meta.url),
      'utf8'
    );
    expect(appSource).toContain('<ProviderSessionContinuityBanners');
    expect(appSource).toContain('copyContinuityAction');
    expect(appSource).toContain('Recovery command copied');
  });
});
