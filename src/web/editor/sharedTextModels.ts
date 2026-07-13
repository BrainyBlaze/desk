import { languageForPath, monaco } from './monacoSetup.js';
import { createSharedTextModelRegistry, type SharedTextModelLease } from './sharedTextModelRegistry.js';

const sharedTextModels = createSharedTextModelRegistry<monaco.editor.ITextModel>({
  keyForPath: (path) => monaco.Uri.file(path).toString(),
  findModel: (path) => monaco.editor.getModel(monaco.Uri.file(path)),
  createModel: (path, content) => monaco.editor.createModel(content, languageForPath(path), monaco.Uri.file(path)),
  readModel: (model) => model.getValue(),
  disposeModel: (model) => model.dispose()
});

export function acquireSharedTextModel(
  path: string,
  diskContent: string
): SharedTextModelLease<monaco.editor.ITextModel> {
  return sharedTextModels.acquire(path, diskContent);
}
