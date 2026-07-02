---
title: "Keyboard shortcuts"
description: "The full keyboard map: session switching, terminals, channels, and the editor"
---

Desk is keyboard-reachable across its subsystems. Shortcuts are scoped to the
active subsystem unless noted.

## Agents

| Keys | Action |
| --- | --- |
| `Ctrl+K` | Session quick-switcher (attention first, then recents, then tree order) |
| `Ctrl+Shift+K` | Quick-switcher from inside a focused terminal |
| `Ctrl+Alt+1..9` | Focus terminal cell N in the active group |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Previous / next session across the whole tree |
| `Escape` | Clear the sidebar filter; close menus and modals |

## Terminals

| Keys | Action |
| --- | --- |
| `Ctrl/Cmd+C` | Copy selection |
| `Ctrl/Cmd+V` | Paste |
| `Ctrl/Cmd+F` | Find in terminal |
| `Ctrl+Alt+C` | Copy the entire terminal buffer |
| `Escape` | Exit the scrollback viewer |
| Right-click on selection | Copy / Create note menu |

## Channels

| Keys | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Channels command palette (switch channel, open views, jump) |
| `j` / `k` | Move the message cursor down / up |
| `s` | Star / unstar the message under the cursor |
| `t` | Open the message's thread |
| `/` | Focus the filter |
| `g` then `u` | Jump to the first unread message |
| `Enter` | Send message (`Shift+Enter` for a newline) |
| `Ctrl/Cmd+Enter` | Save when editing a message |
| `Escape` | Close thread pane, palette, or menu (abandons typing first) |

## Editor and notes

| Keys | Action |
| --- | --- |
| `Ctrl+P` | Quick-open files (fuzzy, recents first) |
| `Ctrl+S` | Save the active file |
| `Escape` | Close pickers and dialogs |

Standard Monaco editing chords (multi-cursor, find/replace, etc.) work as in
VS Code.

## Everywhere

| Keys | Action |
| --- | --- |
| `Escape` | Close the topmost modal, menu, drawer, or overlay |

Rail buttons: a single click switches subsystems; clicking the active
subsystem's button (or double-clicking any) toggles its sidebar.
