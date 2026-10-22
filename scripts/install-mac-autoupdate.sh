#!/bin/bash
# One-time: runs mac-autoupdate.sh every 10 minutes via launchd.
# Log: ~/Library/Logs/claude-code-terminal-autoupdate.log
# Remove: launchctl bootout gui/$(id -u)/com.mvacaporale.claude-code-terminal.autoupdate
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
label=com.mvacaporale.claude-code-terminal.autoupdate
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/claude-code-terminal-autoupdate.log"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$dir/mac-autoupdate.sh</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed $label (log: $log)"
