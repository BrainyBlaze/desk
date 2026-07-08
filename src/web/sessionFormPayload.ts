import type { DeskSessionUiMode } from '../core/types.js';
import { supportsBypassPermissions, supportsNativeUi } from './sessionAgentOptions.js';

export interface SessionFormPayloadInput {
  projectId: string;
  groupId: string;
  name: string;
  cwd: string;
  agent: string;
  resume: string;
  /** Resume value at form load; distinguishes a deliberate clear from a stale-empty field. */
  initialResume: string;
  bypassPermissions: boolean;
  command: string;
  uiMode: DeskSessionUiMode;
  /** Optional runtime model override; empty string = provider default. */
  model?: string;
}

export function buildSessionPayload(form: SessionFormPayloadInput): {
  name: string;
  cwd?: string;
  agent?: string;
  resume?: string;
  clearResume?: boolean;
  bypassPermissions?: boolean;
  command?: string;
  uiMode?: DeskSessionUiMode;
  model?: string;
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
  const resume = form.resume.trim();
  // Only an emptied field that previously SHOWED a value is a deliberate clear;
  // an empty field that loaded empty may simply predate async resume capture.
  const clearResume = resume === '' && form.initialResume.trim() !== '';
  return {
    name: form.name,
    cwd,
    agent: form.agent,
    resume: resume || undefined,
    ...(clearResume ? { clearResume: true } : {}),
    bypassPermissions: supportsBypassPermissions(form.agent) ? form.bypassPermissions : undefined,
    // Emit the concrete choice for native-capable agents: native is the
    // resolved default now, so an omitted terminal would flip to native.
    ...(supportsNativeUi(form.agent, false) ? { uiMode: form.uiMode } : {}),
    ...((form.model ?? '').trim() ? { model: (form.model ?? '').trim() } : {})
  };
}
