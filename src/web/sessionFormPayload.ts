import { supportsBypassPermissions } from './sessionAgentOptions.js';

export interface SessionFormPayloadInput {
  projectId: string;
  groupId: string;
  name: string;
  cwd: string;
  agent: string;
  resume: string;
  bypassPermissions: boolean;
  command: string;
}

export function buildSessionPayload(form: SessionFormPayloadInput): {
  name: string;
  cwd?: string;
  agent?: string;
  resume?: string;
  bypassPermissions?: boolean;
  command?: string;
} {
  const cwd = form.cwd.trim() || undefined;
  const command = form.command.trim();
  if (command) {
    return {
      name: form.name,
      cwd,
      command
    };
  }
  return {
    name: form.name,
    cwd,
    agent: form.agent,
    resume: form.resume.trim() || undefined,
    bypassPermissions: supportsBypassPermissions(form.agent) ? form.bypassPermissions : undefined
  };
}
