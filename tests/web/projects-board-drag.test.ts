import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Projects board drag bootstrap', () => {
  it('seeds dataTransfer so Firefox starts the card drag', () => {
    const source = readFileSync(new URL('../../src/web/projects/BoardView.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(/onDragStart=\{\(event: DragEvent\) => \{[\s\S]*event\.dataTransfer\.setData\('text\/plain', item\.id\);/);
    expect(source).toMatch(/event\.dataTransfer\.effectAllowed = 'move';/);
  });
});
