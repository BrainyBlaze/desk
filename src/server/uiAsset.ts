// Prebuilt UI location — DEV / typecheck stub.
//
// The bun standalone build swaps this for ./uiAsset.standalone.ts (which embeds
// and extracts the UI bundle). standalone.ts is only ever launched from the
// compiled binary, so this variant is never executed at runtime — it exists so
// tsc/Vite can resolve the ./uiAsset.js import without the Bun-only
// `with { type: 'file' }` attribute.
export function resolveEmbeddedUiDir(): string {
  throw new Error('uiAsset: the UI is only embedded in the bun standalone build');
}
