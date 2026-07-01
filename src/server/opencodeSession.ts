import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseOpencodeSessionList, type OpencodeSession } from '../core/opencodeResume.js';

export {
  isOpencodeSessionId,
  parseOpencodeSessionList,
  pickOpencodeCaptureResumeSession,
  pickOpencodeResumeSession,
  pickRecentOpencodeLaunchResumeSession,
  type OpencodeSession
} from '../core/opencodeResume.js';

const execFileAsync = promisify(execFile);

/** Runs `opencode session list --format json` in `cwd` and returns parsed sessions. */
export async function listOpencodeSessions(
  cwd: string,
  binPath: string,
  maxCount = 20
): Promise<OpencodeSession[]> {
  try {
    const { stdout } = await execFileAsync(binPath, ['session', 'list', '-n', String(maxCount), '--format', 'json'], {
      cwd,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseOpencodeSessionList(stdout);
  } catch {
    return [];
  }
}
