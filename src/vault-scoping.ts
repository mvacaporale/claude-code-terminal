import { ClaudeTerminalSettings, PER_VAULT_KEYS, VaultScopedData } from "./types";

/**
 * Both the Talus and Lodestone vaults symlink this plugin to one folder, so
 * they share a single data.json. To stop tabs bleeding between vaults, the
 * tab/session/remote fields (PER_VAULT_KEYS) live in a per-vault slice under
 * `settings.vaultData`, keyed by the vault's base path. These helpers move
 * state between that slice and the flat working fields the rest of the plugin
 * reads. They are pure (no Obsidian dependency) so they can be unit-tested.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

/** Snapshot the flat working per-vault fields into a standalone slice. */
function snapshot(settings: ClaudeTerminalSettings): VaultScopedData {
  const slice = {} as VaultScopedData;
  const dst = slice as unknown as Record<string, unknown>;
  const src = settings as unknown as Record<string, unknown>;
  for (const key of PER_VAULT_KEYS) dst[key] = clone(src[key]);
  return slice;
}

/**
 * Copy a slice's fields into the flat working fields (cloned, to stay isolated).
 * A key missing from the slice (e.g. a field promoted to per-vault after the
 * slice was first written) is left as-is on `settings` — which holds the
 * top-level saved value or the DEFAULT_SETTINGS default — rather than being
 * clobbered with null.
 */
function apply(settings: ClaudeTerminalSettings, slice: VaultScopedData): void {
  const dst = settings as unknown as Record<string, unknown>;
  const src = slice as unknown as Record<string, unknown>;
  for (const key of PER_VAULT_KEYS) {
    if (src?.[key] !== undefined) dst[key] = clone(src[key]);
  }
}

/**
 * Load `vaultKey`'s slice into the flat working fields. On first ever run this
 * also freezes the pre-scoping shared values as `vaultSeed`. A vault with no
 * slice yet is hydrated from that frozen seed (so every vault starts from the
 * same original list) and true is returned to tell the caller to persist —
 * creating this vault's slice. Once a slice exists it always wins.
 */
export function hydrateVaultSlice(settings: ClaudeTerminalSettings, vaultKey: string): boolean {
  if (!settings.vaultData) settings.vaultData = {};
  if (!settings.vaultSeed) settings.vaultSeed = snapshot(settings);
  const slice = settings.vaultData[vaultKey];
  apply(settings, slice ?? settings.vaultSeed);
  return !slice;
}

/** Snapshot the flat working fields into `vaultKey`'s slice before persisting. */
export function syncVaultSlice(settings: ClaudeTerminalSettings, vaultKey: string): void {
  if (!settings.vaultData) settings.vaultData = {};
  settings.vaultData[vaultKey] = snapshot(settings);
}

/**
 * Shape written to data.json: globals + vaultData + vaultSeed, with the flat
 * per-vault fields dropped so they can't drift and re-pollute the shared file.
 */
export function toPersistable(settings: ClaudeTerminalSettings): Partial<ClaudeTerminalSettings> {
  const out: Partial<ClaudeTerminalSettings> = { ...settings };
  for (const key of PER_VAULT_KEYS) delete out[key];
  return out;
}

/**
 * Build the object to write to the shared data.json for a save from `vaultKey`.
 * Both vaults share one data.json and each plugin instance's `vaultData` only
 * holds the slices it loaded, so writing the whole in-memory map would drop a
 * peer vault's slice (last-writer-wins stomping). Instead: take globals from
 * memory (they're shared — last write wins is fine) but merge slices so only
 * THIS vault's slice comes from memory and every other slice is preserved from
 * `onDisk`. The immutable seed prefers whatever is already on disk.
 */
export function mergePersistable(
  settings: ClaudeTerminalSettings,
  vaultKey: string,
  onDisk: Partial<ClaudeTerminalSettings> | null
): Partial<ClaudeTerminalSettings> {
  const out = toPersistable(settings);
  out.vaultData = {
    ...(onDisk?.vaultData ?? {}),
    [vaultKey]: settings.vaultData[vaultKey],
  };
  if (onDisk?.vaultSeed) out.vaultSeed = onDisk.vaultSeed;
  return out;
}
