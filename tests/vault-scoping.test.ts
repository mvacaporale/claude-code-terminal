import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, ClaudeTerminalSettings } from "../src/types";
import { hydrateVaultSlice, syncVaultSlice, toPersistable, mergePersistable } from "../src/vault-scoping";

// Simulate loadData() returning the pre-scoping shared data.json: flat
// top-level per-vault fields, no vaultData yet.
function legacySettings(): ClaudeTerminalSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    persistedSessions: [{ name: "Reading" }, { name: "Mom" }],
    sessionHistory: [{ name: "Reading" }, { name: "Mom" }],
    remoteHost: "miciato",
    remoteVaultPath: "/root/claude/Lodestone",
  };
}

const TALUS = "/Users/me/Documents/Talus";
const LODE = "/Users/me/Documents/Lodestone";

describe("hydrateVaultSlice", () => {
  it("seeds a missing slice from the current top-level values (signals save)", () => {
    const s = legacySettings();
    const needsSave = hydrateVaultSlice(s, TALUS);
    expect(needsSave).toBe(true);
    // Working fields untouched (they already hold the seed); save creates slice.
    syncVaultSlice(s, TALUS);
    expect(s.vaultData[TALUS].persistedSessions).toEqual([{ name: "Reading" }, { name: "Mom" }]);
    expect(s.vaultData[TALUS].remoteVaultPath).toBe("/root/claude/Lodestone");
  });

  it("hydrates the flat working fields from an existing slice (no save)", () => {
    const s = legacySettings();
    s.vaultData = {
      [TALUS]: {
        persistedSessions: [{ name: "Taxes" }],
        sessionHistory: [{ name: "Taxes" }],
        remoteHost: "",
        remoteVaultPath: "",
      },
    };
    const needsSave = hydrateVaultSlice(s, TALUS);
    expect(needsSave).toBe(false);
    expect(s.persistedSessions).toEqual([{ name: "Taxes" }]);
    expect(s.remoteVaultPath).toBe("");
  });

  it("tolerates missing vaultData (older data.json)", () => {
    const s = legacySettings();
    delete (s as unknown as Record<string, unknown>).vaultData;
    expect(hydrateVaultSlice(s, TALUS)).toBe(true);
    expect(s.vaultData).toEqual({});
  });
});

describe("two vaults diverge independently", () => {
  it("each seeds from the shared list, then edits stay isolated", () => {
    // Both vaults open against the same shared settings object's on-disk shape.
    // Talus opens first, seeds + saves.
    const s = legacySettings();
    hydrateVaultSlice(s, TALUS);
    syncVaultSlice(s, TALUS);

    // Talus edits its tabs and saves.
    s.persistedSessions = [{ name: "Switchyards" }];
    syncVaultSlice(s, TALUS);

    // Lodestone opens: its slice is missing, so it seeds from the still-present
    // top-level values (the original shared list), not from Talus's edits.
    hydrateVaultSlice(s, LODE);
    expect(s.persistedSessions).toEqual([{ name: "Reading" }, { name: "Mom" }]);
    syncVaultSlice(s, LODE);

    // Lodestone edits and saves.
    s.persistedSessions = [{ name: "Fabric" }];
    syncVaultSlice(s, LODE);

    // Slices are independent.
    expect(s.vaultData[TALUS].persistedSessions).toEqual([{ name: "Switchyards" }]);
    expect(s.vaultData[LODE].persistedSessions).toEqual([{ name: "Fabric" }]);

    // Reopening Talus restores only Talus's tabs.
    hydrateVaultSlice(s, TALUS);
    expect(s.persistedSessions).toEqual([{ name: "Switchyards" }]);

    // The frozen seed never drifts, despite both vaults' edits.
    expect(s.vaultSeed?.persistedSessions).toEqual([{ name: "Reading" }, { name: "Mom" }]);
  });
});

describe("highlightSavePath is per-vault", () => {
  it("each vault keeps its own highlight folder", () => {
    const s = legacySettings();

    // Talus seeds, then sets its own highlight folder.
    hydrateVaultSlice(s, TALUS);
    s.highlightSavePath = "highlights";
    syncVaultSlice(s, TALUS);

    // Lodestone seeds independently and keeps the classic path.
    hydrateVaultSlice(s, LODE);
    s.highlightSavePath = "3. Resources/Highlights";
    syncVaultSlice(s, LODE);

    expect(s.vaultData[TALUS].highlightSavePath).toBe("highlights");
    expect(s.vaultData[LODE].highlightSavePath).toBe("3. Resources/Highlights");

    // Reopening Talus restores only Talus's folder.
    hydrateVaultSlice(s, TALUS);
    expect(s.highlightSavePath).toBe("highlights");
  });

  it("a slice written before the field was per-vault falls back, not null", () => {
    const s = legacySettings();
    s.highlightSavePath = "3. Resources/Highlights"; // top-level saved value
    // Legacy slice lacks highlightSavePath (field promoted after it was written).
    s.vaultData = {
      [TALUS]: {
        persistedSessions: [{ name: "Taxes" }],
        sessionHistory: [{ name: "Taxes" }],
        remoteHost: "",
        remoteVaultPath: "",
      } as unknown as (typeof s.vaultData)[string],
    };
    hydrateVaultSlice(s, TALUS);
    // Kept the existing value instead of being clobbered with null.
    expect(s.highlightSavePath).toBe("3. Resources/Highlights");
  });
});

describe("mergePersistable", () => {
  it("a save from one vault preserves the other vault's on-disk slice", () => {
    // Talus is running; it only ever loaded its own slice into memory.
    const s = legacySettings();
    hydrateVaultSlice(s, TALUS);
    s.highlightSavePath = "highlights";
    syncVaultSlice(s, TALUS);
    expect(Object.keys(s.vaultData)).toEqual([TALUS]); // no Lodestone in memory

    // Disk already has Lodestone's slice (saved by the other vault).
    const onDisk = {
      vaultData: {
        [LODE]: {
          persistedSessions: [{ name: "Fabric" }],
          sessionHistory: [],
          remoteHost: "",
          remoteVaultPath: "",
          highlightSavePath: "3. Resources/Highlights",
        },
      },
    } as unknown as Partial<typeof s>;

    const out = mergePersistable(s, TALUS, onDisk) as any;
    // Both slices survive; each keeps its own highlight folder.
    expect(out.vaultData[LODE].highlightSavePath).toBe("3. Resources/Highlights");
    expect(out.vaultData[TALUS].highlightSavePath).toBe("highlights");
  });

  it("tolerates an empty/first-run disk", () => {
    const s = legacySettings();
    hydrateVaultSlice(s, TALUS);
    syncVaultSlice(s, TALUS);
    const out = mergePersistable(s, TALUS, null) as any;
    expect(out.vaultData[TALUS]).toBeDefined();
    expect(out.vaultSeed).toBeDefined();
  });
});

describe("toPersistable", () => {
  it("drops the flat per-vault fields but keeps vaultData and vaultSeed", () => {
    const s = legacySettings();
    hydrateVaultSlice(s, TALUS);
    syncVaultSlice(s, TALUS);
    const out = toPersistable(s) as Record<string, unknown>;
    expect("persistedSessions" in out).toBe(false);
    expect("sessionHistory" in out).toBe(false);
    expect("remoteHost" in out).toBe(false);
    expect("remoteVaultPath" in out).toBe(false);
    expect(out.vaultData).toBeDefined();
    expect(out.vaultSeed).toBeDefined();
    expect(out.shellPath).toBe(s.shellPath); // globals survive
  });
});
