import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeTerminalPlugin from "./main";

export class ClaudeTerminalSettingTab extends PluginSettingTab {
  plugin: ClaudeTerminalPlugin;

  constructor(app: App, plugin: ClaudeTerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Shell path")
      .setDesc("Path to the shell executable")
      .addText((text) =>
        text.setPlaceholder("/bin/zsh")
          .setValue(this.plugin.settings.shellPath)
          .onChange(async (value) => {
            this.plugin.settings.shellPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-launch claude")
      .setDesc("Automatically run 'claude' command when terminal opens")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoLaunchClaude).onChange(async (value) => {
          this.plugin.settings.autoLaunchClaude = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addSlider((slider) =>
        slider.setLimits(10, 24, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Centered view")
      .setDesc("Constrain the docked terminal to a centered readable column (toggle via command: 'Toggle centered terminal view')")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.centeredView).onChange(async (value) => {
          this.plugin.settings.centeredView = value;
          await this.plugin.saveSettings();
          this.plugin.applyCenteredClassToAllViews();
        })
      );

    containerEl.createEl("h3", { text: "Highlights" });

    new Setting(containerEl)
      .setName("Enable text highlighting")
      .setDesc("Auto-highlight selected text and show the save-to-markdown popup. You can also toggle this from the highlighter button in the tab bar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.highlightingEnabled).onChange(async (value) => {
          this.plugin.settings.highlightingEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllTabBars();
        })
      );

    new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("Color for text highlights, drawn semi-transparent over the terminal text. Applies to new highlights.")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.highlightColor)
          .onChange(async (value) => {
            this.plugin.settings.highlightColor = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight save path")
      .setDesc("Folder path in vault where highlights are saved")
      .addText((text) =>
        text.setPlaceholder("3. Resources/Highlights")
          .setValue(this.plugin.settings.highlightSavePath)
          .onChange(async (value) => {
            this.plugin.settings.highlightSavePath = value || "3. Resources/Highlights";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Sessions" });

    new Setting(containerEl)
      .setName("Restore sessions on startup")
      .setDesc("Recreate your previous tabs (names and Claude session IDs) when Obsidian reloads. Shells are spawned fresh — scrollback is not restored.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.restoreSessionsOnStartup).onChange(async (value) => {
          this.plugin.settings.restoreSessionsOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Clean copy")
      .setDesc("Strip trailing whitespace from each line and collapse runs of blank lines when copying from the terminal.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cleanCopy).onChange(async (value) => {
          this.plugin.settings.cleanCopy = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Clear session history")
      .setDesc(`${this.plugin.settings.sessionHistory.length} saved session names`)
      .addButton((btn) =>
        btn.setButtonText("Clear history").onClick(async () => {
          this.plugin.settings.sessionHistory = [];
          await this.plugin.saveSettings();
          this.display();
          new Notice("Session history cleared");
        })
      );
  }
}
