export interface SaveQueue {
  run(path: string, overwrite: boolean, task: (overwrite: boolean) => Promise<void>): Promise<void>;
}

interface SaveQueueEntry {
  completion: Promise<void>;
  pendingOverwrite: boolean | null;
  pendingTask: ((overwrite: boolean) => Promise<void>) | null;
}

export function createSaveQueue(): SaveQueue {
  const entries = new Map<string, SaveQueueEntry>();

  return {
    run(path, overwrite, task) {
      const existing = entries.get(path);
      if (existing) {
        existing.pendingOverwrite = (existing.pendingOverwrite ?? false) || overwrite;
        existing.pendingTask = task;
        return existing.completion;
      }

      let resolveCompletion = (): void => undefined;
      let rejectCompletion = (_error: unknown): void => undefined;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const entry: SaveQueueEntry = {
        completion,
        pendingOverwrite: null,
        pendingTask: null
      };
      entries.set(path, entry);

      void (async () => {
        let nextOverwrite = overwrite;
        let nextTask = task;
        try {
          while (true) {
            await nextTask(nextOverwrite);
            if (entry.pendingOverwrite === null) {
              return;
            }
            nextOverwrite = entry.pendingOverwrite;
            nextTask = entry.pendingTask ?? nextTask;
            entry.pendingOverwrite = null;
            entry.pendingTask = null;
          }
        } finally {
          if (entries.get(path) === entry) {
            entries.delete(path);
          }
        }
      })().then(resolveCompletion, rejectCompletion);

      return completion;
    }
  };
}
