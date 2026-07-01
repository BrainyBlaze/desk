import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLspLanguageDetector } from '../src/server/lsp/languageDetection';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-detect-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createLspLanguageDetector', () => {
  it('detects configured language ids under the authorized editor root without leaking backend fields', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(join(workspace, 'node_modules'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'sample.ts'), 'const value = 1;\n');
    writeFileSync(join(workspace, 'src', 'tool.py'), 'print("ok")\n');
    writeFileSync(join(workspace, 'node_modules', 'ignored.rs'), 'fn main() {}\n');

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            languages: [],
            serverCommands: {
              typescript: {
                enabled: true,
                command: '/secret/typescript-language-server',
                args: ['--stdio'],
                env: { TOKEN: 'secret' },
                languageIds: ['typescript', 'javascript'],
                extensions: ['.ts']
              },
              python: {
                enabled: true,
                command: 'pyright-langserver',
                languageIds: ['python'],
                extensions: ['.py']
              },
              rust: {
                enabled: true,
                command: 'rust-analyzer',
                languageIds: ['rust'],
                extensions: ['.rs']
              },
              disabled: {
                enabled: false,
                command: 'disabled-language-server',
                languageIds: ['disabled'],
                extensions: ['.disabled']
              }
            }
          }
        }
      })
    });

    const result = await detector.detect({ root: workspace });

    expect(result).toEqual({ languages: ['typescript', 'javascript', 'python'], truncated: false });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('/secret/typescript-language-server');
    expect(serialized).not.toContain('TOKEN');
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain('sample.ts');
  });

  it('detects TypeScript, Python, and Rust through built-in presets when no custom serverCommands exist', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'sample.ts'), 'const value = 1;\n');
    writeFileSync(join(workspace, 'src', 'tool.py'), 'print("ok")\n');
    writeFileSync(join(workspace, 'src', 'main.rs'), 'fn main() {}\n');

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: { enabled: true }
        }
      })
    });

    const result = await detector.detect({ root: workspace, refresh: true });

    expect(result).toEqual({
      languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'python', 'rust'],
      truncated: false
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('typescript-language-server');
    expect(serialized).not.toContain('pyright');
    expect(serialized).not.toContain('rust-analyzer');
    expect(serialized).not.toContain('github.com');
    expect(serialized).not.toContain(workspace);
  });

  it('rejects missing, out-of-root, and symlink-escaped roots with a static error', async () => {
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(workspace, 'linked-outside');
    symlinkSync(outside, link);

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: { enabled: true, serverCommands: {} }
        }
      })
    });

    await expect(detector.detect({ root: outside })).rejects.toThrow('invalid root');
    await expect(detector.detect({ root: link })).rejects.toThrow('invalid root');
    await expect(detector.detect({ root: 'relative' })).rejects.toThrow('invalid root');
  });

  it('reports truncation when scan caps stop before all files are inspected', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(workspace, 'b.py'), 'print("b")\n');

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] },
              python: { enabled: true, command: 'pyright-langserver', languageIds: ['python'], extensions: ['.py'] }
            }
          }
        }
      }),
      maxFiles: 1
    });

    const result = await detector.detect({ root: workspace });

    expect(result.truncated).toBe(true);
    expect(result.languages.every((language) => ['typescript', 'python'].includes(language))).toBe(true);
  });

  it('target-probes missing configured extensions when the broad ripgrep scan is truncated', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] },
              rust: { enabled: true, command: 'rust-analyzer', languageIds: ['rust'], extensions: ['.rs'] }
            }
          }
        }
      }),
      maxFiles: 1,
      runRipgrep: (_root, args) => {
        if (args.some((arg) => arg.includes('*.rs'))) {
          return { status: 0, signal: null, stdout: 'sample/crates/sample-gpu/src/lib.rs\n' };
        }
        return { status: 0, signal: null, stdout: 'desk/src/server.ts\ndesk/src/other.ts\n' };
      }
    });

    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript', 'rust'], truncated: true });
  });

  it('skips the full ignored directory set without reporting languages from ignored files', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'sample.ts'), 'const sample = true;\n');
    for (const dir of ['.git', 'node_modules', 'dist', 'build', 'target', '.venv', '__pycache__', 'vendor', 'coverage', '.next', '.cache']) {
      mkdirSync(join(workspace, dir), { recursive: true });
      writeFileSync(join(workspace, dir, 'ignored.py'), 'print("ignored")\n');
    }

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] },
              python: { enabled: true, command: 'pyright-langserver', languageIds: ['python'], extensions: ['.py'] }
            }
          }
        }
      })
    });

    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: false });

    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const fallbackDetector = createLspLanguageDetector({
        readManifest: () => ({
          settings: {
            editor: { root: workspace },
            lsp: {
              enabled: true,
              serverCommands: {
                typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] },
                python: { enabled: true, command: 'pyright-langserver', languageIds: ['python'], extensions: ['.py'] }
              }
            }
          }
        })
      });
      expect(await fallbackDetector.detect({ root: workspace, refresh: true })).toEqual({
        languages: ['typescript'],
        truncated: false
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('keeps detecting configured languages when an unrelated directory cannot be read', async () => {
    const workspace = join(root, 'workspace');
    const blocked = join(workspace, '.local', 'blocked-cache');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(workspace, 'src', 'sample.ts'), 'const sample = true;\n');
    writeFileSync(join(blocked, 'hidden.py'), 'print("hidden")\n');
    chmodSync(blocked, 0o000);

    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const detector = createLspLanguageDetector({
        readManifest: () => ({
          settings: {
            editor: { root: workspace },
            lsp: { enabled: true }
          }
        })
      });

      expect(await detector.detect({ root: workspace, refresh: true })).toEqual({
        languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
        truncated: true
      });
    } finally {
      process.env.PATH = originalPath;
      chmodSync(blocked, 0o700);
    }
  });

  it('uses the accepted default scan cap above two thousand files', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    for (let index = 0; index < 2_001; index += 1) {
      writeFileSync(join(workspace, `sample-${index}.ts`), 'const sample = true;\n');
    }

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] }
            }
          }
        }
      })
    });

    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: false });
  });

  it('honors the default max depth on the ripgrep path', async () => {
    const workspace = join(root, 'workspace');
    let deep = workspace;
    for (let depth = 0; depth < 17; depth += 1) {
      deep = join(deep, `d${depth}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'deep.ts'), 'const deep = true;\n');

    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] }
            }
          }
        }
      }),
      runRipgrep: (_root, args) => {
        expect(args).toContain('--max-depth');
        expect(args).toContain('16');
        return { status: 0, signal: null, stdout: '' };
      }
    });

    expect(await detector.detect({ root: workspace })).toEqual({ languages: [], truncated: false });
  });

  it('falls back to the filesystem walk when ripgrep is killed/times out (status null + signal)', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'a.ts'), 'const a = 1;\n');
    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] }
            }
          }
        }
      }),
      // Simulate a slow-CI ripgrep that exceeds the timeout: spawnSync kills it -> status null + SIGTERM, no error.
      runRipgrep: () => ({ status: null, signal: 'SIGTERM', stdout: '' })
    });
    // A killed/timed-out rg is not authoritative: fall back to the walk (which finds a.ts), NOT truncated.
    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: false });
  });

  it('uses ripgrep output on a clean run (status 0/1)', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] }
            }
          }
        }
      }),
      runRipgrep: () => ({ status: 0, signal: null, stdout: 'a.ts\n' })
    });
    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: false });
  });

  it('still reports truncated on a genuine ripgrep error status (>=2, no signal) with partial output', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] }
            }
          }
        }
      }),
      runRipgrep: () => ({ status: 2, signal: null, stdout: 'a.ts\n' })
    });
    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: true });
  });

  it('caches safe detection results until refresh bypasses the TTL', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'a.ts'), 'const a = 1;\n');

    let now = 1_000;
    const detector = createLspLanguageDetector({
      readManifest: () => ({
        settings: {
          editor: { root: workspace },
          lsp: {
            enabled: true,
            serverCommands: {
              typescript: { enabled: true, command: 'typescript-language-server', languageIds: ['typescript'], extensions: ['.ts'] },
              python: { enabled: true, command: 'pyright-langserver', languageIds: ['python'], extensions: ['.py'] }
            }
          }
        }
      }),
      now: () => now
    });

    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: false });

    writeFileSync(join(workspace, 'b.py'), 'print("b")\n');
    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript'], truncated: false });
    expect(await detector.detect({ root: workspace, refresh: true })).toEqual({
      languages: ['typescript', 'python'],
      truncated: false
    });

    now += 6_000;
    expect(await detector.detect({ root: workspace })).toEqual({ languages: ['typescript', 'python'], truncated: false });
  });
});
