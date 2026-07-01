import { describe, expect, it } from 'vitest';
import { planProviderRegistrations } from '../src/web/editor/lsp/providerRegistry';

describe('planProviderRegistrations', () => {
  it('gates registrations on advertised capabilities and lifts completion trigger characters', () => {
    const plan = planProviderRegistrations({
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['.', '"'] },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true }
    });
    expect(plan).toContainEqual({ kind: 'completion', triggerCharacters: ['.', '"'] });
    expect(plan).toContainEqual({ kind: 'hover' });
    expect(plan).toContainEqual({ kind: 'definition' });
    expect(plan).toContainEqual({ kind: 'references' });
    expect(plan).toContainEqual({ kind: 'rename' });
  });

  it('omits providers for absent or false capabilities', () => {
    const plan = planProviderRegistrations({ hoverProvider: true, documentSymbolProvider: false });
    const kinds = plan.map((registration) => registration.kind);
    expect(kinds).toContain('hover');
    expect(kinds).not.toContain('documentSymbol'); // explicitly false: not advertised
    expect(kinds).not.toContain('definition'); // absent: not advertised
    expect(kinds).not.toContain('completion');
  });

  it('maps signatureHelp trigger characters', () => {
    const plan = planProviderRegistrations({ signatureHelpProvider: { triggerCharacters: ['(', ','] } });
    expect(plan).toContainEqual({ kind: 'signatureHelp', triggerCharacters: ['(', ','] });
  });
});
