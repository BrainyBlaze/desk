import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App.js';
import { initPerfTelemetry } from './editor/lsp/perfTelemetry.js';
import { migrateBrowserSessionIdentity } from './sessionIdentityStorageMigration.js';

// Opt-in LSP perf telemetry. No-op unless globalThis.DESK_LSP_PERF is set; installs nothing
// and changes no behavior otherwise.
initPerfTelemetry();

function requireRoot(): HTMLElement {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('root element is missing');
  }
  return root;
}

const root = requireRoot();

async function start(): Promise<void> {
  await migrateBrowserSessionIdentity();
  createRoot(root).render(<App />);
}

void start().catch((error: unknown) => {
  console.error('Desk startup failed', error);
  root.textContent = 'Desk could not migrate saved session state. Check the server migration and reload.';
});
