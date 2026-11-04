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
  /** False when the saved session's transcript is gone, so `--resume` would just fail. */
  hasTranscript?: boolean;
}): string {
  const { initialInput, resume, fork, isFirstSession, hasTranscript = true } = opts;
  // A tab can hold an id whose transcript was never written (Claude only saves
  // one after the first message), and `claude --resume` then exits with "No
  // conversation found". Treat that like having no id.
  const claudeSessionId = hasTranscript ? opts.claudeSessionId : null;
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
