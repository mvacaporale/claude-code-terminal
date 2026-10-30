#!/usr/bin/env node
// Screenshot the plugin running in a real Obsidian, headless (Linux + Xvfb).
//
//   npm run screenshot -- [--out DIR] [--scenario FILE]
//
// Downloads the Obsidian AppImage once (cached in ~/.cache/obsidian-screenshot),
// builds the plugin and node-pty, opens a throwaway vault with the plugin
// enabled and a stub `claude` on PATH, then drives the UI over the Chrome
// DevTools protocol with Playwright. The default scenario (scripts/screenshot-
// scenario.mjs) shows one tab, two tabs, and two tabs side by side; pass
// --scenario to shoot something else. Needs: curl, Xvfb, playwright, a C++
// toolchain (for node-pty).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1]) : fallback;
};
const outDir = opt("--out", path.join(repo, "screenshots"));
const scenarioFile = opt("--scenario", path.join(repo, "scripts", "screenshot-scenario.mjs"));
const PORT = 9333;
const PLUGIN_ID = JSON.parse(fs.readFileSync(path.join(repo, "manifest.json"), "utf8")).id;
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Obsidian, cached between runs.
const cache = path.join(os.homedir(), ".cache", "obsidian-screenshot");
const appDir = path.join(cache, "squashfs-root");
if (!fs.existsSync(path.join(appDir, "obsidian"))) {
  fs.mkdirSync(cache, { recursive: true });
  const releases = JSON.parse(
    execFileSync("curl", ["-fsSL", "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json"]),
  );
  const v = releases.latestVersion;
  const image = path.join(cache, "Obsidian.AppImage");
  console.log(`Downloading Obsidian ${v}…`);
  run("curl", ["-fsSL", "-o", image, `https://github.com/obsidianmd/obsidian-releases/releases/download/v${v}/Obsidian-${v}.AppImage`]);
  fs.chmodSync(image, 0o755);
  run(image, ["--appimage-extract"], { cwd: cache, stdio: "ignore" });
}

// 2. Build the plugin, and node-pty. node-pty uses N-API, so building it
// against this Node's headers loads fine in Obsidian's Electron (no need for
// the Electron headers, which the cloud proxy blocks).
run("npm", ["run", "build"], { cwd: repo });
const ptyDir = path.join(repo, "node_modules", "node-pty");
if (!fs.existsSync(path.join(ptyDir, "build", "Release", "pty.node"))) {
  run("npx", ["node-gyp", "rebuild", `--nodedir=${path.resolve(process.execPath, "..", "..")}`], { cwd: ptyDir });
}

// 3. Throwaway vault and Obsidian config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-shot-"));
const vault = path.join(tmp, "Test Vault");
const pluginDir = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);
fs.mkdirSync(path.join(pluginDir, "node_modules"), { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(repo, f), path.join(pluginDir, f));
fs.symlinkSync(ptyDir, path.join(pluginDir, "node_modules", "node-pty"));
fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([PLUGIN_ID]));
fs.writeFileSync(path.join(vault, "Welcome.md"), "# Test vault\n\nA throwaway vault for plugin screenshots.\n");
fs.writeFileSync(
  path.join(pluginDir, "data.json"),
  JSON.stringify({ shellPath: "/bin/bash", restoreSessionsOnStartup: false }),
);
// A stand-in for the Claude CLI so tabs show something stable.
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!/bin/bash
printf '\\e[38;5;173m✻\\e[0m Welcome to \\e[1mClaude Code\\e[0m  \\e[2m(screenshot stub)\\e[0m\\n\\n'
printf '  \\e[2mcwd: %s\\e[0m\\n\\n' "$PWD"
printf '\\e[2m────────────────────────────────────────\\e[0m\\n> '
exec cat >/dev/null
`,
  { mode: 0o755 },
);
const config = path.join(tmp, "config");
fs.mkdirSync(path.join(config, "obsidian"), { recursive: true });
fs.writeFileSync(
  path.join(config, "obsidian", "obsidian.json"),
  JSON.stringify({ vaults: { shotvault0000001: { path: vault, ts: Date.now(), open: true } } }),
);

// 4. Launch under Xvfb.
let xvfb;
const env = { ...process.env, XDG_CONFIG_HOME: config, PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/bash" };
if (!process.env.DISPLAY) {
  xvfb = spawn("Xvfb", [":99", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore" });
  env.DISPLAY = ":99";
  await sleep(500);
}
const obsidian = spawn(
  path.join(appDir, "obsidian"),
  ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--window-size=1600,1000"],
  { env, stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
obsidian.stderr.on("data", (d) => (stderr += d));
const cleanup = async () => {
  // Obsidian keeps writing its config while it shuts down, so wait for it.
  const exited = new Promise((r) => obsidian.once("exit", r));
  obsidian.kill();
  await Promise.race([exited, sleep(5000)]);
  xvfb?.kill();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
};

try {
  const { chromium } = require("playwright");
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => sleep(500));
  }
  if (!browser) throw new Error(`Obsidian didn't open a debug port.\n${stderr}`);
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await sleep(500);
  }
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 30000 });
  // First open of a vault with plugins asks whether to trust it.
  const trust = page.getByRole("button", { name: /trust author and enable plugins/i });
  if (await trust.isVisible({ timeout: 3000 }).catch(() => false)) {
    await trust.click();
    await page.keyboard.press("Escape");
  }
  await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, { timeout: 15000 });
  await page.setViewportSize({ width: 1400, height: 900 });
  // Startup notices and hover tooltips would cover parts of the shots.
  await page.addStyleTag({ content: ".notice-container, .tooltip { display: none !important; }" });
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [];
  const shot = async (name, locator = page) => {
    const file = path.join(outDir, `${name}.png`);
    await sleep(800);
    await page.mouse.move(1, 899); // no hover tooltips
    await locator.screenshot({ path: file });
    shots.push(file);
  };
  const { default: scenario } = await import(pathToFileURL(scenarioFile).href);
  await scenario({ page, shot, sleep, pluginId: PLUGIN_ID });
  console.log(shots.join("\n"));
  await browser.close().catch(() => {});
} finally {
  await cleanup();
}
