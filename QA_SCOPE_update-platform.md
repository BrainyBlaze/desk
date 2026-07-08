# QA Scope: update-platform Branch

**Branch:** `update-platform`
**Date:** 2026-07-08
**Focus Areas:** Help system, agent roles, file explorer multi-select, file uploads, UI polish

---

## Features Added

### 1. Help System Across Sidebars
- **Channels Sidebar:** Help icon → Modal with Channels documentation link
- **Projects Sidebar:** Help icon → Modal with Projects documentation link  
- **Agents Sidebar:** Help icon → Modal with Agents documentation link
- **Git Sidebar:** Help icon → Modal with Git operations documentation link
- **Tooltip Behavior:** Custom portals, 150ms delay to allow hovering over tooltip content
- **No Browser Tooltip:** title attributes removed, only custom modals shown

### 2. Agent Role Assignment System
- **Backend:** Parse role/functions from YAML frontmatter in member manifests
- **API Endpoint:** `POST /api/channels/member-role` accepts `{ role, functions }`
- **UI Modal:** Click role button on member row → Edit role and functions text
- **Clear Functionality:** Red "Clear" button to remove role assignment
- **Role Display:** Pill shows role with tooltip containing functions text
- **Prompt Integration:** Role/functions injected into agent prompts

### 3. File Explorer Multi-Select
- **Shift+Click:** Select range between last clicked file and current file
- **Ctrl/Cmd+Click:** Toggle individual file selection
- **Visual Feedback:** Blue transparent background (rgba(100, 200, 255, 0.15)) on selected files
- **Context Menu:** Updates for single vs. multiple selections
- **Bulk Operations:**
  - **Duplicate:** Copies all selected files with dedupe suffix
  - **Delete:** Removes all selected files with single confirmation

### 4. File Upload to Explorer
- **Drag-Drop:** Drag files into file explorer to upload
- **Context Menu:** "Upload files" option opens file picker
- **Multiple Files:** Upload multiple files at once
- **Implementation:** Base64 encoding via JSON API → `POST /api/fs/upload`
- **LSP Integration:** Notifies language server coordinator of new files

### 5. Tab Drag-and-Drop
- **Visual Feedback:** Shows drop position indicator before/after tabs
- **Reorder Tabs:** Drag editor tab to new position in tab bar
- **Drop Indicator:** Blue line shows insertion point

---

## Bugs Fixed

### UI/UX Issues
- **Member Action Buttons Visibility:** Fixed clipping in narrow sidebars using absolute positioning + z-index
- **Terminal Cell Buttons:** Removed clip-path that was clipping buttons; use overflow: hidden instead
- **File Tree Hover:** Changed from desk-glow to blue transparent background for consistency
- **Double Tooltips:** Removed title attributes to avoid browser tooltip + custom tooltip
- **Modal Positioning:** Moved help modals inside component return statements
- **Member Role Icon:** Changed from LockKeyhole to Briefcase for clarity

### Styling
- **Text Formatting:** Line breaks in help text preserved with white-space: pre-wrap
- **Help Modal Text:** Simplified formatting for consistency
- **Tree Selection:** Blue transparent background matches multi-select styling

---

## Test Scenarios

### Help System
- [ ] Click help icon in each sidebar (Channels, Projects, Agents, Git)
- [ ] Verify modal opens with correct documentation
- [ ] Verify links open in new tab (docs.desk.cloud URLs)
- [ ] Hover over tooltip content → should not disappear
- [ ] Move cursor off tooltip → should hide after ~150ms
- [ ] No browser tooltip on hover (title attribute not visible)
- [ ] Modal closes on Escape key
- [ ] Modal closes on overlay click

### Agent Role Assignment
- [ ] Add role to channel member → role pill appears
- [ ] Edit role → modal shows current role text
- [ ] Functions text appears in pill tooltip on hover
- [ ] Clear role → pill disappears, role is removed
- [ ] Role/functions persist across tab switch and reload
- [ ] Agent prompt contains injected role and functions
- [ ] Multiple members can have different roles
- [ ] Role assignment works in different channels

