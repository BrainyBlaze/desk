import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MfupError, MfupErrorCode, MfupSession, type MfupAsk, type MfupSessionSnapshot, type UploadSource } from '@mfup/client';
import { useMfupSession } from '@mfup/react';

const SERVER_URL = '/api/uploads';

function isSettled(state: string, published: readonly unknown[] | null): boolean {
  return state === 'aborted' || state === 'failed' || (state === 'committed' && published !== null);
}

let streamingKnown: boolean | null = null;

async function streamingUploadsAvailable(): Promise<boolean> {
  if (streamingKnown !== null) {
    return streamingKnown;
  }
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    if (res.ok) {
      streamingKnown = true;
      return true;
    }
    if (res.status === 404) {
      streamingKnown = false;
    }
    return false;
  } catch {
    return false;
  }
}

async function publishResolvingConflicts(s: MfupSession): Promise<void> {
  try {
    await s.publish();
  } catch (err) {
    if (!(err instanceof MfupError) || err.code !== MfupErrorCode.PUBLISH_CONFLICT) {
      throw err;
    }
    const conflicting = (err.detail as { conflictingFiles?: string[] } | undefined)?.conflictingFiles ?? [];
    const label = conflicting.length > 0 ? `${conflicting.length} file${conflicting.length === 1 ? '' : 's'}` : 'Some files';
    if (window.confirm(`${label} already exist in the target folder. Overwrite?`)) {
      s.sendAction('merge_overwrite');
      try {
        await s.publish();
      } catch (retryErr) {
        s.abort();
        throw retryErr;
      }
    } else {
      s.abort();
    }
  }
}

export interface DeskUploads {
  snapshot: MfupSessionSnapshot | null;
  pendingAsks: readonly MfupAsk[];
  targetDir: string | null;
  busy: boolean;
  /** false → streaming unavailable, caller should use the legacy upload path */
  start(source: UploadSource | FileList | File[], root: string, dirPath: string): Promise<boolean>;
  abort(): void;
  dismiss(): void;
}

export function useDeskUploads(onError: (message: string) => void): DeskUploads {
  const [session, setSession] = useState<MfupSession | null>(null);
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const snapshot = useMfupSession(session);
  const sessionRef = useRef<MfupSession | null>(null);
  const inFlightRef = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const start = useCallback(async (source: UploadSource | FileList | File[], root: string, dirPath: string): Promise<boolean> => {
    if (!(await streamingUploadsAvailable())) {
      return false;
    }
    if (inFlightRef.current) {
      onErrorRef.current('an upload is already running — cancel it or wait');
      return true;
    }
    inFlightRef.current = true;
    try {
      const s = new MfupSession({ serverUrl: SERVER_URL, targetDir: '.', meta: { root, dirPath } });
      try {
        await s.connect();
      } catch {
        streamingKnown = null;
        return false;
      }
      sessionRef.current = s;
      setSession(s);
      setTargetDir(dirPath);
      try {
        await s.upload(source);
        const verdict = await s.settleAsks();
        if (verdict !== 'cancel' && s.state === 'committed') {
          await publishResolvingConflicts(s);
        }
      } catch (err) {
        onErrorRef.current(err instanceof Error ? err.message : String(err));
      }
      return true;
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => () => {
    if (inFlightRef.current) {
      sessionRef.current?.abort();
    }
  }, []);

  const abort = useCallback(() => {
    sessionRef.current?.abort();
  }, []);

  const dismiss = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    sessionRef.current = null;
    setSession(null);
    setTargetDir(null);
  }, []);

  const pendingAsks = useMemo(
    () => (snapshot ? snapshot.asks.filter((ask) => ask.answered === null) : []),
    [snapshot]
  );
  const busy = snapshot !== null && !isSettled(snapshot.state, snapshot.published);

  return { snapshot, pendingAsks, targetDir, busy, start, abort, dismiss };
}
