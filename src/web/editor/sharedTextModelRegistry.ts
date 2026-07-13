export interface SharedTextModelLease<Model> {
  model: Model;
  diskMatches: boolean;
  release: () => void;
}

export interface SharedTextModelRegistry<Model> {
  acquire(path: string, diskContent: string): SharedTextModelLease<Model>;
}

export interface SharedTextModelBackend<Model> {
  keyForPath: (path: string) => string;
  findModel: (path: string) => Model | null;
  createModel: (path: string, content: string) => Model;
  readModel: (model: Model) => string;
  disposeModel: (model: Model) => void;
}

interface RegistryEntry<Model> {
  model: Model;
  references: number;
}

export function createSharedTextModelRegistry<Model>(
  backend: SharedTextModelBackend<Model>
): SharedTextModelRegistry<Model> {
  const entries = new Map<string, RegistryEntry<Model>>();

  return {
    acquire(path, diskContent) {
      const key = backend.keyForPath(path);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          model: backend.findModel(path) ?? backend.createModel(path, diskContent),
          references: 0
        };
        entries.set(key, entry);
      }
      entry.references += 1;

      let released = false;
      return {
        model: entry.model,
        diskMatches: backend.readModel(entry.model) === diskContent,
        release() {
          if (released) {
            return;
          }
          released = true;
          entry.references -= 1;
          if (entry.references === 0 && entries.get(key) === entry) {
            entries.delete(key);
            backend.disposeModel(entry.model);
          }
        }
      };
    }
  };
}
