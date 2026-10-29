# claude-code-terminal

Obsidian plugin (Michaelangelo's private copy of an upstream fork) that embeds a Claude Code terminal, plus highlights, thread saving and in-UI feedback. See README.md.

## Stack
- TypeScript, bundled by esbuild (`esbuild.config.mjs`) from `src/main.ts` to `main.js` (gitignored). node-pty + xterm.
- Pure logic lives in Obsidian-free modules with injected deps so vitest can test it (`tests/`).

## Commands
```bash
npm install --legacy-peer-deps   # plain install trips an npm peer-set bug
npm test                         # vitest
npm run build                    # tsc + production bundle
```

## Deploy
Merge to `main`. The Mac's checkout self-updates on Obsidian launch (`scripts/mac-autoupdate.sh`, README "Auto-update on the Mac").

## Feedback
- The feedback button files a GitHub issue labelled `feedback` in this repo, using a fine-grained token set in plugin settings. Screenshots live on the `feedback-screenshots` branch. Code: `src/feedback-github.ts`. Nothing goes to the vault.
- To work through it ("integrate the feedback from the obsidian claude code plugin"): list open issues labelled `feedback`, look past each ask for the underlying need, then either fix it in a PR with `Fixes #N` in the body, discuss it with Michaelangelo (offer mockups for UI ideas), or close it `not_planned` with a one-line reason.

## Conventions
- Never commit `main.js`, `data.json` or tokens.
- Keep README.md current when settings, commands or behavior change.
