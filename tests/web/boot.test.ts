// The identity migration talks to the server. A transient failure there must
// degrade — stale local keys until the next boot — never leave the operator
// with a page that never rendered.
import { describe, expect, it } from 'vitest';
import { bootDesk } from '../../src/web/boot.js';

describe('browser boot', () => {
  it('renders even when the identity migration rejects', async () => {
    let rendered = 0;
    const seen: unknown[] = [];

    await bootDesk({
      migrate: async () => {
        throw new Error('502 from /api/session-identity-map');
      },
      render: () => {
        rendered += 1;
      },
      onMigrationError: (error) => seen.push(error)
    });

    expect(rendered, 'a failed startup chore must not block the app').toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('renders once after a successful migration, in order', async () => {
    const order: string[] = [];

    await bootDesk({
      migrate: async () => {
        order.push('migrate');
      },
      render: () => {
        order.push('render');
      }
    });

    expect(order).toEqual(['migrate', 'render']);
  });
});
