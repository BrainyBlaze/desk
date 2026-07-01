import { useState } from 'react';

export function ImageView({ src, name }: { src: string; name: string }): JSX.Element {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="viewerStage">
        <div className="viewerStatus">could not load {name}</div>
      </div>
    );
  }
  return (
    <div className={`viewerStage imageStage ${zoomed ? 'zoomed' : ''}`}>
      <img
        src={src}
        alt={name}
        title={zoomed ? 'click to fit' : 'click for 1:1'}
        onClick={() => setZoomed((value) => !value)}
        onError={() => setFailed(true)}
        onLoad={(event) => {
          const img = event.currentTarget;
          setDims({ w: img.naturalWidth, h: img.naturalHeight });
        }}
      />
      <div className="viewerStatus">
        {name}
        {dims ? ` — ${dims.w}×${dims.h}` : ''}
        {zoomed ? ' — 1:1' : ''}
      </div>
    </div>
  );
}
