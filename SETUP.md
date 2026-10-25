# 一次配好这台机器（给 agent 看的说明书）

**给谁看**：在这台机器上跑的 DSH agent。
**为什么有这份文件**：dsh-auto-restart 默认只覆盖两种启动方式 —— 官方桌面端、`dsh web`（任何安装方式）。
其余环境（npx、自制包装、换过的外壳、托管进程）由 **agent 按本文配置一次**，用户只负责确认。

---

## 一、默认就能用的范围

宿主会把自己「怎么跑起来的」写成启动计划（`lib/launch-plan.js`），依据只有四个真实值：
`process.execPath`、`process.argv`、`process.cwd()`、`webServer.getOrigin()`。

| 形态 | 计划 | 是否需要配置 |
| --- | --- | --- |
| `dsh web`（npm / pnpm / volta / scoop / 源码 / npx） | 重放 `node <bin.js> web …` | 否 |
| 官方桌面端 | 重放外壳 exe，并删掉 `ELECTRON_RUN_AS_NODE` | 否 |

`argv` 重放天然与「dsh 装在哪」无关：shim（`dsh.cmd` / `dsh.ps1`）只是转发，`argv[1]` 已经是
`…/@deepseek-ai/dsh/lib/bin.js` 的绝对路径。所以绝大多数机器**不需要任何设置**。

---

## 二、什么时候需要你介入

`restart_dsh` 返回 `reason: "needsSetup"`。

这时候：
- DSH **没有被关闭**，也没有进入倒计时（校验发生在杀进程之前）；
- message 里带着**宿主自述**：`argv` / `execPath` / `cwd` / `origin` / `profile` / `dshVersion` / `electron`。

这些是这台机器上的**真实值**，不要用你记忆里的默认路径去猜。

---

## 三、三步（顺序不能变）

1. **拼一条命令**：用下面的规则，从自述里抄，不要发明路径。
2. **让用户在对话里确认**：把命令**原文**贴出来，并明确说一句「这条命令会在每次重启时以你的权限执行」。
   等到他明确同意再往下。
3. **写配置并重试**：把命令写进设置文件，然后再调一次 `restart_dsh`（它会先验证计划，再进倒计时）。

> 为什么必须让用户确认：agent 会读到网页等不可信内容，而 `launchCommand` 是每次重启都会执行的
> 任意命令。静默写入 = 持久化后门。这一步不是形式。

---

## 四、配置写在哪、写什么

文件：`%USERPROFILE%\.dsh\dsh-auto-restart\settings.json`
（`DSHAR_STATE_DIR` 环境变量存在时以它为准；文件不存在就新建。）

只加/改这两个键，**其余键不要动**（`autoSay` / `timeoutSec` / `countdownSec` / `logKeep` / `wakeMode`）：

```json
{
  "launchCommand": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js\" web --no-open",
  "allowAutoRestart": true
}
```

- `launchCommand`：空字符串 = 回到自动（默认）。写一条**完整命令**，由插件用 `cmd /d /s /c` 执行，
  所以 `%APPDATA%` 这类变量会展开。
- `allowAutoRestart`：`false` 时 `restart_dsh` 直接拒绝，什么也不做。默认 `true`。
- 写合法 JSON、反斜杠要转义、**不要 BOM**（Node 的 `JSON.parse` 见 BOM 会抛错）。

---

## 五、命令怎么写

规则，按重要性排序：

1. **`argv` 原文照抄**：命令 = `"<execPath>" "<argv[1]>"` + `argv[2..]` 逐字保留。
   这是最可靠的一条 —— 它就是这台机器当前的启动方式。
2. **profile 和端口必须与自述一致**：`origin` 里的端口，命令里必须有同值的 `--port`；
   profile 名同理。端口变了页面就连不回来，profile 变了就不是同一个 DSH。
