# claude-code-terminal

Obsidian plugin (Michaelangelo's public fork; display name "Claude Obsidian Plugin", id/repo still `claude-code-terminal`) that embeds a Claude Code terminal, plus highlights, thread saving and in-UI feedback. See README.md.

## Stack
- TypeScript, bundled by esbuild (`esbuild.config.mjs`) from `src/main.ts` to `main.js` (gitignored). node-pty + xterm.
- Pure logic lives in Obsidian-free modules with injected deps so vitest can test it (`tests/`).

## Commands
```bash
npm install --legacy-peer-deps   # plain install trips an npm peer-set bug
npm test                         # vitest
npm run build                    # tsc + production bundle
npm run screenshot               # headless Obsidian on Linux -> screenshots/*.png
```
CI (`.github/workflows/ci.yml`) runs tests and the build on every PR and push to `main`.

## Deploy
Merge to `main`. The Mac's checkout self-updates on Obsidian launch (`scripts/mac-autoupdate.sh`, README "Auto-update on the Mac").

## Feedback
- The feedback button files a GitHub issue labelled `feedback` in the private repo `mvacaporale/claude-code-terminal-feedback` (this repo is public, so feedback stays out of it), using a fine-grained token set in plugin settings. Screenshots live on that repo's `feedback-screenshots` branch. Code: `src/feedback-github.ts`. Nothing goes to the vault.
- To work through it ("integrate the feedback from the obsidian claude code plugin"): list open `feedback` issues in mvacaporale/claude-code-terminal-feedback, look past each ask for the underlying need, then either fix it in a PR here with `Fixes mvacaporale/claude-code-terminal-feedback#N` in the body, discuss it with Michaelangelo (offer mockups for UI ideas), or close it `not_planned` with a one-line reason.
- New feedback is triaged automatically (hourly fixes for errors, nightly small features, threads for bigger builds) and fixes merge on green CI, so keep CI meaningful.

## Agent links
`src/agent-links.ts`: token-gated `obsidian://claude-new-tab` and `obsidian://claude-feedback` handlers plus the vault skill (`SKILL_MD`) the plugin installs on load. Change the skill text there, not in the vault.

## Conventions
- UI changes get screenshots by default: run `npm run screenshot` (add a scenario in `scripts/` when the default one doesn't show the change), look at the PNGs, and share them with Michaelangelo along with the PR. Don't commit the PNGs.
- Never commit `main.js`, `data.json` or tokens.
- Keep README.md current when settings, commands or behavior change.
