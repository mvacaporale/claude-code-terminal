# claude-code-terminal

Obsidian plugin (Michaelangelo's public fork) that embeds a Claude Code terminal, plus highlights, thread saving and in-UI feedback. See README.md.

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
- The feedback button files a GitHub issue (labels `feedback`, `claude-code-terminal`) into the private repo `mvacaporale/claude-code-terminal-feedback`, using a fine-grained token set in plugin settings. Code: `src/feedback-github.ts`. Nothing goes to the vault.
- To work through it ("integrate the feedback from the obsidian claude code plugin"): list open issues in that repo, fix or discuss each in this repo, put `Fixes mvacaporale/claude-code-terminal-feedback#N` in the PR body so merging closes it, and close drops as `not_planned` with a one-line reason. See `TRIAGE.md` in the feedback repo.

## Conventions
- Never commit `main.js`, `data.json` or tokens.
- Keep README.md current when settings, commands or behavior change.
