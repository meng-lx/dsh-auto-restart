# dsh-auto-restart 交接文档（web 端适配 + 市场级自适应改造）

> 给另一台电脑上的 DSH / agent 看。读完这一份就能接着干，不需要原始对话。

## 0. 一句话结论

插件不再"猜 dsh 装在哪"，改成**由宿主自述生成一份启动计划（launch-plan.json），脚本只照计划执行**；
计划不可用就**拒绝关闭 DSH**。官方桌面端与 `dsh web` 两种形态零配置；其余环境由 agent 在对话里
问用户一次、把一条完整命令写进 `settings.json` 的 `launchCommand`。

## 1. 背景：为什么要改

原实现把路径写死成 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
（`scripts/Start-DSH.ps1` 旧 :86-90）。npm / pnpm / volta / scoop / 源码 装法全落空，
而 `Restart-DSH.ps1` 是**先杀宿主再启动**，于是"重启一次 = DSH 再也起不来"。

目标定为：**上插件市场**，两台电脑环境不同、每台机器还会随用户升级/换装而变，
所以不能靠"多写几条 if"，要靠"宿主能自述的就自述，自述不出来的让 agent 问一次用户"。

关键认知（决定了整个方案）：**argv 重放对安装方式免疫**。不管是 `npm -g` 还是 pnpm 的 shim，
node 进程里的 `process.argv` 都已经是 `["node", "<绝对路径>/@deepseek-ai/dsh/lib/bin.js", "web"]`，
shim 只是转发。所以"dsh 装在哪"这个问题**根本不用回答**。

## 2. 设计：三段式

```
宿主事实(hostFacts)  →  启动计划(launch-plan.json)  →  校验(validatePlan)  →  计划门（不可用就不杀）
```

- **事实**：`lib/launch-plan.js: readHostFacts(webServer)` 读 `process.argv / execPath / cwd /
  versions.electron / webServer.getOrigin() / profile / dsh 版本`，每次现读不缓存。
- **计划**：`buildLaunchPlan(facts, launchCommand)` 产出三种 mode：
  | mode | 何时 | exe | args | env |
  | --- | --- | --- | --- | --- |
  | `web` | 非 Electron，或 Electron 里跑的入口是 DSH 自己 | `process.execPath` | `[entry, ...argv.slice(2)]` 原样重放 | Electron 里补 `ELECTRON_RUN_AS_NODE=1` |
  | `desktop` | Electron 且入口不是 DSH（官方桌面壳） | 外壳 exe | `[]` | **删掉** `ELECTRON_RUN_AS_NODE`（继承它会把桌面端拉成 node） |
  | `custom` | 设置了 `launchCommand` | `cmd.exe /d /s /c` | 用户那条命令 | — |
- **校验**：`validatePlan` 检查 exe/entry 文件存在、端口 0..65535。reason 取值：`no-plan /
  empty-command / unknown-mode / no-exe / exe-missing / entry-missing / bad-port`。
- **计划门**：`Restart-DSH.ps1` 在 **Sleep 与 kill 之前**校验计划，不可用就 `throw` 并
  `Set-WakePhase failed`；插件侧 `finishCountdown()` 也先校验再落盘再 spawn。两道门保证
  "宁可重启失败，也不让 DSH 停在关闭状态"。

## 3. 设置项：只加两个，默认不需要动

`~/.dsh/dsh-auto-restart/settings.json`（机器级；状态文件是实例级）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `launchCommand` | `""` | 空 = 自动（argv 重放）。非空 = 用这条命令启动，`source=custom` |
| `allowAutoRestart` | `true` | `false` = 工具直接返回 `disabled`，不杀不启（给"我被 systemd/pm2 托管"的用户） |

`client.js` 的设置页是**显式 5 项数组**（`:588-594`），未知键会被忽略 —— 所以加设置项
**不需要改客户端**，设置页上看不到这两个键是预期的（本期不做 UI）。

