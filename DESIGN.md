# dsh-auto-restart 设计规格

> 本文是唯一权威规格。新会话接手时先读这份，再看 `README.md` 和源码。
> 最后更新：2026-10-25（1.1：启动计划与载体自适应）

## 一句话

agent 调工具 → 立刻返回「倒计时已开始」→ 倒计时在后台走（有真实键鼠输入就取消）→ 到点判一次
整个 DSH 是否空闲 → 宿主自述并校验启动计划 → 计划任务/schtasks/WMI 拉起脚本 →
杀 DSH / 跑命令 / 照计划启动 → 交接文件 + 定向唤醒原会话。

**已适配官方桌面端与官方网页端（`dsh web`）**，两种都真机跑通过。第三方载体由
`lib/launch-plan.js` 检测出差异后**不动手**，由 agent 照 `SETUP.md` 征得同意再配置。

## 架构分工

| 角色 | 只负责 | 绝不负责 |
|---|---|---|
| 插件（host） | 判定「什么时候安全」、状态机、拉起脚本 | 不碰进程、不杀 DSH |
| 脚本（Restart-DSH.ps1） | 「怎么动手」：杀进程、跑命令、启动、调唤醒 | 不判断空闲 |
| 插件（client） | 提示页、倒计时页、设置页 | 不做判决逻辑 |

判据与动作完全分离，任何一侧都不许猜对方的意图。

## 一、触发：只有 agent 主动调工具

- 插件注册一个工具，**唯一入口**。
- 不做开关、不做自动触发、不做定时触发。
- 因此**不做**：开关持久化、「必须观察到一次运行过」、「空闲确认 20 秒」。
- 参数每次由调用方传（不设死默认，不同环境不一样）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 关闭 DSH 时执行的命令。**纯重启也必须传**，传 `echo 1` |
| `autoSay` | 否 | 唤醒词，默认 `已通过插件重启`，每次可覆盖 |
| `timeoutSec` | 否 | 命令超时 |
| `countdownSec` | 否 | 倒计时时长 |

设置页里只放一份「默认值」，供调用方参考，不强制。

## 二、空闲判定：整个 DSH

**判定的时点是倒计时结束那一刻，入口既不判也不预扫。**

倒计时本身就是给「还在跑的东西」收尾的窗口：调用瞬间有任务在跑，不代表倒计时结束时还在跑。而入口那一刻扫出来的「忙」里必然包含调用者自己（工具还没返回，它一定 `running`），除了写一行日志没有任何用处，所以不扫。

任一为真即「忙」：

- `agents.list()` 里有 agent 的 `status === 'running'` —— **包括正在调用本工具的这一个**。
  子代理也在同一个注册表里（`dsh-agent-loop` 用 `agents.enter(agent, parentAgent)` 登记），
  所以不需要另外接 `subagents` 服务
- `jobs` 里任一作业 `status` 为 `running` 或 `stopping`（逐个 owner 查，`jobs.list()`
  默认只返回 unowned 的）
- 拿不到 `agents` 服务（没法确认，就当它在忙）

**插件自己创建的 job / 子代理不计入**（`OWN_JOB_IDS`），否则它会把自己锁死。

**「包括自己」为什么不会死锁**：工具是秒回的，倒计时结束时这一轮通常已经说完、
agent 已 idle。如果还没说完，就该判忙 —— 这正是倒计时想拦住的情况。

**取不到服务时按「忙」处理**（安全侧），绝不冒险。

> 官方口径参考 dsh-shutdown-idle：`ctx.get('agents').list().some(a => a.status === 'running')` 与 `ctx.get('jobs').list().some(j => j.status === 'running')`；拿不到 agents 服务当不空闲。

## 三、状态机

```
调工具
  └─ 立即返回 counting，不判空闲
      └─ 倒计时页（毛玻璃卡片，三行：DSH 重启倒计时 / XX 秒 / 本页面点击鼠标或按任意键取消）
            ├─ 用户真实键鼠输入 → 取消，本次调用结束
            └─ 倒计时到点 → 二次判定
                  ├─ 忙  → 返回 {ok:false, reason:'busy', blockers:[...]}
                  │        同时弹「无法重启」提示页，列出阻塞项
                  │        提示页不自动消失，直到用户真实键鼠输入才关
                  └─ 闲  → 拉起脚本 → 返回 {ok:true, phase:'launching'}
```

**这一轮没说完就算忙**：工具秒回之后，调用它的 agent 仍在 `running`，倒计时到点时
若还没说完，就会判忙、放弃重启。这是有意的 —— 倒计时本来就是给它留的时间。

倒计时结束时仍忙，就放弃这次重启，不自动重试、不排队——用户重新调一次即可。

## 四、倒计时与取消

- 只认三种事件：`pointerdown`、`wheel`、`keydown`。
- **不算**：`mousemove`、别的窗口的操作、窗口失焦、系统级输入。
- 只监听本插件的提示页/浮层内的输入（本页事件），别的窗口动不到。
- **不区分输入来源**：任何 `pointerdown` / `wheel` / `keydown` 都取消。
  这张卡片问的是「现在还有没有人在操作这台机器」，远程桌面、自动化工具、CDP 注入
  同样意味着有人在动。查过 `isTrusted` / `sourceCapabilities`，两者都区分不了；
  `pointerdown.pressure` 能区分（注入 0、真人 0.5），但**故意不用** —— 跳过注入
  等于给外部工具开一个偷跑的洞。
- **页面画出来才开始走秒**：触发时只挂牌（`awaitingViewer`），页面第一次 `GET /state`
  或 `POST /viewer` 才落定 `deadline`。没人来看就在 10 秒后兜底起表。
- 倒计时长度 = 设置值 + 500ms 尾巴；页面显示 `ceil((left - 500) / 1000)`，所以设置 10
  秒就是 10→9→…→0，每个数字各占 1 秒。
- 两种运行形态都要工作：**桌面端（Electron）** 与 **网页端（浏览器）**。

## 五、提示页

