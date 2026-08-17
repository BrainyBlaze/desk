import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifestFile } from '../src/core/config.js';
import { buildSessionSpecs } from '../src/core/manifest.js';
import {
  bindProviderSessionIdentity,
  clearProviderSessionIdentity,
  readProviderSessionBinding,
  replaceProviderSessionIdentity
} from '../src/server/providerSessionBinding.js';
import {
  extractProviderSessionId,
  isProviderSessionProvider,
  isValidProviderSessionId
} from '../src/shared/providerSessionIdentity.js';

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CODEX_ID = '33333333-3333-4333-8333-333333333333';
const OWNED_CLAUDE_ID = '44444444-4444-4444-8444-444444444444';
const OPENCODE_ID = 'ses_12a31855dffeHTCs6tcfOmsddP';

const manifestSource = `
projects:
  - id: demo
    cwd: /workspace/projects/demo
    groups:
      - id: main
        sessions:
          - { name: claude, sessionId: desk-claude, agent: claude, uiMode: terminal }
          - { name: claude-owner, sessionId: desk-claude-owner, agent: claude, resume: ${OWNED_CLAUDE_ID}, uiMode: terminal }
          - { name: codex, sessionId: desk-codex, agent: codex, uiMode: terminal }
          - { name: open, sessionId: desk-open, agent: opencode, uiMode: terminal }
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createManifest(): { manifestPath: string; homeDir: string } {
  const homeDir = mkdtempSync(join(tmpdir(), 'desk-provider-session-binding-'));
  roots.push(homeDir);
  const manifestPath = join(homeDir, 'desk.yaml');
  writeFileSync(manifestPath, manifestSource);
  return { manifestPath, homeDir };
}

function persistedResume(
  manifestPath: string,
  homeDir: string,
  deskSessionId: string
): string | undefined {
  return buildSessionSpecs(readManifestFile(manifestPath), { homeDir }).find(
    (spec) => spec.sessionId === deskSessionId
  )?.resume;
}

describe('bindProviderSessionIdentity', () => {
  it.each([
    ['claude', 'desk-claude', CLAUDE_ID],
    ['codex', 'desk-codex', CODEX_ID],
    ['opencode', 'desk-open', OPENCODE_ID]
  ] as const)(
    'persists an exact %s id and accepts the same binding idempotently',
    async (provider, deskSessionId, providerSessionId) => {
      const { manifestPath, homeDir } = createManifest();

      await expect(
        bindProviderSessionIdentity({
          manifestPath,
          homeDir,
          deskSessionId,
          provider,
          providerSessionId
        })
      ).resolves.toEqual({ ok: true, kind: 'persisted' });
      expect(persistedResume(manifestPath, homeDir, deskSessionId)).toBe(
        providerSessionId
      );

      const before = readFileSync(manifestPath, 'utf8');
      await expect(
        bindProviderSessionIdentity({
          manifestPath,
          homeDir,
          deskSessionId,
          provider,
          providerSessionId
        })
      ).resolves.toEqual({ ok: true, kind: 'already-bound' });
      expect(readFileSync(manifestPath, 'utf8')).toBe(before);
    }
  );

  it('rejects a different id for an already-bound Desk session', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      providerSessionId: CODEX_ID
    });
    const before = readFileSync(manifestPath, 'utf8');

    await expect(
      bindProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-codex',
        provider: 'codex',
        providerSessionId: OTHER_CODEX_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-mismatch'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects a provider that differs from the configured agent', async () => {
    const { manifestPath, homeDir } = createManifest();
    const before = readFileSync(manifestPath, 'utf8');

    await expect(
      bindProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-claude',
        provider: 'codex',
        providerSessionId: CODEX_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-agent-mismatch'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects an id outside the configured provider grammar', async () => {
    const { manifestPath, homeDir } = createManifest();
    const before = readFileSync(manifestPath, 'utf8');

    await expect(
      bindProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-codex',
        provider: 'codex',
        providerSessionId: "'; touch /tmp/pwn #"
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-id-invalid'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects an id already owned by another Desk session', async () => {
    const { manifestPath, homeDir } = createManifest();
    const before = readFileSync(manifestPath, 'utf8');

    await expect(
      bindProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-claude',
        provider: 'claude',
        providerSessionId: OWNED_CLAUDE_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-id-conflict'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects an unknown durable Desk session id', async () => {
    const { manifestPath, homeDir } = createManifest();
    const before = readFileSync(manifestPath, 'utf8');

    await expect(
      bindProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'missing-session',
        provider: 'claude',
        providerSessionId: CLAUDE_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-not-found'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('propagates corrupt manifest storage without changing its bytes', async () => {
    const { manifestPath, homeDir } = createManifest();
    writeFileSync(manifestPath, '');

    await expect(
      bindProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-claude',
        provider: 'claude',
        providerSessionId: CLAUDE_ID
      })
    ).rejects.toThrow('desk manifest is empty');
    expect(readFileSync(manifestPath, 'utf8')).toBe('');
  });
});

describe('provider session reset manifest transaction', () => {
  it('fails closed when two Desk sessions claim the same provider session id', () => {
    const { manifestPath, homeDir } = createManifest();
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - { name: first, sessionId: desk-first, cwd: /tmp, agent: codex, resume: ${CODEX_ID} }\n      - { name: second, sessionId: desk-second, cwd: /tmp, agent: codex, resume: ${CODEX_ID} }\n`
    );

    expect(
      readProviderSessionBinding({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-first'
      })
    ).toMatchObject({
      ok: false,
      code: 'provider-session-id-conflict'
    });
  });

  it('reads and comparison-clears only the expected durable binding', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      providerSessionId: CODEX_ID
    });

    expect(
      readProviderSessionBinding({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-codex'
      })
    ).toEqual({
      ok: true,
      provider: 'codex',
      providerSessionId: CODEX_ID
    });
    await expect(
      clearProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-codex',
        provider: 'codex',
        expectedProviderSessionId: CODEX_ID
      })
    ).resolves.toEqual({ ok: true, kind: 'cleared' });
    expect(persistedResume(manifestPath, homeDir, 'desk-codex')).toBeUndefined();

    await expect(
      clearProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-codex',
        provider: 'codex',
        expectedProviderSessionId: CODEX_ID
      })
    ).resolves.toEqual({ ok: true, kind: 'already-cleared' });
  });

  it('leaves manifest bytes unchanged when the expected binding changed', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      providerSessionId: CODEX_ID
    });
    const before = readFileSync(manifestPath, 'utf8');

    await expect(
      clearProviderSessionIdentity({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-codex',
        provider: 'codex',
        expectedProviderSessionId: OTHER_CODEX_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-mismatch'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects reset discovery for a non-provider session', () => {
    const { manifestPath, homeDir } = createManifest();
    writeFileSync(
      manifestPath,
      'groups:\n  - id: shell-group\n    sessions:\n      - { name: shell, sessionId: desk-shell, command: bash }\n'
    );

    expect(
      readProviderSessionBinding({
        manifestPath,
        homeDir,
        deskSessionId: 'desk-shell'
      })
    ).toMatchObject({
      ok: false,
      code: 'provider-session-agent-mismatch'
    });
  });
});

