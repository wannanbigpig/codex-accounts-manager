# Codex Accounts Manager

English · [简体中文](README.md)

VS Code extension for managing multiple Codex accounts, viewing quota usage, and switching the active global `auth.json`.

![Version](https://img.shields.io/badge/version-0.1.21-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.96.0-007acc)
![License](https://img.shields.io/github/license/wannanbigpig/codex-accounts-manager)
![Stars](https://img.shields.io/github/stars/wannanbigpig/codex-accounts-manager?style=flat)
![Last Commit](https://img.shields.io/github/last-commit/wannanbigpig/codex-accounts-manager)

---

Manage multiple Codex accounts inside VS Code, inspect quota usage, switch the active global account, and monitor key quota data from the status bar.

**Features:** multi-account quota dashboard, OAuth sign-in, account import/export and recovery, cross-window sync, five independent wakeup schedules, execution diagnostics, automatic account switching and quota warnings, background token refresh, status bar monitoring, account details, privacy mode, and multilingual UI.

**Language:** follows the current VS Code display language. Primary support is for Simplified Chinese and English, with additional localization for other languages.

**Proxy:** on startup, the extension automatically loads `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` (including lowercase variants) from `~/.codex/.env` or `CODEX_HOME/.env`. Existing process environment variables take precedence, including empty values that explicitly disable a setting. Proxy URLs support `http://` and `https://`; invalid or unsupported configurations block extension network requests instead of silently falling back to a direct connection.

---

## Preview

These screenshots show the current `0.1.21` interface with demo accounts, quotas, and execution history. The examples use Simplified Chinese; the extension also supports English and other UI languages.

![Quota dashboard with the active account, gauges, and saved account cards](https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/dashboard.jpg)

| Wakeup tasks: independent enable/pause                                                                                                                                                                        | Per-account settings: five schedules                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/wakeup-tasks.jpg" alt="Weekday, quota reset, and paused startup wakeup tasks" width="440" />               | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/wakeup-config.jpg" alt="Dedicated wakeup settings opened from an account card" width="440" />                   |
| History: replies and failure diagnostics                                                                                                                                                                      | Settings: appearance and automation                                                                                                                                                                                |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/wakeup-history.jpg" alt="Wakeup history with reply, duration, error stage, and HTTP status" width="440" /> | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/settings.jpg" alt="Current settings with theme, language, and a 1 to 60 minute refresh interval" width="440" /> |

---

## Overview

### Quota Dashboard

The extension provides a Webview dashboard for managing and monitoring all saved Codex accounts in one place:

- Current account summary with team info and quick actions
- Quota gauges for 5-hour, weekly, and code review usage
- Saved accounts list for multi-account management
- Account cards show plan, health, tags, and quota windows; flip a card for workspace, subscription, and sign-in details
- Privacy mode hides account identifiers and wakeup replies for demos and screenshots
- Quick actions for add, import, and refresh-all

### Scheduled Wakeups

Use the top-right clock to manage all tasks, or the bottom-right clock on an account card to configure that account. Each task is enabled or paused independently, without a master switch. Choose accounts, model, reasoning effort, and prompt (default: `Reply with OK.`); custom model IDs are supported. Model access depends on the selected accounts.

| Schedule      | Configuration and behavior                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily         | Run at a chosen time in the local time zone each day                                                                                                            |
| Weekly        | Choose weekdays and a time, such as 09:30 on workdays                                                                                                           |
| Interval      | 1 minute to 7 days; the first run is one interval after saving or resuming                                                                                      |
| Quota reset   | Follow refreshed reset timestamps for the short window, long window, or either; wake only accounts due at that occurrence, and wait when timestamps are missing |
| After startup | Delay `0–1440` minutes; `0` runs immediately. Saved, edited, or resumed settings apply on the next startup batch                                                |

- Edit, pause, delete, or manually test tasks. The per-account clock opens a single dedicated task directly, or a list when several exist.
- History shows model and effort, per-account duration, a short sanitized reply, failure stage / HTTP status, and post-wakeup quota refresh warnings. Privacy mode also hides replies.
- Wakeups use each account's OAuth tokens and consume a small amount of quota, then refresh it. They leave the current `auth.json` and active account unchanged. Reset schedules follow new timestamps received during manual or automatic quota refresh.
- Keep at least one VS Code window running. Occurrences missed by more than five minutes are skipped. Failed or interrupted occurrences are not replayed automatically; a definitive HTTP 401 permits one token refresh and retry. Manual tests do not change the schedule and remain available for paused tasks.
- Windows and profiles under the same OS user on the same host share tasks, with file leases and durable claims preventing duplicate dispatches. Remote hosts schedule independently. Continuously running windows share one startup batch; all windows must exit before a new batch starts. Sleep/resume does not restart the delay.
- Due tasks run independently; requests for the same account are serialized within a window. Windows missing required accounts leave the occurrence available. Update tasks after deleting accounts. Editing, pausing, or deleting a task cancels its unfinished requests.
- Tasks and the latest 100 history entries live in `~/.codex-accounts-manager/wakeup/`, without account tokens. Reload every VS Code window after upgrading. Existing tasks retain their enabled/paused state; the former master switch no longer blocks them. See the [CHANGELOG](docs/CHANGELOG.md) for upgrade details.

### Multi-Account Management

- Add a new account through OAuth
- Detect an existing local Codex `auth.json` when no account has been saved yet
- Bind the detected local account into the extension with one click
- Import the currently active local Codex `auth.json`
- Refresh quota immediately after local bind or import
- Store multiple accounts locally
- Switch the active account with one click
- Remove accounts you no longer use
- Restore from backups, `auth.json`, or shared JSON
- Export selected accounts and import them on another computer

### Cross-Window Sync

- Watch global `auth.json` changes
- Automatically sync the active account when another VS Code window switches accounts
- Prompt the current window to reload when an external account switch is detected

### ChatGPT / Codex Desktop Integration

- Detect the merged `ChatGPT.app` or legacy `Codex.app` when switching accounts
- Integration is disabled by default. When enabled, ask before restarting by default, or choose automatic restart
- Skip restart if the desktop app is installed but not currently running
- Currently supports common macOS, Windows, and Linux install/process patterns

### Using AiDeck Alongside This Extension

For fuller session management, session recovery, CLI launching, and multi-instance scheduling, see the [AiDeck uTools plugin](https://github.com/wannanbigpig/aideck).

### Automatic Switching and Quota Warnings

- Disabled by default; configure separate 5-hour and weekly thresholds from `0%` to `20%`
- Only valid quota windows participate in automation; 5-hour automation also requires enabling 5-hour quota control
- Optionally reload the VS Code window after an automatic switch, or temporarily lock an account against automatic switching
- Background token refresh is enabled by default and checks saved credentials while VS Code is running
- Sanitized network diagnostics are available in the `Codex Accounts Network` output channel

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

Inspect account email, workspace, sign-in method, subscription expiry, tags, user / account IDs, quota windows, and reset countdowns. The page also shows usage over the last 30 days; values are estimates and may update with a delay.

![Account details with profile, subscription, and quotas](https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/details.jpg)

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
  - Can be disabled, or set to any whole number from `1` to `60` minutes
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
- `Dashboard Theme`
  - Follow VS Code, or choose light / dark
- `Background Token Refresh`
  - Enabled by default; check and renew saved tokens while VS Code is running
- `Quota Colors`
  - Configure green and yellow remaining-quota thresholds
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
7. Use an account card clock to configure a dedicated wakeup task; use the top clock for all tasks and execution history

---

## Commands

Available commands in the VS Code Command Palette:

- `Codex Accounts: Add Account via OAuth`
- `Codex Accounts: Import Current auth.json`
- `Codex Accounts: Switch Account`
- `Codex Accounts: Refresh Quota`
- `Codex Accounts: Refresh All Quotas`
- `Codex Accounts: Restore Accounts from Backup`
- `Codex Accounts: Restore Accounts from auth.json`
- `Codex Accounts: Restore Accounts from Shared JSON`
- `Codex Accounts: Remove Account`
- `Codex Accounts: Open Details`
- `Codex Accounts: Open Codex Home`
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

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/wannanbigpig/codex-accounts-manager/releases/latest)
2. Open the Command Palette in VS Code
3. Run `Extensions: Install from VSIX...`
4. Select the downloaded `.vsix` file

Or install from the command line:

```bash
code --install-extension codex-accounts-manager-x.y.z.vsix
```

### Option 3: Run from Source

```bash
git clone https://github.com/wannanbigpig/codex-accounts-manager.git
cd codex-accounts-manager
npm ci
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

---

## Package VSIX

```bash
npm run package
```

This compiles the extension and creates a `.vsix`. Before packaging, the icon check verifies a PNG image no larger than `1024×1024`.

---

## Notes

- Account data is stored locally
- Switching accounts updates the machine-wide active Codex `auth.json`
- Quota is refreshed immediately after local account bind/import
- External account changes from another window are detected automatically
- Desktop integration is disabled by default; when enabled, the selected restart policy only handles an already-running app
- Free accounts label the 30-day quota window as `Monthly`; paid 7-day windows remain `Weekly`
- Quota visibility depends on the data returned by the current Codex session

---

## Support

- ⭐ [GitHub Star](https://github.com/wannanbigpig/codex-accounts-manager)
- 💬 [Report Issues](https://github.com/wannanbigpig/codex-accounts-manager/issues)

---

## 💝 Support The Project

Thanks for using `Codex Accounts Manager`.

If this project helps you, you can support its ongoing development and maintenance.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-orange?style=for-the-badge&logo=buy-me-a-coffee)](https://github.com/wannanbigpig/codex-accounts-manager/blob/master/docs/DONATE.en.md)

---

## License

This project is open-sourced under the [MIT License](LICENSE).
