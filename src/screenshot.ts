/**
 * Capture the current Obsidian window as PNG bytes via Electron's remote
 * webContents. Desktop-only; throws with a friendly message if the capture
 * API isn't reachable (older/newer Electron without @electron/remote exposed),
 * so callers can fall back to text-only feedback.
 */
interface CapturableImage {
  toPNG(): Uint8Array;
}
interface CapturableWindow {
  capturePage(): Promise<CapturableImage>;
}
interface ElectronRemote {
  getCurrentWindow?(): CapturableWindow;
  getCurrentWebContents?(): CapturableWindow;
}

export async function captureObsidianWindowPng(): Promise<Uint8Array> {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  const electron = req?.("electron") as { remote?: ElectronRemote } | undefined;
  const remote = electron?.remote;
  const target = remote?.getCurrentWindow?.() ?? remote?.getCurrentWebContents?.();
  if (!target?.capturePage) {
    throw new Error("Screenshots aren't available in this Obsidian build.");
  }
  const image = await target.capturePage();
  return image.toPNG();
}
