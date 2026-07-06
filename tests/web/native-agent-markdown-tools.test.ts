import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nativeSurfaceSource = () => readFileSync('src/web/agentSurface/NativeAgentSurface.tsx', 'utf8');
const stylesSource = () => readFileSync('src/web/styles.css', 'utf8');
const appSource = () => readFileSync('src/web/App.tsx', 'utf8');

describe('native agent markdown rendering', () => {
  it('renders committed and pending assistant text through the markdown renderer', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/const ChannelMarkdown = lazy/);
    expect(source).toMatch(/function AgentMarkdown/);
    expect(source).toMatch(/<AgentMarkdown body=\{row\.text\} \/>/);
    expect(source).toMatch(/<AgentMarkdown body=\{text\} \/>/);
    expect(source).not.toMatch(/<span className="nativeAgentText">\{text\}<\/span>/);
  });
});

describe('native agent tool disclosure', () => {
  it('uses the reference-style disclosure structure with header and in/out boxes', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/className="nativeAgentToolHeader"/);
    expect(source).toMatch(/aria-expanded=\{open\}/);
    expect(source).toMatch(/className="nativeAgentToolBody"/);
    expect(source).toMatch(/nativeAgentToolBoxLabel">in/);
    expect(source).toMatch(/nativeAgentToolBoxLabel">out/);
    expect(source).not.toMatch(/nativeAgentToolToggle/);
    expect(source).not.toMatch(/nativeAgentToolDetail/);
  });
});

describe('native agent payload collapse and permission dock', () => {
  it('routes rows with collapse metadata through an expandable payload row', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/function CollapsiblePayloadRow/);
    expect(source).toMatch(/if \(row\.collapse\)/);
    expect(source).toMatch(/<CollapsiblePayloadRow row=\{row\}/);
    expect(source).toMatch(/nativeAgentPayloadPreview/);
    expect(source).toMatch(/channel context/);
  });

  it('renders active permission requests in a composer dock instead of inside the feed', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/className=\"nativeAgentPermissionDock\"/);
    expect(source).toMatch(/<PermissionCard permission=\{model\.pendingPermission\} onRespond=\{handlePermission\} \/>/);
    expect(source).not.toMatch(new RegExp('<div className="nativeAgentFeed"[\\\\s\\\\S]*?<PermissionCard[\\\\s\\\\S]*?</div>\\\\s*\\\\{unseenCount > 0'));
  });
});

describe('native agent Phase B row anatomy', () => {
  it('renders row metadata and copy actions for message rows', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/function RowMeta/);
    expect(source).toMatch(/nativeAgentRowMeta/);
    expect(source).toMatch(/dateTime=\{row\.createdAt\}/);
    expect(source).toMatch(/nativeAgentRowActions/);
    expect(source).toMatch(/copyRowText/);
  });
});

describe('native agent Phase B tool state clarity', () => {
  it('renders explicit tool labels, elapsed time, and active running affordance', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/row\.toolState\?\.label/);
    expect(source).toMatch(/formatDurationMs\(row\.toolState\?\.durationMs\)/);
    expect(source).toMatch(/nativeAgentToolBadge/);
    expect(source).toMatch(/nativeAgentToolSpinner/);
    expect(source).toMatch(/aria-label=\"tool is running\"/);
  });
});

describe('native agent Phase B styles', () => {
  it('defines scoped row anatomy and tool state styles', () => {
    const source = stylesSource();

    expect(source).toMatch(/UX items 6 \+ 7/);
    expect(source).toMatch(/\.nativeAgentRowMeta/);
    expect(source).toMatch(/\.nativeAgentRowActions/);
    expect(source).toMatch(/\.nativeAgentToolBadge/);
    expect(source).toMatch(/\.nativeAgentToolSpinner/);
    expect(source).toMatch(/\.nativeAgentToolElapsed/);
  });
});

