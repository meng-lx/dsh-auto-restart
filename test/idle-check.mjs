/**
 * 空闲判定的离线自测 —— 不需要 DSH，纯 Node 跑。
 *
 *   node test/idle-check.mjs
 *
 * 覆盖四种情况（都只测「该不该动手」和状态机，**绝不**碰真脚本）：
 *   A. 有会话在跑           → busy
 *   B. 没有会话、有后台任务  → busy（这条最容易漏，jobs 是按 caller 查的）
 *   C. 全都空闲             → 进倒计时，然后拉脚本（这里故意指向不存在的脚本，
 *                             所以要断言的是 launch-failed 而不是真重启）
 *   D. 拿不到 agents 服务    → busy（宁可不做）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 把状态目录挪到临时目录：否则每跑一次测试都会往真正的 plugin.log 里插两行
// 「已加载」，而 agent 排查重启问题时正是靠读那份日志。必须在 import index.js
// 之前设置（ESM 静态 import 会先求值模块），所以这里用动态 import。
const 临时状态目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-test-'))
process.env.DSHAR_STATE_DIR = 临时状态目录

const { apply } = await import('../index.js')
const mod = await import('../index.js')

const PASS = []
const FAIL = []

function check(label, actual, expected) {
  const ok = actual === expected
  ;(ok ? PASS : FAIL).push(`${ok ? '✓' : '✗'} ${label}：得到 ${String(actual)}，期望 ${expected}`)
}

function makeCtx(services) {
  const registered = []
  let routeHandler = null
  const webServer = {
    port: 12345,
    register(spec) {
      if (spec && typeof spec.handler === 'function') routeHandler = spec.handler
      return () => {}
    },
  }
  const ctx = {
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    inject(deps, cb) {
      const scope = { effect: ctx.effect }
      for (const d of deps) scope[d] = d === 'webServer' ? webServer : services[d]
      cb(scope)
    },
    get(name) {
      return services[name]
    },
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  /** 走一遍插件自己注册的 /state 路由，拿状态机的当前快照。 */
  const readState = async () => {
    if (!routeHandler) return null
    let body = ''
    const res = {
      writeHead() {},
      setHeader() {},
      end(chunk) {
        body += String(chunk ?? '')
      },
    }
    routeHandler({ method: 'GET', url: '/auto-restart/api/state' }, res)
    // handler 是 `void (async () => …)()` 起的，等它跑完再读 body
    await new Promise((r) => setTimeout(r, 30))
    try {
      return JSON.parse(body).value
    } catch {
      return null
    }
  }
  return { ctx, registered, readState }
}

