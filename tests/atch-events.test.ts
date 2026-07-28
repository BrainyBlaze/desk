import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  AtchEventDecoder,
  AtchEventTailer,
  atchEventPath,
  prepareAtchEventSink
} from '../src/server/runtime/atchEvents.js';

const records = [
  { ts: 1.25, type: 'ready' as const },
  { ts: 2.5, type: 'state' as const, state: 'busy' as const, title: '⠋ desk' },
  { ts: 3.75, type: 'state' as const, state: 'idle' as const, title: 'desk' },
  { ts: 4, type: 'link' as const, uri: 'https://example.test/run' },
  { ts: 5, type: 'exit' as const, code: 0 }
];

const ndjson = records.map((record) => JSON.stringify(record)).join('\n') + '\n';

describe('AtchEventDecoder', () => {
  it('decodes all supported records', () => {
    const decoder = new AtchEventDecoder();
    expect(decoder.push(Buffer.from(ndjson))).toEqual(records);
    expect(decoder.finish()).toEqual([]);
  });

  it('decodes arbitrary byte chunk boundaries, including UTF-8 splits', () => {
    const bytes = Buffer.from(ndjson);
    for (let split = 1; split < bytes.length; split++) {
      const decoder = new AtchEventDecoder();
      expect([
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
        ...decoder.finish()
      ]).toEqual(records);
    }
  });

  it('rejects malformed, unknown, and structurally invalid records', () => {
    const diagnostic = vi.fn();
    const decoder = new AtchEventDecoder({ onDiagnostic: diagnostic });
    const invalid = [
      'not json',
      '{"ts":1,"type":"mystery"}',
      '{"ts":"now","type":"ready"}',
      '{"ts":1,"type":"ready","extra":true}',
      '{"ts":1,"type":"state","state":"working","title":"desk"}',
      '{"ts":1,"type":"state","state":"busy"}',
      '{"ts":1,"type":"link","uri":3}',
      '{"ts":1,"type":"exit","code":1.5}'
    ].join('\n') + '\n';

    expect(decoder.push(Buffer.from(invalid))).toEqual([]);
    expect(diagnostic).toHaveBeenCalledTimes(8);
  });

  it('drops oversized lines and resumes at the next newline', () => {
    const diagnostic = vi.fn();
    const decoder = new AtchEventDecoder({ maxLineBytes: 64, onDiagnostic: diagnostic });
    const input =
      JSON.stringify({ ts: 1, type: 'state', state: 'busy', title: 'x'.repeat(128) }) +
      '\n' +
      JSON.stringify(records[0]) +
      '\n';

    expect(decoder.push(Buffer.from(input))).toEqual([records[0]]);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'line-too-long' })
    );
  });

  it('diagnoses and discards an unterminated EOF fragment', () => {
    const diagnostic = vi.fn();
    const decoder = new AtchEventDecoder({ onDiagnostic: diagnostic });
    decoder.push(Buffer.from('{"ts":1,"type":"ready"}'));

    expect(decoder.finish()).toEqual([]);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unterminated-line' })
    );
  });
});

describe('atch event sink', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-atch-events-'));
    chmodSync(root, 0o700);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses a deterministic direct-child path for each session generation', () => {
    const first = atchEventPath(root, 'workspace/session', 7);
    const again = atchEventPath(root, 'workspace/session', 7);
    const successor = atchEventPath(root, 'workspace/session', 8);

    expect(first).toBe(again);
    expect(first).not.toBe(successor);
    expect(dirname(first)).toBe(root);
    expect(basename(first)).toMatch(/^[a-f0-9]+\.7\.events\.ndjson$/);
  });

  it('precreates an empty current-user regular file with exact mode 0600', () => {
    const path = prepareAtchEventSink(root, 'session-1', 1);
    const stat = lstatSync(path);

    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    if (process.getuid) expect(stat.uid).toBe(process.getuid());
    expect(readFileSync(path)).toHaveLength(0);
  });

  it('fails closed when the socket root mode is not 0700', () => {
    chmodSync(root, 0o755);
    expect(() => prepareAtchEventSink(root, 'session-1', 1)).toThrow(/0700/);
  });

  it('does not replace an existing file or follow a symlink', () => {
    const path = atchEventPath(root, 'session-1', 1);
    const target = join(root, 'target');
    writeFileSync(target, 'keep', { mode: 0o600 });
    symlinkSync(target, path);

    expect(() => prepareAtchEventSink(root, 'session-1', 1)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});

describe('AtchEventTailer', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-atch-tailer-'));
    chmodSync(root, 0o700);
    path = prepareAtchEventSink(root, 'session-1', 1);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits appended complete records exactly once and retains a partial line', () => {
    const received: unknown[] = [];
    const tailer = new AtchEventTailer({ path, onEvent: (event) => received.push(event) });
    const first = JSON.stringify(records[0]) + '\n';
    const second = JSON.stringify(records[1]) + '\n';

    appendFileSync(path, first + second.slice(0, 12));
    tailer.pollNow();
    expect(received).toEqual([records[0]]);

    appendFileSync(path, second.slice(12));
    tailer.pollNow();
    tailer.pollNow();
    expect(received).toEqual([records[0], records[1]]);
    tailer.stop();
  });

  it('resets its offset and decoder when the sink is truncated', () => {
    const received: unknown[] = [];
    const tailer = new AtchEventTailer({ path, onEvent: (event) => received.push(event) });

    appendFileSync(path, JSON.stringify(records[1]) + '\n');
    tailer.pollNow();
    truncateSync(path, 0);
    appendFileSync(path, JSON.stringify(records[0]) + '\n');
    tailer.pollNow();

    expect(received).toEqual([records[1], records[0]]);
    tailer.stop();
  });

  it('distinguishes startup and truncation replay from live appends', () => {
    const received: { event: unknown; phase: string }[] = [];
    appendFileSync(path, JSON.stringify(records[0]) + '\n');
    const tailer = new AtchEventTailer({
      path,
      onEvent: (event, context) => received.push({ event, phase: context.phase })
    });

    tailer.pollNow();
    appendFileSync(path, JSON.stringify(records[1]) + '\n');
    tailer.pollNow();
    truncateSync(path, 0);
    appendFileSync(path, JSON.stringify(records[2]) + '\n');
    tailer.pollNow();

    expect(received).toEqual([
      { event: records[0], phase: 'replay' },
      { event: records[1], phase: 'live' },
      { event: records[2], phase: 'replay' }
    ]);
    tailer.stop();
  });

  it('reports open failures without throwing from the polling loop', () => {
    const diagnostic = vi.fn();
    rmSync(path);
    const tailer = new AtchEventTailer({ path, onEvent: vi.fn(), onDiagnostic: diagnostic });

    expect(() => tailer.pollNow()).not.toThrow();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'tailer-io' })
    );
    tailer.stop();
  });
});
