# IDE and LSP

Desk includes a VS Code-like local editing surface built around Monaco. It is
designed to sit beside the agent fleet so the operator can inspect, edit, and
verify code without leaving the mission-control workspace.

## File explorer

The editor subsystem provides:

- root switching
- lazy folder expansion
- create, rename, move, duplicate, and delete operations
- hidden-file visibility
- drag-and-drop moves
- live filesystem updates

## Monaco editor

Files open in Monaco tabs with:

- syntax highlighting
- multi-cursor editing
- minimap support
- tab restoration
- mtime conflict protection
- content and filename search

## Language servers

Desk can run Language Server Protocol sessions for configured languages. LSP
features are exposed in the editor through Monaco integrations and can include:

- diagnostics
- completions
- hover
- go to definition and references
- document symbols
- rename
- formatting
- code actions
- semantic tokens

Advertised capabilities are gated by the active language server so the UI does
not claim unsupported operations.

## MCP surface for agents

Desk also includes an MCP server for language intelligence. Managed agents can
receive the same language-aware operations the operator sees in the editor,
which lets agents ask for diagnostics, symbols, definitions, and related code
context through a structured tool interface.

## Editor and terminal integration

The editor is connected to the rest of Desk:

- channel file links open in the editor
- git diffs open as Monaco diff tabs
- terminal selections can become notes
- repository roots can be switched from Git and GitHub surfaces
