import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSessionScreenCheckpointStore } from '../src/server/runtime/fileSessionScreenCheckpointStore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-screen-checkpoints-'));
  roots.push(root);
  return join(root, 'screens');
}

describe('durable current-screen checkpoints', () => {
  it('coalesces to the newest bounded screen and restores only its generation', () => {
    const path = directory();
    const first = new FileSessionScreenCheckpointStore(path);
    first.record({
      sessionId: 'main-3',
      generation: 31,
      outputOffset: 10n,
      geometry: { rows: 40, cols: 120 },
      snapshot: 'old'
    });
    first.record({
      sessionId: 'main-3',
      generation: 31,
      outputOffset: 20n,
      geometry: { rows: 40, cols: 120 },
      snapshot: 'current'
    });
    first.close();

    const second = new FileSessionScreenCheckpointStore(path);
    expect(second.get('main-3', 31)).toMatchObject({
      generation: 31,
      outputOffset: 20n,
      geometry: { rows: 40, cols: 120 },
      snapshot: 'current'
    });
    expect(second.get('main-3', 30)).toBeUndefined();
    expect(readdirSync(path)).toHaveLength(1);
    second.close();
  });

  it('ignores a corrupt checkpoint instead of breaking daemon startup', () => {
    const path = directory();
    const first = new FileSessionScreenCheckpointStore(path);
    first.record({
      sessionId: 'qa-bash',
      generation: 8,
      outputOffset: 7n,
      geometry: { rows: 24, cols: 80 },
      snapshot: 'prompt'
    });
    first.close();
    const file = join(path, readdirSync(path)[0]!);
    expect(readFileSync(file, 'utf8')).toContain('qa-bash');
    writeFileSync(file, '{"v":1,"s":"qa-bash","g":8,"o":"not-u64"}', 'utf8');

    const second = new FileSessionScreenCheckpointStore(path);
    expect(second.get('qa-bash', 8)).toBeUndefined();
    second.close();
  });

  it('rejects terminal-state-only snapshots at a nonzero output frontier', () => {
    const path = directory();
    const first = new FileSessionScreenCheckpointStore(path);
    first.record({
      sessionId: 'blank',
      generation: 3,
      outputOffset: 123n,
      geometry: { rows: 24, cols: 80 },
      snapshot: '\x1b[23B\x1b[1C\x1b[?2004h\x1b[?1004h\x1b]0;not-screen-text\x07'
    });

    expect(first.get('blank', 3)).toBeUndefined();
    first.close();
    expect(readdirSync(path)).toEqual([]);
  });

  it('removes the checkpoint when the session really ends', () => {
    const path = directory();
    const store = new FileSessionScreenCheckpointStore(path);
    store.record({
      sessionId: 'ended',
      generation: 4,
      outputOffset: 3n,
      geometry: { rows: 24, cols: 80 },
      snapshot: 'bye'
    });
    store.close();

    const reopened = new FileSessionScreenCheckpointStore(path);
    reopened.forget('ended');
    reopened.close();

    expect(readdirSync(path)).toEqual([]);
  });
});
