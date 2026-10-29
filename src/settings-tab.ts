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
        text.setPlaceholder("highlights")
          .setValue(this.plugin.settings.highlightSavePath)
          .onChange(async (value) => {
            this.plugin.settings.highlightSavePath = value || "highlights";
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
      .setName("Feedback repo")
      .setDesc("owner/name of the private GitHub repo that the feedback button files issues into (label: feedback). Screenshots are committed to its feedback-screenshots branch.")
      .addText((text) =>
        text.setPlaceholder("you/claude-code-terminal-feedback")
          .setValue(this.plugin.settings.feedbackRepo)
          .onChange(async (value) => {
            this.plugin.settings.feedbackRepo = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Feedback GitHub token")
      .setDesc("Fine-grained personal access token limited to the feedback repo, with Issues and Contents set to read and write. Stored in this plugin's data.json. Leave empty to turn feedback off.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("github_pat_…")
          .setValue(this.plugin.settings.feedbackToken)
          .onChange(async (value) => {
            this.plugin.settings.feedbackToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Remote sessions" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Run Claude Code on a remote machine over SSH inside a tmux session (shift+click the + button, or right-click it to choose). Remote sessions keep running when you close their tab — closing detaches, and reopening reattaches with scrollback intact. Requires key-based SSH access plus the claude CLI (logged in) and tmux on the remote.",
    });

    new Setting(containerEl)
      .setName("Remote host")
      .setDesc("SSH destination: an alias from your ~/.ssh/config or user@host. Must connect without a password prompt.")
      .addText((text) =>
        text.setPlaceholder("user@host or ssh alias")
          .setValue(this.plugin.settings.remoteHost)
          .onChange(async (value) => {
            this.plugin.settings.remoteHost = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote working directory")
      .setDesc("Absolute path on the remote where Claude runs — e.g. a synced copy of this vault.")
      .addText((text) =>
        text.setPlaceholder("/path/to/vault-on-remote")
          .setValue(this.plugin.settings.remoteVaultPath)
          .onChange(async (value) => {
            this.plugin.settings.remoteVaultPath = value.trim();
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
