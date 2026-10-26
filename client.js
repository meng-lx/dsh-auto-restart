// dsh-auto-restart 客户端 bundle —— 只负责「画两页」：
//
//   ① **倒计时页**：宿主确认整个 DSH 都闲了，开始 N 秒倒计时。
//      任何真实键鼠输入（点一下、滚一下、按个键）都会取消这次重启。
//   ② **忙时提示页**：倒计时走完时才检查，发现有会话/任务在跑就作废。
//
// 它**不做任何判定**：判定、状态机、拉起脚本全在 Host 半边（index.js）。
// 这里只是把 Host 暴露的 `/auto-restart/api/state` 画出来，并把用户的
// 「取消」「知道了」反向发回去。
//
// 形状与 dsh-flow-v2 一致：执行本脚本**只注册工厂**，真正的实例化由
// factory(require) 完成，返回值必须是 Cordis 插件入口 { name, inject, apply }。
// React 来自模块表 externals（require("react")）。
//
// ⚠ 本文件里**唯一的插件名字面量**是下面这行 PKG —— 它必须等于 package.json 的
//   `name`（客户端模块注册表的键就是它）。座位 id 从它派生。
//
// ⚠ 输入事件的结论（2026-10-23 实测）：CDP 注入的 keydown / mousedown 在 DOM 里
//   和真人输入长得一模一样 —— `isTrusted` 同样是 true、`sourceCapabilities` 也
//   照常是 `{touch:false}`；鼠标那条还有一处差别（真人 pointerdown.pressure 是
//   0.5、注入是 0），但**故意不用它**：倒计时问的是「现在还有没有人在操作这台
//   机器」，远程桌面、别的自动化工具发来的输入同样意味着有人在动。
//   所以任何 pointerdown / wheel / keydown 一律取消，宁可多取消一次，
//   也不要在有人正操作时把 DSH 杀掉。详见「取消」函数里的注释。

var PKG = 'dsh-auto-restart'