- 两态：倒计时 / 无法重启。
- 满屏覆盖：`position: fixed; inset: 0`。
- 真全屏（让 Electron 窗口进全屏）取决于 DSH 是否向插件开放窗口控制，未验证；做不到就只覆盖窗口区域。
- 提示页消失条件与倒计时取消条件一致：真实键鼠输入。

## 六、执行

计划任务拉起 `Restart-DSH.ps1`（独立进程，已验证 WMI 不可用、计划任务可用）：

1. 关闭 DSH —— desktop 按进程名 `DeepSeek Harness` 全杀；web 按谁占着
   `-WebPort` 找 PID，`taskkill /T /F`
2. **有命令才执行** `command`（到点杀整棵进程树）；没有命令就跳过那 8 秒静默，
   直接进入启动
3. 启动 DSH（desktop 用 exe；web 用 `dsh --profile web`）。`wakeMode='plugin'`
   时**不带** `--remote-debugging-port`，也不等调试端口 —— 那 60 秒只有 CDP 注入用得上
4. 写交接文件 `phase: 'ready'`（失败写 `failed`）
5. 唤醒由新进程里的插件自己完成，见第七节

容错：

| 结局 | 行为 | 唤醒词 |
|---|---|---|
| 命令成功 | 照常启动 | `已通过插件重启` |
| 命令失败（exit≠0） | 照样启动，退出码记日志 | `已通过插件重启（命令失败：退出码 N）` |
| 命令超时 | 杀进程树后**立刻启动** | `已通过插件重启（命令超时被中止）` |
| DSH 启动失败 | 重试一次，仍失败则放弃并写日志 | —— |

- **单实例锁**：同一时间只允许一个重启流程。
- 宁可命令没跑完，也要把界面还回来。

## 七、唤醒：定向到会话，不认「当前页面」

**这是第一版的漏洞**：默认「关的时候停在哪页、唤醒就回哪页」是错的 —— agent 回复期间用户可能点到别的会话，关掉的就是另一页，唤醒消息会发错地方。

正确做法：

1. **触发那一刻**记录活跃会话 id（不能等关机时再读页面）。
2. 重启后**回到那个会话**再投递唤醒词。

两条路，优先第二条：

- **A（优先，已实测可用 2026-10-23）**：host 直接往指定会话投递消息 —— 完全不碰页面，最干净。
- **B（退路）**：CDP 先导航到该会话，再注入。

### A 的落地细节（已实现并验证）

交接文件分**两个阶段**写，因为「唤醒谁」和「成没成」两件事只有各自的当事方知道：

- **插件**在拉起脚本**之前**写前半段：回哪个会话、说什么（`phase: 'starting'`）。
  这两个值插件最清楚，不经过命令行再绕一道。
- **脚本**在拉起 DSH 之后补后半段：`phase: 'ready'` + 启动时间戳；失败则 `phase: 'failed'` + 原因。
  只有脚本知道 DSH 到底有没有起来。

路径 `~\.dsh\dsh-auto-restart\wake-request.json`：

```json
{
  "runId": "m8x1p2k3-a1b2c3",
  "phase": "starting",
  "sessionId": "session-…",
  "text": "已通过插件重启",
  "requestedAt": 1792763785947,
  "startedAt": 0,
  "error": ""
}
```

重启后新进程 `apply()` 延迟 6 秒（等服务就绪）调 `deliverPendingWake()`：

0. 读到 `starting` 就**只等不发**：每 250ms→2s 退避重读文件，直到 `ready` 或超时；
   读到 `failed` 直接放弃（重启都失败了，发什么唤醒词）。
1. 见到 `ready` 才试 `ctx.get('sessionController').prompt({ sessionId, content, requestId }, signal)`
   —— 这是 `@Remote('prompt')` 的宿主服务，内部会 `resolveAgent()` 自动 resume 冷会话，
   再 `agent.followup()`。**走的是正常用户消息通道**，所以投递出来的消息和用户手打
   的完全一样（实测：会话里直接多了一条 user 消息）。
2. 退路 `agents.get(sessionId).followup({ content, source: { kind: 'user' } })`
   —— 要求 agent 已在跑，只当兜底。
3. 都没成：按指数退避重试（250ms 起，封顶 2s），最多 2 分钟。
4. 投递成功就**删掉文件**。用户定下的规矩：这份交接文件是**一次性的**，
   插件看过之后不管最后有没有投出去都要清空（见下一条）。

**清空规则（用户 2026-10-23 定）**：文件只承载「最近一次、还没处理完」的状态，
落盘之后一律删除——投递成功删、投递失败超时删、读到旧版 `delivered` 残骸删、重启失败
（`failed`）也删、`starting` 过期也删。因此：

- 文件存在 = 有欠账（还没等到 `ready`，或还没投出去）；
- 文件不存在 = 没有欠账，下次启动什么都不做。

投递失败也删，是宁可漏一次唤醒，也不留一份过期欠条给下次启动误投。这样状态目录里
永远只有 `wake-request.json`（临时）与 `last-run.json`（脚本覆盖写），不会积累。

脚本侧只在「现存文件还是 `starting`」时才补写，避免把已经消费过的旧文件又写成 `ready`。

`wakeMode` 就是在这里分流：`plugin` 让脚本的 `-AutoSay` 传空串（脚本侧看到空就不发），
`script` 保持原来的 CDP 注入。写不进交接文件时自动降级成 `script`。

（旧版的单阶段文件 `pending-wake.json` 仍可读，只作兜底，不再写入。）

## 八、两种运行形态

### 1.1：不猜，由宿主自述（当前实现）

宿主不需要知道自己是哪一边。每次动手前，`lib/launch-plan.js` 把**它实际是怎么跑起来的**
写成 `~/.dsh/dsh-auto-restart/launch-plan.json`：

```
process.execPath  +  process.argv  +  process.cwd()  +  webServer.getOrigin()
        ↓
{ version: 1, mode: 'desktop' | 'web' | 'custom',
  exe, args[], cwd, env, port, origin, detectedBy, createdAt }
```

- `argv` 重放对安装方式免疫：`npm` / `pnpm` / shim 最后一跳都是
  `["node", "<abs>/@deepseek-ai/dsh/lib/bin.js", "web"]`，原样重放即可，
  「DSH 装在哪」不再是一个需要回答的问题；