describe('provider session rebind manifest transaction', () => {
  it('atomically replaces only the exact old identity and is retry-safe once new is durable', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      providerSessionId: CODEX_ID
    });

    await expect(replaceProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      expectedProviderSessionId: CODEX_ID,
      providerSessionId: OTHER_CODEX_ID
    })).resolves.toEqual({ ok: true, kind: 'replaced' });
    expect(persistedResume(manifestPath, homeDir, 'desk-codex')).toBe(OTHER_CODEX_ID);

    const beforeRetry = readFileSync(manifestPath, 'utf8');
    await expect(replaceProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      expectedProviderSessionId: CODEX_ID,
      providerSessionId: OTHER_CODEX_ID
    })).resolves.toEqual({ ok: true, kind: 'already-replaced' });
    expect(readFileSync(manifestPath, 'utf8')).toBe(beforeRetry);
  });

  it('preserves the old identity on stale expected state, wrong provider, invalid target, and unknown session', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      providerSessionId: CODEX_ID
    });
    const before = readFileSync(manifestPath, 'utf8');

    const attempts = [
      replaceProviderSessionIdentity({ manifestPath, homeDir, deskSessionId: 'desk-codex', provider: 'codex', expectedProviderSessionId: OTHER_CODEX_ID, providerSessionId: '55555555-5555-4555-8555-555555555555' }),
      replaceProviderSessionIdentity({ manifestPath, homeDir, deskSessionId: 'desk-codex', provider: 'claude', expectedProviderSessionId: CODEX_ID, providerSessionId: CLAUDE_ID }),
      replaceProviderSessionIdentity({ manifestPath, homeDir, deskSessionId: 'desk-codex', provider: 'codex', expectedProviderSessionId: CODEX_ID, providerSessionId: 'invalid' }),
      replaceProviderSessionIdentity({ manifestPath, homeDir, deskSessionId: 'missing', provider: 'codex', expectedProviderSessionId: CODEX_ID, providerSessionId: OTHER_CODEX_ID })
    ];
    const results = await Promise.all(attempts);
    expect(results.map((result) => result.ok ? 'ok' : result.code)).toEqual([
      'provider-session-mismatch',
      'provider-session-agent-mismatch',
      'provider-session-id-invalid',
      'provider-session-not-found'
    ]);
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects a target owned by another Desk session and leaves the manifest unchanged', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-claude',
      provider: 'claude',
      providerSessionId: CLAUDE_ID
    });
    const before = readFileSync(manifestPath, 'utf8');

    await expect(replaceProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-claude',
      provider: 'claude',
      expectedProviderSessionId: CLAUDE_ID,
      providerSessionId: OWNED_CLAUDE_ID
    })).resolves.toMatchObject({
      ok: false,
      code: 'provider-session-id-conflict'
    });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('propagates persistence failure without altering the original manifest bytes', async () => {
    const { manifestPath, homeDir } = createManifest();
    await bindProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      providerSessionId: CODEX_ID
    });
    const before = readFileSync(manifestPath, 'utf8');

    await expect(replaceProviderSessionIdentity({
      manifestPath,
      homeDir,
      deskSessionId: 'desk-codex',
      provider: 'codex',
      expectedProviderSessionId: CODEX_ID,
      providerSessionId: OTHER_CODEX_ID
    }, {
      updateManifest: async () => {
        throw new Error('simulated manifest persistence failure');
      }
    })).rejects.toThrow('simulated manifest persistence failure');
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });
});

