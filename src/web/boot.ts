// Browser boot order. Extracted from main.tsx so the one guarantee that
// matters here is testable: the app renders even when startup chores fail.

export interface BootOptions {
  /** Best-effort startup chore (identity migration) — may reject. */
  migrate: () => Promise<void>;
  render: () => void;
  onMigrationError?: (error: unknown) => void;
}

/**
 * Render is UNCONDITIONAL. The session-identity migration re-keys local
 * storage and talks to the server to do it, so a restarting server, a proxy
 * blip, or an offline tab makes it reject — none of which are reasons to
 * leave the operator staring at a blank page with no way back except a
 * reload that fails the same way. A failed migration only means local state
 * keeps its old keys until the next successful boot; a failed render means
 * there is no product.
 */
export async function bootDesk(options: BootOptions): Promise<void> {
  try {
    await options.migrate();
  } catch (error) {
    options.onMigrationError?.(error);
  }
  options.render();
}
