import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nativeSurfaceSource = () => readFileSync('src/web/agentSurface/NativeAgentSurface.tsx', 'utf8');
const stylesSource = () => readFileSync('src/web/styles.css', 'utf8');
const appSource = () => readFileSync('src/web/App.tsx', 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssBlock(source: string, selector: string): string {
  return new RegExp(`${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`, 's').exec(source)?.groups?.body ?? '';
}

describe('native agent markdown rendering', () => {
  it('renders committed and pending message text through the markdown renderer', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/const ChannelMarkdown = lazy/);
    expect(source).toMatch(/function AgentMarkdown/);
    expect(source.match(/<AgentMarkdown body=\{row\.text\} \/>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/<AgentMarkdown body=\{text\} \/>/);
    expect(source).not.toMatch(/<span className="nativeAgentText">\{text\}<\/span>/);
  });
});

describe('native agent thinking indicator', () => {
  it('shows immediately after send and clears only on real agent activity or failure', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/const \[awaitingResponse, setAwaitingResponse\] = useState\(false\)/);
    expect(source).toMatch(/agentSurfaceClient\.send\(surfaceId, session, text\);[\s\S]*setAwaitingResponse\(true\);/);
    expect(source).toMatch(/if \(event\.kind !== 'session-info'\) \{[\s\S]*setAwaitingResponse\(false\);[\s\S]*\}/);
    expect(source).toMatch(/onSnapshot: \(\{ state, events \}\) => \{[\s\S]*setAwaitingResponse\(false\);/);
    expect(source).toMatch(/onError: \(_code, message\) => \{[\s\S]*setAwaitingResponse\(false\);/);
    expect(source).toMatch(/onExit: \(\) => \{[\s\S]*setAwaitingResponse\(false\);/);
    expect(source).toMatch(/const showAgentThinking =\s*awaitingResponse \|\| model\.status === 'processing' \|\| model\.status === 'tool-executing';/);
    // The indicator must NOT be gated on pending assistant text: a tool call
    // that runs after a partial assistant message left the transcript dead-still
    // for the whole tool duration (the operator's 15:41/15:51 report).
    expect(source).not.toMatch(/pendingAssistantEntries\.length === 0 &&\s*\(awaitingResponse/);
    expect(source).toMatch(/\{showAgentThinking \? \(/);
    expect(source).toMatch(/aria-label=\"agent is thinking\"/);
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
  it('uses compact status glyphs and hides subsecond elapsed noise in tool badges', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/import \{ Check, Copy, CornerDownLeft, Paperclip, Square, StickyNote, X \} from 'lucide-react'/);
    expect(source).toMatch(/function ToolStatusGlyph/);
    expect(source).toMatch(/aria-label="tool done"/);
    expect(source).toMatch(/aria-label="tool failed"/);
    expect(source).toMatch(/formatDurationMs\(row\.toolState\?\.durationMs\)/);
    expect(source).toMatch(/if \(durationMs < 1000\) return null;/);
    expect(source).toMatch(/nativeAgentToolBadge/);
    expect(source).toMatch(/nativeAgentToolSpinner/);
    expect(source).toMatch(/aria-label=\"tool is running\"/);
    expect(source).not.toMatch(/<span>\{row\.toolState\?\.label \?\? statusClass\}<\/span>/);
  });
});

describe('native agent Phase B styles', () => {
  it('defines scoped row anatomy and tool state styles', () => {
    const source = stylesSource();
    const headerRule = cssBlock(source, '.nativeAgentToolHeaderLine .nativeAgentToolHeader');
    const actionsRule = cssBlock(source, '.nativeAgentRowActions');
    const badgeRule = cssBlock(source, '.nativeAgentToolBadge');

    expect(source).toMatch(/UX items 6 \+ 7/);
    expect(source).toMatch(/\.nativeAgentRowMeta/);
    expect(source).toMatch(/\.nativeAgentRowActions/);
    expect(source).toMatch(/\.nativeAgentToolBadge/);
    expect(source).toMatch(/\.nativeAgentToolSpinner/);
    expect(source).toMatch(/\.nativeAgentToolElapsed/);
    expect(headerRule).toContain('flex: 1 1 auto');
    expect(headerRule).toContain('min-width: 0');
    expect(headerRule).toContain('overflow: hidden');
    expect(actionsRule).toContain('flex: 0 0 52px');
    expect(actionsRule).toContain('width: 52px');
    expect(actionsRule).toContain('justify-content: flex-end');
    expect(badgeRule).toContain('width: 18px');
    expect(badgeRule).toContain('padding: 0');
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

    expect(surface).toMatch(/import \{ Check, Copy, CornerDownLeft, Paperclip, Square, StickyNote, X \} from 'lucide-react'/);
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

describe('native agent composer controls', () => {
  it('mirrors channel composer resize and upload affordances', () => {
    const surface = nativeSurfaceSource();
    const styles = stylesSource();

    expect(surface).toMatch(/import \{ Check, Copy, CornerDownLeft, Paperclip, Square, StickyNote, X \} from 'lucide-react'/);
    expect(surface).toMatch(/import \{ channelsUpload \} from '..\/channels\/channelsClient\.js'/);
    expect(surface).toMatch(/composerInputHeightFromTopResize/);
    expect(surface).toMatch(/runComposerFileUpload/);
    expect(surface).toMatch(/handleComposerFileDragOver/);
    expect(surface).toMatch(/const NATIVE_AGENT_FILE_CHANNEL = 'agent-files'/);
    expect(surface).toMatch(/const uploadNativeFiles = async/);
    expect(surface).toMatch(/channel: NATIVE_AGENT_FILE_CHANNEL/);
    expect(surface).toMatch(/upload: channelsUpload/);
    expect(surface).toMatch(/className=\"nativeAgentComposerResizeHandle\"/);
    expect(surface).toMatch(/aria-label=\"Resize native agent input\"/);
    expect(surface).toMatch(/style=\{manualInputHeight \? \{ height: `\$\{manualInputHeight\}px` \} : undefined\}/);
    expect(surface).toMatch(/const \[slashPaletteOpen, setSlashPaletteOpen\] = useState\(false\)/);
    expect(surface).toMatch(/const slashPointerHandledRef = useRef\(false\)/);
    expect(surface).toMatch(/const filteredAgentCommands = useMemo/);
    expect(surface).toMatch(/const slashPaletteVisible = slashPaletteOpen && input\.startsWith\('\/'\)/);
    expect(surface).toMatch(/const toggleSlashCommands = \(\): void =>/);
    expect(surface).toMatch(/if \(slashPaletteVisible\) \{[\s\S]*setSlashPaletteOpen\(false\);/);
    expect(surface).toMatch(/nativeAgentSlashButton/);
    expect(surface).toMatch(/aria-label=\"Open slash commands\"/);
    expect(surface).toMatch(/onPointerDown=\{\(event\) => \{/);
    expect(surface).toMatch(/slashPointerHandledRef\.current = true;[\s\S]*toggleSlashCommands\(\);/);
    expect(surface).toMatch(/onClick=\{\(\) => \{[\s\S]*slashPointerHandledRef\.current = false;[\s\S]*toggleSlashCommands\(\);/);
    expect(surface).toMatch(/<span className=\"nativeAgentSlashGlyph\" aria-hidden=\"true\">\/<\/span>/);
    expect(surface).not.toMatch(/<Slash size=\{12\} aria-hidden=\"true\" \/>/);
    expect(surface).toMatch(/nativeAgentPaletteEmpty/);
    expect(surface).toMatch(/No commands available/);
    expect(surface).toMatch(/nativeAgentFileButton/);
    expect(surface).toMatch(/type=\"file\"/);
    expect(surface).toMatch(/multiple/);
    expect(surface).toMatch(/<Paperclip size=\{14\} strokeWidth=\{2\.1\} aria-hidden=\"true\" \/>/);
    expect(surface).toMatch(/nativeAgentComposerInputWrap/);
    expect(surface).toMatch(/nativeAgentComposerRightActions/);
    expect(surface).toMatch(/<div className=\"nativeAgentComposerRightActions\">[\s\S]*nativeAgentSlashButton[\s\S]*nativeAgentFileButton[\s\S]*nativeAgentSend/);
    expect(surface).not.toMatch(/nativeAgentComposerLeftActions/);
    expect(surface).toMatch(/nativeAgentComposerIconButton/);
    expect(surface).toMatch(/<CornerDownLeft size=\{14\} strokeWidth=\{2\.1\} aria-hidden=\"true\" \/>/);
    expect(surface).toMatch(/<Square className=\"nativeAgentStopGlyph\" size=\{14\} fill=\"currentColor\" strokeWidth=\{2\.1\} aria-hidden=\"true\" \/>/);
    expect(surface).toMatch(/onPaste=\{\(event\) => \{/);
    expect(surface).toMatch(/handleComposerFilePaste\(event, uploadNativeFiles\)/);
    expect(surface).toMatch(/handleComposerFileDrop\(event, setDragOver, uploadNativeFiles\)/);
    expect(surface).toMatch(/<ChannelMarkdown body=\{body\} channel=\{NATIVE_AGENT_FILE_CHANNEL\}/);

    const composerRule = cssBlock(styles, '.nativeAgentComposer');
    const handleRule = cssBlock(styles, '.nativeAgentComposerResizeHandle');
    const inputWrapRule = cssBlock(styles, '.nativeAgentComposerInputWrap');
    const paletteRule = cssBlock(styles, '.nativeAgentPalette');
    const rightActionsRule = cssBlock(styles, '.nativeAgentComposerRightActions');
    const buttonRule = cssBlock(styles, '.nativeAgentComposerIconButton');
    const inputRule = cssBlock(styles, '.nativeAgentInput');

    expect(composerRule).toContain('position: relative');
    expect(handleRule).toContain('cursor: ns-resize');
    expect(handleRule).toContain('height: 5px');
    expect(inputWrapRule).toContain('border-radius: 0');
    expect(inputWrapRule).toContain('clip-path: polygon(7px 0, calc(100% - 7px) 0, 100% 7px, 100% calc(100% - 7px), calc(100% - 7px) 100%, 7px 100%, 0 calc(100% - 7px), 0 7px)');
    expect(inputWrapRule).toContain('display: grid');
    expect(inputRule).toContain('padding: 8px 96px 8px 8px');
    expect(rightActionsRule).toContain('right: 8px');
    expect(rightActionsRule).toContain('gap: 3px');
    expect(buttonRule).toContain('width: 24px');
    expect(buttonRule).toContain('height: 24px');
    expect(buttonRule).toContain('border: 1px solid color-mix');
    expect(buttonRule).toContain('var(--desk-line)');
    expect(buttonRule).toContain('var(--desk-text-dim)');
    expect(buttonRule).not.toContain('--desk-border');
    expect(buttonRule).toContain('border-radius: 3px');
    expect(buttonRule).toContain('justify-content: center');
    const slashRule = cssBlock(styles, '.nativeAgentSlashGlyph');
    expect(slashRule).toContain('width: 14px');
    expect(slashRule).toContain('height: 14px');
    expect(slashRule).toContain('display: inline-grid');
    expect(slashRule).toContain('place-items: center');
    expect(styles).toMatch(/\.nativeAgentComposerIconButton svg/);
    expect(styles).toMatch(/\.nativeAgentComposerIconButton:active:not\(:disabled\)/);
    expect(styles).toMatch(/\.nativeAgentStopGlyph/);
    expect(styles).toMatch(/\.nativeAgentPaletteEmpty/);
    expect(paletteRule).not.toContain('overflow-y');
    expect(paletteRule).not.toContain('max-height');
    expect(styles).toMatch(/\.nativeAgentComposer\.dragOver/);
    expect(styles).toMatch(/\.nativeAgentComposerStatus/);
  });
});

describe('native agent theme binding', () => {
  const themeSource = () => readFileSync('src/web/arwes/theme.ts', 'utf8');

  it('never references CSS vars the theme does not emit', () => {
    const styles = stylesSource();

    // Phantom vars silently pin to their hardcoded fallback and ignore theme
    // switches (the operator's 16:10 report: chats unreadable on light themes).
    expect(styles).not.toMatch(/var\(--desk-fg[,)]/);
    expect(styles).not.toMatch(/var\(--desk-border[,)]/);
    expect(styles).not.toMatch(/var\(--desk-bg-elev[,)]/);
  });

  it('emits the semantic warn/info vars in both dark and light modes', () => {
    const theme = themeSource();

    expect(theme.match(/'--desk-warn':/g)?.length).toBe(2);
    expect(theme.match(/'--desk-info':/g)?.length).toBe(2);
  });

  it('keeps native chat role colors bound to theme vars, not literals', () => {
    const styles = stylesSource();
    const userRule = cssBlock(styles, '.nativeAgentRow.user');
    const assistantRule = cssBlock(styles, '.nativeAgentRow.assistant');

    expect(userRule).toContain('var(--desk-info)');
    expect(assistantRule).toContain('var(--desk-ok)');
    expect(cssBlock(styles, '.nativeAgentSurface')).toContain('var(--desk-text)');
  });
});

describe('native agent render memoization', () => {
  it('keeps transcript rows and markdown referentially stable across composer keystrokes', () => {
    const source = nativeSurfaceSource();

    // A fresh inline callback here defeats ChannelMarkdown's memo and forces a
    // markdown re-parse of every visible row on every parent render.
    expect(source).toMatch(/const NOOP_OPEN_FILE = \(\): undefined => undefined;/);
    expect(source).toMatch(/onOpenFile=\{NOOP_OPEN_FILE\}/);
    expect(source).not.toMatch(/onOpenFile=\{\(\) => undefined\}/);
    expect(source).toMatch(/const AgentMarkdown = memo\(function AgentMarkdown/);
    expect(source).toMatch(/const AgentFeedItemView = memo\(function AgentFeedItemView/);
    expect(source).toMatch(/const expandTurn = useCallback\(/);
    expect(source).toMatch(/onExpandTurn=\{expandTurn\}/);
  });
});
