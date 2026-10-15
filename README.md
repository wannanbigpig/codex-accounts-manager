# Codex Accounts Manager

[English](README.en.md) · 简体中文

VS Code 扩展，用于管理多个 Codex 账号、查看配额总览，并快速切换当前生效的全局 `auth.json`。

![Version](https://img.shields.io/badge/version-0.1.21-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.96.0-007acc)
![License](https://img.shields.io/github/license/wannanbigpig/codex-accounts-manager)
![Stars](https://img.shields.io/github/stars/wannanbigpig/codex-accounts-manager?style=flat)
![Last Commit](https://img.shields.io/github/last-commit/wannanbigpig/codex-accounts-manager)

---

用于在 VS Code 中统一管理 Codex 多账号、查看配额、切换当前账号，并通过状态栏快速监控使用情况。

**功能：** 多账号与配额总览、OAuth 登录、账号导入导出与恢复、跨窗口同步、五种独立唤醒调度、执行诊断、自动切号与低配额提醒、后台 token 续期、状态栏监控、详情面板、隐私模式和多语言界面。

**语言：** 默认跟随 VS Code 语言设置，当前主要支持简体中文、English，并提供其他语言的本地化支持。

**扩展能力：** 如果你需要更完整的会话管理、CLI 启动、多实例调度等 AI 开发工作台能力，可以安装 uTools 插件 **AiDeck**。AiDeck 项目地址：[https://github.com/wannanbigpig/aideck](https://github.com/wannanbigpig/aideck)。

---

## 界面预览

以下截图来自当前 `0.1.21` 界面，使用虚构账号、配额与执行记录。

![配额总览：当前账号、配额仪表和账号卡片](https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/dashboard.jpg)

| 唤醒任务：每个任务独立启停                                                                                                                                                                       | 单账号配置：五种调度方式                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/wakeup-tasks.jpg" alt="唤醒任务列表，包含工作日、配额重置与已暂停的启动后任务" width="440" /> | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/wakeup-config.jpg" alt="从账号卡片进入的独立唤醒配置" width="440" />                       |
| 执行历史：回复摘要与失败诊断                                                                                                                                                                     | 设置：主题、语言和自动化                                                                                                                                                                      |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/wakeup-history.jpg" alt="唤醒历史中的成功回复、耗时、失败阶段及 HTTP 状态" width="440" />     | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/settings.jpg" alt="当前设置面板，支持主题、语言及任意 1 至 60 分钟刷新间隔" width="440" /> |

---

## 功能概览

### 配额总览面板

提供一个 Webview 仪表盘，用来集中查看和管理所有 Codex 账号：

- 当前账号摘要：显示当前账号、当前团队与快捷操作
- 配额仪表：展示 5 小时、每周、代码审查配额
- 已保存账号列表：集中查看所有已保存账号
- 账号卡片展示套餐、账号状态、标签与各配额窗口；支持翻面查看工作空间、订阅和登录信息
- 隐私模式可隐藏账号标识与唤醒回复，便于演示或截图
- 快捷操作：添加账号、导入当前账号、刷新全部配额
- 支持从卡片进入账号详情、切换账号、刷新、重新授权、重连会话、编辑标签、分享/导入恢复

### 定时唤醒

通过总览右上角的时钟管理全部任务，或点击账号卡片右下角的时钟配置单个账号。每个任务独立启用或停用，无需总开关；支持多个账号、模型选择、自定义模型 ID、推理强度和提示词（默认 `Reply with OK.`）。模型是否可用以所选账号权限为准。

| 调度方式 | 配置与执行规则                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------ |
| 每日     | 每天按本机时区，在指定时间执行                                                                   |
| 每周     | 选择星期与时间，例如每个工作日 09:30                                                             |
| 间隔     | 支持 1 分钟至 7 天；保存或恢复后等待一个间隔再首次执行                                           |
| 配额重置 | 选择短周期、长周期或任一窗口；根据已刷新的实际重置时间调整，只唤醒该次到点的账号，缺少时间时等待 |
| 启动后   | 延迟 `0–1440` 分钟，`0` 表示立即执行；保存、编辑或恢复后在下一批启动时生效                       |

- 任务支持编辑、暂停、删除和立即测试。已有一条独立任务时，账号卡片入口直接打开编辑；多条时先选择任务。
- 执行历史展示模型与推理强度、各账号耗时、脱敏后的简短回复、失败阶段 / HTTP 状态，以及执行后的配额刷新异常；隐私模式同时隐藏回复。
- 唤醒使用所选账号的 OAuth 令牌，会消耗少量额度，结束后刷新配额；不修改当前 `auth.json`，也不切换当前账号。配额重置时间会随手动或自动刷新得到的新数据更新。
- 至少保持一个 VS Code 窗口运行。超过 5 分钟的错过任务会跳过；失败或已中断的执行不自动补发，明确返回 HTTP 401 时可刷新令牌后重试一次。立即测试不改变定时周期，暂停的任务也可手动测试。
- 同一主机、同一系统用户的窗口与配置文件共享任务，并通过文件锁和持久化执行标记去重；不同远程主机分别调度。连续运行的窗口共享一次启动触发，全部窗口退出后才开始新的启动批次，休眠恢复不重新计时。
- 到点任务独立调度，同一窗口内同账号请求串行。缺少当次所需账号的窗口让出执行机会；删除账号后请更新关联任务。暂停、编辑或删除任务会取消该任务未完成的请求。
- 任务和最近 100 条历史存于 `~/.codex-accounts-manager/wakeup/`，其中不存储账号令牌。升级后请重载所有 VS Code 窗口；旧任务保留各自的启用/停用状态，原总开关不再限制执行。完整升级说明见 [CHANGELOG](docs/CHANGELOG.md)。

### 多账号管理

- 通过 OAuth 添加新账号
- 无已绑定账号时自动检测本机已有的 Codex `auth.json`
- 检测到本地账号后可一键绑定到扩展
- 导入当前本机正在使用的 Codex `auth.json`
- 导入或绑定后立即刷新最新配额
- 本地保存多个账号
- 一键切换当前生效账号
- 删除不再使用的账号
- 从备份恢复全部账号
- 从 `auth.json` 恢复账号记录
- 从共享 JSON 恢复/导入账号并保留覆盖提示

### 跨窗口同步

- 监听全局 `auth.json` 变化
- 其他 VS Code 窗口切换账号后，当前窗口会自动同步激活账号状态
- 检测到外部账号切换时，会提示是否重载当前窗口以同步内置 Codex 会话

### ChatGPT / Codex 桌面应用联动

- 切换账号后可检测新版 `ChatGPT.app` 或旧版 `Codex.app`
- 联动默认关闭；开启后默认手动确认重启，也可改为自动重启。仅处理已运行的桌面应用，未运行则跳过
- 支持“自动重启”与“手动确认重启”两种策略
- 允许配置自定义桌面应用路径
- 当前已兼容 macOS、Windows、Linux 的常见安装路径与进程检测

### 与 AiDeck 搭配使用

本扩展专注于 VS Code 内的 Codex 多账号管理、配额查看与快速切换。如果你需要更完整的会话管理、会话恢复、Codex 等 CLI 启动与多实例调度能力，可以安装 uTools 插件 **AiDeck**。

AiDeck 提供面向 Antigravity、Codex 等环境的统一调度层，适合需要在多个账号、多个实例和不同 AI 开发入口之间切换的场景。

项目地址：[https://github.com/wannanbigpig/aideck](https://github.com/wannanbigpig/aideck)

### 自动切号与低配额提醒

- `5 小时配额控制` 默认关闭；仅决定 5 小时配额是否参与自动切号或低配额提醒，不影响状态栏、悬停提示和 Dashboard 的额度显示
- 只有接口返回有效配额窗口时才会参与自动化判断，避免缺失窗口被误判为 `0%`
- `刷新后`按配置自动切换到可用备用账号
- 可分别设置 5 小时与每周阈值（0~20%，默认 20%）
- 可设置临时锁定时长，避免刚触发后被频繁切号
- 配置低配额告警，触发后显示本地化提示

### 后台令牌刷新与网络调试

- 支持后台自动刷新已保存账号的 token（默认开启）
- 可查看上次检测、上次刷新、下次检测时间
- 可选开启 `Codex Accounts Network` 调试日志
- 扩展启动时自动读取 `~/.codex/.env`（或 `CODEX_HOME/.env`）中的 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 和 `NO_PROXY`（兼容小写变量），并用于配额、OAuth、订阅等网络请求；进程已有的代理变量优先，空值可显式关闭对应配置
- 代理 URL 支持 `http://` 和 `https://`；配置无效或使用不支持的协议时会阻止扩展网络请求并明确提示，不会静默回退直连

### 配额查看

每个账号支持查看：

- 5 小时配额百分比
- 每周配额百分比
- 代码审查配额百分比
- 剩余重置时间
- 最近刷新时间

### 状态栏监控

- 在状态栏显示当前账号配额摘要，例如 `Codex 5h 82% · Wk 66%`；月额度使用 `Mo`，标签固定使用英文缩写
- 接口明确没有返回的配额窗口会隐藏；尚未获取或无效的百分比显示 `--`，不会把缺失窗口显示为满额
- 悬停查看账号、各配额的重置倒计时和最后刷新时间，不受自动化控制开关影响
- 支持从总览面板将指定账号加入状态栏摘要（可选固定显示）
- 点击状态栏可直接打开完整配额面板

### 多语言界面

- 自动跟随 VS Code 当前语言环境
- 当前主要支持简体中文、English，并提供其他语言的本地化支持
- 配额总览面板、提示文案和交互文本会随语言切换
- 也可以在扩展设置中单独指定本扩展使用简体中文、English 或其他受支持语言，不影响 VS Code 其他界面

### 详情面板

支持打开单个账号详情页，查看账号邮箱、工作空间、登录方式、订阅到期、标签和用户 / 账号 ID，同时展示各配额窗口、重置倒计时和近 30 天使用详情。使用详情为近似值，可能延迟更新。

![账号详情：账号资料、订阅与配额](https://raw.githubusercontent.com/wannanbigpig/codex-accounts-manager/master/docs/images/details.jpg)

### 更新公告

- Dashboard 在消息中心和弹窗中展示更新公告，支持单条标记已读 / 全部已读。
- 更新公告建议按 `releaseVersion` 声明当前版本，并且使用**每个版本独立的 `id`**，避免旧版本已读状态影响新版本显示。
- `announcements.json` 以“当前版本的更新公告”为准，历史版本内容统一在 [docs/CHANGELOG.md](docs/CHANGELOG.md) 追加记录，历史文档不删除。

---

## 设置项

可在总览面板右上角设置按钮中直接调整，也可以通过 VS Code Settings 搜索 `codexAccounts` 修改。

- `语言`
  - `自动（跟随 VS Code）`，或手动指定简体中文、English 及其他受支持语言
  - 仅影响本扩展的总览面板和提示文案
- `ChatGPT / Codex 桌面应用重启策略`
  - 默认关闭，可按需开启
  - 开启后可选择：
  - `自动重启`：切换账号时如果对应桌面应用正在运行则直接重启
  - `手动确认重启`：切换后每次手动确认是否立即重启
- `配额自动刷新`
  - 默认关闭；开启后可设为 `1–60` 分钟的任意整数
  - 关闭后不再定时刷新
- `5 小时配额控制`
  - 默认关闭，仅控制有效的 5 小时配额是否参与自动切号和预警
  - 不影响状态栏、悬停提示和总览中的额度显示
- `自动切号`
  - 默认关闭
  - 开启后可分别设置 `5 小时` / `每周` 配额阈值
  - 刷新后如果当前激活账号触达阈值，会尝试自动切换到其他可用账号
  - 5 小时阈值仅在 `5 小时配额控制` 开启时生效；每周阈值独立生效
- `Codex App 启动路径`
  - 可选自定义桌面端路径
  - 留空时使用自动检测
- `仪表盘主题`
  - `auto`（跟随 VS Code）
  - `light`
  - `dark`
- `超额预警`
  - 可开启或关闭低配额提醒
  - 默认关闭
  - 开启后可设置 `5% - 90%` 阈值
  - 刷新配额后，如果当前激活账号低于阈值，会弹出中英文预警提示
  - `5 小时配额控制` 关闭时，仅检查每周配额
- `后台令牌刷新`
  - 可开启或关闭保存账号的后台 token 检测与更新
- `配额颜色阈值`
  - 可分别调整绿色与黄色阈值（配套 UI 提示颜色规则）
- `恢复数据操作`
  - 可在界面触发恢复备份 / 恢复 `auth.json` / 恢复共享 JSON

---

## 使用方式

1. 安装扩展
2. 首次启动时，如果本机已有本地 Codex `auth.json`，扩展会提示是否立即绑定并刷新配额
3. 也可以运行 `Codex Accounts: Add Account via OAuth` 添加账号
4. 或运行 `Codex Accounts: Import Current auth.json` 导入当前账号
5. 运行 `Codex Accounts: Show Quota Summary` 打开总览面板
6. 在面板中可进行：刷新配额、切换账号、导入导出、批量重刷、状态栏管理等操作
7. 点击账号卡片右下角的时钟配置唤醒任务，或通过顶部时钟管理全部任务与执行历史
8. 打开详情页查看配额、订阅和使用情况；通过卡片上的重新授权或重连入口处理账号状态问题

### 如何迁移账号到另一台电脑

1. 在账号管理界面勾选需要迁移的账号
2. 点击 `导出选中账号 JSON`
3. 在新电脑安装扩展
4. 点击 `从 Shared JSON 恢复`，或在添加账号窗口中导入 JSON
5. 完成账号恢复

---

## 命令列表

在 VS Code 命令面板中可使用以下命令：

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

## 安装

现在可以直接通过 VS Code 扩展市场安装，也保留 `.vsix` 和源码运行方式。

### 方式一：从扩展市场安装

1. 打开 VS Code 扩展面板
2. 搜索 `Codex Accounts Manager`
3. 找到发布者 `wannanbigpig` 的扩展并点击安装

也可以直接打开市场页面：

[Codex Accounts Manager - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wannanbigpig.codex-accounts-manager)

### 方式二：从 VSIX 安装

1. 从 [GitHub Releases](https://github.com/wannanbigpig/codex-accounts-manager/releases/latest) 下载最新 `.vsix`
2. 在 VS Code 中打开命令面板
3. 执行 `Extensions: Install from VSIX...`
4. 选择下载好的 `.vsix` 文件完成安装

也可以使用命令行安装：

```bash
code --install-extension codex-accounts-manager-x.y.z.vsix
```

### 方式三：从源码运行

```bash
git clone https://github.com/wannanbigpig/codex-accounts-manager.git
cd codex-accounts-manager
npm ci
npm run compile
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

---

## 打包 VSIX

```bash
npm run package
```

该命令先编译，再生成 `.vsix`；打包前自动检查扩展图标为 PNG 且尺寸不超过 `1024×1024`。

---

## 说明

- 账号数据保存在本地
- 切换账号会更新当前机器全局生效的 Codex `auth.json`
- 导入当前账号或首次绑定本地账号后，会立即刷新最新配额
- 如果其他窗口切换了账号，当前窗口会自动检测并提示同步
- ChatGPT/Codex 桌面应用联动默认关闭；开启后按所选策略处理已运行的应用
- Free 账户的 30 天配额窗口显示为“每月”；付费账户的 7 天窗口显示为“每周”
- 配额显示依赖当前账号会话返回的数据

---

## 支持

- ⭐ [GitHub Star](https://github.com/wannanbigpig/codex-accounts-manager)
- 💬 [反馈问题](https://github.com/wannanbigpig/codex-accounts-manager/issues)

---

## 💝 赞助项目

感谢你使用 `Codex Accounts Manager`。

如果这个项目对你有帮助，欢迎赞助项目的持续开发和维护。

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-支持作者-orange?style=for-the-badge&logo=buy-me-a-coffee)](https://github.com/wannanbigpig/codex-accounts-manager/blob/master/docs/DONATE.md)

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
