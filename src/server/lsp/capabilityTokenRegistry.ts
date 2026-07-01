import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';

export interface LspCapabilityTokenBinding {
  workspaceRoot: string;
}

export interface LspCapabilityTokenMintResult extends LspCapabilityTokenBinding {
  token: string;
}

export interface LspCapabilityTokenRegistry {
  mint(workspaceRoot: string): LspCapabilityTokenMintResult;
  resolve(token: string): LspCapabilityTokenBinding | undefined;
  revoke(token: string): void;
  dispose(): void;
}

export function createLspCapabilityTokenRegistry(): LspCapabilityTokenRegistry {
  const bindings = new Map<string, LspCapabilityTokenBinding>();

  return {
    mint(workspaceRoot) {
      const resolvedRoot = safeRealpath(workspaceRoot);
      if (!resolvedRoot || !statSync(resolvedRoot).isDirectory()) {
        throw new Error('workspaceRoot must be an existing directory');
      }

      let token = randomBytes(32).toString('base64url');
      while (bindings.has(token)) {
        token = randomBytes(32).toString('base64url');
      }
      const binding = { workspaceRoot: resolvedRoot };
      bindings.set(token, binding);
      return { token, ...binding };
    },

    resolve(token) {
      return bindings.get(token);
    },

    revoke(token) {
      bindings.delete(token);
    },

    dispose() {
      bindings.clear();
    }
  };
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
