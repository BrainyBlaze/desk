import { useEffect } from 'react';
import { X, CircleCheck, CircleX, UploadCloud, Zap } from 'lucide-react';
import type { MfupAsk, MfupSessionSnapshot } from '@mfup/client';
import { CLIP_OCTAGON_TINY, Cmd, Pill } from '../arwes/primitives.js';
import { formatBytes } from '../systemFormat.js';
import { fileNameOf } from './editorState.js';
import { useDeskUploads, type DeskUploads } from './useDeskUploads.js';

export function UploadsHost({
  onError,
  register,
  onStagingChange
}: {
  onError: (message: string) => void;
  register: (start: DeskUploads['start'] | null) => void;
  onStagingChange: (name: string | null) => void;
}): JSX.Element | null {
  const uploads = useDeskUploads(onError);
  useEffect(() => {
    register(uploads.start);
    return () => register(null);
  }, [register, uploads.start]);
  const stagingName = uploads.busy && uploads.snapshot ? `.incoming.${uploads.snapshot.sessionId}` : null;
  useEffect(() => {
    onStagingChange(stagingName);
  }, [onStagingChange, stagingName]);
  const { snapshot, dismiss } = uploads;
  const settled = snapshot !== null && (snapshot.state === 'aborted' || (snapshot.state === 'committed' && snapshot.published !== null));
  useEffect(() => {
    if (!settled) {
      return;
    }
    const timer = window.setTimeout(dismiss, 10_000);
    return () => window.clearTimeout(timer);
  }, [settled, dismiss]);
  if (!uploads.snapshot) {
    return null;
  }
  return (
    <UploadCard
      snapshot={uploads.snapshot}
      pendingAsks={uploads.pendingAsks}
      targetDir={uploads.targetDir}
      onAbort={uploads.abort}
      onDismiss={uploads.dismiss}
    />
  );
}

function cardTitle(snapshot: MfupSessionSnapshot, targetDir: string | null, hasAsks: boolean): string {
  const dir = targetDir ? fileNameOf(targetDir) : '';
  if (snapshot.state === 'aborted') {
    return 'Upload cancelled';
  }
  if (snapshot.state === 'failed') {
    return 'Upload failed';
  }
  if (snapshot.state === 'committed') {
    if (snapshot.published !== null) {
      return 'Uploaded';
    }
    return hasAsks ? 'Waiting for conflict decision' : 'Publishing…';
  }
  return `Uploading → ${dir}`;
}

export function UploadCard({
  snapshot,
  pendingAsks,
  targetDir,
  onAbort,
  onDismiss
}: {
  snapshot: MfupSessionSnapshot;
  pendingAsks: readonly MfupAsk[];
  targetDir: string | null;
  onAbort: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const { state, fraction, progress, currentFile, reconnect, published, fatalError } = snapshot;
  const terminal = state === 'aborted' || state === 'failed' || (state === 'committed' && published !== null);
  const done = state === 'committed' && published !== null;

  return (
    <div className="uploadCard" style={{ clipPath: CLIP_OCTAGON_TINY }}>
      <div className="uploadCardHead">
        <UploadCloud size={13} />
        <span className="uploadCardTitle">{cardTitle(snapshot, targetDir, pendingAsks.length > 0)}</span>
        {reconnect ? <Pill tone="warn">reconnect #{reconnect.attempt}</Pill> : null}
        {snapshot.streaming ? <Pill tone="ok" title="streaming data leg"><Zap size={9} /> stream</Pill> : null}
        {terminal ? (
          <button type="button" className="uploadCardClose" aria-label="Dismiss" onClick={onDismiss}>
            <X size={11} />
          </button>
        ) : null}
      </div>
      <div className="uploadCardBar">
        <div className="uploadCardBarFill" style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} />
      </div>
      <div className="uploadCardStats">
        <span>{progress.acceptedFiles} files</span>
        <span>
          {formatBytes(Number(progress.bodyDoneBytes))}
          {progress.bodyEstBytes > 0n ? ` / ${formatBytes(Number(progress.bodyEstBytes))}` : ''}
        </span>
        {!terminal && currentFile ? <span className="uploadCardCurrent" title={currentFile.path}>{currentFile.path}</span> : null}
        {done ? <span className="uploadCardOk"><CircleCheck size={11} /> {published.length} published</span> : null}
        {state === 'failed' && fatalError ? <span className="uploadCardErr"><CircleX size={11} /> {fatalError.message}</span> : null}
      </div>
      {pendingAsks.map((ask) => (
        <div key={ask.id} className="uploadCardAsk">
          <span className="uploadCardAskName" title={ask.name ?? undefined}>{ask.name ?? 'file'} already exists</span>
          <Cmd icon={<CircleCheck size={12} />} label="Overwrite" onClick={() => ask.respond('merge_overwrite')} />
          <Cmd icon={<CircleX size={12} />} label="Cancel" tone="danger" onClick={() => ask.respond('cancel')} />
        </div>
      ))}
      {!terminal ? (
        <div className="uploadCardActions">
          <Cmd icon={<X size={12} />} label="Cancel upload" tone="danger" onClick={onAbort} />
        </div>
      ) : null}
    </div>
  );
}
