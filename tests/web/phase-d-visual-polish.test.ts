import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesSource = () => readFileSync('src/web/styles.css', 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssBlock(source: string, selector: string, containing?: string): string {
  const matches = [...source.matchAll(new RegExp(`${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];
  if (containing) {
    return matches.find((match) => match.groups?.body.includes(containing))?.groups?.body ?? '';
  }
  return matches[0]?.groups?.body ?? '';
}

describe('Phase D visual polish styles', () => {
  it('softens global chrome while preserving focused cell emphasis', () => {
    const source = stylesSource();

    expect(cssBlock(source, '.deskShell')).toContain('--desk-chrome-line: color-mix(in srgb, var(--desk-line) 58%, transparent)');
    expect(cssBlock(source, '.deskShell')).toContain('--desk-chrome-line-soft: color-mix(in srgb, var(--desk-line) 34%, transparent)');
    expect(cssBlock(source, '.terminalFrame')).toContain('border: 1px solid var(--desk-chrome-line)');
    expect(cssBlock(source, '.terminalFrame')).toContain('box-shadow: inset 0 0 18px var(--desk-chrome-glow)');
    expect(cssBlock(source, '.terminalFrame > svg')).toContain('opacity: 0.26');
    expect(cssBlock(source, '.workspaceTopbar')).toContain('border-bottom: 1px solid var(--desk-chrome-line)');
    expect(cssBlock(source, '.topbarTelemetry', 'border-top')).toContain('border-top: 1px solid var(--desk-chrome-line-soft)');
    expect(cssBlock(source, '.cellChromeBorder')).toContain('background: var(--desk-chrome-line-soft)');
    expect(cssBlock(source, ".cellChrome[data-focused='true'] .cellChromeBorder")).toContain('background: var(--desk-line-strong)');
  });

  it('calms the sidebar tree selection without touching native-agent owned sections', () => {
    const source = stylesSource();

    expect(cssBlock(source, '.projectTree')).toContain('padding: 7px');
    expect(cssBlock(source, '.treeRow')).toContain('gap: 6px');
    expect(cssBlock(source, '.treeRow')).toContain('min-height: 26px');
    expect(cssBlock(source, '.treeRow > svg')).toContain('--arwes-frames-line-color: var(--desk-chrome-line-soft)');
    expect(cssBlock(source, '.treeRow > svg')).toContain('--arwes-frames-bg-color: transparent');
    expect(cssBlock(source, '.treeMain')).toContain('height: 26px');
    expect(cssBlock(source, '.treeMain')).toContain('color: color-mix(in srgb, var(--desk-text) 80%, var(--desk-text-dim))');
    expect(cssBlock(source, '.treeMain small')).toContain('color: color-mix(in srgb, var(--desk-accent) 68%, var(--desk-text-dim))');
    expect(source).toMatch(
      /\.projectNode\.selected > \.projectRow \.treeMain,\s*\.groupNode\.selected > \.groupRow \.treeMain,\s*\.sessionNode\.selected \.treeMain\s*\{[^}]*background: color-mix\(in srgb, var\(--desk-accent\) 9%, transparent\);[^}]*border-color: var\(--desk-chrome-line\);/s
    );
    expect(cssBlock(source, '.sessionNode.selected')).toContain('filter: none');

    for (const selector of ['.nativeAgentJumpPill', '.nativeAgentPalette', '.nativeAgentChildren']) {
      expect(cssBlock(source, selector)).not.toMatch(/--desk-chrome|Phase D|phase-d/);
    }
  });

  it('separates utility, primary, and destructive button weight', () => {
    const source = stylesSource();

    expect(cssBlock(source, '.deskCmd')).toContain('--arwes-frames-line-color: var(--desk-chrome-line-soft)');
    expect(cssBlock(source, '.deskCmd')).toContain('color: color-mix(in srgb, var(--desk-text) 72%, var(--desk-text-dim))');
    expect(cssBlock(source, '.deskCmd:hover:not(:disabled)')).toContain('--arwes-frames-line-color: var(--desk-chrome-line)');
    expect(cssBlock(source, '.deskCmd:hover:not(:disabled)')).toContain('color: var(--desk-text)');
    expect(cssBlock(source, '.deskCmd.danger')).toContain('color: color-mix(in srgb, var(--desk-error) 72%, var(--desk-text-dim))');
    expect(cssBlock(source, '.deskCmd.danger')).toContain('--arwes-frames-line-color: color-mix(in srgb, var(--desk-error) 44%, transparent)');
    expect(cssBlock(source, '.deskCmd.danger:hover:not(:disabled)')).toContain('color: var(--desk-error)');
    expect(cssBlock(source, '.nativeAgentSend')).toContain('font-weight: 700');
    expect(cssBlock(source, '.nativeAgentSend')).toContain('background: color-mix(in srgb, var(--desk-accent) 20%, transparent)');
    expect(cssBlock(source, '.nativeAgentSend')).not.toContain('box-shadow');
  });
});
