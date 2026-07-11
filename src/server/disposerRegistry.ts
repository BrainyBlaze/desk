export type Disposer = () => void;

interface CloseEmitter {
  once(event: 'close', listener: () => void): unknown;
}

export interface DisposerRegistry {
  add(disposer: Disposer): void;
  bind(server: CloseEmitter): void;
  dispose(): void;
}

export function createDisposerRegistry(): DisposerRegistry {
  const disposers: Disposer[] = [];
  const boundServers = new WeakSet<object>();
  let disposed = false;

  return {
    add(disposer) {
      if (disposed) {
        disposer();
        return;
      }
      disposers.push(disposer);
    },
    bind(server) {
      const identity = server as object;
      if (boundServers.has(identity)) {
        return;
      }
      boundServers.add(identity);
      server.once('close', () => this.dispose());
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const disposer of disposers.splice(0)) {
        try {
          disposer();
        } catch (error) {
          console.error('[desk-api] disposer failed:', error);
        }
      }
    }
  };
}
