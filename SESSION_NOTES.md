# Claude Code Terminal - Session Notes

## Overview
Forked from [dternyak/claude-code-terminal](https://github.com/dternyak/claude-code-terminal) to [mvacaporale/claude-code-terminal](https://github.com/mvacaporale/claude-code-terminal).

Added text highlighting feature similar to Readwise/read-later apps.

## Features Added

### 1. Text Highlighting
- **Click-drag to highlight**: Select text in terminal → auto-creates persistent yellow highlight
- **Hover popup**: Shows X (delete) and copy buttons when hovering over highlight
- **Theme-aware**: Uses amber color (`#854d0e`) in dark mode, warm yellow (`#fef3c7`) in light mode
- **Popup delay**: 300ms delay before hiding popup for easier button clicking

### 2. Save Highlights to Markdown
- **Command**: "Save terminal highlights to file" in command palette
- **Save button**: In floating terminal header
- **Menu item**: In sidebar terminal's "..." menu
- **Format**: Bullet list in markdown
- **Location**: Configurable, defaults to `3. Resources/Highlights/Claude Terminal - YYYY-MM-DD.md`

### 3. Settings Added
- `highlightColor`: Background color for highlights (default: `#fef3c7`)
- `highlightSavePath`: Folder path for saved highlights (default: `3. Resources/Highlights`)

### 4. Other Improvements
- **Symlink fix**: Resolves symlinks for node-pty module loading (useful for development)
- **`claude --continue`**: Terminal now launches with `--continue` flag to resume sessions
- **Shift+Enter support**: Properly sends newline escape sequence without executing
- **Auto-scroll**: Scrolls to bottom 1.5s after session loads

## Key Files Modified

### `src/main.ts`
- Added `TerminalHighlight` interface for tracking highlights
- Added highlight rendering using xterm.js Decorations API (requires `allowProposedApi: true`)
- Added mouseup listener for auto-highlighting selections
- Added Shift+Enter key handler
- Added `saveHighlights()` method for exporting to markdown

### `styles.css`
- Added `.claude-terminal-highlight` styles
- Added `.claude-terminal-highlight-popup` and button styles

## Technical Notes

### xterm.js Decorations API
- Requires `allowProposedApi: true` in Terminal options
- Decorations are overlays on the canvas-rendered text
- Use `opacity: 0.5` (light) or `0.4` (dark) to let text show through
- `decoration.onRender()` callback for styling the DOM element

### Highlight Positioning
- `terminal.getSelectionPosition()` returns `{start: {x, y}, end: {x, y}}`
- `terminal.registerMarker(offset)` creates marker relative to cursor
- Line offset calculation: `line - (buffer.baseY + buffer.cursorY)`

### Theme Detection
```typescript
const isDark = document.body.classList.contains("theme-dark");
```

## Commits Made
1. `5694739` - Add text highlighting feature with save to markdown
2. `c13f311` - Improve highlight popup hover behavior

## Pending/Not Committed
- Dark mode highlight color fix
- `claude --continue` launch command
- Shift+Enter newline support
- Auto-scroll to bottom on load

## Potential Future Improvements
- Add highlight color picker in settings UI
- Support for highlight annotations/notes
- Export highlights with more context (surrounding lines)
- Keyboard shortcut to save highlights
- Highlight persistence across terminal restarts
- Search/filter highlights before saving

## Development Setup
```bash
cd /Users/michaelangelocaporale/Documents/Projects/claude/claude-code-terminal
npm install
npm run build
```

Plugin is symlinked to:
```
/Users/michaelangelocaporale/Documents/Resources/Lodestone/.obsidian/plugins/claude-code-terminal
```

Reload Obsidian with Cmd+R after rebuilding.