window.__ModuleLoader__.load({
  id: PKG,
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var h = React.createElement

    exports.name = PKG
    exports.inject = ['slots']

    /** 与 Host 侧约定的同一条路由（见 index.js 的 API_PATH）。 */
    var API_PATH = '/auto-restart/api'

    /** shell.overlay 上的座位 id。 */
    var OVERLAY_ID = PKG + '-overlay'

    /** 设置页在 settings.section 上的座位 id。 */
    var SETTINGS_ID = PKG + '-settings'

    /** 轮询间隔：倒计时时快一点，其余时候慢一点。 */
    var POLL_ACTIVE_MS = 300
    var POLL_IDLE_MS = 2000

    /**
     * Host 的门禁要求每个请求都带这个头。
     *
     * 同源请求带自定义头不会触发预检，所以这行对正常轮询没有成本；它的作用是把
     * 「别的网页用 fetch 打进来」这条路堵死 —— 跨源带自定义头必先预检，而宿主不放行 CORS。
     */
    var REQUEST_HEADER = 'x-auto-restart'

    function request(path, init) {
      var opts = init || {}
      var headers = Object.assign({}, opts.headers || {})
      headers[REQUEST_HEADER] = '1'
      var merged = Object.assign({}, opts, { headers: headers })
      return fetch(API_PATH + path, merged).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    function readState() {
      return request('/state', { method: 'GET', headers: { accept: 'application/json' } }).then(
        function (body) {
          return body && body.value ? body.value : null
        },
      )
    }

    function postCancel(source) {
      return request('/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: source || 'input' }),
      }).catch(function () {})
    }

    function postDismiss() {
      return request('/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch(function () {})
    }

    /**
     * 报到：告诉 Host「这一页已经画出来了」。
     *
     * Host 收到才起表。倒计时是给人看的，表从人能看到数字那一刻起才有意义；
     * 页面从收到状态到画出第一帧还有十几毫秒，这点时间不该从倒计时里扣。
     */
    function postViewer() {
      return request('/viewer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch(function () {})
    }

    // ── 样式：只用主题 token，不硬编码颜色（ui-plugin.md 硬要求）────────────
    var 遮罩 = {
      position: 'fixed',
      inset: 0,
      // 盖住设置面板等所有浮层：主题里的 modal 都在 1000 上下，
      // 用 9 万既能压住它们，又不到 int 上限那么野
      zIndex: 90000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.3)',
      // 整页轻微失焦：让底下那层“还在，但被隔开了”，卡片自己再磨一次
      backdropFilter: 'blur(3px)',
      WebkitBackdropFilter: 'blur(3px)',
      // 遮罩自己吃掉指针事件，避免误触下面的界面
      pointerEvents: 'auto',
    }

    var 卡片 = {
      minWidth: 320,
      maxWidth: 460,
      padding: '26px 30px 22px',
      borderRadius: 20,
      // 半透明 + 背景模糊 = 毛玻璃；颜色用 token 混透明，跟随主题走
      background:
        'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 58%, transparent)',
      backdropFilter: 'blur(28px) saturate(180%)',
      WebkitBackdropFilter: 'blur(28px) saturate(180%)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-border-secondary) 70%, transparent)',
      color: 'var(--dsw-alias-label-primary)',
      // 外阴影托起来 + 顶边一道内高光，玻璃边缘才不会糊成一片
      boxShadow:
        '0 28px 90px rgba(0, 0, 0, 0.46), 0 6px 20px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.16)',
      textAlign: 'center',
      fontFamily: 'inherit',
    }

    var 标题行 = {
      fontSize: 15,
      fontWeight: 600,
      marginBottom: 8,
      color: 'var(--dsw-alias-label-primary)',
    }

    var 说明 = {
      fontSize: 13,
      lineHeight: 1.6,
      color: 'var(--dsw-alias-label-secondary)',
    }

    var 数字行 = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'center',
      gap: 8,
      margin: '12px 0 6px',
    }

    var 大数字 = {
      fontSize: 60,
      lineHeight: 1.05,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-primary)',
    }

    var 秒单位 = {
      fontSize: 20,
      fontWeight: 500,
      color: 'var(--dsw-alias-label-secondary)',
    }

    var 按钮 = {
      marginTop: 16,
      padding: '6px 16px',
      fontSize: 13,
      borderRadius: 8,
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-secondary)',
      border: '1px solid var(--dsw-alias-border-secondary)',
      fontFamily: 'inherit',
    }

    var 忙红点 = {
      display: 'inline-block',
      width: 8,
      height: 8,
      marginRight: 6,
      borderRadius: 4,
      background: 'var(--dsw-alias-state-error-primary)',
      verticalAlign: 'middle',
    }

    /**
     * 剩余秒数：向下取整，并且少算 1 秒的余量。
     *
     * 截止时间取的是「设置值 + 1 秒」，所以这里用 ceil - 1 得到「向下取整」的显示：
     * 设置 3 秒 → 实际等 4 秒，屏幕上显示 3 → 2 → 1 → 0，每个数字各占 1 秒。
     * 多出的那 1 秒是给最后一下留的缓冲，避免数字刚跳到 0 就动手。
     */
    function 剩余秒(state, now) {
      if (!state) return 0
      // 表还没起（Host 在等页面画出来）：显示完整的设置秒数，数字先不动。
      // 起表后 deadline 定死，这里的算法会从同一个数字接着往下数，看不出接缝。
      if (!state.deadline) return state.countdownSec || 0
      var left = state.deadline - now
      if (left <= 0) return 0
      // Host 在末尾多给了 500ms 缓冲（index.js 的 COUNTDOWN_TAIL_MS）。
      // 先把这段减掉再取整，数字才各占整 1 秒；否则第一个数字只闪半秒。
      var sec = Math.ceil((left - 500) / 1000)
      var max = state.countdownSec || 0
      if (sec > max) sec = max
      return sec > 0 ? sec : 0
    }

    function RestartOverlay() {
      var stateBox = React.useState(null)
      var state = stateBox[0]
      var setState = stateBox[1]

      // 本地 tick：只在倒计时时用，驱动百分秒级的重绘
      var tickBox = React.useState(Date.now())
      var now = tickBox[0]
      var setNow = tickBox[1]

      // 已经对这次倒计时发过取消指令 → 避免每次 mousemove 都 POST 一次
      var cancelledBox = React.useRef(false)

      // 点了取消之后的一小段时间里，服务端那份快照可能还是 counting
      // （/cancel 还在路上）。这段时间不去采信它，否则画面会闪回倒计时页
      // 再跳到终止页 —— 就是「点一下闪一下」的老毛病。
      var suppressBox = React.useRef(0)

      // 已经对这次倒计时报过到 → 只报一次，别把 /viewer 打成轮询
      var reportedBox = React.useRef(false)

      // 当前要画的那份状态
      var 当前 = state
      var phase = 当前 ? 当前.phase : 'idle'
      var counting = phase === 'counting'

      // ── 报到：这一页画出来了，Host 可以起表 ──────────────────────
      // 只对「还没起表」的状态报一次；起表后 deadline 有了，就不用再报了。
      React.useEffect(
        function () {
          if (!counting) {
            reportedBox.current = false
            return undefined
          }
          if (当前 && 当前.deadline) return undefined
          if (reportedBox.current) return undefined
          reportedBox.current = true
          void postViewer()
          return undefined
        },
        [counting, 当前 && 当前.deadline],
      )

      // ── 轮询状态 ──────────────────────────────────────────────────
      React.useEffect(
        function () {

          var stopped = false
          var timer = 0

          function loop() {
            readState()
              .then(function (next) {
                if (stopped) return
                // 本地刚切到终止页、还在等 /cancel 落地的这段时间，
                // 服务端的旧快照（仍是 counting）不许把页面拉回倒计时。
                if (next && next.phase === 'counting' && Date.now() < suppressBox.current) return
                if (next) setState(next)
                // 阶段切换时重置「已取消」标记
                if (!next || next.phase !== 'counting') cancelledBox.current = false
              })
              .catch(function () {
                // Host 没起来 / 路由没注册：静默重试，不弹错误
              })
              .then(function () {
                if (stopped) return
                timer = window.setTimeout(loop, counting ? POLL_ACTIVE_MS : POLL_IDLE_MS)
              })
          }

          loop()
          return function () {
            stopped = true
            if (timer) window.clearTimeout(timer)
          }
        },
        [counting],
      )

      // ── 倒计时期间的重绘 ──────────────────────────────────────────
      React.useEffect(
        function () {
          if (!counting) return undefined
          var id = window.setInterval(function () {
            var t = Date.now()
            setNow(t)
          }, 100)
          return function () {
            window.clearInterval(id)
          }
        },
        [counting],
      )

      // ── 倒计时期间监听真实输入 ───────────────────────────────────
      // capture = true：比任何控件都先拿到事件，界面上的按钮也拦得住
      React.useEffect(
        function () {
          if (!counting) return undefined

          // 不区分输入来源：任何 pointerdown / wheel / keydown 都取消。
          //
          // 曾经试过按 pointerdown.pressure 把「CDP 注入的鼠标按下」漏过去
          // （实测注入的 pressure 是 0、真人是 0.5），方向是错的：
          // 倒计时问的是「现在还有没有人在操作这台机器」，远程桌面、别的
          // 自动化工具、任何软件发出来的输入，都意味着有人在动它。
          // 而且唤醒早已改走 Host 直投（wakeMode: 'plugin'），插件自己根本
          // 不会在倒计时里注入输入，这个判据唯一的用途只剩"帮外部工具偷跑"。
          // 宁可多取消一次，也不要在有人正操作时把 DSH 杀掉。
          function 取消(e) {
            if (cancelledBox.current) return
            cancelledBox.current = true
            void e

            // 直接切到「已取消」页，不要先回 idle 再等 Host 回话：
            // 中间那一帧 idle 什么都不画，屏幕上就是「倒计时闪一下消失、终止页再冒出来」。
            // 本地先摆好这一页，Host 的 /cancel 回来只是把同一页的字段对齐，画面不重建。
            suppressBox.current = Date.now() + 1500
            setState(function (prev) {
              if (!prev || prev.phase !== 'counting') return prev
              var next = Object.assign({}, prev)
              next.phase = 'cancelled'
              next.deadline = 0
              next.cancelReason = 'input'
              next.message = '倒计时被取消（检测到键鼠输入），这次重启没有执行。'
              return next
            })
            void postCancel('input')
          }

          var opts = { capture: true, passive: true }
          window.addEventListener('pointerdown', 取消, opts)
          window.addEventListener('wheel', 取消, opts)
          window.addEventListener('keydown', 取消, opts)
          return function () {
            window.removeEventListener('pointerdown', 取消, opts)
            window.removeEventListener('wheel', 取消, opts)
            window.removeEventListener('keydown', 取消, opts)
          }
        },
        [counting],
      )

      // ── 取消页不自动收摊 ──────────────────────────────────────────────
      // 和「现在不能重启」「重启失败」一样，取消也是一次终止：发起过一次重启、
      // 最后没重启，就得留一张纸告诉人「这次没做」。收摊靠「知道了」按钮。

      // ── 「正在重启」页 3 秒后自行消失 ──────────────────────────────────
      // 脚本拉起来之后一秒内进程就没了，这一页本来只该存在一瞬。3 秒是容错：
      // 脚本没跑起来、或进程迟迟不退出时，不让它一直糊在屏幕上挡人。
      const [重启页已藏, 设重启页已藏] = React.useState(false)
      React.useEffect(
        function () {
          if (phase !== 'launching') {
            设重启页已藏(false)
            return undefined
          }
          var timer = window.setTimeout(function () {
            设重启页已藏(true)
          }, 3000)
          return function () {
            window.clearTimeout(timer)
          }
        },
        [phase],
      )

      if (!state) return null
      if (phase === 'idle') return null

      if (phase === 'launching') {
        if (重启页已藏) return null
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': 'polite' },
            h('div', { style: 标题行 }, '正在重启 DSH'),
            h('div', { style: 说明 }, '已经交给重启脚本，几秒后窗口会关闭并重新打开。'),
          ),
        )
      }

      // 倒计时被取消：这三种终止（取消 / 忙 / 失败）都要给一张带出口的页，
      // 否则「发起过重启」这件事在界面上等于没发生过 —— 页面一闪就没了。
      if (phase === 'cancelled') {
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': 'assertive' },
            h('div', { style: 标题行 }, '已取消重启'),
            h(
              'div',
              { style: Object.assign({}, 说明, { marginTop: 14 }) },
              (当前 && 当前.message) || '倒计时被取消，这次重启没有执行。',
            ),
            h(
              'button',
              {
                type: 'button',
                style: 按钮,
                onClick: function () {
                  setState(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, { phase: 'idle' })
                  })
                  void postDismiss()
                },
              },
              '知道了',
            ),
          ),
        )
      }

      if (phase === 'blocked') {
        var blockers = Array.isArray(state.blockers) ? state.blockers : []
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': 'polite' },
            h('div', { style: 标题行 }, '现在不能重启'),
            h(
              'div',
              { style: 说明 },
              '还有 ',
              h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, String(blockers.length)),
              ' 处在忙，这次没有重启。等它们跑完，请稍后再发起一次重启。',
            ),
            h(
              'div',
              { style: Object.assign({}, 说明, { marginTop: 12, textAlign: 'left' }) },
              blockers.slice(0, 5).map(function (b, i) {
                return h(
                  'div',
                  { key: i },
                  h('span', { style: 忙红点 }),
                  String(b.label || b.kind || '未知任务'),
                )
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                style: 按钮,
                onClick: function () {
                  setState(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, { phase: 'idle', blockers: [] })
                  })
                  void postDismiss()
                },
              },
              '知道了',
            ),
          ),
        )
      }

      // 失败页：脚本没起来、或者起来了但重启始终没发生（看门狗判的）。
      // 这一页必须有「知道了」，否则它和倒计时页一样是块挡板 —— 而它偏偏
      // 可能等不到进程被杀，人就被永远挡在门外。
      if (phase === 'failed') {
        return h(
          'div',
          { style: 遮罩, role: 'presentation' },
          h(
            'div',
            { style: 卡片, role: 'dialog', 'aria-live': 'assertive' },
            h('div', { style: 标题行 }, '重启失败'),
            h(
              'div',
              { style: Object.assign({}, 说明, { marginTop: 14 }) },
              (当前 && 当前.message) || '这次重启没有发生，DSH 仍在运行。',
            ),
            h(
              'button',
              {
                type: 'button',
                style: 按钮,
                onClick: function () {
                  setState(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, { phase: 'idle', blockers: [] })
                  })
                  void postDismiss()
                },
              },
              '知道了',
            ),
          ),
        )
      }

      // counting
      var 秒 = 剩余秒(当前, now)
      return h(
        'div',
        { style: 遮罩, role: 'presentation' },
        h(
          'div',
          { style: 卡片, role: 'dialog', 'aria-live': 'assertive' },
          // 三行，正式版就这三行：
          //   DSH 重启倒计时  /  XX 秒  /  本页面点击鼠标或按任意键取消
          // 不放「取消」按钮：按钮会主动招人去点，而这里的语义是「有人在操作
          // 就说明现在不该动手」，让人下意识去点反而增加误触取消的机会。
          h('div', { style: 标题行 }, 'DSH 重启倒计时'),
          h(
            'div',
            { style: 数字行 },
            h('span', { style: 大数字 }, String(秒)),
            h('span', { style: 秒单位 }, '秒'),
          ),
          h('div', { style: 说明 }, '本页面点击鼠标或按任意键取消'),
          h(
            'div',
            { style: Object.assign({}, 说明, { marginTop: 10, fontSize: 12 }) },
            当前.command ? '关闭后执行：' + 当前.command : '',
          ),
        ),
      )
    }

    // ── 设置页 ──────────────────────────────────────────────────────────────
    // 只放「默认值」：agent 每次调 restart_dsh 传的参数优先。改动只在 Host 的
    // settings.json 里（DESIGN 第十一节：设置落盘，改完立刻生效并保留）。

    var 设置页 = {
      padding: '4px 2px 12px',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
    }

    var 页说明 = {
      fontSize: 12,
      lineHeight: 1.7,
      color: 'var(--dsw-alias-label-secondary)',
    }

    var 设置行 = {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginTop: 12,
    }

    var 设置标签 = {
      flex: '0 0 132px',
      fontSize: 13,
      color: 'var(--dsw-alias-label-secondary)',
    }

    var 输入框 = {
      flex: '1 1 auto',
      minWidth: 0,
      padding: '6px 10px',
      fontSize: 13,
      borderRadius: 8,
      fontFamily: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-secondary)',
    }

    var 设置按钮 = {
      padding: '6px 16px',
      fontSize: 13,
      borderRadius: 8,
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-secondary)',
      border: '1px solid var(--dsw-alias-border-secondary)',
      fontFamily: 'inherit',
    }

    // 刻意没有「默认命令」：命令只能由调用方当次传入。一条留在设置页里的
    // 命令，最坏会在某次纯重启时被悄悄执行，而没人记得自己设过它。
    var 设置项 = [
      { key: 'wakeMode', 标签: '唤醒方式', type: 'select', 提示: '重启后用什么办法把唤醒词送回去' },
      { key: 'autoSay', 标签: '默认唤醒词', type: 'text', 提示: '重启后自动发回原会话的那句话；留空就用代码默认值' },
      { key: 'countdownSec', 标签: '默认倒计时（秒）', type: 'number', 提示: '触发后等多少秒再动手；这期间任何键鼠输入都会取消' },
      { key: 'timeoutSec', 标签: '默认超时（秒）', type: 'number', 提示: '命令最多跑多久；超时就掐掉整棵进程树，DSH 照样拉起来' },
      { key: 'logKeep', 标签: '日志保留份数', type: 'number', 提示: '一次运行一个文件，只保留最近这么多份' },
    ]

    var 现状行 = {
      display: 'flex',
      alignItems: 'baseline',
      gap: 10,
      marginTop: 8,
      fontSize: 12,
      lineHeight: 1.6,
    }

    var 现状名 = {
      flex: '0 0 72px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    var 等宽值 = {
      flex: '1 1 auto',
      minWidth: 0,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 11.5,
      color: 'var(--dsw-alias-label-secondary)',
      wordBreak: 'break-all',
    }

    var 分节标题 = {
      marginTop: 22,
      marginBottom: 2,
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-secondary)',
    }

    function 现状(名, 值) {
      return h(
        'div',
        { style: 现状行 },
        h('span', { style: 现状名 }, 名),
        h('span', { style: 等宽值 }, 值),
      )
    }

    function RestartSettings() {
      var formState = React.useState(null)
      var form = formState[0]
      var setForm = formState[1]

      var noteState = React.useState('')
      var note = noteState[0]
      var setNote = noteState[1]

      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]

      var metaState = React.useState(null)
      var meta = metaState[0]
      var setMeta = metaState[1]

      var runState = React.useState(null)
      var lastRun = runState[0]
      var setLastRun = runState[1]

      // 输入的当前值放在 ref 里，改一次就写一次：自动保存的防抖回调不该依赖
      // 渲染时闭包里的 form（那个是旧的）。
      var 表单引用 = React.useRef(null)
      var 自动保存定时 = React.useRef(null)

      var 置表单 = function (next) {
        表单引用.current = next
        setForm(next)
      }

      React.useEffect(function () {
        return function () {
          if (自动保存定时.current) clearTimeout(自动保存定时.current)
        }
      }, [])

      React.useEffect(function () {
        var alive = true
        request('/settings', { method: 'GET', headers: { accept: 'application/json' } })
          .then(function (body) {
            if (!alive) return
            置表单(body && body.value ? body.value : null)
            setMeta(body && body.meta ? body.meta : null)
          })
          .catch(function () {
            if (alive) setNote('读不到设置（Host 半边可能没起来）')
          })
        request('/last-run', { method: 'GET', headers: { accept: 'application/json' } })
          .then(function (body) {
            if (!alive) return
            setLastRun(body && body.value ? body.value : null)
          })
          .catch(function () {
            // 没有上一次运行结果不算错误，静默留空。
          })
        return function () {
          alive = false
        }
      }, [])

      /**
       * 提交一次设置。静默 = 自动保存：不闪「保存中…」，提示语也短一些。
       * 成功之后用 Host 回给的值覆盖表单——钳位后的真实值（比如 700 会变 600）
       * 必须立刻显示出来，否则输入框里留着的是用户打的字，看起来像没生效。
       */
      var 提交 = function (target, 静默) {
        if (!target) return
        if (!静默) setSaving(true)
        request('/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(target),
        })
          .then(function (body) {
            var 新值 = body && body.value ? body.value : target
            置表单(新值)
            if (body && body.meta) setMeta(body.meta)
            setNote(静默 ? '已自动保存' : '已保存')
          })
          .catch(function (err) {
            setNote('保存失败：' + String(err && err.message ? err.message : err))
          })
          .then(function () {
            if (!静默) setSaving(false)
          })
      }

      var 改 = function (key) {
        return function (event) {
          var value = event && event.target ? event.target.value : ''
          setNote('')
          var next = Object.assign({}, 表单引用.current || {})
          next[key] = value
          置表单(next)
          // 改完就不管了：停手 700ms 后自己保存。关掉设置页也不会丢，
          // 因为他改的那一刻值已经进 formRef 了。
          if (自动保存定时.current) clearTimeout(自动保存定时.current)
          自动保存定时.current = setTimeout(function () {
            自动保存定时.current = null
            提交(next, true)
          }, 700)
        }
      }

      var 保存 = function () {
        if (自动保存定时.current) {
          clearTimeout(自动保存定时.current)
          自动保存定时.current = null
        }
        提交(表单引用.current, false)
      }

      if (!form) {
        return h('div', { style: 设置页 }, h('div', { style: 页说明 }, note || '读取中…'))
      }

      var 渲染字段 = function (field) {
        var 值 = form[field.key] === undefined ? '' : String(form[field.key])
        var 控件
        if (field.type === 'select') {
          var 选项 = meta && meta.wakeModes ? meta.wakeModes : []
          控件 = h(
            'select',
            {
              style: 输入框,
              value: 值,
              'aria-label': field.标签,
              onChange: 改(field.key),
            },
            选项.map(function (opt) {
              return h('option', { key: opt.value, value: opt.value }, opt.label)
            }),
          )
        } else {
          控件 = h('input', {
            type: field.type,
            style: 输入框,
            value: 值,
            placeholder: field.提示,
            'aria-label': field.标签,
            onChange: 改(field.key),
          })
        }
        return h('label', { key: field.key, style: 设置行 }, h('span', { style: 设置标签 }, field.标签), 控件)
      }

      var 上次运行 = '还没跑过'
      if (lastRun && lastRun.at) {
        var 结论 = lastRun.timedOut
          ? '命令超时被中止'
          : lastRun.exitCode === null
            ? '没跑命令'
            : lastRun.exitCode === 0
              ? '命令成功'
              : '命令失败（退出码 ' + lastRun.exitCode + '）'
        上次运行 =
          new Date(lastRun.at).toLocaleString() +
          ' · ' +
          结论 +
          (lastRun.command ? ' · ' + lastRun.command : '')
      }

      var 唤醒说明 = '插件直投（Host 直接发进会话，不碰页面）'
      if (form.wakeMode === 'script') 唤醒说明 = '脚本页面输入（CDP 往输入框打字，要先等渲染）'

      return h(
        'div',
        { style: 设置页 },
        h(
          'div',
          { style: 页说明 },
          '这里只是默认值：agent 每次调用 restart_dsh 时传的参数优先。改动会立刻写盘，DSH 重启后仍然有效。',
        ),
        设置项.map(渲染字段),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 } },
          h(
            'button',
            { type: 'button', style: 设置按钮, disabled: saving, onClick: 保存 },
            saving ? '保存中…' : '保存',
          ),
          note ? h('span', { style: 页说明, role: 'status' }, note) : null,
        ),

        h('div', { style: 分节标题 }, '现在在用'),
        现状('唤醒', 唤醒说明),
        现状('脚本', meta ? meta.scriptPath : '读取中…'),
        现状('状态目录', meta ? meta.stateDir : '读取中…'),
        现状('插件日志', meta ? meta.logs.plugin : '读取中…'),
        现状('运行日志', meta ? meta.logs.run : '读取中…'),
        现状('交接文件', meta ? meta.files.wakeRequest : '读取中…'),
        现状('上次运行', 上次运行),

        h('div', { style: 分节标题 }, '它现在是怎么做事的'),
        [
          '倒计时走完才查整台机器忙不忙：只要还有一个 agent 在跑、或一个后台任务没结束，这次重启就作废。',
          '闲下来了才开始倒计时；倒计时期间任何键鼠输入（本机、远程、别的软件都算）都会取消。',
          '只重启不执行命令是常态：命令要在调用工具的当次传入，这里不给默认命令——留一条在这里，早晚会在某次纯重启时被悄悄执行。',
          '倒计时走完拉起脚本：先关 DSH，再执行命令（如果有），再把 DSH 拉起来。命令失败或超时只影响唤醒词后缀，DSH 照样起来。',
          '重启后由插件自己把唤醒词投回原会话。投不出去就把交接文件删掉、只在插件日志里记一笔，下次启动不会补发——想知道结果就去读日志。',
        ].map(function (line, i) {
          return h('div', { key: 'p' + i, style: 页说明 }, '· ' + line)
        }),
      )
    }

    exports.apply = function (ctx) {
      // ⚠ 两层：ctx.inject(...) 里面再 scope.effect(...)。cordis 只收集 effect 的
      //   返回值，写成 `ctx.effect(() => ctx.inject(...))` 的话旧 fiber 卸载时这组
      //   座位拆不干净，而 slots.register 对同一个 key 二次注册会 throw（旧插件
      //   实测踩过，症状是：界面照旧画得出来、但热重载后整组注册失败）。
      ctx.inject(['slots'], function (scope) {
        scope.effect(function () {
          var disposers = []
          function 记(d) {
            if (typeof d === 'function') disposers.push(d)
          }

          try {
            记(
              scope.slots.inject('shell.overlay', function () {
                return scope.slots.register(
                  { name: 'shell.overlay', id: OVERLAY_ID, order: 100 },
                  RestartOverlay,
                )
              }),
            )
          } catch (err) {
            // 座位注册失败不该拖垮整个插件：工具入口照样能用（只是看不见倒计时）
            try {
              ctx.logger?.warn?.('[' + PKG + '] 注册 shell.overlay 失败：' + String(err))
            } catch {
              // ignore
            }
          }

          try {
            记(
              scope.slots.inject('settings.section', function () {
                return scope.slots.register(
                  { name: 'settings.section', id: SETTINGS_ID, order: 60, label: 'DSH 自动重启' },
                  RestartSettings,
                )
              }),
            )
          } catch (err) {
            try {
              ctx.logger?.warn?.('[' + PKG + '] 注册 settings.section 失败：' + String(err))
            } catch {
              // ignore
            }
          }

          return function () {
            for (var i = disposers.length - 1; i >= 0; i--) {
              try {
                disposers[i]()
              } catch {
                // 单个拆除失败不影响其余的
              }
            }
          }
        })
      })
    }

    return module.exports
  },
})