## 4. agent 怎么介入（本期唯一的人工闸门）

工具 `restart_dsh` 在 execute 里做两道前置门：
1. `allowAutoRestart=false` → `reason: "disabled"`；
2. `validatePlan` 失败 → `reason: "needsSetup"`，并在 **message 里**（不是额外字段 ——
   `output.render` 只输出 message，agent 能看到的只有它）拼上完整宿主自述 + 三步指令：

   1. 拼一条命令：argv 原文照抄，`--profile` 与端口必须与当前 origin 一致，加 `--no-open`；
   2. **在对话里问用户**并说明"这条命令以后每次重启都会以你的权限执行"，等用户确认；
   3. 写进 `settings.json` 的 `launchCommand`，再调一次 `restart_dsh`。

禁止：agent 自己静默写 `launchCommand`（它会读网页等不可信内容 → 等于持久化后门）、改 `.ps1`、
自己 `taskkill`、把 `allowAutoRestart=false` 当修复。细则见插件包 `SETUP.md`（agent 直接读它）。

## 5. 本次改动清单

工作副本 `D:\deepseekharness\dsh-auto-restart\`，已同步到
`C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-auto-restart\`（逐文件 SHA256 一致）。

| 文件 | 改动 |
| --- | --- |
| `lib/launch-plan.js` | **新增** ~300 行。导出 `PLAN_FILE_NAME / PLAN_VERSION / planFilePath / readProfile / readEntryPackage / parseOrigin / readHostFacts / buildLaunchPlan / validatePlan / writePlanFile / readPlanFile` |
| `index.js` | 导入 launch-plan；新增 `PLAN_FILE`；设置 5→7 项（load/apply 双侧校验）；`launchScript(..., planPath)` 追加 `-PlanPath`；`hostFacts()`；`finishCountdown()` 加计划门（`no-launch-plan` / `plan-write-failed` 都不杀）；execute 加 `disabled` / `needsSetup` 两道门；`__test` 导出扩充 |
| `scripts/Restart-DSH.ps1` | `$PlanPath` 参数；`$WorkDir` 默认改 `''`（走计划 cwd）；新增 `Read-LaunchPlan` / `Test-LaunchPlan` / `Start-DetachedProcess`；计划门在 kill 之前；按 plan.mode 覆盖 `$Mode/$WebPort/$ProcName`；web 段用 `if ($WebPort -gt 0)` 包住；启动调用改**哈希表 splat**；Detach 加 `DetachKind` |
| `scripts/Start-DSH.ps1` | `$PlanPath` 参数；有计划就不再推导写死路径；新增 `ConvertTo-QuotedArgument` / `Start-FromPlan`（custom→`cmd /d /s /c`，web/desktop→exe+args+env，env 里 null=删变量） |
| `SETUP.md` | **新增**：给 agent 的说明书（十节，含 reason 排查表、命令五条规则、七条禁止事项） |
| `README.md` | 计划模型、文件表、已知限制改写（加 detach 阶梯与托管形态） |
| `package.json` | `files` 补 `lib/launch-plan.js`、`SETUP.md` |

## 6. 本机踩到的三个坑（换机器大概率还会遇到）

1. **PowerShell 5.1 + 无 BOM 的 UTF-8 脚本 = 灾难**。5.1 按 cp936 解码中文注释/字符串，
   有把引号吞掉导致解析失败的风险。两个 `.ps1` 必须存成 **UTF-8 with BOM**。
   `edit/write` 工具回写会丢 BOM，**每次改完都要补**：
   ```powershell
   $t=[System.IO.File]::ReadAllText($p,(New-Object System.Text.UTF8Encoding($false)))
   [System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($true)))
   ```
   校验要用 `[System.Management.Automation.PSParser]::Tokenize($t,[ref]$e)` 且**以 UTF-8 读文本**；
   `Get-Content -Raw` 不加 `-Encoding` 会报一堆假错。
2. **计划任务可能被策略锁死**（本机 `Register-ScheduledTask` 与 `schtasks /Create` 都是
   `Access is denied.`）。原实现只有计划任务一条路 → detach 必失败。已改成三级阶梯：
   **计划任务 → schtasks → WMI `Win32_Process.Create`**，实测落 WMI 可用（父进程是
   `WmiPrvSE.exe`，不在 DSH 进程树里，`taskkill /T` 带不走；session 1，桌面窗口能出现）。
3. **数组 splat 会按位置绑定**。`$startArgs = @('-TimeoutSec',180)` 后 `& $script @startArgs`
   把 `180` 塞给 `-Mode`（ValidateSet 只有 desktop/web），报
   `无法对参数"Mode"执行参数验证`。必须用**哈希表** `@{ TimeoutSec = 180 }`。

## 7. 怎么在另一台电脑上验证（照做，别跳）

1. 文件就位后 `node --check index.js`、`node --check lib\launch-plan.js`；
2. 两个 ps1 用 PSParser 以 UTF-8 解析，`$errors.Count -eq 0`，并确认文件头是 `EF BB BF`；
3. **不要先拿真宿主试**。造一个假 DSH 替身（任意 HTTP server 监听 3099），手写一份
   `probe-plan.json`（mode=web, exe=node, args=[假服务器脚本, "3099"], port=3099, cwd=...），
   然后 `Restart-DSH.ps1 -Detach -OwnerPid <假服务器pid> -WebPort 3099 -PlanPath probe-plan.json
   -GraceSec 0 -SettleSec 0`。成功标志：父进程打印"已用「wmi|task|schtasks」拉起独立进程"，
   子进程日志出现 `启动脚本返回：ready`，3099 换新 PID 监听；
4. 再 `-DryRun` 演练真实计划（不杀进程）；
5. 最后才让真宿主重启一次，验证新 `index.js` 生效：`GET /auto-restart/api/settings` 的
   `value` 里应出现 `launchCommand` 与 `allowAutoRestart`（旧代码没有这两个键）。

本机验证结果：以上 1–5 全部通过（真宿主 pid 7264 → 10628 → 7244 → 5084），3080 监听正常，
settings 返回 7 个键。

两个实测坑，**写在这里免得下一台机器重犯**：

1. **触发方式决定 `sessionId`**。走工具 `restart_dsh` 时后端取 `exec.agent.id`（本机
   `session-407a467f-78b2-4df2-9113-10fb206c9115`），交接文件带得上会话 id，唤醒能投达；
   而直接 `POST /auto-restart/api/restart` 且 body 不带 `sessionId` 时，写出的请求
   `sessionId` 是空串，新宿主会跳过唤醒 —— 表现为"重启成功但没人叫醒会话"。
   **验证唤醒必须走工具，不要用裸 HTTP 打接口。**
2. **重放 argv 会把"开浏览器"一起重放**。`dsh web` 默认开浏览器，重放后每次重启都多开一个
   标签页。已在 `buildLaunchPlan` 的 web 分支补：命令行里没有 `--no-open` 就追加。
   这一行只对**下一次**重启生效 —— 正在跑的进程用它是启动时加载的那份模块。

## 8. 已知边界 / 未完成

- 容器、systemd、Windows 服务等"杀了会被外部守护重拉"的形态不支持，靠 `allowAutoRestart=false` 让位；
- 第三方 Electron 壳（如 `UtilityProcess` 跑 CLI）未实测；
- 桌面端路径在本机没有真桌面端，`mode=desktop` 只做了 plan 单测（exe 不存在时按预期 `exe-missing`）；
- 设置页仍只显示旧 5 项（`client.js` 未改）；要不要把两个新键暴露到 UI，是下一期的事；
- `package.json` 版本未 bump（`0.1.0`），`engines` 仍只有 `node>=22`，**上市场还需要 `engines.dsh`**；
- 唤醒（`wakeMode: plugin|script`）本次未改。
