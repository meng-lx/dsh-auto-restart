/**
 * dsh-auto-restart —— Host 半边。
 *
 * 只做四件事：
 *   1. 注册唯一的工具入口 `restart_dsh`；
 *   2. 判断**整个 DSH** 是否空闲（任一 agent 在跑 / 任一 job 在跑 = 忙）；
 *   3. 空闲时进入倒计时，倒计时期间任何真实键鼠输入都能取消；
 *   4. 倒计时走完 → 拉起外部脚本 `Restart-DSH.ps1 -Detach`，然后立刻返回。
 *
 * 插件**不碰进程**：杀端口、执行命令、重启、唤醒那一整套全在脚本里。
 * 插件也**不判断**脚本那边是否执行成功 —— 它只负责「什么时候可以动手」。
 *
 * 状态通过一条 fenced HTTP 路由暴露给 Client 半边（正式 bundle 的 Client 不能
 * 直接调 Host，`host.call` 是动态插件专有通道；官方做法就是 Host 注册路由、
 * Client 用 fetch 访问 —— 与本机 dsh-preset-switcher / dsh-flow-runtime 一致）。
 *
 * 注意：HTTP 路由只服务于**本插件自己的界面**，不是给外部脚本轮询的公开 API。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  buildLaunchPlan,
  planFilePath,
  readHostFacts,
  validatePlan,
  writePlanFile,
} from './lib/launch-plan.js'

/** 本插件包的根目录（本文件就在包根）。 */
const PACKAGE_ROOT = import.meta.dirname

/** 唯一的取名处：读本包 package.json 的 name，改包名不用改代码。 */
function readPackageName() {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name
  } catch {
    // 读不到就退回占位，绝不让取名失败拖垮插件
  }
  return 'dsh-auto-restart'
}

export const name = readPackageName()

/** `tools` 是核心服务，硬依赖安全；`webServer` 可能还没就绪 ⇒ 走 ctx.inject。 */
export const inject = ['tools']

/** 面板/状态 API 路径（只给本插件自己的 Client 用）。 */
const API_PATH = '/auto-restart/api'

/**
 * UI 端点的门禁：本机回环 + 自定义请求头 + 同源。
 *
 * 宿主的 webServer **不做** Origin / 鉴权检查（实测：带外源 Origin 的 POST 照样进得来），
 * 而 `/restart` 是能把整台 DSH 关掉的操作，不设门就等于本机随便哪个进程、随便哪个网页
 * 都能触发重启。三层：
 *   ① 带反向代理头的请求直接拒：说明来源已经过中间层，不可信；
 *   ② 来源必须是回环地址；
 *   ③ 必须带 `x-auto-restart: 1` —— 跨源请求带自定义头会先触发浏览器预检，而宿主
 *      不放行 CORS，所以别的网页打不进来（挡的是浏览器，不是本机的其它程序）；
 *   ④ 带了 Origin 就必须与 Host 同源（同源 fetch 不一定带 Origin，所以是「带了才查」）。
 */
const REQUEST_HEADER = 'x-auto-restart'

function checkRequestSource(req) {
  const headers = (req && req.headers) || {}
  for (const key of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
    if (headers[key] !== undefined) {
      return { ok: false, reason: `带了反向代理头 ${key}，来源不可信` }
    }
  }
  const addr = String((req && req.socket && req.socket.remoteAddress) || '')
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!loopback) return { ok: false, reason: `来源不是本机回环地址（${addr || '未知'}）` }
  if (String(headers[REQUEST_HEADER] ?? '') !== '1') {
    return { ok: false, reason: `缺少 ${REQUEST_HEADER} 请求头` }
  }
  const origin = String(headers.origin ?? '').trim()
  if (origin !== '') {
    let sameOrigin = false
    try {
      sameOrigin = new URL(origin).host === String(headers.host ?? '').trim()
    } catch {
      sameOrigin = false
    }
    if (sameOrigin !== true) return { ok: false, reason: `Origin 与 Host 不同源（${origin}）` }
  }
  return { ok: true }
}

/** 外部重启脚本。随包附带，默认取包内的 scripts/，可用 config.scriptPath 覆盖。 */
const DEFAULT_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'Restart-DSH.ps1')

/** 脚本默认唤醒词。 */
const DEFAULT_AUTOSAY = '已通过插件重启'

/**
 * 默认唤醒方式：'plugin' = Host 直投（不等渲染、不碰页面），'script' = 脚本用
 * CDP 往输入框打字（退路，要先等 React 挂载）。
 */
const DEFAULT_WAKE_MODE = 'plugin'

/** 默认倒计时秒数。 */
const DEFAULT_COUNTDOWN = 10

/** 倒计时允许的范围。 */
const MIN_COUNTDOWN = 3
const MAX_COUNTDOWN = 600

/**
 * 倒计时末尾多给的缓冲（毫秒）。
 *
 * 显示侧用 ceil - 1 向下取整，所以 10 秒实际等待 = 10000 + 这段缓冲，
 * 屏幕上仍然是 10→9→…→0 每个数字各占 1 秒，最后这点缓冲是快动手前的余量。
 * 不要给到 1000：那会让第一个数字之前先闪一个多余的值。
 */
const COUNTDOWN_TAIL_MS = 500

/**
 * 进入倒计时后，最多等多久让页面把自己画出来。
 *
 * 为什么要等：倒计时是给人看的，表从「人看见第一个数字」那一刻起才有意义。
 * 从 Host 决定倒计时到浏览器画出第一帧，中间还有一次轮询、一次渲染，
 * 实测能吃掉将近 1 秒 —— 设置 10 秒却从 9 秒开始数，就是这段时间。
 *
 * 兜底的意义：页面可能根本没开（纯 CLI、网页端标签页关了）。那时候不能永远等，
 * 超过这个时间就照常开始走。
 */
const VIEWER_WAIT_MS = 10_000

/** 自定义命令的超时默认值（秒），以及允许的范围。 */
const DEFAULT_TIMEOUT_SEC = 600
const MIN_TIMEOUT_SEC = 10
const MAX_TIMEOUT_SEC = 3600

/** 日志保留份数默认值，以及允许的范围。 */
const DEFAULT_LOG_KEEP = 5
const MIN_LOG_KEEP = 1
const MAX_LOG_KEEP = 50

/** 等脚本注册完计划任务并返回的上限。 */
const LAUNCH_TIMEOUT_MS = 30_000

/**
 * launching 状态的看门狗。
 *
 * 正常路径下走不到这里：脚本拉起后 8～16 秒就会把本进程杀掉，定时器根本没机会
 * 触发。它只兜一种情况——脚本已经被拉起、但重启始终没发生（脚本被外部杀掉、
 * 计划任务没跑起来、权限不足等）。没有它，状态会永远停在 launching，遮罩一直
 * 挂在页面上，而页面又拦着所有键鼠操作，人只能等下一次重启才能恢复。
 */
const LAUNCH_WATCHDOG_MS = 90_000

/**
 * 插件自己的状态目录（日志、待唤醒记录）。
 *
 * `DSHAR_STATE_DIR` 可覆盖：离线测试（`test/idle-check.mjs`）用它把日志和交接
 * 文件挪到临时目录，否则每跑一次测试都会往真正的 `plugin.log` 里插两行
 * 「已加载」，而 agent 排查时正是靠读这份日志。
 */
const STATE_DIR =
  typeof process.env.DSHAR_STATE_DIR === 'string' && process.env.DSHAR_STATE_DIR.trim().length > 0
    ? process.env.DSHAR_STATE_DIR.trim()
    : join(homedir(), '.dsh', 'dsh-auto-restart')

/** 日志目录。 */
const LOG_DIR = join(STATE_DIR, 'logs')

/**
 * 「重启后要唤醒谁、说哪句话」的落盘位置。
 *
 * 动手杀进程的脚本在**另一个进程**里，插件没法把内存里的东西交给它；
 * 而重启之后新进程需要知道该回到哪个会话。落一个 json 是最省事、也最经得起
 * 崩溃的方式：写不进去就别用 plugin 模式（见工具里的 wakeMode）。
 */
const PENDING_FILE = join(STATE_DIR, 'pending-wake.json')

