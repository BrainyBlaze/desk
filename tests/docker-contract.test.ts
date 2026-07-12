import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dockerfile = fileURLToPath(new URL('../Dockerfile', import.meta.url));
const dockerignore = fileURLToPath(new URL('../.dockerignore', import.meta.url));

describe('Docker full CLI contract', () => {
  it('builds and runs the same two-mode desk CLI contract as a source install', () => {
    const source = readFileSync(dockerfile, 'utf8');
    const ignored = readFileSync(dockerignore, 'utf8');
    const retired = ['desk', 'server'].join('-');

    expect(source.match(/FROM node:22\.23\.1-bookworm-slim/g)).toHaveLength(2);
    expect(source).toContain('BUN_VERSION=1.3.14');
    expect(source).toContain('npm run build:distribution');
    expect(source).toContain('libexec/desk-standalone');
    expect(source).toContain('COPY --from=builder /opt/desk /opt/desk');
    expect(source).toContain('ln -s /opt/desk/dist/cli/main.js /usr/local/bin/desk');
    expect(source).toContain('ENTRYPOINT ["desk"]');
    expect(source).toContain('CMD ["serve", "--host", "0.0.0.0", "--port", "5173"]');
    expect(source).not.toContain(retired);
    expect(ignored).toContain('libexec');
    expect(ignored).not.toContain(retired);
  });
});