describe('provider session identity contract', () => {
  it.each(['claude', 'codex', 'opencode'] as const)(
    'recognizes supported provider %s',
    (provider) => {
      expect(isProviderSessionProvider(provider)).toBe(true);
    }
  );

  it.each(['bash', 'custom', '', undefined])(
    'rejects unsupported provider %s',
    (provider) => {
      expect(isProviderSessionProvider(provider)).toBe(false);
    }
  );

  it('uses UUID grammar for Claude and Codex and ses grammar for OpenCode', () => {
    expect(isValidProviderSessionId('claude', CLAUDE_ID)).toBe(true);
    expect(isValidProviderSessionId('codex', CODEX_ID)).toBe(true);
    expect(isValidProviderSessionId('opencode', OPENCODE_ID)).toBe(true);

    expect(isValidProviderSessionId('claude', OPENCODE_ID)).toBe(false);
    expect(isValidProviderSessionId('codex', OPENCODE_ID)).toBe(false);
    expect(isValidProviderSessionId('opencode', CODEX_ID)).toBe(false);
  });

  it.each([
    ['claude', { session_id: ` ${CLAUDE_ID} ` }, CLAUDE_ID],
    ['codex', { session_id: ` ${CODEX_ID} ` }, CODEX_ID],
    ['opencode', { sessionID: ` ${OPENCODE_ID} ` }, OPENCODE_ID]
  ] as const)(
    'extracts only the canonical %s provider payload field',
    (provider, payload, expected) => {
      expect(extractProviderSessionId(provider, payload)).toBe(expected);
    }
  );

  it('does not mistake Codex current-thread or camelCase fields for the root session id', () => {
    expect(
      extractProviderSessionId('codex', {
        id: CODEX_ID,
        thread_id: CODEX_ID,
        threadId: CODEX_ID,
        sessionId: CODEX_ID
      })
    ).toBeUndefined();
  });

  it('does not cross-accept provider-specific aliases', () => {
    expect(extractProviderSessionId('claude', { sessionId: CLAUDE_ID })).toBeUndefined();
    expect(extractProviderSessionId('opencode', { session_id: OPENCODE_ID })).toBeUndefined();
    expect(extractProviderSessionId('codex', null)).toBeUndefined();
    expect(extractProviderSessionId('codex', [])).toBeUndefined();
  });
});