3. **一条能在 cmd 里直接跑的命令**（`cmd /d /s /c` 执行，不是 PowerShell 语法）。
4. 建议加 `--no-open`：重启时页面已经开着，再弹一个标签页只是噪音。
5. 命令只负责「从零起来」；杀旧进程、等端口都是插件的事，命令里不要写 `taskkill`。

例子（`<…>` 换成自述里的真实值）：

```text
# npm 全局安装的 web（推荐：直接用自述里的两个绝对路径）
"C:\Program Files\nodejs\node.exe" "C:\Users\me\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3080 --no-open

# 只信 PATH（npx 缓存被清、路径搬过家时用这个）
dsh web --port 3080 --no-open

# 官方桌面端（外壳 exe，无参数）
"%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
```

---

## 六、写完怎么验证

再调一次 `restart_dsh`。如果还是 `needsSetup`，看 message 里的 reason：

| reason | 含义 | 怎么修 |
| --- | --- | --- |
| `no-plan` | 计划没生成（一般伴随写盘失败） | 看插件日志里的写盘错误 |
| `exe-missing` | 命令里的 exe 不存在 | 用自述里的 `execPath` 原文 |
| `entry-missing` | web 的 `argv[1]`（bin.js）不存在 | npx 缓存被清 / 源码被移走 → 改成 PATH 形式 |
| `empty-command` | `launchCommand` 是空串却判成自定义 | 空串本就是「自动」，不会走到这 |
| `bad-port` | 端口不在 0..65535 | 用 `origin` 里的端口 |
| `unknown-mode` | 计划文件被改坏 | 删掉 `launch-plan.json` 让它重新生成 |

---

## 七、不要做的事

- **不要改插件里的 `.ps1` / `index.js`**：升级会被覆盖，而且脚本是唯一的执行点。
- **不要自己 `taskkill` / `Stop-Process`**：关进程有先后顺序和端口释放等待，手杀容易留下半死状态。
- **不要静默写 `launchCommand`**：必须先让用户看到命令原文并同意。
- **不要把 `allowAutoRestart=false` 当成修复**：那是关掉功能，不是适配。
- **不要为了让校验通过去改 `validatePlan` 的判据**：校验失败说明计划确实不可用。

---

## 八、文件与日志

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/dsh-auto-restart/settings.json` | 设置（含 `launchCommand` / `allowAutoRestart`） |
| `~/.dsh/dsh-auto-restart/launch-plan.json` | 启动计划，**每次重启前重写** |
| `~/.dsh/dsh-auto-restart/logs/plugin.log` | 插件日志（含计划生成与校验结果） |
| `~/.dsh/dsh-auto-restart/last-run.json` | 上次重启期间那条命令的结果 |
| `<插件目录>/scripts/logs/restart-*.log` | 重启脚本日志（杀进程、启动、唤醒） |

---

## 九、明确不支持的形态

容器（docker / k8s）、systemd / Windows 服务、任何「杀了会被外部守护进程重新拉起」的托管。
这些环境里「重启」的语义不归本插件管：把 `allowAutoRestart` 设成 `false`，让运维去重启。
插件不会假装能处理 —— 它会拒绝，而不是把 DSH 停在一个起不来的状态。

## 十、看到「无法创建独立进程」时

重启的真实动作必须由一个**不在 DSH 进程树里**的子进程完成（否则 `taskkill /T` 会把它一起
杀掉）。脚本按 计划任务 → `schtasks` → WMI（`Win32_Process.Create`）三级阶梯尝试。三级全
失败才会报 `无法创建独立进程（三种方式都不通）`，此时**DSH 没有被关闭**。

这一条不是 `launchCommand` 能修的，`launchCommand` 只解决「用什么命令把 DSH 拉起来」。
遇到它：如实告诉用户这台机器不允许插件创建独立进程（常见于被组策略锁死计划任务的机器），
建议把 `allowAutoRestart` 设为 `false`，重启由用户自己做。**不要**改成自己 `Start-Process`
或手写 `taskkill` 来绕过 —— 那会把 DSH 停在一个没人拉起来的状态。
