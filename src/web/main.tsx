import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App.js';
import { initPerfTelemetry } from './editor/lsp/perfTelemetry.js';

// Opt-in LSP perf telemetry. No-op unless globalThis.DESK_LSP_PERF is set; installs nothing
// and changes no behavior otherwise.
initPerfTelemetry();

const root = document.getElementById('root');

if (!root) {
  throw new Error('root element is missing');
}

createRoot(root).render(<App />);
