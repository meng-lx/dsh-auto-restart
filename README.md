# dsh-auto-restart

> **网页端暂未验证。** 桌面端（Electron）已完整实测；网页端（`dsh web`）代码两侧都已适配，
> 但还没有在真机上跑过。计划在**本周末内**完成验证并更新本文档。

等**整个 DSH 都空闲下来**再安全地重启它，重启完成后自动回到原会话说一句话。

插件只负责判断「什么时候可以动手」；杀进程、跑命令、重启、唤醒，交给包里的
PowerShell 脚本。两边通过一个交接文件通信，谁也不猜对方的状态。

## 前置条件

- DeepSeek Harness（桌面端或网页端）
- Windows

重启动作由包里的 PowerShell 脚本完成。插件只在倒计时结束后调用它，
设置页里能看到它当前解析到的路径。想换成自己的实现也只要接住同样的参数。

## 安装

1. 把本目录放到任意位置（例如 `D:\DeepSeek Harness\dsh-auto-restart`）；
2. 在 DSH 里执行插件安装：`plugin_manager install_bundle`，`target` 填本目录的绝对路径；
3. 重启 DSH（Host 半边改动需要重启才生效）。

也可以直接改 profile 的 `package.json` 加一条 `link:` 依赖并写进
`dsh.profile.bundles`，效果一样。

## 用起来是这样

1. agent 调 `restart_dsh` 工具（唯一触发方式，没有开关、没有自动触发）；
2. 工具**立刻返回**，倒计时在后台走，界面浮出一张毛玻璃卡片；
3. 倒计时期间动一下鼠标、滚一下、按任意键 → 本次取消，界面给一张「已取消重启」页；
4. 倒计时走完 → 判一次空闲（这是唯一的判定点）：
   - 还有别的东西在跑 → 不重启，给一张「现在不能重启」页，列出是谁；
   - 全部闲着 → 写交接文件、拉起脚本，工具所在的这一轮可以继续说；
5. 脚本关掉 DSH、执行命令（如果有）、重新启动；
6. 新进程里的插件读到交接文件，把唤醒词投进原会话，然后删掉它。

从触发到唤醒词出现，通常 **15–20 秒**。

## 调用参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 否 | DSH 关闭之后、重启之前执行的命令。**可以留空**——留空即纯重启，什么也不执行。没有默认值。 |
| `autoSay` | 否 | 重启后发给原会话的那句话，默认「已通过插件重启」。 |
| `countdownSec` | 否 | 倒计时秒数，3–600，默认 10。 |
| `timeoutSec` | 否 | 命令最多跑多少秒，10–3600，默认 600。超时就杀掉整棵进程树，照样启动 DSH。 |
| `wakeMode` | 否 | 重启后由谁唤醒原会话：`plugin`（默认，插件直投，不碰页面、不依赖调试端口）/ `script`（外部脚本用 CDP 往输入框注入，仅在插件不可用时才需要）。 |

命令失败（`exit ≠ 0`）或超时都**不会**阻止重启：退出码写进日志与
`last-run.json`，唤醒词自动补上「（命令失败：退出码 N）」或「（命令超时被中止）」。

## 空闲怎么判

**倒计时结束的那一刻**判一次，任一成立就算忙（宁可不动手）：

- `agents.list()` 里有 agent 的 `status === 'running'` —— **包括正在调用本工具的这一个**。
  子代理也在同一个注册表里，所以不需要另外接 `subagents` 服务；
- `jobs` 里任一 job 处于 `running` / `stopping`（逐个 owner 查，因为 `jobs.list()`
  默认只返回 unowned 的）；
- 拿不到 `agents` 服务（没法确认，就当它在忙）。

插件自己创建的 job / 子代理不计入 —— 否则它会把自己锁死。

占着忙就不重启，也不排队、不自动重试：提示页只负责告诉你是谁挡着。

## 为什么是倒计时结束才判

倒计时的作用就是给 agent 留时间把这一轮说完。所以工具不做拦截、立刻返回，
让调用它的这一轮继续输出；到点才判，此时自己也已经空闲了。

入口处只顺手记下当时的忙项，供倒计时页显示，不据此拒绝。**能不能停，只由倒计时
结束那一次决定。**

## 倒计时被取消

**任何输入都取消，不区分来源。** 这张卡片问的是「现在还有没有人在操作这台机器」，
远程桌面、别的自动化工具、任何软件发出的键鼠输入，同样意味着有人在动。

所以判断只看有没有 `pointerdown` / `wheel` / `keydown`，不看事件来源。

## 设置页

「设置 → DSH 自动重启」里有五个默认值：唤醒方式、默认唤醒词、默认倒计时、
默认超时、日志保留份数。

**没有「默认命令」，这是故意的。** 命令只能由调用方当次传入。一条留在设置页里的
命令，最坏会在某次纯重启时被悄悄执行，而没人记得自己设过它。

**它只是默认值**：agent 每次调 `restart_dsh` 传的参数优先，没传才落回这里。
改动会存进 `~/.dsh/dsh-auto-restart/settings.json`，DSH 重启后仍然有效；
文件损坏或字段非法时逐项回落到代码默认值。

