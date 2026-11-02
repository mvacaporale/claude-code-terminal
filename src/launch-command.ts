/**
 * Build the shell command that launches Claude in a fresh local session.
 * `fork` uses `--fork-session` so the parent session's transcript stays
 * intact and the fork gets a brand-new id, letting both run in parallel tabs.
 */
export function buildLocalLaunchCommand(opts: {
  initialInput?: string;
  resume: boolean;
  fork: boolean;
  claudeSessionId: string | null;
  isFirstSession: boolean;
}): string {
  const { initialInput, resume, fork, claudeSessionId, isFirstSession } = opts;
  // A review session always wants a fresh conversation to drop the prompt into.
  if (initialInput) return "clear && claude";
  if (resume && claudeSessionId) {
    return fork
      ? `clear && claude --resume ${claudeSessionId} --fork-session`
      : `clear && claude --resume ${claudeSessionId}`;
  }
  // Resuming a tab whose conversation id was never recorded must not fall back
  // to --continue: that opens whichever conversation in the vault was most
  // recent, so every such tab reopened the same chat. Start it fresh instead.
  if (resume) return "clear && claude";
  if (isFirstSession) return "clear && claude --continue";
  return "clear && claude";
}
