import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App.js';
import { initPerfTelemetry } from './editor/lsp/perfTelemetry.js';
import { bootDesk } from './boot.js';
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

void bootDesk({
  migrate: migrateBrowserSessionIdentity,
  render: () => createRoot(root).render(<App />),
  onMigrationError: (error: unknown) => {
    // Visible, but never fatal: stale local keys are recoverable on the next
    // boot, a page that never rendered is not.
    console.error('Desk: saved session state could not be migrated; continuing without it', error);
  }
});