describe('native agent Phase C turn collapse and virtualization', () => {
  it('uses feed items, turn summary rows, and a virtualized feed container', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/useVirtualizer/);
    expect(source).toMatch(/buildAgentFeedItems/);
    expect(source).toMatch(/function TurnSummaryRow/);
    expect(source).toMatch(/nativeAgentVirtualSpacer/);
    expect(source).toMatch(/virtualizer\.measureElement/);
    expect(source).toMatch(/nativeAgentTurnSummary/);
  });

  it('defines scoped turn summary and virtual feed styles', () => {
    const source = stylesSource();

    expect(source).toMatch(/UX item 10/);
    expect(source).toMatch(/\.nativeAgentVirtualSpacer/);
    expect(source).toMatch(/\.nativeAgentVirtualItem/);
    expect(source).toMatch(/\.nativeAgentTurnSummary/);
    expect(source).toMatch(/\.nativeAgentTurnSummaryMeta/);
  });
});

describe('native agent message actions and notes', () => {
  it('shows copy success only after clipboard write resolves', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/type CopyState = 'idle' \| 'copied' \| 'failed'/);
    expect(source).toMatch(/await copyRowText\(text\)/);
    expect(source).toMatch(/showCopyState\(copied \? 'copied' : 'failed'\)/);
    expect(source).toMatch(/nativeAgentRowAction copied/);
  });

  it('bounds stalled clipboard writes and falls back to execCommand copy', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/const COPY_TIMEOUT_MS = 800/);
    expect(source).toMatch(/Promise\.race/);
    expect(source).toMatch(/copyRowTextWithTimeout/);
    expect(source).toMatch(/fallbackCopyRowText/);
    expect(source).toMatch(/document\.execCommand\('copy'\)/);
  });

  it('uses compact accessible icons for row copy and note actions', () => {
    const surface = nativeSurfaceSource();
    const styles = stylesSource();

    expect(surface).toMatch(/import \{ Copy, StickyNote \} from 'lucide-react'/);
    expect(surface).toMatch(/<Copy size=\{14\} aria-hidden="true" \/>/);
    expect(surface).toMatch(/<StickyNote size=\{14\} aria-hidden="true" \/>/);
    expect(surface).toMatch(/aria-label=\{copyActionLabel\}/);
    expect(surface).toMatch(/title=\{copyActionLabel\}/);
    expect(surface).toMatch(/aria-label="Create note"/);
    expect(surface).not.toMatch(/copyState === 'copied' \? 'Copied' : copyState === 'failed' \? 'Failed' : 'Copy'/);
    expect(styles).toMatch(/width: 24px/);
    expect(styles).toMatch(/height: 24px/);
    expect(styles).toMatch(/justify-content: center/);
  });

  it('wires message context menus to the existing notes creator flow', () => {
    const surface = nativeSurfaceSource();
    const app = appSource();

    expect(surface).toMatch(/onMessageMenu\?: \(text: string, x: number, y: number\) => void/);
    expect(surface).toMatch(/onContextMenu=\{\(event\) => openMessageMenu\(event, row\.text\)\}/);
    expect(surface).toMatch(/<RowActions text=\{row\.text\} onCreateNote=\{onCreateNote\} \/>/);
    expect(app).toMatch(/onTerminalSelectionMenu: \(text: string, x: number, y: number\) => setTerminalMenu\(\{ text, x, y \}\)/);
    expect(app).toMatch(/onSelectionMenu=\{onTerminalSelectionMenu\}/);
    expect(app).toMatch(/onMessageMenu=\{onSelectionMenu\}/);
    expect(app).toMatch(/onCreateNote=\{onCreateNoteFromText\}/);
    expect(app).toMatch(/noteCreatorRef\.current\?\.\(text\)/);
  });

  it('defines collision-safe collapsed payload header styles', () => {
    const surface = nativeSurfaceSource();
    const styles = stylesSource();

    expect(surface).toMatch(/nativeAgentPayloadMetaLine/);
    expect(surface).toMatch(/nativeAgentPayloadPreviewLine/);
    expect(styles).toMatch(/\.nativeAgentPayloadMetaLine/);
    expect(styles).toMatch(/flex-shrink: 0/);
    expect(styles).toMatch(/\.nativeAgentPayloadPreviewLine/);
    expect(styles).toMatch(/min-width: 0/);
  });
});
