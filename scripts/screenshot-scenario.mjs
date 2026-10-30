// Default scenario for scripts/screenshot.mjs: open the terminal, add a second
// tab, then show both side by side. Copy this file and pass it with
// --scenario to shoot a different change.
export default async function ({ page, shot, sleep }) {
  const command = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id);

  await command("claude-code-terminal:open-claude-terminal-center");
  await page.locator(".claude-terminal-tab").first().waitFor();
  await sleep(1500);
  await shot("1-one-tab");

  await command("claude-code-terminal:new-terminal-session");
  await sleep(1500);
  await shot("2-two-tabs");

  await page.locator('.claude-terminal-tab-action[aria-label="Side by side"]').click();
  await sleep(1500);
  await shot("3-side-by-side");

  // The right-click menu on a tab.
  await page.locator(".claude-terminal-tab").first().click({ button: "right" });
  await shot("4-tab-menu");
  await page.keyboard.press("Escape");
}