### File Explorer Multi-Select
- [ ] Shift+Click on file → selects range from last clicked
- [ ] Ctrl/Cmd+Click on file → toggles individual selection
- [ ] Click without modifier → single selection (normal behavior)
- [ ] Visual highlight shows blue background on selected files
- [ ] Right-click on selected file → context menu shows multi-select options
- [ ] Right-click on unselected file → single-select context menu
- [ ] Context menu labels change (e.g., "Delete 3 files" vs "Delete")

### Multi-File Operations
- [ ] **Duplicate:**
  - Select 1 file → creates `filename-1.ext`
  - Select 3 files → creates copies with correct dedupes
  - Duplicates appear in tree immediately
  - Duplicated content matches original

- [ ] **Delete:**
  - Select 1 file → shows "Delete file?" confirmation
  - Select 3 files → shows "Delete 3 files?" confirmation
  - Cancel → files remain
  - Confirm → files removed from tree
  - Confirm → files removed from filesystem

### File Upload
- [ ] Drag single file into explorer → uploads with correct name
- [ ] Drag 3 files into explorer → all upload
- [ ] Drag into specific directory → file appears in correct location
- [ ] Upload with duplicate name → creates with suffix
- [ ] Right-click → "Upload files" → file picker opens
- [ ] Select 5 files → all upload to target directory
- [ ] Large file (10MB+) → uploads successfully
- [ ] After upload → file appears in explorer tree
- [ ] File content is correct (not corrupted)
- [ ] Upload trigger notifies LSP coordinator

### Tab Drag-and-Drop
- [ ] Drag tab left → reorders to new position
- [ ] Drag tab right → reorders to new position
- [ ] Visual indicator shows insertion point (before/after)
- [ ] Drop before first tab → moves to start
- [ ] Drop after last tab → moves to end
- [ ] Drag tab to different group → (if applicable)
- [ ] Tab content remains correct after reorder
- [ ] Unsaved indicator (dot) preserved after reorder

---

## Regression Testing

### Existing Functionality Should Still Work
- [ ] Normal file operations (create, rename, delete single file)
- [ ] File explorer tree navigation and scrolling
- [ ] Tab switching and closing
- [ ] Terminal functionality
- [ ] Git operations and history
- [ ] Channel switching and messaging
- [ ] Project creation and management
- [ ] Agent launching and interaction
- [ ] Search functionality
- [ ] Settings and preferences

### Sidebars
- [ ] All sidebars collapse/expand normally
- [ ] Sidebar width adjustment works
- [ ] Sidebar scrolling works
- [ ] Icons and text visible at all zoom levels
- [ ] Member list sorting and filtering (if exists)

### Performance
- [ ] Help modals open without lag
- [ ] Multi-select with 100+ files still responsive
- [ ] File upload doesn't freeze UI
- [ ] Tab reordering smooth (no jank)

---

## Browser/Platform Testing
- [ ] macOS + Safari
- [ ] macOS + Chrome/Edge
- [ ] Linux + Chrome/Firefox
- [ ] Windows + Edge/Chrome

---

## Edge Cases

### Multi-Select Edge Cases
- [ ] Select file A, then Shift+Click file A again → should select only A (range = 1)
- [ ] Select file A, Shift+Click file C, then Ctrl+Click file B → mixed selection
- [ ] Ctrl+Click selected file → should deselect it
- [ ] Click empty space → selection clears

### Upload Edge Cases
- [ ] Upload to directory that doesn't exist → creates parent directories
- [ ] Upload file with special characters in name → sanitized/encoded correctly
- [ ] Upload file while file tree is being edited → no conflicts
- [ ] Drag 0 bytes file → uploads successfully
- [ ] Cancel upload mid-flight → cleanup handles gracefully

### Role Assignment Edge Cases
- [ ] Role text contains newlines → preserved/displayed correctly
- [ ] Functions text is very long → tooltip still readable
- [ ] Role contains Unicode/emoji → displays correctly
- [ ] Rapid role changes → last change wins (no race conditions)

---

## Known Limitations / Deferred
- None at this time

---

## Sign-Off Checklist
- [ ] QA testing completed
- [ ] All critical scenarios passed
- [ ] No new regressions found
- [ ] Performance acceptable
- [ ] Ready for merge
