import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Issue #52: at a narrow viewport the Channels "Add agent" dialog painted UNDER
 * the responsive sidebar drawer, so the drawer swallowed clicks aimed at agent
 * rows. Both layers live in the same stacking context (`.deskContent`, z 1), so
 * the winner at a given point is decided purely by their z-index — which is what
 * this test replays, using the rects measured on the reported build.
 */

type Rule = { media: string | null; selectors: string[]; body: string };
type Rect = { x: number; y: number; width: number; height: number };

const NARROW_MEDIA = '(max-width: 860px)';

/** Rects measured by the QA rehearsal at 800x650, DPR 1 (issue #52). */
const NARROW_GEOMETRY = {
  dialog: { x: 19, y: 194.5, width: 784, height: 297 },
  sidebar: { x: -5, y: 59, width: 340, height: 568 },
  agentRow: { x: 45, y: 333.5, width: 520, height: 65 }
} satisfies Record<string, Rect>;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('unbalanced braces in stylesheet');
}

/** Flat rule list; @media blocks are entered, other at-rules (keyframes) skipped. */
function parseRules(source: string): Rule[] {
  const css = stripComments(source);
  const rules: Rule[] = [];
  let media: string | null = null;
  let mediaEnd = -1;
  let prelude = '';
  let index = 0;
  while (index < css.length) {
    if (media !== null && index > mediaEnd) media = null;
    const char = css[index];
    if (char === '}') {
      prelude = '';
      index += 1;
      continue;
    }
    if (char !== '{') {
      prelude += char;
      index += 1;
      continue;
    }
    const close = matchingBrace(css, index);
    const head = prelude.trim().replace(/\s+/g, ' ');
    prelude = '';
    if (head.startsWith('@media')) {
      media = head.slice('@media'.length).trim();
      mediaEnd = close;
      index += 1;
      continue;
    }
    if (!head.startsWith('@')) {
      rules.push({
        media,
        selectors: head.split(',').map((selector) => selector.trim()),
        body: css.slice(index + 1, close)
      });
    }
    index = close + 1;
  }
  return rules;
}

/** Last declared z-index for `selector` under the given viewport, or null. */
function zIndexOf(rules: Rule[], selector: string, viewport: 'narrow' | 'wide'): number | null {
  let value: number | null = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    if (rule.media !== null && !(viewport === 'narrow' && rule.media === NARROW_MEDIA)) continue;
    const declared = /(?:^|[;{\s])z-index:\s*(-?\d+)/.exec(rule.body);
    if (declared) value = Number(declared[1]);
  }
  return value;
}

function covers(rect: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
  );
}

/** Topmost painted layer at a point among same-context siblings (highest z wins). */
function elementAtPoint(
  layers: { name: string; z: number | null; rect: Rect }[],
  point: { x: number; y: number }
): string {
  const hits = layers
    .filter((layer) => covers(layer.rect, point))
    .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  if (hits.length === 0) throw new Error('no layer covers the point');
  return hits[0]!.name;
}

const rules = parseRules(readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8'));

const DRAWER_SELECTOR = '.subsystemPanels > [data-panel]:has(> .agentTreePanel)';

describe('modal dialogs versus the responsive sidebar drawer', () => {
  it('paints the modal scrim above the drawer and its scrim at narrow widths', () => {
    const modal = zIndexOf(rules, '.modalScrim', 'narrow');
    const drawer = zIndexOf(rules, DRAWER_SELECTOR, 'narrow');
    const drawerScrim = zIndexOf(rules, '.drawerScrim', 'narrow');

    expect(modal).not.toBeNull();
    expect(drawer).not.toBeNull();
    expect(drawerScrim).not.toBeNull();
    expect(modal!).toBeGreaterThan(drawer!);
    expect(modal!).toBeGreaterThan(drawerScrim!);
  });

  it('lets an agent row keep the click at the geometry reported in issue #52', () => {
    const modal = zIndexOf(rules, '.modalScrim', 'narrow');
    const drawer = zIndexOf(rules, DRAWER_SELECTOR, 'narrow');
    const rowCentre = {
      x: NARROW_GEOMETRY.agentRow.x + NARROW_GEOMETRY.agentRow.width / 2,
      y: NARROW_GEOMETRY.agentRow.y + NARROW_GEOMETRY.agentRow.height / 2
    };

    // The drawer really does overlap the row centre — the fix is stacking, not layout.
    expect(covers(NARROW_GEOMETRY.sidebar, rowCentre)).toBe(true);
    expect(covers(NARROW_GEOMETRY.dialog, rowCentre)).toBe(true);

    expect(
      elementAtPoint(
        [
          { name: 'channels sidebar drawer', z: drawer, rect: NARROW_GEOMETRY.sidebar },
          { name: 'add agent dialog', z: modal, rect: NARROW_GEOMETRY.dialog }
        ],
        rowCentre
      )
    ).toBe('add agent dialog');
  });

  it('keeps toasts and the portalled select panel above the modal scrim', () => {
    const modal = zIndexOf(rules, '.modalScrim', 'wide');

    expect(modal!).toBeLessThan(zIndexOf(rules, '.toastStack', 'wide')!);
    expect(modal!).toBeLessThan(zIndexOf(rules, '.deskSelectPanelPortal', 'wide')!);
  });

  it('keeps the desktop control from issue #52 unchanged: no drawer layer at all', () => {
    expect(zIndexOf(rules, DRAWER_SELECTOR, 'wide')).toBeNull();
    expect(zIndexOf(rules, '.modalScrim', 'wide')).not.toBeNull();
  });
});
