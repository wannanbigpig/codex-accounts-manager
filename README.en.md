# Codex Accounts Manager 

English · [简体中文](README.md)

VS Code extension for managing multiple Codex accounts, viewing quota usage, and switching the active global `auth.json`.

![Version](https://img.shields.io/badge/version-0.1.19-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.96.0-007acc)
![License](https://img.shields.io/github/license/wannanbigpig/codex-tools)
![Stars](https://img.shields.io/github/stars/wannanbigpig/codex-tools?style=flat)
![Last Commit](https://img.shields.io/github/last-commit/wannanbigpig/codex-tools)

---

Manage multiple Codex accounts inside VS Code, inspect quota usage, switch the active global account, and monitor key quota data from the status bar.

**Features:** quota dashboard, multi-account management, OAuth sign-in, first-run local account detection and binding, immediate quota refresh after import, cross-window account sync, ChatGPT/Codex desktop auto-restart, status bar monitoring, details panel, multilingual UI, and extension-level language override.

**Language:** follows the current VS Code display language. Primary support is for Simplified Chinese and English, with additional localization for other languages.

**Proxy:** on startup, the extension automatically loads `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` (including lowercase variants) from `~/.codex/.env` or `CODEX_HOME/.env`. Existing process environment variables take precedence, including empty values that explicitly disable a setting. Proxy URLs support `http://` and `https://`; invalid or unsupported configurations block extension network requests instead of silently falling back to a direct connection.

---

## Preview

| Quota Dashboard | Details Panel |
| --- | --- |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/dashboard.png" alt="Codex Tools quota dashboard" width="420" /> | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/detail.png" alt="Codex Tools details panel" width="420" /> |
| Settings Panel | Status Bar |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/setting.png" alt="Codex Tools settings panel" width="260" /> | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/status_bar.png" alt="Codex Tools status bar" width="220" /> |

---

## Overview

### Quota Dashboard

The extension provides a Webview dashboard for managing and monitoring all saved Codex accounts in one place:

- Current account summary with team info and quick actions
- Quota gauges for 5-hour, weekly, and code review usage
- Saved accounts list for multi-account management
- Account cards stretch evenly across the available width, with a minimum column width of `300px` (or one column in narrower windows); columns are added as space allows without reserving empty columns for nonexistent accounts, and cards share a content-based height with aligned footer actions and full emails on hover
- Quick actions for add, import, and refresh-all

### Scheduled Wakeups

Open the clock button at the top right of the quota dashboard to add wakeup tasks. Choose saved accounts and a daily / weekday time or a fixed interval in hours / minutes. Select a model from the dropdown or enter a custom model ID, select a reasoning effort, and use a short prompt (default: `Reply with OK.`). Tasks support editing, pausing, deleting, manual tests, and recent execution history. Scheduled execution is disabled by default; enable the master switch after configuration. Enable or pause individual tasks on their cards.

- Keep at least one VS Code window running. Occurrences missed by more than five minutes are skipped, including after shutdown or sleep.
- Fixed intervals support 1 minute to 7 days. The first run is one interval after saving or resuming the task; subsequent runs keep the scheduled cadence. Manual tests do not change it, and missed cycles are not replayed in a batch. Reload all VS Code windows after upgrading: older schedulers preserve and refuse to process the newer storage format containing interval tasks.
- Model choices include the GPT-6 and GPT-5.6 families; access depends on the selected accounts. Saved models are not replaced automatically. GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14; the editor displays a reminder. See the [official model guidance](https://learn.chatgpt.com/docs/models#gpt-55-retirement).
- Requests use each selected account's OAuth tokens and consume a small amount of quota. Quotas refresh afterward; wakeups leave the current `auth.json` and active account intact. The actual quota window is determined by the server.
- Windows and profiles under the same OS user on the same host share tasks. File leases and durable occurrence claims prevent duplicate scheduled dispatches. Failed or interrupted occurrences are not replayed automatically; a definitive HTTP 401 allows one token refresh and retry.
- Editing, pausing, or deleting a task cancels its unfinished requests. Pausing the master switch stops scheduled runs; manual tests remain available.
- Metadata lives in `~/.codex-accounts-manager/wakeup/`, without account tokens. Remote hosts schedule independently. The latest 100 history entries are retained; durable occurrence markers are kept separately.
- The request follows [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools/blob/main/src-tauri/src/modules/codex_local_access_foundation.rs). Enter a model ID available to the selected accounts.

### Multi-Account Management

- Add a new account through OAuth
- Detect an existing local Codex `auth.json` when no account has been saved yet
- Bind the detected local account into the extension with one click
- Import the currently active local Codex `auth.json`
- Refresh quota immediately after local bind or import
- Store multiple accounts locally
- Switch the active account with one click
- Remove accounts you no longer use

### Cross-Window Sync

- Watch global `auth.json` changes
- Automatically sync the active account when another VS Code window switches accounts
- Prompt the current window to reload when an external account switch is detected

### ChatGPT / Codex Desktop Integration

- Detect the merged `ChatGPT.app` or legacy `Codex.app` when switching accounts
- Automatically restart the matching desktop app if it is already running
- Skip restart if the desktop app is installed but not currently running
- Currently supports common macOS, Windows, and Linux install/process patterns

### Quota Visibility

Each account can show:

- 5-hour quota percentage
- Weekly quota percentage
- Code review quota percentage
- Reset countdown
- Last refresh time

### Status Bar Monitoring

- Show the current account quota summary, for example `Codex 5h 82% · Wk 66%`; monthly quotas use `Mo`, and compact labels stay in English
- Hide quota windows explicitly absent from the API; show `--` for unavailable or invalid percentages instead of inventing a full quota
- Hover to inspect account details, quota reset countdowns, and the last refresh time independently of automation settings
- Pin selected accounts from the dashboard into status visibility
- Click the status bar entry to open the full quota dashboard

### Multilingual UI

- Automatically follows the current VS Code display language
- Primary support for Simplified Chinese and English, with additional localization for other languages
- Dashboard copy, prompts, and interaction text switch with the editor language
- You can also force this extension to use Simplified Chinese, English, or another supported language without changing the rest of VS Code

### Details Panel

Open a per-account details panel to inspect:

- Account email
- Team / organization information
- User ID / account ID
- Raw quota payload

---

## Settings

You can change these directly from the settings button in the top-right corner of the dashboard, or from VS Code Settings by searching for `codexAccounts`.

- `Language`
  - `Auto (follow VS Code)`, `Simplified Chinese`, `English`, and other supported languages
  - Only affects Codex Accounts Manager dashboard copy and prompt text
- `ChatGPT / Codex Desktop Restart Policy`
  - Disabled by default
  - When enabled, choose:
  - `Restart automatically`: restart the matching desktop app on account switch if it is already running
  - `Ask every time`: let you confirm each restart manually
- `Automatic Quota Refresh`
  - Can be disabled, or set to `5 / 10 / 15 / 30 / 60` minutes
  - Disabled by default
  - When disabled, no timed refresh runs
- `5-hour Quota Control`
  - Disabled by default; quota display in the status bar, tooltip, and dashboard remains available regardless of this setting
  - Controls whether a valid 5-hour quota can trigger automatic switching or quota warnings
- `Automatic Account Switching`
  - Disabled by default
  - When enabled, set separate thresholds for `5-hour` and `weekly` quota
  - After refresh, the extension can switch to another saved account when the active one hits a threshold
  - The 5-hour threshold only applies while `5-hour Quota Control` is enabled; the weekly threshold remains independent
- `Codex App Launch Path`
  - Optional custom desktop app path
  - Leave empty to use auto-detection
- `Dashboard Display`
  - Choose whether to show the `Code Review` quota
- `Quota Warning`
  - Enable or disable low-quota alerts
  - Disabled by default
  - When enabled, choose a threshold from `5%` to `90%`
  - After refresh, the extension shows a localized warning when the active account drops below the configured threshold
  - Only quota windows returned by the API are checked; while 5-hour control is disabled, only the weekly quota is checked

---

## Usage

1. Install the extension
2. On first launch, if a local Codex `auth.json` already exists, the extension can bind it and refresh quota immediately
3. Run `Codex Accounts: Add Account via OAuth`
4. Or run `Codex Accounts: Import Current auth.json`
5. Run `Codex Accounts: Show Quota Summary`
6. Refresh quotas, switch accounts, inspect details, and manage status bar visibility from the dashboard

---

## Commands

Available commands in the VS Code Command Palette:

- `Codex Accounts: Add Account via OAuth`
- `Codex Accounts: Import Current auth.json`
- `Codex Accounts: Switch Account`
- `Codex Accounts: Refresh Quota`
- `Codex Accounts: Refresh All Quotas`
- `Codex Accounts: Remove Account`
- `Codex Accounts: Open Details`
- `Codex Accounts: Show Quota Summary`

---

## Installation

The extension is now available on the VS Code Marketplace, and you can still install it from a `.vsix` package or run it from source.

### Option 1: Install from the Marketplace

1. Open the Extensions view in VS Code
2. Search for `Codex Accounts Manager`
3. Find the extension published by `wannanbigpig` and click Install

You can also open the Marketplace page directly:

[Codex Accounts Manager - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wannanbigpig.codex-accounts-manager)

### Option 2: Install from VSIX

1. Download the released `.vsix` file
2. Open the Command Palette in VS Code
3. Run `Extensions: Install from VSIX...`
4. Select the downloaded `.vsix` file

Or install from the command line:

```bash
code --install-extension codex-accounts-manager-x.y.z.vsix
```

### Option 3: Run from Source

```bash
git clone https://github.com/wannanbigpig/codex-tools.git
cd codex-tools
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

---

## Package VSIX

```bash
npx @vscode/vsce package
```

---

## Notes

- Account data is stored locally
- Switching accounts updates the machine-wide active Codex `auth.json`
- Quota is refreshed immediately after local account bind/import
- External account changes from another window are detected automatically
- ChatGPT/Codex desktop restart only happens when the app is already running
- Free accounts label the 30-day quota window as `Monthly`; paid 7-day windows remain `Weekly`
- Quota visibility depends on the data returned by the current Codex session

---

## Support

- ⭐ [GitHub Star](https://github.com/wannanbigpig/codex-tools)
- 💬 [Report Issues](https://github.com/wannanbigpig/codex-tools/issues)

---

## 💝 Support The Project

Thanks for using `Codex Accounts Manager`.

If this project helps you, you can support its ongoing development and maintenance.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-orange?style=for-the-badge&logo=buy-me-a-coffee)](https://github.com/wannanbigpig/codex-tools/blob/master/docs/DONATE.en.md)

---

## License

This project is open-sourced under the [MIT License](LICENSE).
