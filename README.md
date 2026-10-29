---
type: note
tags: [obsidian-plugin, claude-code, terminal, ai-tools]
context:
last_edited: 2026-07-09
summary: Documentation for the Claude Code Terminal Obsidian plugin, detailing installation, features, usage, and configuration for AI coding assistance.
---

# Claude Code Terminal

An embedded terminal plugin for Obsidian that integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Anthropic's AI coding assistant.
<img width="470" height="332" alt="Screenshot 2026-02-02 at 12 12 32 AM" src="https://github.com/user-attachments/assets/af19d945-8028-476d-bba8-9ace8b482ab9" />



![Obsidian](https://img.shields.io/badge/Obsidian-1.5.0+-purple)
![Platform](https://img.shields.io/badge/Platform-Desktop%20Only-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **Floating Terminal**: Quick-access popup window
- **Sidebar Integration**: Dock to Obsidian's native right sidebar
- **Auto-launch Claude**: Optionally start Claude Code automatically when terminal opens
- **Theme Matching**: Terminal colors adapt to your Obsidian theme
- **Resizable & Draggable**: Floating window can be positioned and resized
- **Full PTY Support**: Real terminal emulation via node-pty

## Requirements

- **Obsidian** 1.5.0 or later (desktop only)
- **Claude Code CLI** installed and configured ([installation guide](https://docs.anthropic.com/en/docs/claude-code))
- **Node.js** 18+ (for building from source)
- **Build tools** for compiling native modules (Xcode Command Line Tools on macOS, build-essential on Linux, Visual Studio Build Tools on Windows)

## Installation

### From Community Plugins

1. Open Obsidian Settings > Community plugins
2. Search for **"Claude Code Terminal"**
3. Install and enable

### From Source

This plugin uses native modules that need to be compiled for your system.

```bash
cd /path/to/your/vault/.obsidian/plugins
git clone https://github.com/dternyak/claude-code-terminal.git
cd claude-code-terminal
npm install
npm run rebuild:electron
npm run build
```

Restart Obsidian and enable in Settings > Community plugins.

### Electron Version Note

The `rebuild:electron` script is configured for Electron 37.3.1 (Obsidian 1.9.x). If you're using a different Obsidian version, you may need to adjust the Electron version in package.json:

```bash
# Check Obsidian's Electron version
# In Obsidian: Open Developer Tools (Cmd+Option+I) > Console > process.versions.electron

# Update rebuild command if needed
npm run rebuild:electron -- -v YOUR_ELECTRON_VERSION
```

## Usage

### Toggle Terminal

**Easiest:** `Cmd+P` (Mac) or `Ctrl+P` (Windows/Linux) → type "Claude" → select command

Or use:
- **Hotkey**: <kbd>Cmd+Shift+`</kbd> (Mac) / <kbd>Ctrl+Shift+`</kbd> (Windows/Linux)
- **Ribbon**: Terminal icon in left sidebar

### Floating Window Controls

| Button | Action |
|--------|--------|
| + | Clear terminal |
| Panel icon | Dock to right sidebar |
| - | Hide (terminal keeps running) |
| x | Close and terminate session |

### Sidebar Mode

When docked in the right sidebar, use the "..." menu for:
- **Undock to floating window** - Return to floating mode
- **Clear terminal** - Clear the screen

## Configuration

Open Settings > Claude Terminal:

| Setting | Description | Default |
|---------|-------------|---------|
| Shell path | Path to shell executable | `/bin/zsh` (macOS/Linux) or `powershell.exe` (Windows) |
| Auto-launch Claude | Run `claude` command on terminal open | Enabled |
| Font size | Terminal font size | 13px |
| Remote host | SSH destination for remote sessions | Empty (disabled) |
| Remote working directory | Directory Claude runs in on the remote | Empty |
| Feedback repo | `owner/name` of the private repo feedback is filed into | `mvacaporale/claude-code-terminal-feedback` |
| Feedback GitHub token | Fine-grained token for that repo only | Empty (feedback off) |

## Remote Sessions

You can run Claude Code on a remote machine (e.g. an always-on server holding a synced copy of your vault) instead of locally.

**Requirements on the remote:** the `claude` CLI installed and logged in, `tmux`, and key-based SSH access (connecting must not prompt for a password). Your local shell must be POSIX-compatible (zsh/bash — fish is not supported for remote sessions). Setting up an alias in `~/.ssh/config` is the easiest way to configure the connection.

**Setup:** fill in *Remote host* (an ssh alias or `user@host`) and *Remote working directory* in the plugin settings.

**Creating a remote session:** shift+click the **+** button in the tab bar, or right-click it and choose "New session on \<host\>". Remote tabs show a small server icon.

**Lifecycle:** each remote tab runs inside a named tmux session on the remote, so:
- Closing the tab (x) only **detaches** — Claude keeps running on the remote.
- Reopening (via the history dropdown or automatic restore on Obsidian reload) **reattaches** with scrollback and in-flight work intact.
- To actually stop one, right-click the tab and choose **Kill remote session**.
- If the remote machine rebooted, reopening recreates the session with `claude --resume`, continuing the same conversation.

## Feedback

The speech-bubble button (tab bar, ribbon, or the *Send feedback* command) opens a box for a note plus up to three screenshots. Each submission becomes a GitHub issue labelled `feedback` in a **private** feedback repo you own (this plugin's repo is public, so its own issues would be public). Screenshots are committed to that repo's `feedback-screenshots` branch (created on first use). Nothing is written to the vault.

Feedback is off until a token is set, so other people running this plugin can't file into your inbox. To set it up:

1. Create a private repo for the inbox, e.g. `you/claude-code-terminal-feedback`.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to **only** that repo and the permissions *Issues: Read and write* and *Contents: Read and write*.
3. In *Settings > Claude Terminal*, set *Feedback repo* (defaults to `mvacaporale/claude-code-terminal-feedback`) and paste the token into *Feedback GitHub token*. The token is stored in the plugin's `data.json`.

If a send fails (offline, bad token), the box stays open with your text so you can retry.

## Claude Code Setup

For the best experience with Claude Code in your vault, copy the example files from the `examples/` folder:

### 1. Create a CLAUDE.md file (recommended)

Copy `examples/CLAUDE.md` to your vault root. This gives Claude Code instructions for:
- Thorough file searching (handles emoji prefixes, special characters)
- Preserving heading structure when editing
- Archiving instead of deleting files
- Understanding your vault conventions

```bash
cp examples/CLAUDE.md /path/to/your/vault/CLAUDE.md
```

### 2. Configure default permissions (recommended)

Copy `examples/settings.local.json` to `.claude/` in your vault root:

```bash
mkdir -p /path/to/your/vault/.claude
cp examples/settings.local.json /path/to/your/vault/.claude/settings.local.json
```

This grants Claude Code full access to your vault without permission prompts.

## Development

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Production build
npm run build

# Rebuild native modules
npm run rebuild:electron
```

### Auto-update on the Mac

Obsidian loads this plugin straight from the Mac's checkout, so "deploying" means that checkout
pulls `main` and rebuilds. Each time Obsidian launches or reloads, the plugin runs
`scripts/mac-autoupdate.sh` in the background (`src/self-update.ts`); when it built something new, a
notice says to reload Obsidian once more to use it. It only updates when the checkout is on `main`
with no local changes (otherwise it logs "skipping"). Log: `~/Library/Logs/claude-code-terminal-autoupdate.log`.

### Project Structure

```
claude-terminal/
├── src/
│   ├── main.ts             # Plugin entry: views, commands, settings
│   ├── feedback-modal.ts   # Feedback box (text + screenshots)
│   ├── feedback-github.ts  # Files feedback as a GitHub issue
│   └── …                   # Terminal, sessions, highlights, threads
├── tests/              # vitest unit tests (npm test)
├── manifest.json       # Obsidian plugin manifest
├── package.json        # Dependencies & scripts
├── esbuild.config.mjs  # Build configuration
├── tsconfig.json       # TypeScript config
├── styles.css          # Plugin styles
└── main.js             # Built output (generated)
```

## Troubleshooting

### "Error: Failed to start terminal"

The node-pty native module may not be compiled for your Electron version:

```bash
npm run rebuild:electron
```

### Terminal shows garbled characters

Ensure styles.css is loaded. The plugin includes required xterm.js styles.

### Claude command not found

Make sure Claude Code is installed and in your PATH:

```bash
# Check if claude is available
which claude

# If not, install it
npm install -g @anthropic-ai/claude-code
```

### Permission prompts keep appearing

Add the specific commands to your `.claude/settings.local.json` permissions array, or select "Yes, and always allow" when prompted.

## Credits

- [xterm.js](https://xtermjs.org/) - Terminal emulator
- [node-pty](https://github.com/microsoft/node-pty) - PTY bindings
- Inspired by [obsidian-terminal-sidebar](https://github.com/deltartificial/obsidian-terminal-sidebar)

## License

MIT License - see [LICENSE](LICENSE) for details.