页面下半截是只读的：脚本路径、状态目录、两个日志、交接文件，以及上一次运行的
结果（命令、退出码、是否超时）。

## 状态路由

路由前缀 `/auto-restart/api`，只服务于本插件自己的界面，不是对外 API：

| 路由 | 用途 |
| --- | --- |
| `GET /state` | 状态机快照（`idle` / `counting` / `launching` / `blocked` / `cancelled` / `failed`） |
| `GET /probe` | 现扫一遍宿主：此刻谁在忙、各 agent 的状态 |
| `GET` / `POST /settings` | 读 / 写五个默认值 |
| `GET /last-run` | 上一次脚本运行的结果 |
| `POST /restart` | 非工具入口（body: `{ sessionId, countdownSec?, autoSay?, command?, wakeMode? }`） |
| `POST /cancel` | 取消倒计时（body: `{ reason }`） |
| `POST /dismiss` | 关掉终止提示页 |

## 文件

| 文件 | 干什么 |
| --- | --- |
| `index.js` | Host 半边：工具、空闲判定、倒计时状态机、拉起脚本、状态路由 |
| `client.js` | Client 半边：`shell.overlay` 上的倒计时页与终止页，`settings.section` 里的设置页 |
| `scripts/Restart-DSH.ps1` | 真正动手：关 DSH → 跑命令 → 启动 DSH → 补交接状态 |
| `scripts/Start-DSH.ps1` | 被上一个脚本调用：按 desktop / web 启动，等就绪 |
| `scripts/say.js` | 只在 `wakeMode: 'script'` 时用：CDP 往输入框注入 |
| `test/idle-check.mjs` | 离线单测，`node test/idle-check.mjs`，不需要 DSH |
| `cordis.patch.yml` | bundle patch，把本包插进 profile 的 cordis 树 |
| `install.ps1` | 把插件装进 profile（`-Profile web\|desktop\|both`） |
| `locale/*.json`、`icon.svg` | 插件市场与设置页里显示的标题、描述、图标 |

## 状态与日志

都在 `~/.dsh/dsh-auto-restart/` 下：

| 路径 | 内容 |
| --- | --- |
| `settings.json` | 设置页的五个默认值 |
| `wake-request.json` | 交接文件，只在一次重启流程中存在，投递完即删 |
| `last-run.json` | 上一次脚本运行的结果（命令、退出码、是否超时、时间） |
| `logs/plugin.log` | 插件自己的日志（加载、倒计时、投递、失败原因） |
| `logs/restart-*.log` | 每次重启流程一个文件，保留最近 N 份 |

脚本自己的日志在 `Restart-DSH.ps1` 同级的 `logs/` 下。

## 交接文件怎么工作

只有一个文件，它的 `phase` 就是全部状态：

| phase | 谁写 | 含义 |
| --- | --- | --- |
| `starting` | 插件 | 已经拉起脚本，但还没确认 DSH 启动成功 |
| `ready` | 脚本 | DSH 真起来了，该投递了 |
| `failed` | 脚本 | 启动失败，不应该唤醒 |

插件读到 `ready` 就用 `sessionController.prompt()` 把唤醒词投进原会话 —— 走的是
正常的用户消息通道，不碰页面 DOM、不需要调试端口。投递失败退回 `agent.followup()`。

**文件在哪都有讲究，处理完就删。** 所以「文件在 = 有欠账，文件不在 = 没事做」，
状态目录不会积累。只有一种情况不删：读到 `starting` 说明脚本还没确认启动，
这时候删掉就再也等不到 `ready` 了。

## 两种载体

插件的 Host 半边不需要知道自己是哪一边：拉起脚本时不传 `-Mode`（默认 `auto`），
脚本自己按「有没有可见主窗口」判断；插件只额外传一个 `-WebPort <当前端口>`，
网页端重启后要绑回同一个端口，已经开着的标签页才连得回来。

真正的差别都在脚本里：

| | desktop | web |
|---|---|---|
| 怎么关 | 按进程名 `DeepSeek Harness` 全杀 | 按谁占着这个端口找 PID，`taskkill /T /F` |
| 怎么起 | `DeepSeek Harness.exe` | `dsh --profile web --no-open` |
| 就绪判据 | 主窗口出现 | 端口有响应（401 也算，说明服务在） |

**唤醒链路两种载体完全一样**：交接文件 + `sessionController.prompt()` 直投。
`wakeMode: 'script'` 只有桌面端有。

网页端重启后，标签页会自己连回去（端口固定、cookie 持久、连接层带指数退避重连），
不需要刷新；桌面端用随机端口，旧窗口等不到，由脚本重新开一个。

## 已知限制

- 网页端尚未实测（插件、脚本两侧都按网页端写好了，缺一次真机验证）；
- 桌面端的启动路径依赖 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，DSH 装在别处需要改
  `scripts/Start-DSH.ps1`；
- 桌面端重启后窗口位置、大小由 DSH 自己决定，插件不介入。
