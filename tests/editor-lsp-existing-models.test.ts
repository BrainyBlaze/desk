import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/web/editor/monacoSetup.js', () => ({
  initMonaco: vi.fn(),
  languageForPath: vi.fn(() => 'typescript'),
  monaco: {
    editor: {},
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}` })
    }
  }
}));

import { openExistingTextModelsForLspBinding } from '../src/web/editor/EditorSubsystem';

function makeModel(uri: string, languageId: string, text: string) {
  return {
    uri: { toString: () => uri },
    getLanguageId: () => languageId,
    getValue: () => text
  };
}

describe('openExistingTextModelsForLspBinding', () => {
  it('opens already-restored text models with live contents when an LSP binding is created late', () => {
    const binding = { openModel: vi.fn() };
    const first = makeModel('file:///workspace/a.ts', 'typescript', 'const a = 1;');
    const second = makeModel('file:///workspace/b.ts', 'typescript', 'const b = 2;');

    openExistingTextModelsForLspBinding(
      [
        { model: first },
        { model: null },
        { model: second }
      ],
      binding
    );

    expect(binding.openModel).toHaveBeenCalledTimes(2);
    expect(binding.openModel).toHaveBeenNthCalledWith(
      1,
      { uri: 'file:///workspace/a.ts', languageId: 'typescript' },
      'const a = 1;'
    );
    expect(binding.openModel).toHaveBeenNthCalledWith(
      2,
      { uri: 'file:///workspace/b.ts', languageId: 'typescript' },
      'const b = 2;'
    );
  });
});
