import { describe, expect, it } from 'vitest';
import { parseAgentPids } from '../src/server/killSwitch.js';


describe('parseAgentPids', () => {
  it('matches codex/claude binaries and excludes the server pid', () => {
    const ps = [
      '101 /workspace/.local/bin/codex resume abc',
      '102 node /workspace/.nvm/node_modules/@openai/codex/bin/codex.js',
      '103 claude --resume xyz',
      '104 /usr/bin/node /workspace/projects/desk/server.js',
      '105 vim codex_notes.md',
      '106 grep claude'
    ].join('\n');
    expect(parseAgentPids(ps, 999).sort((a, b) => a - b)).toEqual([101, 102, 103]);
  });

  it('excludes the provided self pid', () => {
    const ps = '201 /workspace/.local/bin/codex\n202 claude';
    expect(parseAgentPids(ps, 201)).toEqual([202]);
  });
});
