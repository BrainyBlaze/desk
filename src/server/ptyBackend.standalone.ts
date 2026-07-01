// Terminal PTY backend — Bun STANDALONE build ONLY.
//
// scripts/build-standalone.ts swaps ./ptyBackend.js to this file at compile time.
// It implements node-pty's `spawn` -> IPty surface (the subset terminalBroker.ts
// and terminalBridge.ts use: onData / onExit / write / resize / kill / pid) on
// top of Bun's native PTY (Bun.Terminal + Bun.spawn{ terminal }).
//
// Why not node-pty here: under bun, node-pty's pty master reports EOF immediately
// so onExit fires at once and interactive children (`tmux attach`) appear to die
// (oven-sh/bun#25822). Bun.Terminal drives the same ptys correctly. The one real
// semantic difference handled below: Bun.Terminal's `exit` callback is the PTY
// *stream* lifecycle (EOF), NOT the child's exit — the actual exit is awaited
// from proc.exited, which is what onExit must reflect.
//
// Excluded from tsconfig (uses Bun globals + bun-only Bun.Terminal); never loaded
// under Node. node-pty stays the dev/Vite backend.

interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

// The IPty subset the broker / bridge consume. Typed locally so this file pulls
// in no node-pty types (node-pty must not enter the standalone graph).
interface PtyHandle {
  readonly pid: number;
  onData(handler: (chunk: string) => void): { dispose(): void };
  onExit(handler: (event: PtyExitEvent) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export function spawn(file: string, args: string[], options: PtySpawnOptions = {}): PtyHandle {
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const dataHandlers = new Set<(chunk: string) => void>();
  const exitHandlers = new Set<(event: PtyExitEvent) => void>();
  const decoder = new TextDecoder();

  const terminal = new Bun.Terminal({
    name: options.name ?? 'xterm-256color',
    cols,
    rows,
    data: (_terminal: unknown, bytes: Uint8Array) => {
      // Stream-decode so a UTF-8 sequence split across reads isn't corrupted.
      const chunk = decoder.decode(bytes, { stream: true });
      if (chunk.length > 0) {
        for (const handler of dataHandlers) handler(chunk);
      }
    },
    // PTY stream EOF — NOT the child's exit. Ignored; real exit comes from
    // proc.exited below (this is exactly node-pty-under-bun's confusion).
    exit: () => {}
  });

  const proc = Bun.spawn([file, ...args], {
    terminal,
    cwd: options.cwd,
    env: options.env
  });

  let exited = false;
  const fireExit = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    const event: PtyExitEvent = { exitCode };
    for (const handler of exitHandlers) handler(event);
  };
  void proc.exited.then(
    (code: number | null) => fireExit(typeof code === 'number' ? code : 0),
    () => fireExit(1)
  );

  return {
    pid: proc.pid,
    onData(handler: (chunk: string) => void): { dispose(): void } {
      dataHandlers.add(handler);
      return { dispose: () => dataHandlers.delete(handler) };
    },
    onExit(handler: (event: PtyExitEvent) => void): { dispose(): void } {
      exitHandlers.add(handler);
      return { dispose: () => exitHandlers.delete(handler) };
    },
    write(data: string): void {
      try {
        terminal.write(data);
      } catch {
        // terminal closed underneath us — drop the write.
      }
    },
    resize(nextCols: number, nextRows: number): void {
      try {
        terminal.resize(nextCols, nextRows);
      } catch {
        // closed — ignore.
      }
    },
    kill(): void {
      try {
        proc.kill();
      } catch {
        // already gone.
      }
      try {
        terminal.close();
      } catch {
        // already closed.
      }
    }
  };
}
