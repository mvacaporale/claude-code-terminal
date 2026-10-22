#!/bin/bash
# Keeps the Mac's live plugin checkout on the latest main, so merging a PR from
# anywhere "deploys" it. Run by launchd (see scripts/install-mac-autoupdate.sh).
# Skips quietly unless the checkout is on main, has no local changes, and can fast-forward.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

[ "$(git branch --show-current)" = main ] || exit 0
[ -z "$(git status --porcelain)" ] || { echo "$(date '+%F %T') local changes; skipping"; exit 0; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || exit 0

before=$(git rev-parse HEAD)
git merge -q --ff-only origin/main
if ! git diff --quiet "$before" HEAD -- package.json; then
  npm install
  npm run rebuild:electron
fi
npm run build
echo "$(date '+%F %T') updated to $(git rev-parse --short HEAD); reload the plugin in Obsidian"
