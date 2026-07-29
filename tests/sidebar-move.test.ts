import { describe, expect, it } from 'vitest';
import { getMovedSessionId, getProjectDropGroup, getSidebarDropSessionId } from '../src/web/sidebarMove';

describe('sidebar session move helpers', () => {
  it('drops sessions on the first group when a project is the drop target', () => {
    expect(
      getProjectDropGroup({
        groups: [
          { id: 'project-a:first', groupId: 'first', sessions: [] },
          { id: 'project-a:second', groupId: 'second', sessions: [] }
        ]
      })?.id
    ).toBe('project-a:first');
  });

  it('selects the moved session by its durable id after snapshot refresh', () => {
    expect(
      getMovedSessionId(
        {
          view: {
            projects: [
              {
                groups: [
                  {
                    id: 'project-b:target',
                    sessions: [{ spec: { name: 'bash', sessionId: 'session-bash' } }]
                  }
                ]
              }
            ]
          }
        },
        'project-b:target',
        'bash'
      )
    ).toBe('session-bash');
  });

  it('reads the dragged session id from native drag data', () => {
    expect(
      getSidebarDropSessionId({
        getData(type: string) {
          return type === 'application/x-desk-session' ? 'agentdesk-source' : '';
        }
      })
    ).toBe('agentdesk-source');

    expect(
      getSidebarDropSessionId({
        getData(type: string) {
          return type === 'text/plain' ? 'agentdesk-fallback' : '';
        }
      })
    ).toBe('agentdesk-fallback');
  });
});
