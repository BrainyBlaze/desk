import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../src/server');
const readServerFile = (name: string): string => readFileSync(join(SERVER_ROOT, name), 'utf8');

const ROUTE_OWNERS = {
  'routes/lspRoutes.ts': ['/api/lsp/detected-languages'],
  'routes/settingsRoutes.ts': ['/api/settings'],
  'routes/systemRoutes.ts': [
    '/api/desk',
    '/api/system',
    '/api/pulse',
    '/api/attention',
    '/api/attention-clear',
    '/api/attention-read',
    '/api/agent-event',
    '/api/kill-all'
  ],
  'routes/sessionsRoutes.ts': [
    '/api/up',
    '/api/add',
    '/api/add-group',
    '/api/add-project',
    '/api/add-project-group',
    '/api/add-project-session',
    '/api/edit-project',
    '/api/delete-project',
    '/api/edit-project-group',
    '/api/delete-project-group',
    '/api/edit-project-session',
    '/api/delete-project-session',
    '/api/restart-project-session',
    '/api/set-session-ui-mode',
    '/api/move-project-session',
    '/api/group-layout-sizes',
    '/api/reorder-projects',
    '/api/reorder-groups',
    '/api/reorder-sessions'
  ],
  'routes/terminalRoutes.ts': [
    '/api/terminal-broker-metrics',
    '/api/terminal-resize',
    '/api/terminal-repaint',
    '/api/terminal-scroll',
    '/api/terminal-capture'
  ]
} as const;

const CALLED_ROUTE_HANDLERS = [
  'handleFsRequest',
  'handleAgentSessionInjectRequest',
  'createLspRoutes',
  'createSettingsRoutes',
  'createSystemRoutes',
  'createSessionsRoutes',
  'createTerminalRoutes'
] as const;

const DIRECT_ROUTE_HANDLERS = ['handleGitRequest', 'handleProjectsRequest', 'handleChannelsRequest'] as const;

describe('server composition-root architecture', () => {
  it('keeps installDeskApi as assembly only', () => {
    const root = readServerFile('vitePlugin.ts');

    expect(root).toContain('createDeskServices');
    expect(root).toContain('createDisposerRegistry');
    expect(root).toContain('createDeskApiMiddleware');
    expect(root).not.toContain('url.pathname ===');
    expect(root).not.toContain('new LspManager');
    expect(root).not.toContain('createDefaultTerminalBroker');
    expect(root).not.toMatch(/\.once\(['"]close['"]/);
    for (const handler of CALLED_ROUTE_HANDLERS) {
      expect(root, `${handler} should be wired into the composition root`).toContain(`${handler}(`);
    }
    for (const handler of DIRECT_ROUTE_HANDLERS) {
      expect(root, `${handler} should be wired into the composition root`).toMatch(
        new RegExp(`\\n\\s+${handler},`)
      );
    }
  });

  it('assigns every formerly inline endpoint to one domain router', () => {
    const allSources = Object.entries(ROUTE_OWNERS).map(([file, routes]) => ({ file, routes, source: readServerFile(file) }));

    for (const { file, routes, source } of allSources) {
      for (const route of routes) {
        expect(source, `${route} should be owned by ${file}`).toContain(route);
        const owners = allSources.filter((candidate) => candidate.source.includes(route));
        expect(owners.map((owner) => owner.file), `${route} should have one route owner`).toEqual([file]);
      }
    }
  });
});