- `mode` 由自述特征判定（Electron 主进程 → `desktop`；`bin.js` + `web` 子命令 → `web`；
  两者都不像 → `custom`）；
- 唯一的覆盖入口是 `settings.json` 的 `launchCommand`：重放不可行时
  （npx 缓存被清、自制 bat 包装、容器）由 agent 填一条完整命令。

**两道计划门**，都在杀进程之前：

| 门 | 位置 | 不过时 |
|---|---|---|
| 插件侧 | `index.js` 的 `finishCountdown` | 不写交接文件、不拉脚本，直接给失败页 |
| 脚本侧 | `Restart-DSH.ps1` 的 `Sleep` 之前 | 直接退出，**一个进程都不杀** |

校验内容：`mode` 认识、exe / 入口文件存在、端口像样。**计划不可用就不动手**——
先杀再发现起不来，是这类工具最伤人的失败形态。

启动方式的三级阶梯（`taskkill /T` 会连带带走父进程，所以必须脱离进程树）：
**计划任务 → `schtasks` → WMI（`Win32_Process.Create`）**。实测某些机器上
`Register-ScheduledTask` 被策略拒绝（`Access is denied.`），此时自动落到下一级；
三级都不通会直接报错并**保持 DSH 运行**。

### 1.0 的做法（已被 1.1 取代，保留作背景）

| 形态 | 唤醒方式 | 关/起 | 备注 |
|---|---|---|---|
| 桌面端（Electron） | `wakeMode: 'plugin'` 直投（首选）/ CDP 注入（退路） | 按进程名杀、`DeepSeek Harness.exe` 起 | 已实测 |
| 网页端（浏览器） | 只能直投（网页端没有 CDP） | 按端口定位 PID、`dsh --profile web` 起 | 脚本与插件两侧均已支持 |

1.0 让脚本自己判载体：拉起时传 `-WebPort <port>` 与 `-OwnerPid <pid>`，脚本先问
「这个进程有没有在监听 WebPort / 有没有窗口」，判得准就按判出来的走。旧判据在双实例
并存时会判错：网页端内核进程名也叫 `DeepSeek Harness.exe`，按名字杀会把两边一起杀掉。
1.1 用自述取代了这套推断。

**网页端为什么能在原地自愈。** 连接层自带指数退避重连（500ms 起、10 秒封顶、
一直重试到恢复），登录 cookie 是**持久化签名**的（密钥在 `$DSH_HOME/.credentials.yaml`，
`cookieMaxAgeDays` 默认 30 天），签名绑定的是 `hostname + port` 而不是每次启动
新生成的随机令牌。端口不变 ⇒ cookie 一直有效 ⇒ 标签页自己连回去，**不需要刷新**。

桌面端反过来：`dsh-desktop-host` 传 `--port 0`，每次重启换端口，旧窗口等的那个端口
再也没人监听，只能由脚本重新开窗口。这不是缺陷，是端口策略的必然结果。

（证据：`dsh-client-connection/README.zh.md` 第 41、43、60 行；
`dsh-web-app/cordis.patch.yml` 的 `port: !!js ctx.webStartup.port ?? 3080`。）

## 九、日志