function loadTool(services) {
  const { ctx, registered, readState } = makeCtx(services)
  apply(ctx, { scriptPath: 'Z:\\不存在\\Restart-DSH.ps1' })
  if (registered.length !== 1) throw new Error(`工具没注册成功（register 调了 ${registered.length} 次）`)
  return { tool: registered[0], readState }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** MIN_COUNTDOWN 是 3 秒，留一点余量给 200ms 的 tick。 */
const 等倒计时 = 4200

// ── A. 别的会话在跑：入口不拦，倒计时结束时判忙 ────────────────────────
{
  const { tool, readState } = loadTool({
    agents: { list: () => [{ id: 'self-session', status: 'idle' }, { id: 'other', status: 'running' }] },
  })
  const r = await tool.execute({ command: 'echo 1', countdownSec: 3 }, { agent: null })
  check('A1 入口直接返回 counting（不阻塞）', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  const s = await readState()
  check('A2 倒计时结束时判为忙', s?.phase, 'blocked')
  check('A3 blocker 是 agent', s?.blockers?.[0]?.kind, 'agent')
}

// ── B. 没有会话在跑，但有后台任务 ─────────────────────────────────────
{
  const { tool, readState } = loadTool({
    agents: { list: () => [{ id: 'idle-a', status: 'idle' }] },
    jobs: {
      list: (caller) =>
        caller === 'idle-a'
          ? [{ id: 'job-1', kind: 'bash', label: 'pnpm dev', status: 'running' }]
          : [],
    },
  })
  const r = await tool.execute({ command: 'echo 1', countdownSec: 3 }, { agent: null })
  check('B1 入口直接返回 counting', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  const s = await readState()
  check('B2 后台任务在跑', s?.phase, 'blocked')
  check('B3 blocker 里有 job', s?.blockers?.some((b) => b.kind === 'job'), true)
}

// ── C. 全都空闲 → 走到拉起脚本 → 脚本不存在 → failed ───────────────────
{
  const { tool, readState } = loadTool({
    agents: { list: () => [{ id: 'idle-b', status: 'idle' }] },
    jobs: { list: () => [] },
  })
  const r = await tool.execute({ command: 'echo 1', countdownSec: 3 }, { agent: null })
  check('C1 空闲时立刻返回 counting', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  const s = await readState()
  check('C2 空闲就往下走，脚本不存在 → failed', s?.phase, 'failed')
}

// ── D. 拿不到 agents 服务 ─────────────────────────────────────────────
{
  const { tool, readState } = loadTool({})
  const r = await tool.execute({ command: 'echo 1', countdownSec: 3 }, { agent: null })
  check('D1 没有 agents 服务也先返回 counting', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  const s = await readState()
  check('D2 拿不到 agents 服务就判忙', s?.phase, 'blocked')
}

// ── E. 命令可置空：留空 = 纯重启，不是参数错误 ────────────────────────
{
  const { tool, readState } = loadTool({
    agents: { list: () => [{ id: 'idle-c', status: 'idle' }] },
    jobs: { list: () => [] },
  })
  const r = await tool.execute({ countdownSec: 3 }, { agent: null })
  check('E1 不传 command 不算参数错误', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  check('E2 空命令照常走完倒计时', (await readState())?.phase, 'failed')
}

// ── F. 纯空格也当空命令 ──────────────────────────────────────────────
{
  const { tool, readState } = loadTool({
    agents: { list: () => [{ id: 'idle-d', status: 'idle' }] },
    jobs: { list: () => [] },
  })
  const r = await tool.execute({ command: '   ', countdownSec: 3 }, { agent: null })
  check('F1 纯空格当空命令处理', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  check('F2 照常走完倒计时', (await readState())?.phase, 'failed')
}

// ── G. timeoutSec 越界被夹紧，不会抛 ─────────────────────────────────
{
  const { tool, readState } = loadTool({
    agents: { list: () => [{ id: 'idle-e', status: 'idle' }] },
    jobs: { list: () => [] },
  })
  const r = await tool.execute({ countdownSec: 3, timeoutSec: 999999 }, { agent: null })
  check('G1 超大 timeoutSec 不炸', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  check('G2 照常走完倒计时', (await readState())?.phase, 'failed')
}

// ── K. 只有调用者自己在跑，也算忙（这次改动的核心）─────────────────────
{
  const running = { id: 'self-only', status: 'running' }
  const { tool, readState } = loadTool({
    agents: { list: () => [running] },
    jobs: { list: () => [] },
  })
  const r = await tool.execute({ countdownSec: 3 }, { agent: running })
  check('K1 自己也先返回 counting', r.phase, 'counting')
  await readState()
  await sleep(等倒计时)
  const s = await readState()
  check('K2 这一轮没说完就不重启', s?.phase, 'blocked')
  check('K3 拦住的正是调用者自己', s?.blockers?.[0]?.id, 'self-only')
}

// 取消（按钮 / 键鼠 / 接口）走的是同一个 cancelSource，改前改后没动过，
// 前端已经实测过「倒计时被取消」那一页，这里不重复测。

// ── H. 唤醒词后缀：只认这次的结果，成功时不加尾巴 ────────────────────
{
  const { decorateWakeText } = mod.__test
  const at = 1_000_000
  const fake = (payload) => () => payload

  check('H1 命令成功不加后缀', decorateWakeText('已重启', at, fake({ at: at + 5, exitCode: 0, timedOut: false })), '已重启')
  check(
    'H2 命令失败补退出码',
    decorateWakeText('已重启', at, fake({ at: at + 5, exitCode: 3, timedOut: false })),
    '已重启（命令失败：退出码 3）',
  )
  check(
    'H3 命令超时补说明',
    decorateWakeText('已重启', at, fake({ at: at + 5, exitCode: null, timedOut: true })),
    '已重启（命令超时被中止）',
  )
  check(
    'H4 上一轮的旧结果不算数',
    decorateWakeText('已重启', at, fake({ at: at - 1, exitCode: 9, timedOut: false })),
    '已重启',
  )
  check('H5 没有结果文件不加后缀', decorateWakeText('已重启', at, fake(null)), '已重启')
  check('H6 纯重启（没跑命令）不加后缀', decorateWakeText('已重启', at, fake({ at: at + 5, exitCode: null, timedOut: false })), '已重启')
}

// ── I. 两阶段交接文件：解析、容错、投完推进状态 ──────────────────────
// 这些函数读写的是真实目录，所以先把现场备份下来，测完原样放回去。
{
  const { readWakeRequest, writeWakeRequest, clearWakeRequest, WAKE_REQUEST_FILE } = mod.__test

  const backup = fs.existsSync(WAKE_REQUEST_FILE) ? fs.readFileSync(WAKE_REQUEST_FILE, 'utf8') : null

  try {
    try {
      fs.rmSync(WAKE_REQUEST_FILE, { force: true })
    } catch {}
    check('I1 没有文件时读出来是 null', readWakeRequest(), null)

    writeWakeRequest({
      runId: 'test-run-1',
      phase: 'starting',
      sessionId: ' s-1 ',
      text: '你好',
      requestedAt: 5,
    })
    const r = readWakeRequest()
    check('I2 读回 runId', r.runId, 'test-run-1')
    check('I3 读回 phase', r.phase, 'starting')
    check('I4 sessionId 两端空格被去掉', r.sessionId, 's-1')
    check('I5 text 原样读回', r.text, '你好')
    check('I6 startedAt 缺省补 0', r.startedAt, 0)

    // 交接文件是一次性的：插件看过就删，不论最后有没有投出去。
    clearWakeRequest()
    check('I7 清空后读回 null', readWakeRequest(), null)
    check('I8 清空是幂等的（再删一次不抛异常）', (clearWakeRequest(), readWakeRequest()), null)

    // 下一轮重启会写一份新的，runId 不同，不会跟上一轮混淆。
    writeWakeRequest({ runId: 'test-run-2', phase: 'starting', sessionId: 's-2', text: '下一轮', requestedAt: 9 })
    check('I9 新一轮写回自己的 runId', readWakeRequest().runId, 'test-run-2')
    check('I10 新一轮 phase 是 starting', readWakeRequest().phase, 'starting')

    fs.writeFileSync(WAKE_REQUEST_FILE, '{ 这不是 json', 'utf8')
    check('I11 坏文件不抛异常，返回 null', readWakeRequest(), null)
  } finally {
    clearWakeRequest()
    if (backup !== null) {
      try {
        fs.writeFileSync(WAKE_REQUEST_FILE, backup, 'utf8')
      } catch {}
    }
  }
}


// ── J. 带 BOM 的 json 也能读 ─────────────────────────────────────────
// Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM（EF BB BF），
// 而 JSON.parse 遇到 BOM 直接报错。脚本那边已改成无 BOM 写入，这里再保一层容错。
{
  const { readWakeRequest, writeWakeRequest, clearWakeRequest, WAKE_REQUEST_FILE } = mod.__test
  const backup = fs.existsSync(WAKE_REQUEST_FILE) ? fs.readFileSync(WAKE_REQUEST_FILE, 'utf8') : null
  try {
    writeWakeRequest({ runId: 'bom-run', phase: 'ready', sessionId: 's-bom', text: 'x' })
    fs.writeFileSync(
      WAKE_REQUEST_FILE,
      '\ufeff' + JSON.stringify({ runId: 'bom-run', phase: 'ready', sessionId: 's-bom', text: 'x' }),
      'utf8',
    )
    check('J 带 BOM 的文件能解析', readWakeRequest()?.runId, 'bom-run')
  } finally {
    clearWakeRequest()
    if (backup !== null) {
      try {
        fs.writeFileSync(WAKE_REQUEST_FILE, backup, 'utf8')
      } catch {}
    }
  }
}

// ── K. 设置落盘与读回 ────────────────────────────────────────────────
// 设置是「用户偏好」，必须活过一次重启。状态目录已被 DSHAR_STATE_DIR 挪到临时目录，
// 所以这里随便写，碰不到真实设置。
{
  const { loadSettings, readSettingsFile, writeSettingsFile, SETTINGS_DEFAULTS, SETTINGS_FILE } = mod.__test
  fs.rmSync(SETTINGS_FILE, { force: true })
  check('K1 无文件时读回代码默认值', loadSettings().countdownSec, SETTINGS_DEFAULTS.countdownSec)

  writeSettingsFile({ autoSay: '自定义唤醒', countdownSec: 120, timeoutSec: 900, logKeep: 3, wakeMode: 'script' })
  const back = loadSettings()
  check('K2 写盘后能读回 autoSay', back.autoSay, '自定义唤醒')
  check('K3 写盘后能读回 countdownSec', back.countdownSec, 120)
  check('K4 写盘后能读回 timeoutSec', back.timeoutSec, 900)
  check('K5 写盘后能读回 logKeep', back.logKeep, 3)
  check('K6 写盘后能读回 wakeMode', back.wakeMode, 'script')

  // 只写一个字段：其余保持默认，而不是整份作废
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ countdownSec: 45 }), 'utf8')
  const partial = loadSettings()
  check('K7 缺字段时该字段生效', partial.countdownSec, 45)
  check('K8 缺字段不影响其它项', partial.autoSay, SETTINGS_DEFAULTS.autoSay)

  // 越界值被 clamp 收进来，而不是丢回默认
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ countdownSec: 999999 }), 'utf8')
  check('K9 越界值被 clamp 到上限', loadSettings().countdownSec, 600)

  // 坏文件：当作没设过，不抛
  fs.writeFileSync(SETTINGS_FILE, '{ 坏掉的 json', 'utf8')
  check('K10 坏文件不抛异常', readSettingsFile(), null)
  check('K11 坏文件回落到默认值', loadSettings().countdownSec, SETTINGS_DEFAULTS.countdownSec)

  // 非法 wakeMode 被忽略
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ wakeMode: 'nonsense' }), 'utf8')
  check('K12 非法 wakeMode 被忽略', loadSettings().wakeMode, SETTINGS_DEFAULTS.wakeMode)
}

console.log([...PASS, ...FAIL].join('\n'))
console.log(`\n通过 ${PASS.length} 项，失败 ${FAIL.length} 项`)
process.exit(FAIL.length === 0 ? 0 : 1)
