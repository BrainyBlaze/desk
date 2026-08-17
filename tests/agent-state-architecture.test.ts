import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:js|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('canonical agent-state architecture', () => {
  it('has no legacy attention or event-normalization production modules', () => {
    expect(existsSync(join(root, 'src/server/attention.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/server/agentEvents.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/shared/controlPlane/model.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/shared/controlPlane/session.ts'))).toBe(false);
  });

  it('has no retired attention transport or compatibility bridge in server runtime', () => {
    const paths = [
      'src/server/channels/api.ts',
      'src/server/deskRuntime.ts',
      'src/server/routes/systemRoutes.ts',
      'src/server/runtime/nativeSessionControl.ts',
      'src/server/runtime/terminalDaemon.ts'
    ];
    const forbidden = [
      'attentionTracker',
      'startAttentionPolling',
      'stopAttentionPolling',
      'setRaiseListener',
      'drainNativeAttentionEvents',
      'NativeAttentionEvent',
      '/control/attention',
      'eventToLegacySignal',
      'normalizeAgentEventForApi'
    ];

    for (const path of paths) {
      const source = readFileSync(join(root, path), 'utf8');
      for (const symbol of forbidden) {
        expect(source, `${path} still contains ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it('has no retired agent-signal vocabulary in channels delivery history', () => {
    const engine = readFileSync(join(root, 'src/server/channels/delivery/engine.ts'), 'utf8');
    const events = readFileSync(join(root, 'src/server/channels/delivery/events.ts'), 'utf8');

    expect(engine).not.toContain('AgentSignalKind');
    expect(events).not.toContain("'approval-requested'");
    expect(events).not.toContain("'input-requested'");
  });

  it('contains no competing state vocabulary anywhere in production', () => {
    const forbidden = [
      'AgentPresenceModel',
      'eventToLegacySignal',
      'worker-rendered',
      'SOURCE_RANK',
      'SOURCE_TTL_MS',
      'SourceContribution',
      'resolveState',
      'channelsProbe',
      'attentionEventsSince',
      '/control/attention',
      'runtime.busy',
      'awaitingApproval'
    ];

    for (const path of sourceFiles(join(root, 'src'))) {
      const source = readFileSync(path, 'utf8');
      for (const symbol of forbidden) {
        expect(source, `${path} still contains ${symbol}`).not.toContain(symbol);
      }
    }
  });
});
