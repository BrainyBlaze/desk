import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsService } from '../../src/server/lsp/diagnosticsService';

describe('diagnosticsService', () => {
  it('returns current diagnostics without acquiring a server or sending an LSP request', async () => {
    const manager = {
      getDiagnostics: vi.fn(() => ({
        diagnostics: [
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
            message: 'type error',
            severity: 1,
            source: 'typescript',
            code: 'ts-100',
            tags: [1]
          }
        ]
      })),
      acquireServer: vi.fn(),
      sendRequest: vi.fn()
    };
    const service = createDiagnosticsService({ manager });

    await expect(
      service.diagnostics({
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts',
        languageId: 'typescript'
      })
    ).resolves.toEqual({
      diagnostics: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          message: 'type error',
          severity: 1,
          source: 'typescript',
          code: 'ts-100',
          tags: [1]
        }
      ]
    });
    expect(manager.getDiagnostics).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      uri: 'file:///workspace/src/example.ts'
    });
    expect(manager.acquireServer).not.toHaveBeenCalled();
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('returns an empty diagnostics result when the manager has no diagnostics', async () => {
    const service = createDiagnosticsService({
      manager: {
        getDiagnostics: vi.fn(() => ({ diagnostics: [] }))
      }
    });

    await expect(
      service.diagnostics({
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts'
      })
    ).resolves.toEqual({ diagnostics: [] });
  });

  it('refreshes planned running targets and returns the merged cache', async () => {
    const manager = {
      getDiagnostics: vi.fn(() => ({ diagnostics: [{ range: range(), message: 'merged diagnostic' }] })),
      pullDiagnosticsForRunningSession: vi.fn(async () => ({ status: 'updated', diagnostics: [] }))
    };
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [
          { serverConfigId: 'typescript', workspaceRoot: '/workspace', isPrimary: true },
          { serverConfigId: 'eslint', workspaceRoot: '/workspace', isPrimary: false }
        ]
      }))
    };
    const service = createDiagnosticsService({ manager, requestPlanner });
    const settings = { enabled: true };

    await expect(
      service.diagnostics({
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts',
        languageId: 'typescript',
        settings,
        refresh: true
      })
    ).resolves.toEqual({ diagnostics: [{ range: range(), message: 'merged diagnostic' }] });

    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      feature: 'diagnostic'
    });
    expect(manager.pullDiagnosticsForRunningSession).toHaveBeenCalledTimes(2);
    expect(manager.pullDiagnosticsForRunningSession).toHaveBeenNthCalledWith(1, {
      workspaceRoot: '/workspace',
      serverConfigId: 'typescript',
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript'
    });
    expect(manager.pullDiagnosticsForRunningSession).toHaveBeenNthCalledWith(2, {
      workspaceRoot: '/workspace',
      serverConfigId: 'eslint',
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript'
    });
    expect(manager.getDiagnostics).toHaveBeenLastCalledWith({
      workspaceRoot: '/workspace',
      uri: 'file:///workspace/src/example.ts'
    });
  });

  it('keeps refresh best-effort and returns cached diagnostics when planning or pulls fail', async () => {
    const cached = { diagnostics: [{ range: range(), message: 'cached diagnostic' }] };
    const manager = {
      getDiagnostics: vi.fn(() => cached),
      pullDiagnosticsForRunningSession: vi.fn(async () => ({ status: 'failed', diagnostics: cached.diagnostics }))
    };
    const service = createDiagnosticsService({
      manager,
      requestPlanner: { planLspRequest: vi.fn(() => ({ targets: [{ serverConfigId: 'typescript', workspaceRoot: '/workspace', isPrimary: true }] })) }
    });

    await expect(
      service.diagnostics({
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts',
        settings: { enabled: true },
        refresh: true
      })
    ).resolves.toEqual(cached);

    expect(manager.pullDiagnosticsForRunningSession).toHaveBeenCalledTimes(1);

    const noPlanService = createDiagnosticsService({
      manager,
      requestPlanner: { planLspRequest: vi.fn(() => undefined) }
    });
    await expect(
      noPlanService.diagnostics({
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts',
        settings: { enabled: true },
        refresh: true
      })
    ).resolves.toEqual(cached);
  });
});

function range() {
  return { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } };
}
