import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nativeSurfaceSource = () => readFileSync('src/web/agentSurface/NativeAgentSurface.tsx', 'utf8');

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
    expect(source).toMatch(/<CollapsiblePayloadRow row=\{row\} \/>/);
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
