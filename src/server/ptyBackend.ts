// Terminal PTY backend — DEV / default (Node + Vite): node-pty.
//
// The Bun standalone build swaps this module for ./ptyBackend.standalone.ts (a
// Bun.Terminal adapter) at compile time. The reason: node-pty's pty handling is
// broken under bun (oven-sh/bun#25822 — the pty master EOFs immediately, so
// onData/onExit misfire and an interactive child like `tmux attach` looks like
// it exits at once, even though the tmux session is alive). Under Node the same
// node-pty works, so the dev/Vite path keeps using it.
//
// terminalBroker.ts / terminalBridge.ts import { spawn, IPty } from here instead
// of straight from 'node-pty' — that single seam is what the build swaps.
export { spawn } from 'node-pty';
export type { IPty } from 'node-pty';
