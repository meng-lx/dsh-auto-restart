/**
 * dsh-auto-restart —— 启动计划（launch plan）。
 *
 * 解决的问题：重启脚本必须知道「这台机器上的 DSH 到底是怎么跑起来的」，
 * 而这件事在不同客户端、不同安装方式下完全不一样（npm/pnpm/源码 checkout/
 * 官方桌面端/第三方 Electron 壳/容器……）。让脚本去猜，猜错了就是把 DSH
 * 杀掉之后起不来。
 *
 * 所以不猜：**正在运行的那个宿主**自己知道答案。它把 `process.argv`、
 * `process.execPath`、`process.cwd()`、`webServer.getOrigin()` 原样写进一份
 * 计划文件，脚本照着执行。计划里没有一处是推断出来的路径。
 *
 * 唯一的覆盖入口是 `settings.json` 里的 `launchCommand`：当重放不可行
 * （npx 缓存被清、自制 bat 包装、容器）时，由 agent 填一条完整命令。
 *
 * 计划不可用时的处理原则写在使用方（index.js / Restart-DSH.ps1）：
 * **什么都不杀**。宁可这次不重启，也不要把 DSH 停在关闭状态。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, join } from 'node:path'

/** 计划文件名（放在插件的状态目录里，与交接文件同住）。 */
export const PLAN_FILE_NAME = 'launch-plan.json'

/** 计划结构版本。字段增删时改它，方便以后做兼容。 */
export const PLAN_VERSION = 1