- 目录：`~\.dsh\dsh-auto-restart\logs\`
- 一次重启流程 = 一个文件
- **保留最近 N 次**（默认 5，可配），超出删最旧的
- 内容：各阶段时间戳、命令逐行输出、退出码、唤醒结果

## 十、设置页

只放默认值：唤醒方式、默认唤醒词、默认倒计时、默认超时、日志保留份数；
另有**两个适配兜底**：`launchCommand`（重放不可行时的一条完整启动命令）与
`allowAutoRestart`（检测不出「怎么再起来」时默认 `false`，由人显式打开）。
实际每次由调用方传参覆盖，优先级是「调用参数 > 设置页默认值 > 代码常量」。

**这五项落盘**在 `~/.dsh/dsh-auto-restart/settings.json`：`apply` 时读一次，
缺字段/坏文件/越界值各自兜底（逐字段校验，不让一个坏字段连累其余），
保存时写盘；写盘失败只记日志，内存里照常生效。

原先它们是纯内存的（依据第十一节「不做开关持久化」），后来发现不行：设置页存的
是**用户偏好**，DSH 一重启就退回代码默认值，用户改过的倒计时、唤醒词等于白改。
落盘只影响「默认值」，不改变优先级：调用参数仍然覆盖设置页的值。

**刻意没有「默认命令」。** 命令只能由调用方当次传入（`command` 本身可留空 =
纯重启）。一条留在设置页里的命令，最坏会在某次纯重启时被悄悄执行，而没人记得
自己设过它；工具里也没有回退到设置页取命令的逻辑。`GET /last-run` 里那个
`command` 是**上一次实际跑过的命令**（只读收据），不是默认值。

设置页另外附一块**只读的「现在在用」**（脚本路径、状态目录、插件日志、运行日志、
交接文件、上一次运行结果）和一段行为说明。理由：这个插件的真相散在四个文件里，
人想核对时不该靠翻会话。只读区不提供任何写入入口。

「上一次运行结果」读 `last-run.json`（脚本写的收据，不删），与「处理完即删」的
交接文件是两回事——前者回答「命令跑成什么样」，后者回答「还有没有欠账」。

## 十一、明确不做

- 对外 HTTP API。`/auto-restart/api/*` 只服务本插件自己的界面，不承诺兼容性
- 「必须观察到运行过」、「空闲确认 20 秒」
- 忙时自动等待/重试

~~开关持久化~~ 已改为**做**（第十节）：设置页承载的是用户偏好，重启一次就退回
代码默认值等于没设置过。

## 十二、待验证（动代码前必须先查清）

1. **会话 id 怎么取** —— ✅ 已查清：不用碰前端路由。工具执行上下文 `exec.agent`
   就是调用方的 Agent 实例，`exec.agent.id` 即会话 id。
2. **host 能否往指定会话投递消息** —— ✅ 能，且已实测。分层要说清：
   `sessionController` 服务暴露的是 `@Remote('prompt')` 那层，签名 `prompt(request, signal)`
   （`signal.throwIfAborted()` 只在受理前用；`source` 由它内部构造为
   `{ kind: 'user', rpcId: request.requestId }`）；它再调
   `commands.prompt(request, source)`，那一层才落到 `agent.steer/followup(message)`。
   所以插件侧只需传 `(request, signal)`。它的 `resolveAgent` 在 agent 不在时会自动
   `ctx.agents.resume()` 把冷会话拉起来；`ReactLoopAgent.followup()` 是"加一条下一轮
   提示词并唤醒"，正是唤醒该用的那个。
3. **subagent / 子查询在哪个服务里** —— ✅ 已查清，而且**不需要额外接线**。
   `subagents` 是独立服务（`sendMessage`/`listChildren`/`listDescendants`/`interrupt`），
   但子代理并不是藏在它里面的"另一种东西"：`dsh-agent-loop` 的
   `agents.enter(agent, parentAgent)`（`dsh-agent-loop/lib/index.js:1791`）会把每个
   子代理以 `owner = parentAgent` 的身份登记进同一个 `agents` 注册表，而
   `agents.list()` 返回的是 store 里的全部条目（`roots()` 才筛掉有 owner 的）。
   所以 `ctx.agents.list()` **本来就包含子代理**，`agent.status === 'running'` 一并覆盖。
   2026-10-23 实测：起一个占位子代理（`f9f588a2-09b0-4d4c-8484-cc3b3378ad9d`）后，
   `GET /auto-restart/api/probe` 的 `agents` 数组里它和主会话同时 `running`，
   `blockers` 里同时出现两条 `kind: 'agent'`。**故不注入 `subagents` 服务**。
   顺带加了 `/auto-restart/api/probe`（只读）：现扫一遍宿主，返回
   `{ at, blockers, agents: [{id, status}] }`，调试用；`/state` 只是状态机的记忆，
   不反映实时忙闲。
4. **CDP 注入的 keydown 如何与真实用户输入区分** —— ✅ 结论：**不区分，任何输入都取消**。
   做法：页面里同时装监听，再用 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`
   注入一次，最后让真人在同一页面按键、点鼠标，对比两边字段
   （探针脚本 `_probe/input-probe.mjs`，三档 `install` / `inject` / `dump`）。

   数据相当反直觉：

   | 字段 | CDP 注入 | 真人 | 能区分？ |
   | --- | --- | --- | --- |
   | `keydown.isTrusted` | `true` | `true` | ❌ |
   | `keydown.sourceCapabilities` | `{touch:false}` | `{touch:false}` | ❌ |
   | `pointerdown.pressure` | `0` | `0.5` | ✅（但**不用**） |

   键盘没有可靠判据（真人用中文输入法时 `code` 是空串、`keyCode` 是 `231`，
   注入的反而是规规矩矩的 `KeyA` / `65`）；鼠标唯一稳定差别是压力值。

   **但那个压力判据故意不采用**（用户 2026-10-23 明确纠正）：倒计时问的是
   「现在还有没有人在操作这台机器」，远程桌面、别的自动化工具、任何软件发来的
   输入，同样意味着有人在动它。跳过 `pressure=0` 的输入，等于给外部工具开一个
   偷跑的洞，方向是反的。而且唤醒已改走 Host 直投（`wakeMode: 'plugin'`），
   插件自己根本不会在倒计时里注入输入 —— 这个判据唯一可能的用途就是破坏这条语义。

   所以维持最保守的规则：**任何 `pointerdown` / `wheel` / `keydown` 都取消**，
   宁可多取消一次，也不要在有人正操作时把 DSH 杀掉。探针脚本留着，
   以后想复核"注入到底长什么样"时还能复跑。
5. **插件能否让 Electron 窗口全屏** —— ❌ 未验证。本版改用 `shell.overlay` 座位 +
   `position: fixed; inset: 0`，铺满整个框体，实测够用，也不再需要真全屏。
6. **网页端有没有唤醒的可能** —— ✅ 已解决：A 方案（Host 直投）跑在 Host 进程里，
   与界面是桌面端还是浏览器无关，网页端一样用。脚本侧也已支持
   （`-Mode web`：按端口定位进程杀、`dsh --profile web` 起、等端口响应判就绪）。

## 十三、文件布局（实际）

```
D:\DeepSeek Harness\dsh-auto-restart\
  DESIGN.md              本文件（唯一权威）
  README.md              用法
  SETUP.md               给 agent 的说明书：默认覆盖不到的环境怎么一次性配好
  package.json           插件包（dsh.bundle.patch + dsh.client）
  cordis.patch.yml       启用条目
  index.js               Host：工具 + 空闲判定 + 倒计时 + 计划门 + 拉脚本 + 状态路由
  client.js              Client：shell.overlay 上的倒计时页/终止页，settings.section 设置页
  lib/launch-plan.js     启动计划：从宿主自述算出「怎么再起来一次」，并校验
  scripts/Restart-DSH.ps1  真正动手：验计划 → 关 DSH → 跑命令 → 照计划启动 → 补交接状态
  scripts/Start-DSH.ps1    被上一个脚本调用：照计划启动，等就绪
  scripts/say.js         只在 wakeMode:'script' 时用：CDP 往输入框注入
  install.ps1            把插件装进 profile（-Profile web|desktop|both）
  locale/en.json         插件标题与描述
  icon.svg               图标
  test/idle-check.mjs    判定逻辑的离线单测（49 项，不需要 DSH）
  _probe/                开发期临时脚本与取证截图，**不属于**插件
```

Host/Client 主文件放包根（`index.js` / `client.js`），只有启动计划拆进 `lib/`。
原因：`import.meta.dirname` 读同目录 `package.json` 取包名最直接；官方模板本身
就是根目录布局，`lib/` 只放可以独立单测的纯函数。

## 十四、与现有脚本的关系

- `D:\DeepSeek Harness\dsh-tools\Restart-DSH.ps1` 是执行层，本插件**调用**它，不重写。
- 插件实际传的参数：`-Command <命令>`、`-AutoSay <唤醒词或空串>`、`-CommandTimeoutSec <秒>`、`-Detach`。
  用 `-Detach` 是因为脚本要在 8 秒后杀掉 DSH —— 而杀死 DSH 会连带杀死调用它的
  进程，所以必须让脚本把活交给计划任务里的独立进程，插件只等"注册成功"那一刻。
- `wakeMode: 'script'` 时 `-AutoSay` 传唤醒词（脚本走 CDP 注入）；
  `wakeMode: 'plugin'` 时传**空串** —— `Start-DSH.ps1` 看到空就不发，避免两边重复唤醒。
- 脚本把命令结果写进 `~/.dsh/dsh-auto-restart/last-run.json`
  （`{ at, exitCode, timedOut, command, summary }`）。插件重启后读它，才好在唤醒词后面
  补「（命令失败：退出码 N）」—— 结果产生在另一个进程里，不落盘就传不回来。
- **交接文件是唯一的会话 id 通路**：脚本不接 `-SessionId` 这类参数。
  插件自己把「唤醒谁、说什么」写进 `wake-request.json`，脚本只负责在后面补
  `phase` 与 `startedAt`（读-改-写，且只在现存阶段是 `starting` 时补）。

## 十五、实现进度（2026-10-24）

**已经跑通的**（都在真实 DSH 里验过，不是纸面结论）：

1. 工具 `restart_dsh` 注册成功 —— 装完当场出现在调用方 agent 的工具表里。
2. 状态路由 `GET /auto-restart/api/state` 返回 200，Client 能轮询到。
3. Client 座位 `shell.overlay` 上注册成功（inspect 里可见 `dsh-auto-restart-overlay`）。
4. **忙时判定**：先起一个后台任务再去调工具，倒计时走完后才判定；那一刻仍忙就
   返回 `busy`，提示页准确列出是哪个 job 在忙，且**没有**重启。
   （2026-10-24 修正：判定从「调用入口」移到「倒计时结束」，见第二节。）
5. **倒计时页**：毛玻璃卡片 + 60px 大数字，三行文案（`DSH 重启倒计时` /
   `XX 秒` / `本页面点击鼠标或按任意键取消`），**不放取消按钮**——按钮会主动招人
   去点，反而增加误触取消的机会；用户已亲眼确认；倒计时期间键鼠一动就取消，
   `cancelReason` 记为 `input`。
6. **端到端重启**：`echo end-to-end-ok` → 计划任务 `DSH-AutoRestart-20261023-214220`
   → 关掉 6 个 DSH 进程 → 命令退出码 `0` → 重新拉起 → CDP 注入唤醒词
   「已通过插件重启」，且**真的投进了本会话**（不是别的页面）。
7. 离线单测 `node test/idle-check.mjs`：30 项全过（真会话/后台任务/服务缺失/参数边界/
   倒计时走完拉脚本/命令可置空/唤醒词后缀的三种状态/BOM 容错/交接文件的读写与状态推进）。
8. **`wakeMode: 'plugin'` 直投唤醒**（2026-10-23 21:56 实测，第七节 A 方案的落地）：
   工具调用 → 判空闲 → 10 秒倒计时 → 写交接记录 → 拉脚本 → 关掉 6 个
   DSH 进程 → 执行 `echo plugin-wake-ok`（退出码 `0`）→ DSH 重启 → 新进程 `apply()`
   6 秒后用 `sessionController.prompt()` 投递 → **第 1 次尝试成功**，会话里直接多出
   一条 user 消息「插件直投成功，DSH 已重启」。全程 37 秒；记录投递后自动删除，
   未走 CDP、未碰页面 DOM。
   （当时代交文件还是单阶段的 `pending-wake.json`；之后按用户要求改成两阶段，
   见第七节。单阶段文件仍可读作兜底。）
9. **命令超时**（2026-10-23 22:30 实测）：故意跑一条卡住的命令
   `Start-Sleep -Seconds 300`、超时设 15 秒。日志实况：
   `22:30:17 执行命令` → `22:30:32 命令超时（15 秒没结束），中止并继续启动 DSH`
   → `22:30:32 重新启动 DSH` → `22:30:52 已清理计划任务`。命令进程树被杀干净、
   没有残留进程，`last-run.json` 落地 `{timedOut:true, exitCode:null, summary:"timeout"}`，
   唤醒词自动变成「唤醒词-超时测试（命令超时被中止）」。
10. **两阶段交接（starting → ready）端到端**（2026-10-23 23:00 实测）：手写一份
   `phase: "starting"` 的交接文件（模拟插件拉起脚本前的动作）→ `Restart-DSH.ps1 -Detach`
   → 脚本关掉 DSH、执行空命令、重新拉起 → 新进程 23:00:07 加载插件、23:00:08 注册路由
   → 23:00:13 读到 `ready` → `sessionController` **第 1 次尝试**投递成功 →
   `deliveredAt` 记为 1792767613728。投递出去的这句话就是本会话里那条「两阶段交接测试」，
   看起来与用户手打完全一致。
   （`starting` 这一步是手动写的，因为 `restart_dsh` 当时不在该会话的工具表里；
   插件自己写 starting 的代码路径与写这个文件完全相同，离线单测覆盖。）
   注：这次实测时文件里留下的是 `phase:"delivered"`；按用户后来定的清空规则，现在
   投递成功后文件会直接删掉，`delivered` 只剩读旧文件时的兼容分支。

11. **工具秒回 + 倒计时后台走**（2026-10-24）：`restart_dsh` 不再阻塞到倒计时结束，
    调用后立刻返回 `counting`，截止时间写进状态，页面自己走秒；到点后再判一次空闲。
    这样调用方这一轮能接着说，倒计时才真的起到「给它留时间说完」的作用。
    `timeoutMs` 随之从「最大倒计时 + 90 秒」降到 15 秒。
12. **页面画出来才起表**：触发时只挂牌 `awaitingViewer`，页面首次 `GET /state` 立刻
    落定 `deadline`（没人来看则 10 秒后兜底）。此前从触发到第一帧要吃掉近 1 秒，
    用户看到的是「设置 10 秒却从 9 开始」。
13. **关窗不影响流程**（2026-10-24 实测）：起表后直接把窗口关掉，倒计时照走、
    到点照常写交接文件、关进程、重启，唤醒词仍由新进程的插件投回来 ——
    因为表和判定都在 Host 里，唤醒也不经过页面。
14. **全链路耗时压到 17 秒左右**：纯重启跳过 8 秒静默、`wakeMode='plugin'` 时
    `Start-DSH.ps1` 不再等 60 秒调试端口（实测那一项曾白等 62 秒）、插件首次检查
    由 6 秒改为 800ms（实测 5.6 秒 → 1.5 秒）。剩下的约 4 秒是 Electron 冷启动。
15. **启动计划（1.1）**：`lib/launch-plan.js` 把宿主自述写成 `launch-plan.json`，
    脚本照它执行；「DSH 装在哪」不再需要回答。`argv` 重放对 npm / pnpm / shim 免疫。
16. **两道计划门（1.1）**：校验不过时，插件侧不写交接文件、脚本侧一个进程都不杀。
    这是「先杀再发现起不来」的唯一可靠防线。
17. **脱离进程树的三级阶梯（1.1）**：计划任务 → `schtasks` → WMI。实测某些机器上
    `Register-ScheduledTask` 直接 `Access is denied.`，单条路径的实现在那种机器上必然挂。
18. **网页端真机验证（1.1）**：`dsh web` 走 `node <bin.js> web` 重放，端口固定、
    标签页自己连回去；唤醒链路两种载体完全一样（交接文件 + `sessionController.prompt()`）。
19. **设置页补两个适配兜底（1.1）**：`launchCommand` 与 `allowAutoRestart`，
    检测不出「怎么再起来」时默认不自动重启，由 agent 照 `SETUP.md` 征得同意后再配。

**这一版和规格的偏差（都是先跑通再收紧）：**

- 客户端从"整页路由"改成了 `shell.overlay` 座位：座位是现成的、frame-wide、
  写在宿主主题里，比自建路由页省一整套壳。
- 倒计时页取消**不区分来源**：任何 `pointerdown` / `wheel` / `keydown` 都取消
  （第十二节第 4 条：压力判据故意不用，远程/自动化输入同样算有人在操作）。
- ~~没有设置页；默认值都是代码常量~~ → 已有「设置 → DSH 自动重启」五个默认值
  （唤醒方式、唤醒词、倒计时、超时、日志份数；**没有默认命令**，见第十节），
  已落盘到 `settings.json`（原先只在内存里，重启即丢，见第十节）；
  另加只读的「现在在用」与行为说明（第十节）。
- ~~工具 schema 暂时没有 `timeoutSec`~~ → 已有（10–3600，默认 600），
  并且真的接进了脚本（见十五.9）。

## 十六、下一步（按价值排序）

1. ~~**唤醒改成 Host 直投**~~ —— ✅ 已完成（`wakeMode: 'plugin'`，见七、十五.8）。
2. ~~**把 `subagents` 纳入空闲判定**~~ —— ✅ 结论是**不用改**：子代理以 `owner`
   身份登记在同一个 `agents` 注册表里，`agents.list()` 本来就看得到（十二.3 实测）。
   顺手加了 `/auto-restart/api/probe` 作实时调试口。
3. ~~**真人输入判定**（第十二节第 4 条）~~ —— ✅ 已查清并**决定不区分**：
   `isTrusted`/`sourceCapabilities` 都区分不了，鼠标 `pressure` 能区分但故意不用
   （远程/自动化输入同样意味着有人在操作）。任何输入一律取消。
   探针脚本留在 `_probe/input-probe.mjs`，随时可复跑。
4. ~~**设置页**~~ —— ✅ 已完成：「设置 → DSH 自动重启」，五个默认值（唤醒方式、唤醒词、
   倒计时、超时、日志份数；默认命令被有意去掉），`GET/POST /auto-restart/api/settings`，
   已落盘到 `settings.json`（逐字段兜底，坏文件不报错）；
   另加只读的「现在在用」与「上一次运行结果」（`GET /last-run`）。
5. ~~**命令超时**~~ —— ✅ 已完成（十五.9）。
6. ~~**发布**~~ —— ✅ 已公开：https://github.com/meng-lx/dsh-auto-restart（public，master），
   已向 awesome-dsh-plugin 提 PR（`#9003`）。仓库只进 README、SETUP、源码与脚本；
   `DESIGN.md`、`_probe/`、`test/` 由 `.gitignore` 排除。
   当时的 gate 只差「仓库满 1 天」这一条，24 小时后自动转绿。
7. **1.1 已合并回主目录**：`dsh-auto-restart-web` 里那份 `lib/launch-plan.js` 与两个
   重写的 `.ps1` 已替换主目录版本；`SETUP.md`、`install.ps1` 一并进入。
   （原 `HANDOFF.md` 的动机与踩坑已并入第十八节，文件本身已删除。）
   `45c9e32`（入口不再预扫）已同步，`test/idle-check.mjs` 49 项全过。
   下一步：把 1.1 推上 GitHub、更新 README 的口径、按 `WEB-CHECKLIST.md` 在网页端再走一遍。

## 十七、踩过的坑（省得再踩）

- **正式 bundle 的 Client 不能调 Host**：`host.call` 是动态插件专有通道。官方做法
  是 Host 注册 HTTP 路由、Client 用**同源相对路径** `fetch`。所以插件里那条
  `/auto-restart/api` 不是"对外 API"，是自家界面用的内部路由（第十一节仍然成立：
  不给外部脚本提供轮询接口）。
- **`ctx.inject(...)` 里必须用 `scope.effect(...)`**，不能图省事写
  `ctx.effect(() => ctx.inject(...))`：cordis 只收集 effect 的返回值，写错了
  热重载时座位/路由拆不干净，而 `slots.register` 与 `webServer.register` 对同一
  个 key 二次注册都会 throw。dsh-flow-v2 已经踩过一次，这次照抄了它的写法。
- **`jobs.list()` 不带参数只返回 unowned 的 job**：想查全进程忙闲必须逐个 owner
  调 `jobs.list(agentId)` 再合并。只查一次会把"别人的后台任务"当成空闲。
- **PowerShell 5.1 的中文输出是 GBK**：按 UTF-8 解会得到一屏问号，要先用严格
  UTF-8 试、失败了再退回 GBK（`TextDecoder` 两条路都支持）。
- **工具会阻塞整个回合**：`execute` 里等倒计时意味着 agent 那一轮一直挂着。这既是
  代价也是设计：判定放在倒计时之后，就是为了让「调用时有任务在跑、倒计时结束时跑完了」
  这种最常见的情况能顺利重启。必须尊重 `exec.signal`（用户按 Esc 中断时立刻收手，
  而不是继续等）。
- **`sessionController.prompt` 有两个同名层，别传错第二个参数**：`@Remote('prompt')`
  那层是 `prompt(request, signal)`，`signal` 只用于 `throwIfAborted()`；里面再调
  `commands.prompt(request, source)`，第二参数换成 `{ kind: 'user', rpcId }`。
  插件拿到的是前者，所以传 `AbortSignal` 是对的；把 `source` 传成 signal 会让
  `createUserMessage` 收到一个怪 source。
- **Host 半边改完不一定要重启 DSH**：`plugin_manager` 把本插件 `enabled: false`
  再 `true` 一遍就会重新 `apply()`（实测有效，比整个 Desktop 重启快得多）。
  `cordis.patch.yml` 里"改完必须重启"的注释对源码热重载来说过时了。
- **热重载 Client 能把整个 DSH 带崩**（2026-10-23 22:15 实测，代价是一次崩溃）：
  `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<时间>-web-boot.log` 里写着

      Error: web boot: 1 entry did not activate
      dsh-restart-idle: import failed (see console for the import error)

  即 Client bundle 导入失败 → web boot 少激活一个 entry → Electron 直接退出
  （新进程 16 秒后拉起，端口从 63131 变成 49933，页面上的会话是断的）。
  触发时机：**改完 `client.js` 立刻热重载**，bundle 处于半写状态或构建失败。
  Client 侧的异常会被 `__ModuleLoader__` 吞掉，日志里只剩"import failed"，
  真正原因得自己复现。
  防护两条：①改完先 `node --check client.js`；②再跑
  `node _probe/load-client.mjs`（离线用 React 替身把 `factory` 与 `apply`
  各跑一遍，能直接看到抛在哪一行），都过了再热重载。
- **别对正在跑的页面调 `Page.reload`**：DSH 的 web boot 会重新检查每个 entry，
  任何一次失败的导入都会变成"DSH 起不来"，而不会退化成"这一个插件没生效"。

## 十八、1.1 为什么这么改（决策记录）

这一节回答「为什么不是多写几条 if」，也是 1.1 那次改造的动机原文。

### 问题：旧实现把路径写死

`scripts/Start-DSH.ps1` 旧版按 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
启动，npm / pnpm / volta / scoop / 源码 装法全落空；而 `Restart-DSH.ps1` 是**先杀宿主再启动**，
于是"重启一次 = DSH 再也起不来"。

目标定成「上插件市场」后，这个前提就不成立了：两台电脑装法不同，同一台机器还会随用户
升级/换装而变。**多写几条 if 是在赌用户怎么装**，赌错一次的代价是 DSH 起不来。

### 关键认知：argv 重放对安装方式免疫

不管 `npm -g` 还是 pnpm 的 shim，node 进程里的 `process.argv` 都已经是
`["node", "<绝对路径>/@deepseek-ai/dsh/lib/bin.js", "web"]`，shim 只是转发。
所以「DSH 装在哪」这个问题**根本不用回答**——这也是为什么方案里没有一处是推断出来的路径。

### 三段式

```
宿主事实(hostFacts) → 启动计划(launch-plan.json) → 校验(validatePlan) → 计划门（不可用就不杀）
```

- **事实**：`lib/launch-plan.js: readHostFacts(webServer)` 读
  `process.argv / execPath / cwd / versions.electron / webServer.getOrigin() / profile / dsh 版本`，
  每次现读不缓存。
- **计划**：`buildLaunchPlan(facts, launchCommand)` 产出三种 mode——

  | mode | 何时 | exe | args | env |
  |---|---|---|---|---|
  | `web` | 非 Electron，或 Electron 里跑的入口是 DSH 自己 | `process.execPath` | `[entry, ...argv.slice(2)]` 原样重放 | Electron 里补 `ELECTRON_RUN_AS_NODE=1` |
  | `desktop` | Electron 且入口不是 DSH（官方桌面壳） | 外壳 exe | `[]` | **删掉** `ELECTRON_RUN_AS_NODE`（继承它会把桌面端拉成 node） |
  | `custom` | 设置了 `launchCommand` | `cmd.exe /d /s /c` | 用户那条命令 | — |

- **校验**：`validatePlan` 检查 exe/entry 文件存在、端口 0..65535。reason 取值：
  `no-plan / empty-command / unknown-mode / no-exe / exe-missing / entry-missing / bad-port`。
- **计划门**：两道。`Restart-DSH.ps1` 在 Sleep 与 kill 之前校验，不可用就 `throw` 并
  `Set-WakePhase failed`；插件侧 `finishCountdown()` 也先校验再落盘再 spawn。
  两道门保证「宁可重启失败，也不让 DSH 停在关闭状态」。

### 唯一的人工闸门：`needsSetup`

工具 `restart_dsh` 在 execute 里做两道前置门：

1. `allowAutoRestart=false` → `reason: "disabled"`（给「我被 systemd/pm2 托管」的用户让位）；
2. `validatePlan` 失败 → `reason: "needsSetup"`，并在 **message 里**（不是额外字段——
   `output.render` 只输出 message，agent 能看到的只有它）拼上完整宿主自述 + 三步指令：
   拼一条命令 → **在对话里问用户并说明「这条命令以后每次重启都会以你的权限执行」** →
   写进 `settings.json` 的 `launchCommand` 再来一次。

**禁止**：agent 自己静默写 `launchCommand`（它会读网页等不可信内容，等于持久化后门）、
改 `.ps1`、自己 `taskkill`、把 `allowAutoRestart=false` 当修复。细则见 `SETUP.md`。

### 两个实测坑

1. **触发方式决定 `sessionId`**。走工具时后端取 `exec.agent.id`，交接文件带得上会话 id，
   唤醒能投达；而裸 `POST /auto-restart/api/restart` 且 body 不带 `sessionId` 时，
   写出的请求 `sessionId` 是空串，新宿主会跳过唤醒 —— 表现为「重启成功但没人叫醒会话」。
   **验证唤醒必须走工具。**
2. **重放 argv 会把「开浏览器」一起重放**。`dsh web` 默认开浏览器，重放后每次重启多开
   一个标签页。`buildLaunchPlan` 的 web 分支已补：命令行里没有 `--no-open` 就追加。
   这一行只对**下一次**重启生效 —— 正在跑的进程用的是启动时加载的那份模块。

## 十九、1.2 为什么这么改（决策记录）

三件事，都是「补一个原本就存在的洞」，不是新功能。

### 19.1 状态路由加门禁

**问题**：`webServer.register` 收的是一个不处理 `Upgrade` 的简单 request handler，
没有 origin 门禁。而这个前缀下全是会改动状态的操作——取消倒计时、关提示页、写设置。
也就是说：你在浏览器里随便打开的任何网页，只要往 `http://127.0.0.1:<port>/auto-restart/api/cancel`
发一个 POST，就能把一次即将执行的重启取消掉，或者把设置改了。

对照：官方服务 `app://` 自带 `Origin` 校验、`WebServer.handleUpgrade` 拒绝任意跨界升级；
第三方插件拿到的是「降级到简单 handler」那个口子。

**顺带删掉的**：`POST /restart`（直接从 HTTP 触发一次完整重启）。
它当初是为了绕开「`restart_dsh` 在工具表里、却进不了模型看到的工具定义」而加的测试通道，
不是产品功能。1.2 起只认环境变量 `DSH_AUTO_RESTART_LOCAL_RESTART=1`，默认不存在。
理由：**能让外部凭空重启一次 DSH 的入口，不该出现在交给别人的代码里**。
而这个插件坚持「agent 全自动」——手动重启是别的插件该做的事，加进来只会多一份要维护的攻击面。

**改法**（`index.js` 的 `rejectUntrusted()`，注册时挂上）：
1. 来源地址必须是回环，且没有 `X-Forwarded-For` / `X-Real-IP`（有就说明前面有代理，
   `socket.remoteAddress` 是谁已不可信）；
2. 必须带 `X-Auto-Restart: 1`（跨站发自定义头必触发预检，预检过不了）；
3. 带了 `Origin` 时，必须与 `Host` 同源。

**定位**：只挡网页脚本。本机其它进程补个头就能调 —— 它们本来就有能力杀进程，
这里不假装能防住，也不值得加 token 增加复杂度。

### 19.2 判定项补两条：排队消息、已武装的定时提醒

**问题**：`agents.list()` 里 `status === 'idle'` 不等于「这一轮真的走完了」。
宿主 `dsh-desktop-host/lib/index.js:100` 的 `hasDesktopActiveTasks()` 已经把这件事说清楚了：

```js
function hasDesktopActiveTasks(liveAgents, jobs) {
  return liveAgents.some((agent) => agent.status === "running"
    || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
    || jobs.some(...)
    || scope.hasArmedSchedules()
}
```

队列被消费完之后状态才回到 idle，中间有一瞬间状态是 idle 但这一轮还没完。
定时提醒同理：已武装但还没触发时，没有任何 agent 在跑，只靠 `agents` + `jobs` 判不出来。

**改法**：
- 排队消息读 `agent.inbox.nextTurn` / `nextStep`，非空即算忙（`kind: 'queued'`）。
- 已武装的定时提醒走宿主自己的 `ctx.waterfall('workspace/session-activity', { sessionId })`，
  返回里有 `kind === 'schedule'` 的条目即算忙（`kind: 'schedule'`）。
  **没有**自己在插件里维护一份定时器账本：宿主已经有这个信息，自己再记一份必然会和它漂移。
- 瀑布抛错或取不到 → 当作「没挂东西」。宁可偶尔多放行一次，也不要让重启被一个
  取不到数据的接口永久卡死（这是「自己造成的 bug 比挡不住更严重」的取舍）。

### 19.3 关窗口：试过「先请求」，实测等不到，默认回到强杀

**问题**：`Restart-DSH.ps1` 原来是直接 `taskkill /F`。对 Electron 来说等于拔电源：
正常退出时主进程会做的收尾一概跳过。宿主自己的退出菜单用的是
`forceCloseWindows → waitForPersistence → app.quit()`，是给持久化留了时间的。

**改法**：新增 `-HostWaitSec`。先给主进程发 `WM_CLOSE`（走宿主自己的关闭路径），
再轮询进程是否退出；等不到才 `taskkill /F`。`CommandTimeoutSec` 那条路径同理。

**2026-10-26 实测：等不到，默认值已定为 0。**
日志证据（`scripts/logs/restart-20261026-122828.log`）：

```
12:28:29  请求关闭主进程 PID 15756（优雅，最多等 8 秒）
12:28:30    成功: 给进程发送了终止信号，进程的 PID 为 15756。
12:28:38  优雅关闭没等到，剩 6 个进程，改为强制结束（会话日志可能不完整）
```

信号确实发出去了，进程没退：DSH 收到 WM_CLOSE 后先做 2 秒退出检查，
判定后台有任务就弹确认框、窗口不关，而无人值守时那个框永远没人点。
同机对照（`restart-20261026-123357.log`）：不等 → 关闭耗 1 秒、脚本启动到 `ready` 6 秒；
等 8 秒 → 关闭耗 9 秒、启动到 `ready` 14 秒。所以默认 `-HostWaitSec 0`。

**代价**：默认不再给宿主留收尾时间（和 1.1 以前一样直接强杀）；
想在某台机器上再试可以显式传 `-HostWaitSec 8`。

## 二十、1.2 的版本与发布

- `package.json` → `1.2.0`，补 `license: MIT` + `LICENSE`（市场维护者合并时提的请求）。
- 测试 49 → 64 项：新增 L 组（门禁七条）、M 组（排队消息）、N 组（定时提醒）、
  O 组（瀑布抛错不误判）。

