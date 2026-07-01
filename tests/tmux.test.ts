import { describe, expect, it } from 'vitest';
import { createTmuxPlan } from '../src/core/tmux';
import type { SessionSpec } from '../src/core/types';

const baseSession: SessionSpec = {
  groupId: 'group-1',
  groupLabel: 'Group 1',
  name: 'alpha',
  cwd: '/workspace/projects/alpha',
  agent: 'codex',
  resume: '00000000-0000-7000-8000-000000000001',
  tmuxSession: 'agentdesk-group-1-alpha-00000000',
  command:
    "cd '/workspace/projects/alpha' && codex --dangerously-bypass-approvals-and-sandbox resume '00000000-0000-7000-8000-000000000001'"
};

describe('tmux planning', () => {
  it('starts only missing sessions and preserves already running agents', () => {
    const plan = createTmuxPlan([baseSession], new Set(['agentdesk-group-1-alpha-00000000']));

    expect(plan).toEqual([
      {
        type: 'preserve',
        session: baseSession,
        argv: []
      }
    ]);
  });

  it('builds a safe argv vector for missing session startup', () => {
    const plan = createTmuxPlan([baseSession], new Set());

    expect(plan).toEqual([
      {
        type: 'start',
        session: baseSession,
        argv: [
          'new-session',
          '-d',
          '-s',
          'agentdesk-group-1-alpha-00000000',
          '-c',
          '/workspace/projects/alpha',
          "cd '/workspace/projects/alpha' && codex --dangerously-bypass-approvals-and-sandbox resume '00000000-0000-7000-8000-000000000001'"
        ]
      }
    ]);
  });
});