export function planFilePath(stateDir) {
  return join(stateDir, PLAN_FILE_NAME)
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readJson(file) {
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/**
 * 从 argv 里取 profile 名。
 *
 * launcher（bin.js）在启动时会把自己的参数改写成 `--profile <name>`，
 * 所以运行中的宿主 argv 里通常已经有它；两条兜底路径分别是
 * `--profile=name` 和「没写 --profile 但带了位置参数」的旧形态。
 */
export function readProfile(argv) {
  const args = Array.isArray(argv) ? argv : []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--profile' && typeof args[i + 1] === 'string') return args[i + 1]
    if (typeof arg === 'string' && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return ''
}

/**
 * 读入口脚本所属的包：`bin.js` 在 `<pkg>/lib/bin.js`，所以 package.json 在上一级。
 *
 * 用途只有一个：判断「这个入口是不是 DSH 本体」。Electron 里跑 `dsh web`
 * （ELECTRON_RUN_AS_NODE）和 Electron 桌面端是两种完全不同的重启方式，
 * 光看 `process.versions.electron` 分不开。
 */
export function readEntryPackage(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return { name: '', version: '' }
  const pkg = readJson(resolve(dirname(entry), '..', 'package.json'))
  return {
    name: typeof pkg?.name === 'string' ? pkg.name : '',
    version: typeof pkg?.version === 'string' ? pkg.version : '',
  }
}

/**
 * 把 origin 拆成脚本能直接用的四个值。
 *
 * 优先用 `webServer.getOrigin()`（它知道协议、绑定地址、端口，TLS 时自动是 https）；
 * 退化时才用端口拼一个 127.0.0.1 —— 那种情况下绑定地址可能是别的网卡，所以
 * 只当兜底，不当事实。
 */
export function parseOrigin(origin, fallbackPort) {
  let url = null
  try {
    url = new URL(String(origin))
  } catch {
    url = null
  }
  if (url) {
    const scheme = url.protocol.replace(/:$/, '')
    const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80
    return { scheme, host: url.hostname, port, origin: url.origin }
  }
  const port = Number.isInteger(fallbackPort) ? fallbackPort : 0
  return {
    scheme: 'http',
    host: '127.0.0.1',
    port,
    origin: port > 0 ? `http://127.0.0.1:${port}` : '',
  }
}

/**
 * 读宿主自我描述。**每次用都现读**，不要缓存：
 * 端口可能变（桌面壳随机端口）、profile 可能被 rescue 换过、cwd 可能被切过。
 */
export function readHostFacts(webServer) {
  let origin = ''
  try {
    origin = typeof webServer?.getOrigin === 'function' ? String(webServer.getOrigin()) : ''
  } catch {
    origin = ''
  }
  let port = 0
  try {
    port = typeof webServer?.port === 'number' ? webServer.port : 0
  } catch {
    port = 0
  }
  if (!origin && port > 0) origin = `http://127.0.0.1:${port}`

  const argv = Array.isArray(process.argv) ? process.argv.slice() : []
  const cwd = safeCwd()
  const execPath = typeof process.execPath === 'string' ? process.execPath : ''
  const rawEntry = argv.length > 1 ? String(argv[1] ?? '') : ''
  const entry = rawEntry.length > 0 && cwd.length > 0 ? (isAbsolute(rawEntry) ? rawEntry : resolve(cwd, rawEntry)) : rawEntry
  const pkg = readEntryPackage(entry)

  return {
    argv,
    execPath,
    cwd,
    entry,
    entryPackage: pkg.name,
    entryIsDsh: pkg.name === '@deepseek-ai/dsh',
    electron: Boolean(process.versions?.electron),
    origin,
    port,
    profile:
      readProfile(argv) ||
      (typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE : ''),
    dshHome: typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME : '',
    dshVersion: pkg.version,
    sessionId: typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID : '',
    pid: Number.isInteger(process.pid) ? process.pid : 0,
  }
}

/** `process.cwd()` 在目录被删掉之后会抛，别让它把整份计划带下去。 */
function safeCwd() {
  try {
    return process.cwd()
  } catch {
    return ''
  }
}

/**
 * 生成计划。
 *
 * 三种 mode，描述的是「脚本怎么再拉起一次、怎么判断它起来了」，
 * 不是用户选了哪个 profile：
 *
 *   web      node 直接跑 bin.js（npm/pnpm/源码/Electron 里的 CLI 都走这条）。
 *            重放 = execPath + [入口, ...原参数]，安装方式完全不参与。
 *   desktop  Electron 桌面端。重放 = 外壳 exe 本身；必须去掉
 *            ELECTRON_RUN_AS_NODE，否则拉起来的是 node 而不是界面。
 *   custom   settings.json 的 launchCommand 覆盖。
 */
export function buildLaunchPlan(facts, launchCommand) {
  const override = typeof launchCommand === 'string' ? launchCommand.trim() : ''
  const where = parseOrigin(facts?.origin, facts?.port)
  const cwd = typeof facts?.cwd === 'string' && facts.cwd.length > 0 ? facts.cwd : ''

  const base = {
    version: PLAN_VERSION,
    source: override ? 'settings' : 'auto',
    host: where.host,
    port: where.port,
    scheme: where.scheme,
    origin: where.origin,
    profile: typeof facts?.profile === 'string' ? facts.profile : '',
    dshVersion: typeof facts?.dshVersion === 'string' ? facts.dshVersion : '',
    dshHome: typeof facts?.dshHome === 'string' ? facts.dshHome : '',
    sessionId: typeof facts?.sessionId === 'string' ? facts.sessionId : '',
    pid: Number.isInteger(facts?.pid) ? facts.pid : 0,
    createdAt: Date.now(),
  }

  if (override) {
    return { ...base, mode: 'custom', command: override, exe: '', args: [], cwd, env: {} }
  }

  const exe = typeof facts?.execPath === 'string' ? facts.execPath : ''
  const argv = Array.isArray(facts?.argv) ? facts.argv : []
  const entry = typeof facts?.entry === 'string' ? facts.entry : ''

  // Electron 里跑 CLI：execPath 是外壳 exe，但真正的入口是 bin.js，
  // 必须补回 ELECTRON_RUN_AS_NODE=1 才能当 node 用。
  const cliInsideElectron = Boolean(facts?.electron) && facts?.entryIsDsh === true

  if (cliInsideElectron || !facts?.electron) {
    const webArgs = [entry, ...argv.slice(2)]
    // 重放的是「原来那条命令行」，但原来那次可能是用户手动敲的、默认会开浏览器。
    // 重启时页面本来就会自己连回来，再开一个只会多出一个新标签页 —— 所以补上 --no-open。
    // 原命令行里已经带了就别重复加。
    if (!webArgs.includes('--no-open')) webArgs.push('--no-open')
    return {
      ...base,
      mode: 'web',
      exe,
      args: webArgs,
      cwd,
      env: cliInsideElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    }
  }

  return {
    ...base,
    mode: 'desktop',
    exe,
    args: [],
    cwd,
    env: { ELECTRON_RUN_AS_NODE: null },
  }
}

/**
 * 动手之前的校验。返回 `{ ok, reason, detail }`，reason 是给日志和 agent 看的短标签。
 *
 * 只校验「能不能把它再跑起来」这一件事，不校验运行参数对不对 ——
 * 参数原样来自 argv，本来就是对的。
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return { ok: false, reason: 'no-plan' }

  if (plan.mode === 'custom') {
    if (typeof plan.command !== 'string' || plan.command.trim().length === 0) {
      return { ok: false, reason: 'empty-command' }
    }
    return { ok: true }
  }

  if (plan.mode !== 'web' && plan.mode !== 'desktop') {
    return { ok: false, reason: 'unknown-mode', detail: String(plan.mode ?? '') }
  }

  if (typeof plan.exe !== 'string' || plan.exe.trim().length === 0) {
    return { ok: false, reason: 'no-exe' }
  }
  if (!existsSync(plan.exe)) {
    return { ok: false, reason: 'exe-missing', detail: plan.exe }
  }

  if (plan.mode === 'web') {
    const entry = Array.isArray(plan.args) ? plan.args[0] : ''
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, reason: 'entry-missing' }
    }
    if (!existsSync(entry)) {
      return { ok: false, reason: 'entry-missing', detail: entry }
    }
  }

  const port = plan.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, reason: 'bad-port', detail: String(port) }
  }

  return { ok: true }
}

/**
 * 写计划文件。无 BOM 的 UTF-8 —— 读它的是 Windows PowerShell 5.1，
 * 而 `Set-Content -Encoding UTF8` 会写 BOM、Node 的 JSON.parse 会直接抛。
 * 这里由 Node 写，天然没有 BOM，但保持和交接文件一致的写法。
 */
export function writePlanFile(file, plan) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function readPlanFile(file) {
  const parsed = readJson(file)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}