/**
 * 两阶段交接文件：插件写前半（唤醒谁、说什么），脚本写后半（成没成、什么时候成的）。
 *
 * 为什么要分两次写：
 * - 插件在**被杀之前**必须先落盘，否则「唤醒谁」就丢了；
 * - 只有脚本知道 DSH 到底有没有被拉起来，所以「成没成 + 启动时间」只能由它写。
 *
 * 字段：`{ runId, phase: 'starting'|'ready'|'failed'|'delivered', sessionId, text, requestedAt, startedAt, error }`
 */
const WAKE_REQUEST_FILE = join(STATE_DIR, 'wake-request.json')

/**
 * 脚本跑完命令后的结果，由 `Restart-DSH.ps1` 写在同一个目录。
 *
 * 为什么要有这个文件：命令失败或超时也照样重启，这件事发生在**另一个进程**里，
 * 插件只有读它的结果，才能在唤醒词后面补一句「（命令失败：退出码 N）」。
 */
const RUN_RESULT_FILE = join(STATE_DIR, 'last-run.json')

/**
 * 设置页里那几项「默认值」的落盘位置。
 *
 * 为什么要落盘：它承载的是**用户偏好**，不是一次调用的参数。不存的话，DSH 一重启
 * 就退回代码默认值，用户改过的倒计时、唤醒词等于白改——踩过一次。
 */
const SETTINGS_FILE = join(STATE_DIR, 'settings.json')

/**
 * 启动计划：宿主把自己「怎么跑起来的」写在这，脚本照着它重启。
 *
 * 为什么不放在 settings.json 里：它是**观察结果**（argv/execPath/端口），不是偏好，
 * 每次重启前都要重写一遍；混进设置文件会让「用户改过什么」变得看不出来。
 * 生成逻辑在 `lib/launch-plan.js`，这里只负责落盘和路径传递。
 */
const PLAN_FILE = planFilePath(STATE_DIR)

/** 落盘记录的有效期：超过这个时间还没投递就当它陈旧了。 */
const PENDING_TTL_MS = 15 * 60 * 1000

/** 新进程起来后，最多花这么久去把欠下的那句唤醒词投递掉。 */
const WAKE_RETRY_MS = 120_000

