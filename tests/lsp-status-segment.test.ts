import { describe, it, expect } from 'vitest';
import { lspStatusSegment, type LspSessionStatus } from '../src/web/editor/lsp/statusSegment.js';

const base: LspSessionStatus = { languageId: 'rust', serverName: 'rust-analyzer', phase: 'ready' };

describe('lspStatusSegment', () => {
  it('returns null when there is no session status', () => {
    expect(lspStatusSegment(null)).toBeNull();
  });

  it('renders a calm, untoned ready segment', () => {
    const seg = lspStatusSegment({ ...base, phase: 'ready' });
    expect(seg).not.toBeNull();
    expect(seg!.key).toBe('lsp');
    expect(seg!.text).toBe('LSP: ready');
    expect(seg!.tone).toBeUndefined();
    expect(seg!.hint).toContain('rust');
    expect(seg!.hint).toContain('rust-analyzer');
  });

  it('renders warming with the accent tone', () => {
    const seg = lspStatusSegment({ ...base, phase: 'warming' });
    expect(seg!.text).toBe('LSP: warming');
    expect(seg!.tone).toBe('accent');
  });

  it('renders degraded with a warn tone and the fallback reason in the hint', () => {
    const seg = lspStatusSegment({ ...base, phase: 'degraded', reason: 'warm start failed' });
    expect(seg!.text).toBe('LSP: degraded');
    expect(seg!.tone).toBe('warn');
    expect(seg!.hint).toContain('warm start failed');
  });

  it('falls back to a built-in-features hint when degraded carries no reason', () => {
    const seg = lspStatusSegment({ ...base, phase: 'degraded' });
    expect(seg!.tone).toBe('warn');
    expect(seg!.hint).toContain('built-in');
  });

  it('renders restarting with a warn tone', () => {
    const seg = lspStatusSegment({ ...base, phase: 'restarting' });
    expect(seg!.text).toBe('LSP: restarting');
    expect(seg!.tone).toBe('warn');
  });

  it('renders stopped with a danger tone and reason in the hint', () => {
    const seg = lspStatusSegment({ ...base, phase: 'stopped', reason: 'crash budget exhausted' });
    expect(seg!.text).toBe('LSP: stopped');
    expect(seg!.tone).toBe('danger');
    expect(seg!.hint).toContain('crash budget exhausted');
  });

  it('shows indexing with a rounded percentage when progress is active during ready', () => {
    const seg = lspStatusSegment({ ...base, phase: 'ready', progress: { percentage: 41.7 } });
    expect(seg!.text).toBe('LSP: indexing 42%');
    expect(seg!.tone).toBe('accent');
  });

  it('shows indexing with the progress title and percentage', () => {
    const seg = lspStatusSegment({
      ...base,
      phase: 'ready',
      progress: { title: 'rust-analyzer indexing', percentage: 10, message: 'crate 1/8' }
    });
    expect(seg!.text).toBe('LSP: rust-analyzer indexing 10%');
    expect(seg!.hint).toContain('crate 1/8');
  });

  it('shows a generic indexing label when progress has neither title nor percentage', () => {
    const seg = lspStatusSegment({ ...base, phase: 'ready', progress: {} });
    expect(seg!.text).toBe('LSP: indexing');
    expect(seg!.tone).toBe('accent');
  });

  it('clamps an out-of-range percentage into 0-100', () => {
    expect(lspStatusSegment({ ...base, phase: 'ready', progress: { percentage: 140 } })!.text).toBe('LSP: indexing 100%');
    expect(lspStatusSegment({ ...base, phase: 'ready', progress: { percentage: -5 } })!.text).toBe('LSP: indexing 0%');
  });

  it('overlays indexing on top of warming while the server is still coming up', () => {
    const seg = lspStatusSegment({ ...base, phase: 'warming', progress: { percentage: 5 } });
    expect(seg!.text).toBe('LSP: indexing 5%');
    expect(seg!.tone).toBe('accent');
  });

  it('lets a terminal lifecycle phase win over a stale progress payload', () => {
    // A degraded/restarting/stopped session must not masquerade as healthy indexing.
    expect(lspStatusSegment({ ...base, phase: 'degraded', progress: { percentage: 50 } })!.text).toBe('LSP: degraded');
    expect(lspStatusSegment({ ...base, phase: 'restarting', progress: { percentage: 50 } })!.text).toBe('LSP: restarting');
    expect(lspStatusSegment({ ...base, phase: 'stopped', progress: { percentage: 50 } })!.text).toBe('LSP: stopped');
  });
});
