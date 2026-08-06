# TODO — Session Groups (save threads to a note)

Feature is built, unit-tested (32 tests), and validated live end-to-end (save → archive → render →
Continue+reveal → rehydrate-after-purge → Read). Merged to `main` with these follow-ups outstanding.
See `HANDOFF-test-automation.md` for the test-automation plan.

## Should-do (untested code paths — each ~quick to exercise in a throwaway vault)
- [ ] **Explicit `tabs=` subset** — only the "save all open tabs" path was run live; the name-filter path is unrun.
- [ ] **Note in a subfolder** — `ensureNote` folder auto-creation never fired (saved to a root note).
- [ ] **Second group in one note (model B)** — upsert is unit-tested, but only one group was written live.
- [ ] **Session not yet detected (`session: null`)** — handled in code, not observed live.
- [ ] **Reopen into the floating window** — only the docked-view reveal path was tested.

## Usability
- [ ] **Agent-command doc** — document `open "obsidian://claude-threads-save?note=&group=&tabs="` where the
      in-terminal agent sees it (small skill or a line in the vault `CLAUDE.md`) so you can just say
      "save these threads to my X note." Receipt at `.claude/threads/.last-save.json` confirms the result.

## Cleanup before shipping to the live plugin
- [ ] Remove the pre-existing debug `new Notice("Claude Terminal: debug build hl-diag-5 loaded")` +
      debug log in `main.ts` `onload` (inherited from `main`, not this feature — but it ships on any build).

## Optional / deferred
- [ ] **Tier 1 jsdom renderer tests** (see `HANDOFF-test-automation.md`).
- [ ] **Slice 6** — minimal tab-bar Groups dropdown (`settings.sessionGroups`); note is the real home.
- [ ] **Remote (miciato) thread archival** — remote threads are recorded + reopenable but their transcripts
      (on the remote host) are not yet copied.

## Deploy
- [ ] Build production `main.js` into the live plugin (currently the `review-console` worktree), or fold
      `main` into whatever branch is deployed.