/** 插件运行时状态。Client 每次轮询拿到的就是它。 */
function createState() {
  return {
    /** idle | counting | launching | blocked | idle-cancelled */
    phase: 'idle',
    /** counting 阶段的截止时间（epoch ms） */
    deadline: 0,
    /** 本次倒计时总秒数 */
    countdownSec: 0,
    /** 取消原因：input | api | abort */
    cancelReason: '',
    /** 将要执行的命令 */
    command: '',
    /** 唤醒词 */
    autoSay: '',
    /** 发起这次重启的会话 */
    sessionId: '',
    /** phase === 'blocked' 时：谁在忙 */
    blockers: [],
    /** 最近一次结果（给界面显示） */
    last: null,
  }
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 没有任何历史设置文件时，七项设置各取什么。 */
const SETTINGS_DEFAULTS = {
  autoSay: DEFAULT_AUTOSAY,
  timeoutSec: DEFAULT_TIMEOUT_SEC,
  countdownSec: DEFAULT_COUNTDOWN,
  logKeep: DEFAULT_LOG_KEEP,
  wakeMode: DEFAULT_WAKE_MODE,
  /**
   * 启动命令覆盖。空字符串 = 自动（宿主自述 + argv 重放），这是默认路径。
   * 只有重放不可行时（npx 缓存被清、自制 bat 包装、容器）才由 agent 写一条完整命令。
   */
  launchCommand: '',
  /** 总开关。false 时 `restart_dsh` 直接拒绝，连倒计时都不进。 */
  allowAutoRestart: true,
}

/**
 * 读回设置：以代码默认值打底，再用文件里**通过校验**的字段覆盖。
 *
 * 逐字段校验而不是整体信任——手工改坏的文件只该丢掉那一个字段，
 * 不该把其余四项一起打回默认；范围外的值按 clamp 收进来，而不是整份作废。
 */
function loadSettings() {
  const merged = { ...SETTINGS_DEFAULTS }
  const saved = readSettingsFile()
  if (!saved) return merged
  if (typeof saved.autoSay === 'string' && saved.autoSay.trim().length > 0) {
    merged.autoSay = saved.autoSay.trim().slice(0, 200)
  }
  if (saved.timeoutSec !== undefined) {
    merged.timeoutSec = clampInt(saved.timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC)
  }
  if (saved.countdownSec !== undefined) {
    merged.countdownSec = clampInt(saved.countdownSec, MIN_COUNTDOWN, MAX_COUNTDOWN, DEFAULT_COUNTDOWN)
  }
  if (saved.logKeep !== undefined) {
    merged.logKeep = clampInt(saved.logKeep, MIN_LOG_KEEP, MAX_LOG_KEEP, DEFAULT_LOG_KEEP)
  }
  if (saved.wakeMode === 'plugin' || saved.wakeMode === 'script') {
    merged.wakeMode = saved.wakeMode
  }
  if (typeof saved.launchCommand === 'string') {
    // 空串是合法值（= 回到自动），所以这里不判长度，只裁长度上限。
    merged.launchCommand = saved.launchCommand.trim().slice(0, 2000)
  }
  if (saved.allowAutoRestart === false || saved.allowAutoRestart === true) {
    merged.allowAutoRestart = saved.allowAutoRestart
  }
  return merged
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 读一个服务的 `list()`（原型方法要 bind，不能丢 this）。 */
function safeList(service) {
  if (!service || typeof service.list !== 'function') return []
  try {
    const list = service.list.bind(service)()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 收集「谁在忙」。
 * 取不到某个服务时**按忙处理** —— 宁可不动手，也不要杀正在干活的进程。
 */
/**
 * 插件自己创建的后台任务 / 子代理 —— 它们不算阻塞项，否则插件会把自己锁死。
 * 目前插件不建任何 job；留着这个集合，是为了以后真加了也不会自锁。
 */
const OWN_JOB_IDS = new Set()

/**
 * 现在有哪些东西在忙。
 *
 * 这里**不排除调用工具的那个 agent**：规则是「倒计时结束时除了插件自己，
 * 谁在跑都不重启」。工具已经秒回、本轮回复也发完了，它要是还在 running，
 * 说明这一轮确实没说完，该拦。
 */
async function collectBlockers(services) {
  const blockers = []
  let sawAgentService = false
  const roster = []

  const agents = services.agents
  if (agents) {
    sawAgentService = true
    for (const agent of safeList(agents)) {
      if (!agent) continue
      roster.push(agent)
      let status
      try {
        status = agent.status
      } catch {
        status = 'running' // 读不到状态 = 当它在跑
      }
      if (status === 'running') {
        blockers.push({ kind: 'agent', id: String(agent.id ?? ''), label: '有会话正在跑' })
      }
    }
  }
  if (!sawAgentService) {
    blockers.push({ kind: 'agent', id: '', label: '拿不到 agents 服务，无法确认空闲' })
  }

  // 排队消息：agent 看起来 idle，但信箱里压着一条，这时候动手就是把它吞了。
  // 判据对齐宿主自己的 hasDesktopActiveTasks（dsh-desktop-host/lib/index.js:100）。
  for (const agent of roster) {
    let queued = 0
    try {
      const inbox = agent.inbox || {}
      queued = (inbox.nextTurn?.length ?? 0) + (inbox.nextStep?.length ?? 0)
    } catch {
      queued = 0
    }
    if (queued > 0) {
      blockers.push({ kind: 'queued', id: String(agent.id ?? ''), label: '有排队消息待处理' })
      break
    }
  }

  // 已武装的定时提醒：到点会真的开跑，也算「有人在等这台机器」。
  // 宿主只在退出检查里查这个（quit-inspection），这里照抄同一条瀑布。
  if (roster.length > 0 && typeof services.sessionActivity === 'function') {
    for (const agent of roster) {
      const rows = await services.sessionActivity(agent.id)
      if (!Array.isArray(rows)) continue
      if (rows.some((entry) => entry && entry.kind === 'schedule')) {
        blockers.push({ kind: 'schedule', id: String(agent.id ?? ''), label: '有已武装的定时提醒' })
        break
      }
    }
  }

  const jobs = services.jobs
  if (jobs) {
    const seen = new Map()
    const remember = (list) => {
      for (const job of list ?? []) {
        if (job && job.id !== undefined) seen.set(job.id, job)
      }
    }
    remember(safeList(jobs))
    for (const agent of safeList(services.agents)) {
      if (!agent || agent.id === undefined) continue
      try {
        remember(jobs.list ? jobs.list.bind(jobs)(agent.id) : [])
      } catch {
        // 查不动的那个 owner 忽略掉即可；agents 那边已经覆盖了它的忙闲
      }
    }
    for (const job of seen.values()) {
      if (job.status === 'running' || job.status === 'stopping') {
        // 插件自己起的任务不算忙，否则它永远等不到自己空闲。
        if (job.id !== undefined && OWN_JOB_IDS.has(String(job.id))) continue
        // 后台任务的 label 常常是整段命令：取首行 + 截断，否则提示页会被撑爆
        const raw = String(job.label || job.kind || '后台任务')
        const label = raw.split('\n')[0].trim().slice(0, 60)
        blockers.push({
          kind: 'job',
          id: String(job.id),
          label: label.length > 0 ? label : '后台任务',
        })
      }
    }
  }

  return blockers
}

/**
 * Windows PowerShell 5.1 往控制台写中文用的是 OEM 代码页（本机 936 = GBK），
 * 按 UTF-8 直接解会得到一屏问号。先按**严格** UTF-8 试一次（纯 ASCII 和本来
 * 就是 UTF-8 的输出都能过），解不了才退回 GBK。
 */
function decodeConsole(buffer) {
  if (buffer.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

/**
 * 拉起外部脚本。
 * `-Detach` 让脚本自己注册计划任务、把真正的工作交给独立进程，然后立刻返回；
 * 所以这里通常 1-2 秒就能拿到退出码。
 *
 * `-Mode` 不传：脚本自己判断载体（有主窗口=桌面端，没有=网页端）。
 * `-WebPort` 传当前端口：网页端重启后必须绑回同一个端口，页面才连得回来。
 *
 * `planPath` 是**必给**的：脚本只照计划执行，不再自己猜 dsh 装在哪。
 * 没有计划就什么都不杀（见 `finishCountdown` 的校验门）。
 */
function launchScript(scriptPath, command, autoSay, commandTimeoutSec, webPort, planPath) {
  return new Promise((resolve) => {
    let settled = false
    /** 收集原始字节，最后再决定用哪种编码解 —— 见 decodeConsole 的注释。 */
    const chunks = []
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const scriptArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Command',
      command,
      '-AutoSay',
      autoSay,
      '-CommandTimeoutSec',
      String(commandTimeoutSec),
      '-Detach',
    ]
    if (Number.isInteger(webPort) && webPort > 0) {
      scriptArgs.push('-WebPort', String(webPort))
    }
    if (typeof planPath === 'string' && planPath.length > 0) {
      scriptArgs.push('-PlanPath', planPath)
    }
    // 把自己的 pid 交给脚本：载体（桌面端/网页端）由脚本猜会猜错 ——
    // 两个实例并存时「有窗口=桌面端」这条判据会把网页端内核一起杀掉。
    // 直接告诉它「我就在这个进程里」，脚本就能精确判定、精确关进程。
    scriptArgs.push('-OwnerPid', String(process.pid))

    let child
    try {
      child = spawn('powershell.exe', scriptArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      finish({ ok: false, error: '拉起脚本失败：' + String(err) })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 杀不掉也没关系，下面照样给结论
      }
      finish({ ok: false, error: `脚本 ${LAUNCH_TIMEOUT_MS / 1000} 秒内没有返回` })
    }, LAUNCH_TIMEOUT_MS)

    if (child.stdout) child.stdout.on('data', (chunk) => chunks.push(chunk))
    if (child.stderr) child.stderr.on('data', (chunk) => chunks.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: '脚本进程异常：' + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, output: decodeConsole(Buffer.concat(chunks)).slice(-4000) })
    })
  })
}

// ── 待唤醒记录：跨进程交接 ────────────────────────────────────────────
// 写：倒计时走完、拉起脚本之前；读：新进程 apply() 之后。
//
// 两阶段协议：插件写「唤醒谁、说什么」，脚本补「成没成、什么时候成的」。
// 只有读到 ready 才真正投递 —— 脚本没成功拉起 DSH 时，投递也投不到。

function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 这些 json 有一半是外部脚本写的，而 Windows PowerShell 5.1 的
 * `Set-Content -Encoding UTF8` **会写 BOM**；`JSON.parse` 遇到 BOM 直接抛
 * `Unexpected token ''`。脚本那边已经改成无 BOM 写入了，这里再兜一层，
 * 免得旧文件或别人手写的文件把唤醒流程卡死。
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function parseJsonFile(file) {
  return JSON.parse(stripBom(readFileSync(file, 'utf8')))
}

/**
 * 读设置文件。**任何异常都返回 `null`**：设置是最不该让插件起不来的一类数据，
 * 文件不存在、权限不够、内容被人手改坏，一律当作「没设过」，由代码默认值兜底。
 */
function readSettingsFile() {
  try {
    const raw = parseJsonFile(SETTINGS_FILE)
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * 写设置文件。失败只返回 `false`，**不影响内存里已经生效的值**——
 * 用户刚点的保存，不该因为磁盘问题而看起来没生效。
 */
function writeSettingsFile(value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function writeWakeRequest(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(WAKE_REQUEST_FILE, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function readWakeRequest() {
  try {
    const parsed = parseJsonFile(WAKE_REQUEST_FILE)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      runId: typeof parsed.runId === 'string' ? parsed.runId : '',
      phase: typeof parsed.phase === 'string' ? parsed.phase : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '',
      text: typeof parsed.text === 'string' ? parsed.text : '',
      requestedAt: typeof parsed.requestedAt === 'number' ? parsed.requestedAt : 0,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      deliveredAt: typeof parsed.deliveredAt === 'number' ? parsed.deliveredAt : 0,
      error: typeof parsed.error === 'string' ? parsed.error : '',
    }
  } catch {
    return null
  }
}

function clearWakeRequest() {
  try {
    rmSync(WAKE_REQUEST_FILE, { force: true })
  } catch {
    // 删不掉就留着，靠 runId 去重
  }
}

/**
 * 交接文件是**一次性的**：插件一旦看过，不论最后有没有投出去，都把它删掉。
 *
 * 用户定下的模型：**只保留最近一次的运行状态，做完就改状态**。最初的做法是投递成功后
 * 把 phase 改成 `delivered` 留着，但那样会留下一个「已经处理完」的残骸，下次启动还得
 * 再判一次它到底做过没做。清空更干净：
 * - 文件在 = 有欠账（要么还没到 ready，要么还没投出去）；
 * - 文件不在 = 没有欠账。
 * 投递失败也删，宁可漏一次唤醒，也不让一份过期的欠条在下次启动时被误投出去。
 */

/** 旧版单阶段记录：只读不写，留给升级前留下的文件兜底。 */
function readPendingWake() {
  try {
    const parsed = parseJsonFile(PENDING_FILE)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function clearPendingWake() {
  try {
    rmSync(PENDING_FILE, { force: true })
  } catch {
    // 删不掉就留着，下次启动多半还能用
  }
}

/**
 * 读脚本写下的命令执行结果。没跑命令、或文件还没写出来，都返回 null。
 *
 * 字段：`{ at: 毫秒, exitCode: 数字|null, timedOut: 布尔, command: 字符串 }`
 */
function readRunResult() {
  try {
    const parsed = parseJsonFile(RUN_RESULT_FILE)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      timedOut: parsed.timedOut === true,
      command: typeof parsed.command === 'string' ? parsed.command : '',
    }
  } catch {
    return null
  }
}

/**
 * 按脚本的执行结果，给唤醒词补一句后缀。
 *
 * 只认**这次**的结果：`result.at` 必须不早于待唤醒记录的写入时间，
 * 否则就是上一轮留下的旧账，补上去只会让人误会。
 */
function decorateWakeText(text, sinceAt, reader = readRunResult) {
  const result = reader()
  if (!result || result.at < sinceAt) return text
  if (result.timedOut) return `${text}（命令超时被中止）`
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `${text}（命令失败：退出码 ${result.exitCode}）`
  }
  return text
}

/**
 * 把上一轮欠下的那句唤醒词投递到原会话。
 *
 * 入口只看两件事：有交接文件就走两阶段协议（等脚本写 ready 再发），
 * 只有旧的 pending-wake.json 才走单阶段兜底。
 */
async function deliverPendingWake(getService, log) {
  const request = readWakeRequest()
  if (request && request.sessionId && request.runId) {
    await deliverTwoPhase(request, getService, log)
    return
  }
  await deliverLegacyPending(getService, log)
}

/**
 * 两阶段交接文件的主流程：等 ready → 投递 → 把状态改成 delivered。
 *
 * 为什么不能读到 starting 就发：DSH 还没起来，`sessionController` 根本不在，
 * 发出去只会白等；而且脚本失败时（failed）压根不该发。
 *
 * 「只投一次」不靠账本，靠 phase 自己：投完立刻改成 `delivered`，
 * 下次启动读到 delivered 就什么都不做。
 */
async function deliverTwoPhase(request, getService, log) {
  const requestedAt = request.requestedAt > 0 ? request.requestedAt : Date.now()
  if (Date.now() - requestedAt > PENDING_TTL_MS) {
    clearWakeRequest()
    log(`交接文件里的请求是 ${Math.round((Date.now() - requestedAt) / 60000)} 分钟前的，已过期，丢弃`)
    return
  }

  let phase = request.phase
  log(`发现交接文件：runId ${request.runId}，阶段 ${phase || '空'}，目标会话 ${request.sessionId}`)

  if (phase === 'delivered') {
    clearWakeRequest()
    log('这轮唤醒已经投递过了（旧版留下的 phase = delivered，已删除）')
    return
  }

  if (phase === 'failed') {
    log(`上一轮重启失败（${request.error || '原因未知'}），不唤醒`)
    clearWakeRequest()
    return
  }

  const deadline = Date.now() + WAKE_RETRY_MS
  let attempt = 0
  let delay = 250
  let lastError = ''

  while (Date.now() < deadline) {
    attempt += 1

    if (phase !== 'ready') {
      const fresh = readWakeRequest()
      if (fresh && fresh.runId === request.runId) {
        phase = fresh.phase
        if (fresh.phase === 'failed') {
          log(`重启失败（${fresh.error || '原因未知'}），不唤醒`)
          clearWakeRequest()
          return
        }
        if (fresh.startedAt > 0) request.startedAt = fresh.startedAt
      }
      if (phase !== 'ready') {
        lastError = `脚本还没写 ready（当前 ${phase || '空'}）`
        await sleep(delay)
        delay = Math.min(2000, delay * 2)
        continue
      }
      log(
        `交接文件已就绪（第 ${attempt} 次检查）：DSH 启动于 ${new Date(
          request.startedAt > 0 ? request.startedAt : Date.now(),
        ).toISOString()}`,
      )
    }

    const base = request.text.trim().length > 0 ? request.text.trim() : DEFAULT_AUTOSAY
    const text = decorateWakeText(base, requestedAt)
    if (await pushWake(getService, log, request.sessionId, text, attempt)) {
      clearWakeRequest()
      log(`已投递，交接文件已删除（runId ${request.runId}）`)
      return
    }
    lastError = '服务还没就绪'
    await sleep(delay)
    delay = Math.min(2000, delay * 2)
  }

  log(
    `唤醒没成功：${WAKE_RETRY_MS / 1000} 秒内没能把「${request.text || DEFAULT_AUTOSAY}」投给会话 ${
      request.sessionId
    }（最后一次：${lastError}）`,
  )
  clearWakeRequest()
  log('交接文件已删除：宁可漏这一次，也不留一份过期的欠条给下次启动')
}

/** 旧版单阶段记录（升级前留下的 pending-wake.json）——只投递，不再写新文件。 */
async function deliverLegacyPending(getService, log) {
  const pending = readPendingWake()
  if (!pending) return

  const at = typeof pending.at === 'number' ? pending.at : 0
  if (Date.now() - at > PENDING_TTL_MS) {
    clearPendingWake()
    log(`发现一条 ${Math.round((Date.now() - at) / 60000)} 分钟前的待唤醒记录，已过期，丢弃`)
    return
  }

  const sessionId = typeof pending.sessionId === 'string' ? pending.sessionId.trim() : ''
  if (!sessionId) {
    clearPendingWake()
    log('待唤醒记录里没有会话 id，丢弃')
    return
  }

  const base = typeof pending.text === 'string' && pending.text.trim().length > 0 ? pending.text.trim() : DEFAULT_AUTOSAY
  const text = decorateWakeText(base, at)

  const deadline = Date.now() + WAKE_RETRY_MS
  let attempt = 0
  let delay = 250
  while (Date.now() < deadline) {
    attempt += 1
    if (await pushWake(getService, log, sessionId, text, attempt)) {
      clearPendingWake()
      return
    }
    await sleep(delay)
    delay = Math.min(2000, delay * 2)
  }
  log(`唤醒没成功：${WAKE_RETRY_MS / 1000} 秒内没能把「${text}」投给会话 ${sessionId}；记录留在 ${PENDING_FILE}`)
}

/**
 * 真正把一句话投进会话。成功返回 true。
 *
 * 优先 `sessionController.prompt()` —— 它会自己把冷会话 resume 起来；
 * 没有这个服务时退回 `agent.followup()`，但那要求 agent 已经在跑，只当兜底。
 */
async function pushWake(getService, log, sessionId, text, attempt) {
  try {
    const controller = getService('sessionController')
    if (controller && typeof controller.prompt === 'function') {
      const requestId = `auto-restart-wake-${Date.now()}-${attempt}`
      // 签名是 prompt(request, signal)：signal 只用来在**受理前**中断，
      // 受理之后就交给 agent 了，所以这里给一个永不触发的中断器。
      await controller.prompt(
        { sessionId, content: [{ type: 'text', text }], requestId },
        new AbortController().signal,
      )
      log(`唤醒完成：已用 sessionController 把「${text}」投递给会话 ${sessionId}（第 ${attempt} 次尝试）`)
      return true
    }

    const agent = getService('agents')?.get?.(sessionId)
    if (agent && typeof agent.followup === 'function') {
      await agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      log(`唤醒完成：已用 agent.followup 把「${text}」投递给会话 ${sessionId}（第 ${attempt} 次尝试）`)
      return true
    }
    return false
  } catch (err) {
    log(`唤醒尝试失败（第 ${attempt} 次）：${String(err?.message ?? err)}`)
    return false
  }
}

function createLogger(options = {}) {
  let file = ''
  const keep = () => {
    const value = typeof options.keep === 'function' ? Number(options.keep()) : DEFAULT_LOG_KEEP
    if (!Number.isFinite(value)) return DEFAULT_LOG_KEEP
    return Math.max(MIN_LOG_KEEP, Math.min(MAX_LOG_KEEP, Math.trunc(value)))
  }
  /** 只留最近 N 个流程日志（文件名里的 stamp 是可按字典序排的）。 */
  const prune = () => {
    try {
      const names = readdirSync(LOG_DIR)
        .filter((name) => name.startsWith('restart-') && name.endsWith('.log'))
        .sort()
      const extra = names.length - keep()
      for (let i = 0; i < extra; i += 1) {
        try {
          unlinkSync(join(LOG_DIR, names[i]))
        } catch {
          // 删不掉就留着，不影响这次流程
        }
      }
    } catch {
      // 目录还不存在时无需清理
    }
  }
  const write = (to, text) => {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      if (!file) file = join(LOG_DIR, `restart-${stamp()}.log`)
      appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    } catch {
      // 日志失败绝不能让插件挂掉
    }
    void to
  }
  return {
    /** 开始一次新流程 = 换一个新文件（顺手清掉超出保留份数的旧文件） */
    begin() {
      prune()
      file = join(LOG_DIR, `restart-${stamp()}.log`)
      return file
    },
    line(text) {
      write('log', text)
    },
    file() {
      return file
    },
  }
}

function jsonResponse(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch {
    // 连接已经断了就算了
  }
}

async function readJsonBody(req) {
  if (typeof req[Symbol.asyncIterator] !== 'function') return {}
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function apply(ctx, config = {}) {
  // 加载痕迹：热重载时最容易出问题的地方就是这里“悄悄没跑”，
  // 所以每一步都往 plugin-load.log 里落一行。写不进去也不影响插件。
  const trace = (text) => {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      appendFileSync(
        join(LOG_DIR, 'plugin-load.log'),
        `[${new Date().toISOString()}] ${text}\n`,
        'utf8',
      )
    } catch {
      // ignore
    }
  }

  trace(`apply 开始 pid=${process.pid}`)

  const log = (message) => {
    const line = `[${name}] ${message}`
    try {
      ctx.logger?.info?.(line)
    } catch {
      // ignore
    }
    try {
      console.log(line)
    } catch {
      // ignore
    }
    // 再落地一份：宿主控制台在重启、崩溃之后就没了，文件还能查。
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      appendFileSync(
        join(LOG_DIR, 'plugin.log'),
        `[${new Date().toISOString()}] ${message}\n`,
        'utf8',
      )
    } catch {
      // ignore
    }
  }

  const scriptPath =
    typeof config.scriptPath === 'string' && config.scriptPath.trim().length > 0
      ? config.scriptPath.trim()
      : DEFAULT_SCRIPT

  const state = createState()

  /**
   * 设置页存的「默认值」。**落盘**在 `SETTINGS_FILE`，启动时读回，
   * 缺字段或读坏一律用代码默认值兜底（见 `readSettingsFile`）。每次调用仍以工具参数为准。
   *
   * 刻意**没有** `command`：命令只能由调用方当次传入，不能有「默认命令」。
   * 一条留在设置页里的命令，在最坏的情况下会在某次纯重启时被悄悄执行，
   * 而没人记得自己设过它。工具里也没有回退到这里的逻辑。
   */
  const settings = loadSettings()

  /**
   * 只读的「现状」：设置页要显示的不只是可编辑的默认值，还有它到底在用
   * 哪个脚本、把日志写到哪、交接文件叫什么。这些不给改，只用来对照。
   */
  const settingsMeta = () => ({
    wakeModes: [
      { value: 'plugin', label: '插件直投（推荐）', hint: 'Host 直接往会话发，不碰页面，不用等渲染' },
      { value: 'script', label: '脚本页面输入（退路）', hint: 'CDP 往输入框打字，要先等 12 秒渲染' },
    ],
    scriptPath,
    stateDir: STATE_DIR,
    logDir: LOG_DIR,
    logs: {
      plugin: join(LOG_DIR, 'plugin.log'),
      run: join(LOG_DIR, 'restart-*.log'),
    },
    files: {
      wakeRequest: WAKE_REQUEST_FILE,
      lastRun: RUN_RESULT_FILE,
      plan: PLAN_FILE,
      settings: SETTINGS_FILE,
    },
    limits: {
      countdownSec: [MIN_COUNTDOWN, MAX_COUNTDOWN],
      timeoutSec: [MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC],
      logKeep: [MIN_LOG_KEEP, MAX_LOG_KEEP],
    },
    defaults: {
      autoSay: DEFAULT_AUTOSAY,
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      countdownSec: DEFAULT_COUNTDOWN,
      logKeep: DEFAULT_LOG_KEEP,
      wakeMode: DEFAULT_WAKE_MODE,
      launchCommand: '',
      allowAutoRestart: true,
    },
  })

  /** 把一次 POST 的载荷校验后并进 settings，返回本次实际改动的项。 */
  const applySettings = (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const changed = []
    if (typeof p.autoSay === 'string') {
      const text = p.autoSay.trim().slice(0, 200)
      settings.autoSay = text.length > 0 ? text : DEFAULT_AUTOSAY
      changed.push('autoSay')
    }
    if (p.timeoutSec !== undefined) {
      settings.timeoutSec = clampInt(p.timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC)
      changed.push('timeoutSec')
    }
    if (p.countdownSec !== undefined) {
      settings.countdownSec = clampInt(p.countdownSec, MIN_COUNTDOWN, MAX_COUNTDOWN, DEFAULT_COUNTDOWN)
      changed.push('countdownSec')
    }
    if (p.logKeep !== undefined) {
      settings.logKeep = clampInt(p.logKeep, MIN_LOG_KEEP, MAX_LOG_KEEP, DEFAULT_LOG_KEEP)
      changed.push('logKeep')
    }
    if (p.wakeMode === 'plugin' || p.wakeMode === 'script') {
      settings.wakeMode = p.wakeMode
      changed.push('wakeMode')
    }
    if (typeof p.launchCommand === 'string') {
      // 空串也接受：那是「清掉覆盖、回到自动」的合法写法。
      settings.launchCommand = p.launchCommand.trim().slice(0, 2000)
      changed.push('launchCommand')
    }
    if (p.allowAutoRestart === false || p.allowAutoRestart === true) {
      settings.allowAutoRestart = p.allowAutoRestart
      changed.push('allowAutoRestart')
    }
    // 内存里先生效，再落盘：写盘失败只是"下次重启会丢"，不该让这次保存看起来没成功。
    if (changed.length > 0 && !writeSettingsFile(settings)) {
      logger.line(`设置写盘失败（${SETTINGS_FILE}），本次仍按新值工作，但下次启动会回落到文件里的旧值`)
    }
    return changed
  }

  const logger = createLogger({ keep: () => settings.logKeep })
  /** 取消来源：'' | 'input'（前端检测到键鼠）| 'api'（直接调接口）| 'abort'（会话中断） */
  let cancelSource = ''

  const setState = (patch) => {
    Object.assign(state, patch)
    // 只要离开 counting，「等页面起表」这件事就作废，别让残留标志把下一次重启卡在
    // 「永远等页面」。正常情况下 beginFromViewer 会先把它清掉。
    if (patch && patch.phase && patch.phase !== 'counting') awaitingViewer = false
  }

  const getService = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }

  const services = {
    get agents() {
      return getService('agents')
    },
    get jobs() {
      return getService('jobs')
    },
    // 脚本重启网页端时要绑回同一个端口：cookie 和页面地址都绑在 host:port 上，
    // 换端口等于把已经开着的页面全废掉。
    get webServer() {
      return getService('webServer')
    },
    /**
     * 某个会话上「还挂着什么」（定时提醒走这条瀑布）。
     *
     * 宿主自己的退出检查就是这么问的（dsh-desktop-host 的 quit-inspection），
     * 查不到就当没有：宁可漏一条提醒，也不要因为瀑布没就绪把重启永久卡死。
     */
    async sessionActivity(sessionId) {
      try {
        if (typeof ctx.waterfall !== 'function') return []
        const rows = await ctx.waterfall(
          'workspace/session-activity',
          { sessionId },
          () => Promise.resolve([]),
        )
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },
  }

  /**
   * 宿主的自我描述，每次用都现读。
   *
   * 不缓存的原因：端口可能被桌面壳换掉、profile 可能被 rescue 换过、
   * 进程 cwd 也可能在会话里被切走。缓存一份等于拿旧事实去杀进程。
   */
  const hostFacts = () => readHostFacts(services.webServer)

  const snapshot = () => ({
    phase: state.phase,
    deadline: state.deadline,
    // 页面据此判断「表还没起」：此时显示完整秒数、不跳动，等 Host 定死 deadline 再走。
    awaitingViewer,
    countdownSec: state.countdownSec,
    cancelReason: state.cancelReason,
    command: state.command,
    autoSay: state.autoSay,
    blockerCount: state.blockers.length,
    blockers: state.blockers.slice(0, 8),
    last: state.last,
    message: state.message || '',
    now: Date.now(),
    // 调试用：确认宿主把端口交出来了（网页端重启要绑回这个值）
    port: services.webServer?.port ?? 0,
  })

  /**
   * 后台倒计时句柄。
   *
   * 为什么不用 await 把工具挂住：工具没返回时，调用它的那一轮 agent 永远是
   * running。而规则是「倒计时结束时除了插件自己，谁在跑都不重启」——
   * 挂住就等于永远把自己判成忙，一次也重启不了。所以工具立刻返回，
   * 秒数由插件在后台走，走完再判。
   *
   * 副作用是好的：这几十秒里 agent 可以继续把这一轮说完。
   */
  let countdownTimer = null
  /** 已排队、等倒计时走完的那一次重启。 */
  let pendingRestart = null
  /**
   * 倒计时是否还没起表（等页面把自己画出来）。
   *
   * 起表前 deadline 是 0，页面显示的是完整的设置秒数、且不跳动；
   * 页面第一次来读状态（或主动报到）时才把 deadline 定死，从那以后才开始倒数。
   */
  let awaitingViewer = false
  /** 进入「等页面」状态的时刻，用于兜底超时。 */
  let viewerArmedAt = 0

  const stopCountdown = () => {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }

  /** 取消：状态与日志只在这里改，保证页面看到的和日志写的是同一件事。 */
  const cancelCountdown = (reason) => {
    stopCountdown()
    pendingRestart = null
    const why =
      reason === 'input' ? '检测到键鼠输入' : reason === 'abort' ? '会话被中断' : '收到取消请求'
    logger.line(`倒计时取消（${reason}）：${why}`)
    setState({
      phase: 'cancelled',
      deadline: 0,
      cancelReason: reason,
      last: { at: Date.now(), ok: false, reason },
      message: `倒计时被取消（${why}），这次重启没有执行。`,
    })
  }

  /** 倒计时走完的唯一出口：此刻才判「整台机器现在能不能停」。 */
  const finishCountdown = async () => {
    const pending = pendingRestart
    pendingRestart = null
    if (!pending) return
    const { command, autoSay, timeoutSec, sessionId } = pending
    let wakeMode = pending.wakeMode

    // 倒计时走完了：这时候才真正判定「整台机器现在能不能停」。
    // 之所以放在这里而不是调用入口，是因为倒计时本身就是给在跑的任务的收尾窗口——
    // 调用时正忙、倒计时结束时已经跑完，就是可以重启的；反之就该放弃。
    const blockersAtEnd = await collectBlockers(services)
    if (blockersAtEnd.length > 0) {
      logger.line(
        `倒计时结束时仍有 ${blockersAtEnd.length} 处在忙，放弃重启：${blockersAtEnd
          .map((b) => `${b.kind}:${b.label}`)
          .join(' / ')}`,
      )
      setState({
        phase: 'blocked',
        blockers: blockersAtEnd,
        deadline: 0,
        countdownSec: 0,
        cancelReason: '',
        last: { at: Date.now(), ok: false, reason: 'busy-at-deadline' },
      })
      return
    }

    setState({ phase: 'launching', deadline: 0, blockers: [] })

    // 动手之前最后一道门：把「怎么再拉起一次」落成计划文件，脚本照计划执行。
    //
    // 计划由宿主自述生成（argv/execPath/cwd/getOrigin），不猜安装路径。
    // 计划不可用就**什么都不杀** —— 这一次重启作废，但 DSH 还活着；
    // 反过来（先杀再发现起不来）就是用户最痛的那个失败：服务没了，只能手动开。
    const plan = buildLaunchPlan(hostFacts(), loadSettings().launchCommand)
    const planCheck = validatePlan(plan)
    if (!planCheck.ok) {
      logger.line(`启动计划不可用（${planCheck.reason} ${planCheck.detail ?? ''}），放弃重启，DSH 未关闭`)
      setState({
        phase: 'failed',
        deadline: 0,
        countdownSec: 0,
        last: { at: Date.now(), ok: false, reason: 'no-launch-plan' },
        message:
          `无法确定这台机器上该怎么重新启动 DSH（${planCheck.reason}` +
          `${planCheck.detail ? '：' + planCheck.detail : ''}），这次重启已取消，DSH 仍在运行。` +
          `请让 agent 读插件包里的 SETUP.md，把启动命令写进 ${SETTINGS_FILE} 的 launchCommand 再来一次。`,
      })
      return
    }
    if (!writePlanFile(PLAN_FILE, plan)) {
      logger.line(`计划写不进去（${PLAN_FILE}），放弃重启，DSH 未关闭`)
      setState({
        phase: 'failed',
        deadline: 0,
        countdownSec: 0,
        last: { at: Date.now(), ok: false, reason: 'plan-write-failed' },
        message: `启动计划写不进 ${PLAN_FILE}，这次重启已取消，DSH 仍在运行。`,
      })
      return
    }
    logger.line(`启动计划：${PLAN_FILE}（mode=${plan.mode} exe=${plan.exe} 端口=${plan.port}）`)

    // 先落盘再动手：万一脚本把 DSH 杀了而我们自己没来得及写，唤醒就丢了。
    // 写的是两阶段文件的前半段（唤醒谁、说什么）；后半段（成没成、何时成）
    // 由脚本在拉起 DSH 之后补上，插件再来读。
    let pendingRunId = ''
    if (wakeMode === 'plugin') {
      pendingRunId = makeRunId()
      const written = writeWakeRequest({
        runId: pendingRunId,
        phase: 'starting',
        sessionId,
        text: autoSay,
        requestedAt: Date.now(),
        startedAt: 0,
        error: '',
      })
      if (written) {
        logger.line(`已写交接请求：${WAKE_REQUEST_FILE}（目标会话 ${sessionId}）`)
      } else {
        wakeMode = 'script'
        pendingRunId = ''
        logger.line('交接请求写不进去，本次降级为脚本注入')
      }
    }

    logger.line(`倒计时结束，拉起脚本：${scriptPath}（唤醒方式：${wakeMode}）`)

    const result = await launchScript(
      scriptPath,
      command,
      // plugin 模式下让脚本别插手唤醒（-AutoSay 留空 = 不发）
      wakeMode === 'plugin' ? '' : autoSay,
      timeoutSec,
      plan.port,
      PLAN_FILE,
    )
    logger.line(`脚本返回：${JSON.stringify(result)}`)

    if (!result.ok) {
      // 脚本压根没起来，这次重启不会发生 —— 把刚写的请求撤掉，
      // 否则下次启动会读到一条永远等不到 ready 的残账。
      if (pendingRunId && readWakeRequest()?.runId === pendingRunId) {
        clearWakeRequest()
        logger.line('脚本没起来，已撤销交接请求')
      }
      setState({
        phase: 'failed',
        last: { at: Date.now(), ok: false, reason: 'launch-failed' },
        message: `拉起重启脚本失败：${result.error || '退出码 ' + String(result.code)}。DSH 没有重启。`,
      })
      return
    }

    setState({
      phase: 'launching',
      last: { at: Date.now(), ok: true, reason: 'launched' },
    })

    // 兜底看门狗（见 LAUNCH_WATCHDOG_MS 的注释）：只在「脚本已拉起但重启
    // 始终没发生」时触发，把卡住的遮罩收回成一张失败页。
    const 看门狗 = setTimeout(() => {
      if (state.phase !== 'launching') return
      logger.line('看门狗：90 秒仍停在 launching，判为这次重启没有发生')
      setState({
        phase: 'failed',
        last: { at: Date.now(), ok: false, reason: 'launch-watchdog' },
        message:
          '重启脚本已经拉起，但 90 秒内 DSH 一直没有退出 —— 这次重启没有发生。' +
          `可以看一下 ${join(dirname(scriptPath), 'logs')} 里最新的 restart-*.log。`,
      })
    }, LAUNCH_WATCHDOG_MS)
    if (typeof 看门狗.unref === 'function') 看门狗.unref()
  }

  /**
   * 页面就绪，开始起表。
   *
   * 「就绪」的判据只有一个：页面来读了状态（GET /state）或者主动报到（POST /viewer）。
   * 倒计时是给人看的，所以表从人能看到数字那一刻起才有意义；从 Host 决定倒计时
   * 到浏览器画出第一帧之间的那段时间（一次轮询 + 一次渲染，实测接近 1 秒）
   * 不该算进倒计时里，否则设置 10 秒会从 9 秒开始数。
   */
  const beginFromViewer = (origin) => {
    if (state.phase !== 'counting' || !awaitingViewer) return false
    const deadline = Date.now() + state.countdownSec * 1000 + COUNTDOWN_TAIL_MS
    awaitingViewer = false
    setState({ deadline })
    logger.line(`页面就绪（${origin}），倒计时开始：${state.countdownSec} 秒`)
    return true
  }

  const startCountdown = () => {
    stopCountdown()
    const tick = () => {
      if (state.phase !== 'counting') {
        stopCountdown()
        return
      }
      if (cancelSource) {
        cancelCountdown(cancelSource)
        return
      }
      if (awaitingViewer) {
        // 页面一直没出现（纯 CLI、标签页关着）也得能走：超时就当没人看，照常起表。
        if (viewerArmedAt && Date.now() - viewerArmedAt >= VIEWER_WAIT_MS) {
          beginFromViewer('无人查看，超时兜底')
        }
        return
      }
      if (Date.now() >= state.deadline) {
        stopCountdown()
        void finishCountdown()
      }
    }
    countdownTimer = setInterval(tick, 200)
    if (typeof countdownTimer.unref === 'function') countdownTimer.unref()
  }

  const tool = {
    name: 'restart_dsh',
    description:
      '确认整个 DSH 都空闲后，安全地重启它。会先检查所有会话与后台任务；有任何一个在忙就立刻返回 busy 且**不会**重启。' +
      '空闲时进入倒计时，倒计时期间任何真实键鼠输入都会取消本次重启。倒计时走完才拉起外部重启脚本。' +
      '`command` 只在「重启期间顺带做一件事」时才需要；纯重启就别传它，不要为了占位而传一条无害命令。' +
      '倒计时由插件在后台走秒，工具会立刻返回：这几十秒里你可以继续把这一轮说完。' +
      '秒数走完时再判一次 —— 除了插件自己，只要有会话或后台任务还在跑，这次重启就作废，' +
      '不会重启，也不会自动重试。' +
      '如果本机还没适配（返回 reason=needsSetup），先按 message 里的三步做：拿宿主自述拼命令 → ' +
      '让用户在对话里确认 → 写进 settings.json 的 launchCommand，再调一次。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'DSH 关闭之后、重新启动之前要执行的命令。**可以留空**：留空就是纯重启，不执行任何命令。' +
            '没有默认值 —— 不会在你没要求的时候跑任何东西。',
        },
        autoSay: {
          type: 'string',
          description: `重启后自动发给原会话的那句话，默认「${DEFAULT_AUTOSAY}」。`,
        },
        countdownSec: {
          type: 'number',
          description: `倒计时秒数，${MIN_COUNTDOWN}-${MAX_COUNTDOWN}，默认 ${DEFAULT_COUNTDOWN}。`,
        },
        timeoutSec: {
          type: 'number',
          description:
            `命令最多跑多少秒，${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}，默认 ${DEFAULT_TIMEOUT_SEC}。` +
            '超时就中止命令、照样启动 DSH —— 防止命令卡住把 DSH 晾在外面。',
        },
        wakeMode: {
          type: 'string',
          enum: ['plugin', 'script'],
          description:
            '重启后由谁把唤醒词发回原会话：plugin = 插件在重启后自己投递（默认，不碰页面、' +
            '不依赖调试端口，也省掉脚本那 12 秒等渲染）；script = 外部脚本用 CDP 往输入框注入，' +
            '仅在插件投递不可用时才需要。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          phase: { type: 'string' },
          message: { type: 'string' },
          blockers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['kind', 'label'],
            },
          },
        },
        required: ['ok', 'reason'],
      },
      render(args, value) {
        const text = typeof value?.message === 'string' ? value.message : JSON.stringify(value)
        return [{ type: 'text', text }]
      },
    },
    // 工具不再等倒计时，几毫秒就返回，所以超时给宽一点就够。
    timeoutMs: 15_000,
    isConcurrencySafe() {
      return false
    },

    async execute(args, exec) {
      // command 可以留空：空就是「纯重启」，不假装跑一条无害命令。
      // 不设默认值 —— 默认值一旦非空，就意味着"没人要求执行的东西也在执行"。
      const command = typeof args?.command === 'string' ? args.command.trim() : ''
      const autoSay =
        typeof args?.autoSay === 'string' && args.autoSay.trim().length > 0
          ? args.autoSay.trim()
          : settings.autoSay
      // 调用方没传就落回设置页的默认值（DESIGN 第十节：设置页只提供默认值）
      const countdownSec = clampInt(
        args?.countdownSec === undefined ? settings.countdownSec : args.countdownSec,
        MIN_COUNTDOWN,
        MAX_COUNTDOWN,
        settings.countdownSec,
      )
      // 命令超时：只管"命令卡住"这一种情况，超时即中止并照常启动 DSH。
      const timeoutSec = clampInt(
        args?.timeoutSec === undefined ? settings.timeoutSec : args.timeoutSec,
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC,
        settings.timeoutSec,
      )
      // 优先级：本次调用的参数 > 设置页的默认值 > 代码默认值（plugin）。
      // 默认走 plugin：直投不碰页面、不用等渲染，比脚本注入快十几秒。
      const 想要的方式 = args?.wakeMode === 'script' || args?.wakeMode === 'plugin' ? args.wakeMode : settings.wakeMode
      let wakeMode = 想要的方式 === 'script' ? 'script' : 'plugin'

      if (state.phase === 'counting' || state.phase === 'launching') {
        return {
          ok: false,
          reason: 'already-running',
          phase: state.phase,
          message: '已经有一次重启在倒计时/启动中，这次调用忽略。',
        }
      }

      // 现读设置：agent 可能刚把 launchCommand 写进文件，而内存里那份还是旧的。
      const fresh = loadSettings()

      // 总开关。关掉之后连倒计时都不进 —— 这是「我不想让任何东西自动重启 DSH」的表达。
      if (fresh.allowAutoRestart === false) {
        return {
          ok: false,
          reason: 'disabled',
          phase: state.phase,
          message:
            '自动重启已关闭（settings.json 里 allowAutoRestart=false）。需要重启请手动操作，' +
            '或把该字段改成 true（删掉也等于 true）后再调用 restart_dsh。',
        }
      }

      // 进场先确认「这台机器上确实存在一种能把它再拉起来的办法」。
      //
      // 这一步必须在倒计时之前做：倒计时走完才发现起不来，等于把人骗到遮罩页上再告诉他重启失败，
      // 而那时候进程已经被杀了。
      const planNow = buildLaunchPlan(hostFacts(), fresh.launchCommand)
      const planCheck = validatePlan(planNow)
      if (!planCheck.ok) {
        const facts = hostFacts()
        const 自述 = [
          `argv: ${JSON.stringify(facts.argv)}`,
          `execPath: ${facts.execPath || '（空）'}`,
          `cwd: ${facts.cwd || '（空）'}`,
          `origin: ${facts.origin || '（空）'}  ← 重启后必须还是这个地址，页面才连得回来`,
          `profile: ${facts.profile || '（空）'}`,
          `dshVersion: ${facts.dshVersion || '（未知）'}`,
          `electron: ${facts.electron ? '是（跑在桌面端外壳里）' : '否'}`,
        ].join('\n')
        logger.line(`启动计划不可用（${planCheck.reason} ${planCheck.detail ?? ''}），返回 needsSetup`)
        return {
          ok: false,
          reason: 'needsSetup',
          phase: state.phase,
          message: [
            `重启被拦下：插件没法确定在这台机器上怎么重新启动 DSH（${planCheck.reason}` +
              `${planCheck.detail ? '：' + planCheck.detail : ''}）。DSH 没有被关闭，也没有进入倒计时。`,
            '',
            '宿主自述（真实值，不要自己猜）：',
            自述,
            '',
            '接下来由你完成，一共三步：',
            '1. 用上面的自述拼一条「把同样形态的 DSH 从零拉起来」的命令。别改 profile，别改端口 ——',
            '   端口变了页面就连不回来；profile 变了就不是同一个 DSH 了。',
            '2. 在对话里把这条命令的原文发给用户，明确告诉他：这条命令会在每次重启时以他的权限执行。',
            '   必须等到他明确同意再往下走。',
            `3. 用户确认后，把命令写进 ${SETTINGS_FILE} 的 launchCommand 字段（JSON 字符串，`,
            '   反斜杠要转义），然后再次调用 restart_dsh。',
            '',
            '不要改插件里的 .ps1，不要自己结束进程。写完之后可以再调一次本工具，它会先验证再动手。',
            '细则见插件包里的 SETUP.md。',
          ].join('\n'),
        }
      }

      const self = exec?.agent
      const sessionId = self?.id !== undefined ? String(self.id) : ''

      const flowLog = logger.begin()
      logger.line(
        `工具调用：command=${command ? JSON.stringify(command) : '（无，纯重启）'} autoSay=${JSON.stringify(autoSay)} 倒计时=${countdownSec}s 命令超时=${timeoutSec}s 会话=${sessionId}`,
      )

      // 空闲判定只在倒计时结束那一刻做（见下面）。入口不判，也不预扫：
      // 调用它的这个 agent 此刻必然是 running，扫出来的「忙」里永远有它自己，
      // 除了在日志里写一句噪音，改变不了任何行为。
      cancelSource = ''
      // 先不起表：deadline 留 0，等页面把自己画出来（来读状态）那一刻再定。
      // 实际等待 = 设置值 + 999ms：多出来的不到 1 秒，页面上不会先蹦出一个「设置值+1」。
      // 显示侧（client.js 剩余秒）用 ceil - 1 做向下取整，所以设置 3 秒看到的是 3→2→1→0，
      // 每个数字各占 1 秒，最后那 999ms 是快动手前的缓冲。
      awaitingViewer = true
      viewerArmedAt = Date.now()
      setState({
        phase: 'counting',
        deadline: 0,
        countdownSec,
        cancelReason: '',
        command,
        autoSay,
        sessionId,
        blockers: [],
      })
      logger.line(`进入 ${countdownSec} 秒倒计时，等页面画出来再起表`)

      pendingRestart = { command, autoSay, timeoutSec, wakeMode, sessionId }
      startCountdown()

      return {
        ok: true,
        reason: 'counting',
        phase: 'counting',
        message:
          `倒计时已开始：${countdownSec} 秒后判定一次。除了插件自己，只要有会话或后台任务还在跑，` +
          `这次重启就作废。这 ${countdownSec} 秒里你可以继续把这一轮说完 —— 说完再判，说不完就不重启。`,
      }
    },
  }

  // ── 工具入口（唯一触发方式）──────────────────────────────────────────
  ctx.effect(() => {
    try {
      const dispose = ctx.tools.register(tool)
      trace('restart_dsh 注册成功')
      return dispose
    } catch (err) {
      trace(`restart_dsh 注册失败：${String(err?.message ?? err)}\n${String(err?.stack ?? '')}`)
      throw err
    }
  }, `${name}: restart_dsh 工具`)

  // ── 补投上一轮欠下的唤醒词 ───────────────────────────────────────────
  // 只在「上次是用 plugin 模式重启的」时候才有活干：只留一小段让路由先注册好，
  // 不用等服务就绪 —— deliverPendingWake 里每 250ms 会重试，服务晚到也能接上。
  // 首检只等 200ms：新宿主起来时交接文件往往已经是 ready，早看一眼就少一秒。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void deliverPendingWake(getService, log)
    }, 200)
    return () => clearTimeout(timer)
  }, `${name}: 补投唤醒词`)

  // ── 状态路由（只给本插件的 Client 用）───────────────────────────────
  ctx.inject(['webServer'], (scope) => {
    trace('webServer 注入回调已进入')
    const ws = scope.webServer
    if (!ws || typeof ws.register !== 'function') {
      log('webServer 不可用，倒计时界面拿不到状态')
      return
    }
    // ⚠ 必须 scope.effect，不能用 ctx.effect：cordis 只收集 effect 的返回值，
    //   挂在根上的话热重载时这组路由拆不干净，而 webServer.register 对同一个
    //   路径二次注册会 throw（dsh-flow-v2 实测踩过）。
    scope.effect(() => {
      try {
      const dispose = ws.register({
        kind: 'prefix',
        path: API_PATH,
        handler: (req, res) => {
          void (async () => {
            // 门禁先过：这三层挡的是「别的网页/别的进程顺手把 DSH 关掉」。
            const guard = checkRequestSource(req)
            if (!guard.ok) {
              log(`拒绝一次 API 请求：${guard.reason}`)
              jsonResponse(res, 403, {
                ok: false,
                error: { code: 'forbidden', message: guard.reason },
              })
              return
            }
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const route = url.pathname.slice(API_PATH.length) || '/state'

            if (route === '/state' && (req.method === 'GET' || req.method === 'HEAD')) {
              // 也有人是页面主动报到（POST /viewer），这里兜一手：
              // 只要求读状态就说明有人在看，可以起表了。
              beginFromViewer('GET /state')
              jsonResponse(res, 200, { ok: true, value: snapshot() })
              return
            }

            if (route === '/viewer' && req.method === 'POST') {
              // 页面把自己画出来之后主动报到：这一刻起表，人看到的就是完整的设置秒数。
              const started = beginFromViewer('页面报到')
              jsonResponse(res, 200, { ok: true, value: { started, ...snapshot() } })
              return
            }

            if (route === '/probe' && (req.method === 'GET' || req.method === 'HEAD')) {
              // 实时扫描：state 只是状态机的记忆，这里现查一遍宿主，给调试和验证用。
              const live = await collectBlockers(services)
              const agents = []
              for (const agent of safeList(services.agents)) {
                let status = 'unknown'
                try {
                  status = String(agent?.status ?? 'unknown')
                } catch {
                  status = 'unreadable'
                }
                agents.push({ id: String(agent?.id ?? ''), status })
              }
              jsonResponse(res, 200, { ok: true, value: { at: Date.now(), blockers: live, agents } })
              return
            }

            if (route === '/settings' && (req.method === 'GET' || req.method === 'HEAD')) {
              jsonResponse(res, 200, { ok: true, value: { ...settings }, meta: settingsMeta() })
              return
            }

            if (route === '/settings' && req.method === 'POST') {
              const payload = await readJsonBody(req)
              const changed = applySettings(payload)
              logger.line(`设置页更新：${changed.join(', ') || '（无变化）'}`)
              jsonResponse(res, 200, { ok: true, value: { ...settings }, meta: settingsMeta() })
              return
            }

            if (route === '/last-run' && (req.method === 'GET' || req.method === 'HEAD')) {
              // 上一次脚本跑完留下的结果（命令退出码、是否超时、DSH 有没有起来）。
              // 交接文件是「处理完即删」的，这里读的是另一个只跑不删的收据。
              jsonResponse(res, 200, { ok: true, value: readRunResult() })
              return
            }

            if (route === '/cancel' && req.method === 'POST') {
              const payload = await readJsonBody(req)
              if (state.phase === 'counting') {
                // 前端在检测到键鼠时调用（source=input）；直接调接口的算 api。
                cancelSource = payload && payload.source === 'input' ? 'input' : 'api'
                logger.line('收到取消请求：' + cancelSource)
              }
              jsonResponse(res, 200, { ok: true, value: snapshot() })
              return
            }

            if (route === '/dismiss' && req.method === 'POST') {
              await readJsonBody(req)
              if (
                state.phase === 'blocked' ||
                state.phase === 'cancelled' ||
                state.phase === 'failed' ||
                state.phase === 'idle'
              ) {
                setState({ phase: 'idle', blockers: [], cancelReason: '', message: '' })
              }
              jsonResponse(res, 200, { ok: true, value: snapshot() })
              return
            }

            if (route === '/restart' && req.method === 'POST') {
              // 和工具完全同一条路径：只是把「谁发起的」从 exec.agent 换成请求体里的
              // sessionId。网页端没有 agent 上下文时，这是唯一能走完整流程的入口。
              const body = await readJsonBody(req)
              const payload = body && typeof body === 'object' ? body : {}
              const targetSession = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
              const result = await tool.execute(payload, {
                agent: targetSession ? { id: targetSession } : undefined,
                signal: new AbortController().signal,
              })
              jsonResponse(res, 200, { ok: true, value: result, state: snapshot() })
              return
            }

            jsonResponse(res, 404, {
              ok: false,
              error: { code: 'not-found', message: `不认识的路径：${route}` },
            })
          })()
        },
      })
      log('状态路由已注册：' + API_PATH)
      return dispose
      } catch (err) {
        log('注册状态路由失败（不影响工具本身）：' + String(err))
        return () => {}
      }
    })
  })

  log(`已加载（脚本 ${scriptPath}）`)
}

/** 仅供 test/idle-check.mjs 直接测判定逻辑；不属于插件契约，Cordis 不会看它。 */
export const __test = {
  collectBlockers,
  createState,
  clampInt,
  decorateWakeText,
  readWakeRequest,
  writeWakeRequest,
  clearWakeRequest,
  WAKE_REQUEST_FILE,
  DEFAULT_COUNTDOWN,
  loadSettings,
  readSettingsFile,
  writeSettingsFile,
  SETTINGS_DEFAULTS,
  SETTINGS_FILE,
  // 启动计划：判定逻辑纯函数，可以在没有宿主的环境里直接测。
  buildLaunchPlan,
  validatePlan,
  readHostFacts,
  planFilePath,
  writePlanFile,
  PLAN_FILE,
}
