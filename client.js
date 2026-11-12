// dsh-fish-service · 客户端插件（DSH Web）
//
// 纯原生 JS + React（DSH 平台自带），没有 npm、没有 CDN、没有构建步骤。
//
// P1：设置页（状态 / 服务地址 / 超时 / 默认音色 / 缓存 / 日志）。
// P2：消息朗读按钮（conversation.chat.assistant-actions）、
//     语音输入麦克风（conversation.input.right）+ 三选一面板（conversation.input.overlay）、
//     自动朗读开关（conversation.input.left）；
//     设置页补「朗读」「语音输入」两个分区。
// P3：本地识图：输入框旁独立按钮（conversation.input.right，与麦克风同一排），
//     点选图片后在本机识别成文字，按顺序插入输入框；图片不进草稿、不上传、不进模型。
// P4：输入框左下工具行的本地 AI 状态胶囊（conversation.input.left）：
//     显存占比 + 任务数，2 秒轮询；点开看 GPU / 模型 / 队列 / 版本详情。
//
// 所有请求都走宿主路由 /dsh-fish-service/*：浏览器不接触 token，也不直接访问 localai。
//
// 槽位 props 说明（DSH 0.2.2-rc.1 的 standard props，见 CONTRACT / docs/P2.md）：
//   - 每个槽位都带 sessionId / useChat / useInput / inputActions / useTrajectory；
//   - conversation.chat.assistant-actions 额外带 messageId（已定稿的助手消息）；
//   - inputActions.captureInsertion() 取「草稿选区 + 版本号」，
//     inputActions.insertText(text, span) 只有在版本没变、编辑器允许编辑时才会插入并返回 true。
//   插入失败不能直接改 DOM（会丢 React 状态），要求用户重试或走剪贴板兜底。

window.__ModuleLoader__.load({
  id: 'dsh-fish-service',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const inject = ['slots', 'uiConversation', 'sidebarRightTabs']
    const h = React.createElement
    const B = '/dsh-fish-service'

    // ---------------- 网络 ----------------

    const get = (path) => fetch(B + path, { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => null)

    const post = (path, body, opts = {}) => fetch(B + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      // 停止朗读时用 AbortController 掐掉还没回来的 /read/segment 请求。
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).then((r) => r.json().catch(() => null))
      .catch((error) => ({
        ok: false,
        code: error?.name === 'AbortError' ? 'canceled' : 'upstream_error',
        hint: String(error?.message || error),
      }))

    /** multipart 上传；不要手动设 content-type，浏览器自己带 boundary。 */
    const postForm = (path, form) => fetch(B + path, { method: 'POST', body: form })
      .then((r) => r.json().catch(() => null))
      .catch((error) => ({ ok: false, code: 'upstream_error', hint: String(error?.message || error) }))

    const 音频地址 = (路径) => `${B}/audio?path=${encodeURIComponent(String(路径 || ''))}`

    // ---------------- 极简 store（跨槽位共享状态） ----------------

    function 造store(初值) {
      let 值 = 初值
      const 听 = new Set()
      return {
        get: () => 值,
        set(下一个) {
          值 = typeof 下一个 === 'function' ? 下一个(值) : 下一个
          for (const 函数 of [...听]) {
            try { 函数(值) } catch { /* 单个订阅者出错不影响别人 */ }
          }
        },
        subscribe(函数) {
          听.add(函数)
          return () => 听.delete(函数)
        },
      }
    }

    function useStore(store) {
      const [值, 设值] = React.useState(store.get)
      React.useEffect(() => {
        const 停 = store.subscribe(设值)
        设值(store.get())
        return 停
      }, [store])
      return 值
    }

    // ---------------- 插件偏好（来自 /state，设置页保存后同步更新） ----------------

    const 偏好 = 造store({
      载入: false,
      在线: false,
      config: {},
      健康: null,
      音色: [],
      插件: {},
    })

    let 偏好请求 = null
    function 载入偏好({ force = false } = {}) {
      if (偏好请求 && !force) return 偏好请求
      偏好请求 = get('/state').then((s) => {
        if (s && s.ok) {
          偏好.set((旧) => ({
            ...旧,
            载入: true,
            在线: Boolean(s.health && s.health.reachable),
            config: s.config || {},
            健康: s.health || null,
            音色: Array.isArray(s.voices) ? s.voices : 旧.音色,
            插件: s.plugin || {},
          }))
        } else {
          偏好.set((旧) => ({ ...旧, 载入: true }))
        }
        return s
      }).catch(() => {
        偏好请求 = null
        return null
      })
      return 偏好请求
    }

    // ---------------- 按会话自动朗读（纯函数，便于单测） ----------------

    const 会话自动朗读上限 = 200
    const 会话键合法 = (键) => typeof 键 === 'string' && /^session-/.test(键)
    const 真值 = (值) => 值 === true || 值 === 'true' || 值 === 1 || 值 === '1'

    /** 当前会话是否自动朗读：本会话有设置就用它，否则回落到全局默认（autoRead）。 */
    function 读会话自动朗读(配置, 会话键) {
      const 配置项 = 配置 && typeof 配置 === 'object' ? 配置 : {}
      const 表 = 配置项.autoReadSessions && typeof 配置项.autoReadSessions === 'object'
        && !Array.isArray(配置项.autoReadSessions)
        ? 配置项.autoReadSessions
        : null
      if (表 && 会话键合法(会话键) && Object.prototype.hasOwnProperty.call(表, 会话键)) {
        return 真值(表[会话键])
      }
      return 真值(配置项.autoRead)
    }

    /** 只改当前会话那一条，返回新配置；其它会话与全局默认保持不变。 */
    function 写会话自动朗读(配置, 会话键, 开) {
      const 配置项 = 配置 && typeof 配置 === 'object' ? 配置 : {}
      if (!会话键合法(会话键)) return 配置项
      const 表 = 配置项.autoReadSessions && typeof 配置项.autoReadSessions === 'object'
        && !Array.isArray(配置项.autoReadSessions)
        ? { ...配置项.autoReadSessions }
        : {}
      // 先删再写：最近改过的会话排在最后，超过上限时优先淘汰最早的设置。
      delete 表[会话键]
      表[会话键] = 开 === true || 开 === 'true'
      const 键们 = Object.keys(表)
      while (键们.length > 会话自动朗读上限) delete 表[键们.shift()]
      return { ...配置项, autoReadSessions: 表 }
    }

    /** 后台朗读：旧配置没有该字段、或值无法识别时按开启；只有明确关闭才关。 */
    function 读后台自动朗读(配置) {
      const 值 = 配置 && typeof 配置 === 'object' ? 配置.autoReadInBackground : undefined
      if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
      return true
    }

    /** 这条新回复是否自动朗读：会话开关必须开；页面在后台时还要「后台也自动朗读」开着。 */
    function 是否自动朗读(配置, 会话键, 页面可见) {
      if (!读会话自动朗读(配置, 会话键)) return false
      if (页面可见) return true
      return 读后台自动朗读(配置)
    }

    // 有组件挂载时才轮询 /health（30 秒一次），没人看就不打扰服务。
    let 心跳 = null
    let 挂载数 = 0
    function 保活(开) {
      挂载数 += 开 ? 1 : -1
      if (挂载数 < 0) 挂载数 = 0
      if (开 && !心跳) {
        心跳 = setInterval(async () => {
          try {
            const r = await fetch(B + '/health', { cache: 'no-store' }).then((x) => x.json())
            if (r) 偏好.set((旧) => ({ ...旧, 在线: Boolean(r.ok) }))
          } catch { /* 服务重启/DSH 关闭时忽略 */ }
        }, 30000)
      } else if (!开 && 挂载数 === 0 && 心跳) {
        clearInterval(心跳)
        心跳 = null
      }
    }

    // ---------------- 朗读播放器（全局只有一个） ----------------
    //
    // 流式朗读（P2 性能修复）：
    //   1. POST /read/plan 立刻拿分段计划（不合成）；
    //   2. 按顺序请求 /read/segment，拿到第 1 段就开始播，同时预取下一段；
    //   3. 切换消息 / 再点一次 = stop()：递增代次 + abort 未完成的 segment 请求。
    // 这样长文不用等全部合成，首段出声明显更早；同一段重复朗读由服务端缓存直接命中。

    const 播放 = {
      态: 造store({ phase: 'idle', messageId: '', error: '', index: 0, total: 0 }),
      音频: null,
      预取: null,
      序号: 0,
      消息: '',
      中止: null,

      stop(错误 = '') {
        this.序号 += 1
        try { this.中止?.abort() } catch { /* 已经结束 */ }
        this.中止 = null
        for (const 音频 of [this.音频, this.预取]) {
          if (!音频) continue
          try { 音频.pause() } catch { /* 已经结束 */ }
          try { 音频.removeAttribute('src'); 音频.load() } catch { /* 忽略 */ }
        }
        this.音频 = null
        this.预取 = null
        this.消息 = ''
        this.态.set({ phase: 'idle', messageId: '', error: 错误, index: 0, total: 0 })
      },

      /** 流式合成并顺序播放；同一条消息再点一次 = 停止。 */
      async 合成并播放(messageId, 文本, 配置) {
        this.stop()
        const 代 = ++this.序号
        const 中止 = typeof AbortController === 'function' ? new AbortController() : null
        this.中止 = 中止
        this.消息 = messageId
        this.态.set({ phase: 'synth', messageId, error: '', index: 0, total: 0 })

        const plan = await post('/read/plan', {
          text: 文本,
          voice: 配置.ttsVoice,
          speed: 配置.ttsSpeed,
          maxChars: 配置.readMaxChars,
          skipCodeBlocks: 配置.readSkipCode !== false,
        }, { signal: 中止?.signal })
        if (代 !== this.序号) return
        if (!plan || !plan.ok) {
          this.中止 = null
          this.态.set({ phase: 'error', messageId, error: (plan && plan.hint) || '朗读准备失败，请稍后重试。', index: 0, total: 0 })
          return
        }

        const 段们 = Array.isArray(plan.segments) ? plan.segments.filter((x) => x && typeof x.text === 'string') : []
        if (!段们.length) {
          this.中止 = null
          this.态.set({ phase: 'error', messageId, error: '这条消息没有可朗读的文字。', index: 0, total: 0 })
          return
        }
        const 总段 = 段们.length
        const 提示 = plan.truncated ? '（内容过长，仅朗读了前一部分）' : ''

        // 每段只请求一次；任务表让「预取」和「正在播的下一段」复用同一个请求。
        const 任务 = new Map()
        const 要段 = (i) => {
          if (!任务.has(i)) {
            任务.set(i, post('/read/segment', {
              index: Number.isInteger(段们[i].index) ? 段们[i].index : i,
              total: 总段,
              text: 段们[i].text,
              ...(plan.voice ? { voice: plan.voice } : {}),
              ...(plan.speed ? { speed: plan.speed } : {}),
            }, { signal: 中止?.signal }))
          }
          return 任务.get(i)
        }

        // 第 1 段和第 2 段一起发出去：第 1 段一到就播，第 2 段在后台合成。
        // 第 1 段回来之前保持「合成中」转圈；回来后才切到「播放中 1/N」。
        void 要段(0)
        if (总段 > 1) void 要段(1)

        for (let i = 0; i < 总段; i++) {
          if (代 !== this.序号) return
          const r = await 要段(i)
          if (代 !== this.序号) return
          if (!r || !r.ok) {
            try { 中止?.abort() } catch { /* 已经结束 */ }
            this.中止 = null
            this.态.set({
              phase: 'error',
              messageId,
              error: (r && r.hint) || '朗读中断，请重试。',
              index: 0,
              total: 0,
            })
            return
          }
          this.态.set((旧) => ({ ...旧, phase: 'playing', error: '', hint: 提示, index: i + 1, total: 总段 }))
          // 播放当前段之前先把下一段请求发出去，利用播放时间做预取。
          if (i + 1 < 总段) void 要段(i + 1)
          const 错误 = await this.播一段({ wavPath: r.wavPath }, 代)
          if (代 !== this.序号) return
          if (错误) {
            try { 中止?.abort() } catch { /* 已经结束 */ }
            this.中止 = null
            this.态.set((旧) => ({ ...旧, phase: 'error', error: 错误, index: 0, total: 0 }))
            return
          }
        }
        if (代 === this.序号) {
          this.中止 = null
          this.态.set({ phase: 'idle', messageId: '', error: '', hint: 提示, index: 0, total: 0 })
        }
      },

      播一段(item, 代) {
        return new Promise((resolve) => {
          const 音频 = new Audio(音频地址(item.wavPath))
          this.音频 = 音频
          let 结束 = false
          let 检查 = null
          const 收尾 = (错误) => {
            if (结束) return
            结束 = true
            if (检查) { clearInterval(检查); 检查 = null }
            if (this.音频 === 音频) this.音频 = null
            try { 音频.pause() } catch { /* 忽略 */ }
            resolve(错误)
          }
          音频.onended = () => 收尾('')
          音频.onerror = () => 收尾('音频无法播放，请再点一次朗读。')
          try {
            音频.play().then(() => { /* 开始播了 */ }).catch(() => {
              收尾('浏览器阻止了自动播放，请再点一次朗读。')
            })
          } catch {
            收尾('无法播放这段音频。')
          }
          // 播放器被 stop() 强行换掉时，别让 Promise 永远挂着。
          检查 = setInterval(() => {
            if (代 !== this.序号) 收尾('')
          }, 300)
        })
      },
    }

    // ---------------- 从聊天快照里取消息文字 ----------------

    function 取轮次键们(快照, turn) {
      try {
        const 键们 = 快照 && 快照.locations && 快照.locations.getTurn ? 快照.locations.getTurn(turn) : null
        return Array.isArray(键们) ? 键们 : []
      } catch {
        return []
      }
    }

    function 取节点(快照, 键) {
      try {
        return 快照 && 快照.nodes && 快照.nodes.get ? 快照.nodes.get(键) : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 在 Chat 快照里找「最终节点 messageId 等于本条消息」的轮次。
     * 消息定稿后轮次不会变，所以按 messageId 缓存轮次号；否则每条消息每次快照
     * 都扫全部轮次，长会话里会拖慢流式渲染。
     */
    const 消息轮次缓存 = new Map()

    function 找消息轮次(快照, messageId) {
      if (!快照 || !messageId) return null
      const 轮次 = 快照.timeline && Array.isArray(快照.timeline.turnOrder) ? 快照.timeline.turnOrder : []
      const 缓存 = 消息轮次缓存.get(messageId)
      // 先试缓存轮次；命中就只扫一轮。缓存失效（切会话/重建）时再扫全部。
      const 候选 = 缓存 !== undefined && 轮次.includes(缓存) ? [缓存] : []
      for (const turn of 候选) {
        const 键们 = 取轮次键们(快照, turn)
        for (const 键 of 键们) {
          const 节点 = 取节点(快照, 键)
          if (!节点 || 节点.kind !== 'turn-tail') continue
          const 终 = 节点.data && 节点.data.closing && 节点.data.closing.finalNode
          if (终 && 终.messageId === messageId) {
            return {
              turn,
              键们,
              是最后: 轮次[轮次.length - 1] === turn,
              块们: Array.isArray(节点.data.closing.blocks) ? 节点.data.closing.blocks : [],
            }
          }
        }
      }
      for (const turn of 轮次) {
        if (候选.length && turn === 候选[0]) continue
        const 键们 = 取轮次键们(快照, turn)
        for (const 键 of 键们) {
          const 节点 = 取节点(快照, 键)
          if (!节点 || 节点.kind !== 'turn-tail') continue
          const 终 = 节点.data && 节点.data.closing && 节点.data.closing.finalNode
          if (终 && 终.messageId === messageId) {
            消息轮次缓存.set(messageId, turn)
            return {
              turn,
              键们,
              是最后: 轮次[轮次.length - 1] === turn,
              块们: Array.isArray(节点.data.closing.blocks) ? 节点.data.closing.blocks : [],
            }
          }
        }
      }
      return null
    }

    function 消息位置(快照, messageId) {
      const 命中 = 找消息轮次(快照, messageId)
      if (!命中) return ''
      return `${命中.turn}|${命中.是最后 ? 1 : 0}`
    }

    function 消息文本(快照, messageId) {
      const 命中 = 找消息轮次(快照, messageId)
      if (!命中) return ''
      // 只读「这一轮最终回复」的文本块（closing.blocks）；工具调用 / 思考 / 中间步骤都不读。
      const 段 = []
      for (const 块 of 命中.块们) {
        if (块 && 块.kind === 'text' && typeof 块.text === 'string') 段.push(块.text)
      }
      return 段.join('\n\n').trim()
    }

    /** 兜底：快照取不到时，从按钮所在的 DOM 行往上找最近的助手消息行。 */
    function DOM取文本(元素) {
      try {
        if (!元素 || typeof 元素.closest !== 'function') return ''
        const 行 = 元素.closest('[data-chat-flow-key]') || 元素.closest('[data-chat-anchor-key]')
        if (!行 || !行.parentElement) return ''
        const 列表 = 行.parentElement
        let 目标 = null
        for (let 前 = 行.previousElementSibling; 前; 前 = 前.previousElementSibling) {
          if (前.getAttribute && 前.getAttribute('data-chat-flow-kind') === 'assistant-step') { 目标 = 前; break }
        }
        if (!目标) {
          const 全部 = 列表.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
          目标 = 全部.length ? 全部[全部.length - 1] : null
        }
        if (!目标) return ''
        const 文 = String(目标.innerText || '').trim()
        return 文
      } catch {
        return ''
      }
    }

    // ---------------- 图标 + 样式 ----------------

    function 图标发声(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('path', { d: 'M2.6 6.1h2.1L7.6 3.4v9.2L4.7 9.9H2.6z', fill: 'currentColor' }),
        h('path', { d: 'M10.1 5.4a3.4 3.4 0 0 1 0 5.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { d: 'M11.9 3.7a5.6 5.6 0 0 1 0 8.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    function 图标暂停(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 3.4, y: 2.8, width: 3.2, height: 10.4, rx: 1 }),
        h('rect', { x: 9.4, y: 2.8, width: 3.2, height: 10.4, rx: 1 }))
    }

    function 图标转圈(大小 = 15) {
      return h('svg', { className: 'fish-spin', viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.25 }),
        h('path', { d: 'M8 2a6 6 0 0 1 6 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    function 图标麦克风(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('rect', { x: 5.6, y: 1.8, width: 4.8, height: 8, rx: 2.4, fill: 'currentColor' }),
        h('path', { d: 'M3.6 7.6a4.4 4.4 0 0 0 8.8 0', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M8 12v2.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    function 图标图片(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 5.7, cy: 6.6, r: 1.15, fill: 'currentColor' }),
        h('path', { d: 'M2.6 12.2l3.1-3.1 2.1 2.1 1.9-1.7 3.7 3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', strokeLinecap: 'round' }))
    }

    function 图标停止(大小 = 14) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 2.4 }))
    }

    const 样式文本 = `
@keyframes fish-spin { to { transform: rotate(360deg) } }
@keyframes fish-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
@keyframes fish-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }
.fish-spin { animation: fish-spin .9s linear infinite; transform-origin: 50% 50%; }
.fish-iconbtn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 24px; min-width: 24px; padding: 0 4px; margin: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
}
.fish-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, inherit); }
.fish-iconbtn[data-on="1"] { color: var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-iconbtn[data-rec="1"] { color: #d0342c; }
.fish-iconbtn[disabled] { opacity: .45; cursor: default; }
.fish-dot { width: 7px; height: 7px; border-radius: 50%; background: #d0342c; animation: fish-pulse 1.1s ease-in-out infinite; }
.fish-panel {
  position: absolute; left: 8px; right: 8px; bottom: 0; margin-bottom: 10px;
  z-index: 40; box-sizing: border-box; max-width: 560px; margin-left: auto; margin-right: auto;
  padding: 12px 14px; border-radius: 12px; animation: fish-in .12s ease-out;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.98));
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 10px 30px rgba(0,0,0,.18);
  font-size: 13px; line-height: 1.6;
}
.fish-panel-title { font-weight: 650; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.fish-panel-dim { opacity: .62; font-size: 12px; }
.fish-panel-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.fish-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 8px;
  background: transparent; color: inherit; font: inherit; font-size: 12.5px;
  padding: 6px 12px; cursor: pointer;
}
.fish-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.fish-btn[data-primary="1"] {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-state-business-primary, #2f6fed); color: #fff;
}
.fish-btn[disabled] { opacity: .5; cursor: default; }
.fish-wave { display: inline-flex; align-items: center; gap: 2px; height: 22px; }
.fish-wave i { display: block; width: 3px; border-radius: 2px; background: currentColor; transition: height .12s linear; }
.fish-err { color: #c0392b; font-size: 12px; }
.fish-ok { color: var(--dsw-alias-state-business-primary, #2f6fed); font-size: 12px; }
/* 原生下拉：某些主题下 option 会继承白色文字，而弹层的系统背景是白色 → 看不清。
   这里显式给 select 与 option 配「背景/文字」成对颜色，跟随 DSH 主题变量。 */
select.fish-select {
  color-scheme: light dark;
  background-color: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
select.fish-select option,
select.fish-select optgroup {
  background-color: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
select.fish-select option:checked {
  background-color: var(--dsw-alias-state-business-primary, #2f6fed);
  color: #ffffff;
}
/* 其它原生表单控件同理，避免浅底白字 */
.fish-service-settings input,
.fish-service-settings textarea,
.fish-service-settings select {
  background-color: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.fish-service-settings input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-service-settings input::placeholder { color: var(--dsw-alias-label-secondary, #888); opacity: 1; }
/* 框选文字工具条：紧凑一行，翻译结果在下方展开，不抢选区的复制操作 */
.fish-selbar {
  display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;
  max-width: min(540px, 92vw); padding: 4px 6px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.98));
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 6px 20px rgba(0,0,0,.14);
  font-size: 12px; line-height: 1.5;
}
.fish-selbar button {
  border: 0; border-radius: 6px; background: transparent; color: inherit;
  font: inherit; font-size: 12px; padding: 4px 8px; cursor: pointer;
}
.fish-selbar button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.fish-selbar button[disabled] { opacity: .45; cursor: default; }
.fish-selnote { opacity: .62; font-size: 11.5px; padding: 0 4px; }
.fish-selpanel {
  flex-basis: 100%; margin-top: 2px; padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
}
.fish-seltext {
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto;
  user-select: text; -webkit-user-select: text;
}
.fish-selrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
/* 输入框旁的本地识图按钮：识别状态用小浮条，不挤占输入栏 */
.fish-vision-toast {
  position: fixed; right: 18px; bottom: 84px; z-index: 60; max-width: 260px;
  padding: 6px 10px; border-radius: 8px; pointer-events: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 12px; line-height: 1.5;
  box-shadow: 0 4px 16px rgba(0,0,0,.16);
}
/* 输入框左下工具行：本地 AI 小胶囊；详情浮层向上弹，不挤占输入区 */
.fish-metrics { position: relative; display: inline-flex; align-items: center; height: 26px; }
.fish-metrics-pill {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px;
  border: 1px solid transparent; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary, #666); font: inherit; font-size: 12px; line-height: 1;
  cursor: pointer; white-space: nowrap;
}
.fish-metrics-pill:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, inherit);
}
.fish-metrics-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-state-business-primary, #2f6fed);
}
.fish-metrics-text { overflow: hidden; text-overflow: ellipsis; }
.fish-metrics-pill[data-level="warn"] { color: #d98600; }
.fish-metrics-pill[data-level="danger"] { color: #e0524a; }
.fish-metrics[data-offline="1"] .fish-metrics-pill { opacity: .62; }
.fish-metrics[data-offline="1"] .fish-metrics-dot { background: var(--dsw-alias-label-secondary, #8a8a8a); }
.fish-metrics-pop {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 75;
  box-sizing: border-box; width: 288px; max-width: min(88vw, 320px); max-height: 60vh; overflow: auto;
  padding: 12px 14px; border-radius: 12px; animation: fish-in .12s ease-out;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.98));
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 10px 30px rgba(0,0,0,.24);
  font-size: 12px; line-height: 1.6;
}
.fish-metrics-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.fish-metrics-title { font-weight: 650; font-size: 13px; }
.fish-metrics-dim { opacity: .62; }
.fish-metrics-row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 1px 0; }
.fish-metrics-key { opacity: .62; flex: none; }
.fish-metrics-val { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fish-metrics-bar {
  height: 4px; margin: 5px 0 4px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));
}
.fish-metrics-bar i { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-metrics-bar[data-level="warn"] i { background: #d98600; }
.fish-metrics-bar[data-level="danger"] i { background: #e0524a; }
.fish-metrics-sep { height: 1px; margin: 8px 0; background: var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.fish-metrics-empty { opacity: .7; padding: 8px 0; }
.fish-metrics-hint { color: #e0524a; margin-top: 6px; }
.fish-metrics-actions { display: flex; gap: 8px; margin-top: 10px; }
.fish-metrics-actions .fish-btn { flex: 1; padding: 5px 8px; }

/* 右栏「双语翻译」：原文/译文左右并排对着翻，窄容器自动改上下；长文本在框内滚动。 */
.fish-tr { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 380px; padding: 10px 12px; box-sizing: border-box; container-type: inline-size; container-name: fish-tr; }
.fish-tr-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); gap: 8px; flex: 1 1 0; min-height: 0; }
.fish-tr-top { display: flex; flex-direction: column; gap: 6px; flex: none; }
.fish-tr-pane { display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 0; }
.fish-tr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-height: 16px; font-size: 11.5px; line-height: 1.4; }
.fish-tr-role { flex: none; font-weight: 600; color: var(--dsw-alias-label-secondary, #666); }
.fish-tr-switch { flex: none; margin-left: auto; padding: 0 2px; border: 0; background: none; color: var(--dsw-alias-state-business-primary, #2f6fed); font: inherit; font-size: 11.5px; line-height: 1.4; cursor: pointer; }
.fish-tr-switch:hover { text-decoration: underline; }
.fish-tr-edit { position: relative; flex: 1 1 0; min-height: 96px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.fish-tr-edit:focus-within { border-color: var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-tr-mirror, .fish-tr-textarea { position: absolute; inset: 0; box-sizing: border-box; margin: 0; padding: 8px 10px; border: 0; font: inherit; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; }
.fish-tr-mirror { color: transparent; overflow: hidden; pointer-events: none; user-select: none; }
.fish-tr-textarea { width: 100%; height: 100%; resize: none; overflow: auto; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); outline: none; }
.fish-tr-textarea::placeholder { color: var(--dsw-alias-label-secondary, #888); opacity: 1; }
.fish-tr-seg { border-radius: 3px; background: transparent; }
.fish-tr-seg[data-active="1"] { background: var(--dsw-alias-state-business-primary-subtle, rgba(47,111,237,.16)); box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary-subtle, rgba(47,111,237,.16)); }
.fish-tr-seg[data-selected="1"] { background: var(--dsw-alias-state-business-primary-subtle, rgba(47,111,237,.26)); box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-tr-seg[data-selected="1"][data-active="1"] { background: var(--dsw-alias-state-business-primary-subtle, rgba(47,111,237,.34)); }
.fish-tr-segbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: none; min-height: 24px; font-size: 12px; }
.fish-tr-segbar[data-idle="1"] { opacity: .85; }
.fish-tr-segbar .fish-btn { padding: 2px 8px; font-size: 12px; }
.fish-tr-del { color: var(--dsw-alias-state-error-primary, #c0392b); }
.fish-tr-pane[data-locked="1"] .fish-tr-edit { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.fish-tr-pane[data-locked="1"] .fish-tr-textarea { color: var(--dsw-alias-label-secondary, #666); cursor: default; }
.fish-tr-pane[data-busy="1"] { opacity: .72; }
.fish-tr-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: none; }
.fish-tr-actions .fish-btn { display: inline-flex; align-items: center; gap: 6px; }
.fish-tr-note { font-size: 12px; line-height: 1.5; }
@container fish-tr (max-width: 380px) {
  .fish-tr-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
}
`

    // 样式只注入一次：每个消息都渲染一份 <style> 会把 DOM 撑爆。
    // DSH 自己的客户端包也是这么做的（在客户端模块里往 head 里插一段 CSS）。
    // 借用一个计数：apply 可能被重放（热重载），最后一个卸载者才移除节点。
    let 样式借用 = 0
    function 注入样式() {
      try {
        if (typeof document === 'undefined') return () => {}
        let 节点 = document.querySelector('style[data-fish-service="p2"]')
        const 新建 = !节点
        if (!节点) {
          节点 = document.createElement('style')
          节点.dataset.fishService = 'p2'
          节点.textContent = 样式文本
          document.head.appendChild(节点)
        }
        样式借用 += 1
        return () => {
          样式借用 = Math.max(0, 样式借用 - 1)
          if (新建 && 样式借用 === 0) {
            try { 节点.remove() } catch { /* 已从文档移除 */ }
          }
        }
      } catch {
        // 注入失败只影响外观，不影响功能。
        return () => {}
      }
    }

    // ---------------- 朗读按钮 ----------------

    const 已自动朗读 = new Set()
    // 每个会话「第一次看到时的最后一轮」：只有比它更新的回复才会自动朗读，
    // 这样打开旧会话 / 切回旧会话都不会把历史消息念一遍。
    const 会话初始末轮 = new Map()

    function 末轮次(快照) {
      try {
        const 轮次 = 快照 && 快照.timeline && Array.isArray(快照.timeline.turnOrder) ? 快照.timeline.turnOrder : []
        return 轮次.length ? 轮次[轮次.length - 1] : -1
      } catch {
        return -1
      }
    }

    /** props.useChat 缺失时的占位选择器：仍然按 hook 调用，保证 hook 数量稳定。 */
    function 空选择器() {
      const [空] = React.useState('')
      return 空
    }

    function 朗读按钮(props) {
      const { messageId } = props || {}
      const 播放态 = useStore(播放.态)
      const 偏好态 = useStore(偏好)
      const 按钮 = React.useRef(null)
      const 挂载时已载入 = React.useRef(Boolean(偏好.get().载入))

      // 槽位标准 props：useChat 一定有；真没有时退化成空选择器（不读快照，只走 DOM 兜底）。
      const 用聊天 = typeof props?.useChat === 'function' ? props.useChat : 空选择器

      const 文本 = 用聊天((快照) => 消息文本(快照, messageId))
      const 位置 = 用聊天((快照) => 消息位置(快照, messageId))
      const 末轮 = 用聊天((快照) => 末轮次(快照))
      const 会话键 = String(props?.sessionId || '')

      React.useEffect(() => {
        // 本轮所有消息按钮挂载时记录一次；之后新到的回复轮次会更大。
        if (!会话初始末轮.has(会话键)) 会话初始末轮.set(会话键, 末轮)
      }, [末轮, 会话键])

      React.useEffect(() => {
        保活(true)
        if (!偏好.get().载入) void 载入偏好()
        return () => 保活(false)
      }, [])

      const 正在这条 = 播放态.messageId === messageId && (播放态.phase === 'synth' || 播放态.phase === 'playing')
      const 合成中 = 正在这条 && 播放态.phase === 'synth'
      const 播放中 = 正在这条 && 播放态.phase === 'playing'
      const 自动朗读 = 读会话自动朗读(偏好态.config, 会话键)
      const 后台朗读 = 读后台自动朗读(偏好态.config)
      const 全局自动朗读开 = 界面开关开(偏好态.config, '自动朗读')

      const 取文本 = () => 文本 || DOM取文本(按钮.current)

      const 点 = async () => {
        if (正在这条) {
          播放.stop()
          return
        }
        const 原文本 = 取文本()
        if (!原文本) {
          播放.态.set({ phase: 'error', messageId, error: '这条消息没有可朗读的文字。', index: 0, total: 0 })
          return
        }
        await 播放.合成并播放(messageId, 原文本, 偏好.get().config || {})
      }

      // 自动朗读：按当前会话的设置判断（未单独设置时回落到全局默认）；
      // 只在「偏好已加载 + 这条是最后一轮」时触发一次。窗口在后台时，
      // 是否朗读由「后台也自动朗读」决定（默认开）。
      React.useEffect(() => {
        if (!挂载时已载入.current) return
        if (!偏好态.载入 || !自动朗读 || !全局自动朗读开) return
        if (!文本 || !位置) return
        const [轮次文本, 最后] = String(位置).split('|')
        if (最后 !== '1') return
        const 轮次 = Number(轮次文本)
        const 初始 = 会话初始末轮.get(会话键)
        if (Number.isFinite(轮次) && Number.isFinite(初始) && 轮次 <= 初始) return
        if (已自动朗读.has(messageId)) return
        const 页面可见 = typeof document === 'undefined' || document.visibilityState === 'visible'
        if (!是否自动朗读(偏好态.config, 会话键, 页面可见)) return
        已自动朗读.add(messageId)
        void 播放.合成并播放(messageId, 文本, 偏好.get().config || {})
      }, [文本, 位置, 偏好态.载入, 自动朗读, 后台朗读, 全局自动朗读开, messageId, 会话键])

      const 标题 = 合成中 ? '正在准备朗读，再点一次可取消'
        : 播放中 ? '停止朗读'
          : 偏好态.在线 === false ? '朗读这条回复（本地 AI 未启动）'
            : '朗读这条回复'

      const 错误 = 播放态.messageId === messageId && 播放态.phase === 'error' ? 播放态.error : ''
      const 提示 = 播放态.messageId === messageId && 播放态.hint && 播放态.phase !== 'error' ? 播放态.hint : ''

      return h(React.Fragment, null,
        h('button', {
          ref: 按钮,
          type: 'button',
          className: 'fish-iconbtn',
          'data-on': 播放中 ? '1' : undefined,
          title: 标题,
          'aria-label': 标题,
          'aria-busy': 合成中 ? 'true' : undefined,
          onClick: 点,
        },
          合成中 ? 图标转圈() : 播放中 ? 图标暂停() : 图标发声(),
          播放中 && 播放态.total > 1 ? h('span', { style: { fontSize: 11 } }, `${播放态.index}/${播放态.total}`) : null),
        错误 ? h('span', { className: 'fish-err', role: 'status', style: { marginLeft: 6 } }, 错误) : null,
        提示 ? h('span', { className: 'fish-panel-dim', role: 'status', style: { marginLeft: 6 } }, 提示) : null)
    }

    // ---------------- 框选文字：朗读 / 翻译 ----------------

    const 选中交互ID = 'fish-selection'
    const 选中播放标识 = 'fish-selection'

    function 选中工具条({ readText, dismiss, clearSelection }) {
      const 偏好态 = useStore(偏好)
      const 在线 = 偏好态.在线 !== false
      const [面板, 设面板] = React.useState(null)
      const 容器 = React.useRef(null)

      const 取文本 = () => {
        const 文本 = typeof readText === 'function' ? readText() : ''
        return String(文本 == null ? '' : 文本).trim()
      }
      const 收起 = () => {
        try { clearSelection?.() } catch { /* 选区已经没了 */ }
        try { dismiss?.() } catch { /* 工具条已经关了 */ }
      }

      // 点外面 / Esc 关闭；点工具条内部不触发，避免选区和复制被打断。
      React.useEffect(() => {
        const 点外面 = (事件) => {
          if (容器.current && 事件.target instanceof Node && 容器.current.contains(事件.target)) return
          try { dismiss?.() } catch { /* 忽略 */ }
        }
        const 按Esc = (事件) => {
          if (事件.key !== 'Escape') return
          try { dismiss?.() } catch { /* 忽略 */ }
        }
        document.addEventListener('pointerdown', 点外面, true)
        document.addEventListener('keydown', 按Esc, true)
        return () => {
          document.removeEventListener('pointerdown', 点外面, true)
          document.removeEventListener('keydown', 按Esc, true)
        }
      }, [dismiss])

      const 朗读 = () => {
        const 文本 = 取文本()
        if (!文本) return
        void 播放.合成并播放(选中播放标识, 文本, 偏好.get().config || {})
        收起()
      }

      const 翻译 = async (原文) => {
        const 文本 = String(原文 || 取文本()).trim()
        if (!文本) return
        设面板({ 原文: 文本, 载入中: true, 错误: '', 译文: '', 已复制: false })
        const 结果 = await post('/translate', { text: 文本 })
        if (!结果 || !结果.ok) {
          设面板({
            原文: 文本,
            载入中: false,
            错误: (结果 && 结果.hint) || '翻译失败，请稍后重试。',
            译文: '',
            已复制: false,
          })
          return
        }
        设面板({ 原文: 文本, 载入中: false, 错误: '', 译文: String(结果.text || ''), 已复制: false })
      }

      const 复制 = async () => {
        if (!面板?.译文) return
        try {
          await navigator.clipboard.writeText(面板.译文)
          设面板((旧) => (旧 ? { ...旧, 已复制: true, 错误: '' } : 旧))
        } catch {
          设面板((旧) => (旧 ? { ...旧, 错误: '复制失败，请手动选中译文复制。' } : 旧))
        }
      }

      return h('div', {
        ref: 容器,
        className: 'fish-selbar',
        role: 'toolbar',
        'aria-label': '选中文字操作',
        // 保住当前选区：点按钮时不把选区换成按钮上的文字。
        onPointerDown: (事件) => 事件.preventDefault(),
      },
        h('button', {
          type: 'button',
          disabled: !在线,
          title: 在线 ? '朗读选中的文字' : '本地 AI 未启动',
          onClick: 朗读,
        }, '朗读'),
        h('button', {
          type: 'button',
          disabled: !在线 || Boolean(面板?.载入中),
          title: 在线 ? '翻译选中的文字' : '本地 AI 未启动',
          onClick: () => void 翻译(),
        }, '翻译'),
        !在线 ? h('span', { className: 'fish-selnote' }, '本地 AI 未启动') : null,
        面板
          ? h('div', { className: 'fish-selpanel' },
              面板.载入中 ? h('div', { className: 'fish-panel-dim', role: 'status' }, '翻译中…') : null,
              面板.错误 ? h('div', { className: 'fish-err', role: 'status' }, 面板.错误) : null,
              面板.译文 ? h('div', { className: 'fish-seltext', role: 'status' }, 面板.译文) : null,
              h('div', { className: 'fish-selrow' },
                !面板.载入中 && 面板.错误
                  ? h('button', { type: 'button', onClick: () => void 翻译(面板.原文) }, '重试')
                  : null,
                面板.译文 ? h('button', { type: 'button', onClick: 复制 }, 面板.已复制 ? '已复制' : '复制') : null,
                h('button', { type: 'button', onClick: () => 设面板(null) }, '关闭')))
          : null)
    }

    // ---------------- 输入设备（纯函数，便于单测） ----------------

    /** 录音约束：空标识 = 跟随系统默认；非空则精确指定该设备。 */
    function 构建录音约束(deviceId) {
      const 设备标识 = typeof deviceId === 'string' ? deviceId.trim() : ''
      const 音频 = { echoCancellation: true, noiseSuppression: true }
      if (设备标识) 音频.deviceId = { exact: 设备标识 }
      return { audio: 音频 }
    }

    /** 设备被拔掉、改名或约束不满足时，浏览器报这几个错误。 */
    function 设备不可用错误(错误) {
      const 名 = String(错误?.name || '')
      return 名 === 'OverconstrainedError' || 名 === 'NotFoundError' || 名 === 'DevicesNotFoundError'
    }

    /**
     * 打开麦克风；指定了设备但设备不可用时自动回退到系统默认。
     * getUserMedia 由调用方注入，便于单测模拟浏览器行为。
     * 返回 { stream, fellBack }。
     */
    async function 打开麦克风(deviceId, getUserMedia) {
      const 已选 = typeof deviceId === 'string' ? deviceId.trim() : ''
      const 申请 = typeof getUserMedia === 'function'
        ? getUserMedia
        : (约束) => navigator.mediaDevices.getUserMedia(约束)
      try {
        return { stream: await 申请(构建录音约束(已选)), fellBack: false }
      } catch (错误) {
        if (!已选 || !设备不可用错误(错误)) throw 错误
        return { stream: await 申请(构建录音约束('')), fellBack: true }
      }
    }

    /** 设备名像虚拟声卡/采集卡时，提醒用户改选真实麦克风。 */
    const 虚拟设备特征 = /stream|virtual|cable|voicemeeter|vb-audio|loopback|stereo\s*mix|立体声混音/i

    function 是虚拟设备名称(名称) {
      return typeof 名称 === 'string' && 虚拟设备特征.test(名称)
    }

    function 虚拟设备提示(名称) {
      return 是虚拟设备名称(名称)
        ? '当前输入设备可能是虚拟设备，请在设置里改选真实麦克风。'
        : ''
    }

    function 补设备提示(文本, 名称) {
      const 提示 = 虚拟设备提示(名称)
      return 提示 ? `${文本} ${提示}` : 文本
    }

    // 输入设备列表与最近一次录音实际使用的设备（只在本次页面会话里，不持久化）。
    const 设备 = 造store({
      列表: [],
      最近名称: '',
      最近标识: '',
      枚举中: false,
      提示: '',
    })

    async function 已有麦克风权限() {
      try {
        if (!navigator.permissions?.query) return false
        const 状态 = await navigator.permissions.query({ name: 'microphone' })
        return 状态.state === 'granted'
      } catch {
        return false
      }
    }

    /** 先申请权限（已有权限就直接枚举），再列出音频输入设备。 */
    async function 刷新设备列表() {
      if (设备.get().枚举中) return
      设备.set((旧) => ({ ...旧, 枚举中: true, 提示: '' }))
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
          设备.set((旧) => ({ ...旧, 枚举中: false, 提示: '当前浏览器不支持选择麦克风。' }))
          return
        }
        if (!(await 已有麦克风权限())) {
          let 流
          try {
            流 = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch {
            设备.set((旧) => ({ ...旧, 列表: [], 枚举中: false, 提示: '未获得麦克风权限，无法列出设备。' }))
            return
          }
          try { 流?.getTracks?.().forEach((轨) => 轨.stop()) } catch { /* 忽略 */ }
        }
        let 全部 = []
        try { 全部 = await navigator.mediaDevices.enumerateDevices() } catch { 全部 = [] }
        const 列表 = []
        for (const 项 of Array.isArray(全部) ? 全部 : []) {
          if (!项 || 项.kind !== 'audioinput') continue
          const 标识 = String(项.deviceId || '')
          if (!标识) continue
          const 名称 = String(项.label || '').trim() || `麦克风 ${列表.length + 1}`
          列表.push({ deviceId: 标识, label: 名称 })
        }
        if (!列表.length) {
          设备.set((旧) => ({ ...旧, 列表: [], 枚举中: false, 提示: '未获得麦克风权限，无法列出设备。' }))
          return
        }
        设备.set((旧) => ({ ...旧, 列表, 枚举中: false, 提示: '' }))
      } catch {
        设备.set((旧) => ({ ...旧, 枚举中: false, 提示: '未获得麦克风权限，无法列出设备。' }))
      }
    }

    // ---------------- 录音器（MediaRecorder 优先，退化到 PCM/WAV） ----------------

    function 停流(流) {
      try { 流?.getTracks?.().forEach((轨) => 轨.stop()) } catch { /* 忽略 */ }
    }

    function 造电平(流) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) throw new Error('no audio context')
        const 上下文 = new Ctx()
        try { void 上下文.resume?.() } catch { /* 有些浏览器不需要/不允许 */ }
        const 源 = 上下文.createMediaStreamSource(流)
        const 分析 = 上下文.createAnalyser()
        分析.fftSize = 256
        源.connect(分析)
        const 缓冲 = new Uint8Array(分析.frequencyBinCount)
        return {
          读取() {
            try {
              分析.getByteTimeDomainData(缓冲)
              let 峰 = 0
              for (const v of 缓冲) {
                const d = Math.abs(v - 128) / 128
                if (d > 峰) 峰 = d
              }
              return Math.min(1, 峰 * 2.2)
            } catch { return 0 }
          },
          关闭() {
            try { 源.disconnect(); 分析.disconnect(); 上下文.close() } catch { /* 忽略 */ }
          },
        }
      } catch {
        return { 读取: () => 0, 关闭() {} }
      }
    }

    function 用MediaRecorder(流, mime) {
      const 录制 = new MediaRecorder(流, { mimeType: mime })
      const 块 = []
      录制.ondataavailable = (事件) => { if (事件.data && 事件.data.size) 块.push(事件.data) }
      const 电平 = 造电平(流)
      录制.start(250)
      let 停止 = false
      return {
        mime,
        读取电平: () => 电平.读取(),
        async stop() {
          if (!停止) {
            停止 = true
            await new Promise((resolve) => {
              录制.onstop = resolve
              try { 录制.stop() } catch { resolve() }
            })
          }
          电平.关闭()
          停流(流)
          return { blob: new Blob(块, { type: mime }), mime }
        },
        cancel() {
          try { 停止 = true; 录制.stop() } catch { /* 忽略 */ }
          电平.关闭()
          停流(流)
        },
      }
    }

    function 编码WAV(采样, 采样率) {
      const 数据长度 = 采样.length
      const 缓冲 = new ArrayBuffer(44 + 数据长度 * 2)
      const 视 = new DataView(缓冲)
      const 写文 = (偏移, 文) => { for (let i = 0; i < 文.length; i++) 视.setUint8(偏移 + i, 文.charCodeAt(i)) }
      写文(0, 'RIFF')
      视.setUint32(4, 36 + 数据长度 * 2, true)
      写文(8, 'WAVE')
      写文(12, 'fmt ')
      视.setUint32(16, 16, true)
      视.setUint16(20, 1, true)
      视.setUint16(22, 1, true)
      视.setUint32(24, 采样率, true)
      视.setUint32(28, 采样率 * 2, true)
      视.setUint16(32, 2, true)
      视.setUint16(34, 16, true)
      写文(36, 'data')
      视.setUint32(40, 数据长度 * 2, true)
      let 偏移 = 44
      for (let i = 0; i < 数据长度; i++) {
        const s = Math.max(-1, Math.min(1, 采样[i]))
        视.setInt16(偏移, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        偏移 += 2
      }
      return new Uint8Array(缓冲)
    }

    function 用WAV(流) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return Promise.reject(new Error('浏览器不支持 WebAudio 录音'))
      const 上下文 = new Ctx()
      try { void 上下文.resume?.() } catch { /* 忽略 */ }
      const 源 = 上下文.createMediaStreamSource(流)
      const 节点 = 上下文.createScriptProcessor(4096, 1, 1)
      const 块 = []
      let 峰 = 0
      节点.onaudioprocess = (事件) => {
        const 数据 = 事件.inputBuffer.getChannelData(0)
        块.push(new Float32Array(数据))
        let 本帧 = 0
        for (let i = 0; i < 数据.length; i++) {
          const d = Math.abs(数据[i])
          if (d > 本帧) 本帧 = d
        }
        峰 = Math.max(峰, 本帧)
      }
      源.connect(节点)
      节点.connect(上下文.destination)
      const 采样率 = 上下文.sampleRate
      let 停止 = false
      const 收尾 = () => {
        try { 节点.disconnect(); 源.disconnect(); 上下文.close() } catch { /* 忽略 */ }
        停流(流)
      }
      return Promise.resolve({
        mime: 'audio/wav',
        读取电平: () => { const v = 峰; 峰 = 0; return Math.min(1, v * 2.2) },
        async stop() {
          if (!停止) { 停止 = true; 收尾() }
          const 总长 = 块.reduce((和, x) => 和 + x.length, 0)
          const 合并 = new Float32Array(总长)
          let 偏移 = 0
          for (const x of 块) { 合并.set(x, 偏移); 偏移 += x.length }
          return { blob: new Blob([编码WAV(合并, 采样率)], { type: 'audio/wav' }), mime: 'audio/wav' }
        },
        cancel() {
          if (!停止) { 停止 = true; 收尾() }
        },
      })
    }

    async function 创建录音器(流, 格式) {
      const 偏好mime = 格式 === 'webm' ? 'audio/webm;codecs=opus' : null
      const 候选 = 偏好mime ? [偏好mime] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      if (格式 !== 'wav' && typeof window.MediaRecorder === 'function') {
        const mime = 候选.find((x) => {
          try { return window.MediaRecorder.isTypeSupported(x) } catch { return false }
        })
        if (mime) return 用MediaRecorder(流, mime)
      }
      return 用WAV(流)
    }

    // ---------------- 语音输入状态机 ----------------

    const 语音 = {
      态: 造store({
        phase: 'idle', // idle | requesting | recording | choose | uploading | transcribing | done | error
        sessionId: '',
        startedAt: 0,
        seconds: 0,
        level: 0,
        peak: 0,
        micLabel: '',
        durationMs: 0,
        bytes: 0,
        mime: '',
        choice: '',
        hint: '',
        error: '',
        text: '',
        pendingText: '',
        path: '',
        elapsedMs: 0,
      }),
      录音器: null,
      计时器: null,
      关闭定时: null,
      片段: null,
      插入位: null,
      // 录音有异步步骤（要等用户点「允许麦克风」）；取消/关闭时递增它，
      // 晚到的 getUserMedia 结果发现代号变了就自己收掉，不会在关掉面板后又开始录。
      代: 0,
    }

    const 选择键 = 'dsh-fish-service.voice-choice'

    function 记住的选择() {
      try {
        const v = window.localStorage.getItem(选择键)
        return ['text', 'audio', 'cancel'].includes(v) ? v : ''
      } catch { return '' }
    }

    function 记住选择(选择) {
      if (偏好.get().config.rememberVoiceChoice === false) return
      try { window.localStorage.setItem(选择键, 选择) } catch { /* 无痕模式 */ }
    }

    function 麦克风错误(错误) {
      const 名 = String(错误?.name || '')
      if (名 === 'NotAllowedError' || 名 === 'SecurityError') return '未获得麦克风权限，请允许浏览器使用麦克风后重试。'
      if (名 === 'NotFoundError' || 名 === 'DevicesNotFoundError') return '未找到麦克风，请连接麦克风后重试。'
      if (名 === 'NotReadableError') return '麦克风正被其他程序占用，请关闭会议或录音软件后重试。'
      if (名 === 'OverconstrainedError') return '麦克风不支持当前的录音设置，请改用系统默认设备后重试。'
      return '无法打开麦克风，请检查设备后重试。'
    }

    function 清理录音() {
      if (语音.计时器) { clearInterval(语音.计时器); 语音.计时器 = null }
      if (语音.录音器) {
        try { 语音.录音器.cancel?.() } catch { /* 忽略 */ }
        语音.录音器 = null
      }
    }

    function 安排关闭(毫秒 = 6000) {
      if (语音.关闭定时) clearTimeout(语音.关闭定时)
      语音.关闭定时 = setTimeout(() => {
        语音.关闭定时 = null
        关闭语音面板()
      }, 毫秒)
    }

    // 录音上限：计时器到 300 秒就自动停，stop() 收尾还会多出几十毫秒。
    // 略超上限是正常的，按上限截断；只有明显超出（用户拿着录音没停）才判超限。
    const 录音上限毫秒 = 5 * 60 * 1000
    const 录音上限容差毫秒 = 3000
    function 规整录音时长(时长, 上限 = 录音上限毫秒, 容差 = 录音上限容差毫秒) {
      const 值 = Math.max(0, Number(时长) || 0)
      if (值 > 上限 + 容差) return { ok: false, durationMs: 值, capped: false }
      return { ok: true, durationMs: Math.min(值, 上限), capped: 值 >= 上限 }
    }

    async function 开始录音(props) {
      // 语音识别总开关关掉时录音功能不可用（按钮已隐藏，这里再兜一次）。
      if (!界面开关开(偏好.get().config, '语音识别')) return
      const 当前 = 语音.态.get().phase
      if (当前 !== 'idle' && 当前 !== 'error') return
      if (语音.关闭定时) { clearTimeout(语音.关闭定时); 语音.关闭定时 = null }
      清理录音()
      const 代 = ++语音.代
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '当前浏览器不支持录音，请换用其他浏览器后重试。' }))
        安排关闭()
        return
      }
      const 配置 = 偏好.get().config || {}
      const 插入位 = (() => {
        try { return props?.inputActions?.captureInsertion?.() ?? null } catch { return null }
      })()
      语音.插入位 = 插入位
      语音.态.set({
        ...语音.态.get(),
        phase: 'requesting',
        sessionId: String(props?.sessionId || ''),
        startedAt: Date.now(),
        seconds: 0,
        level: 0,
        durationMs: 0,
        bytes: 0,
        mime: '',
        choice: '',
        hint: '',
        error: '',
        text: '',
        pendingText: '',
        path: '',
        elapsedMs: 0,
      })
      语音.片段 = null
      let 流
      let 回退默认 = false
      try {
        const 打开 = await 打开麦克风(配置.recordDeviceId || '')
        流 = 打开.stream
        回退默认 = 打开.fellBack === true
      } catch (错误) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: 麦克风错误(错误) }))
        安排关闭(8000)
        return
      }
      if (代 !== 语音.代) {
        停流(流)
        return
      }
      let 麦克风名 = ''
      let 麦克风标识 = ''
      try {
        const 轨 = 流.getAudioTracks?.()[0]
        麦克风名 = String(轨?.label || '')
        麦克风标识 = String(轨?.getSettings?.()?.deviceId || '')
      } catch { 麦克风名 = ''; 麦克风标识 = '' }
      语音.态.set((旧位) => ({
        ...旧位,
        micLabel: 麦克风名,
        hint: 回退默认 ? '所选麦克风不可用，已改用系统默认设备。' : '',
      }))
      设备.set((旧位) => ({
        ...旧位,
        最近名称: 麦克风名 || 旧位.最近名称,
        最近标识: 麦克风标识 || 旧位.最近标识,
      }))
      try {
        const 录音器 = await 创建录音器(流, 配置.recordMime || 'auto')
        if (代 !== 语音.代) {
          录音器.cancel?.()
          停流(流)
          return
        }
        语音.录音器 = 录音器
        const 开始 = Date.now()
        语音.态.set((旧) => ({ ...旧, phase: 'recording', startedAt: 开始, mime: 录音器.mime }))
        语音.计时器 = setInterval(() => {
          const 秒 = Math.floor((Date.now() - 开始) / 1000)
          const 电平值 = 录音器.读取电平()
        语音.态.set((旧) => (旧.phase === 'recording'
          ? { ...旧, seconds: 秒, level: 电平值, peak: Math.max(旧.peak || 0, 电平值) }
          : 旧))
          if (秒 >= 300) void 停止录音()
        }, 200)
      } catch {
        清理录音()
        停流(流)
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音启动失败，请检查麦克风后重试。' }))
        安排关闭(8000)
      }
    }

    async function 停止录音() {
      const 态 = 语音.态.get()
      if (态.phase !== 'recording' || !语音.录音器) return
      const 代 = 语音.代
      if (语音.计时器) { clearInterval(语音.计时器); 语音.计时器 = null }
      const 录音器 = 语音.录音器
      语音.录音器 = null
      let 结果
      try {
        结果 = await 录音器.stop()
      } catch {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '结束录音失败，请重试。' }))
        安排关闭(8000)
        return
      }
      // 等待 MediaRecorder 收尾期间用户可能已经取消/关了面板。
      if (代 !== 语音.代) return
      const 规整 = 规整录音时长(Date.now() - Number(态.startedAt || Date.now()))
      if (!规整.ok) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音超过 5 分钟已停止，请分段录制。' }))
        安排关闭(8000)
        return
      }
      const 时长 = 规整.durationMs
      const 大小 = 结果.blob.size
      if (大小 > 25 * 1024 * 1024) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音超过 25MB 已停止，请缩短录音时长。' }))
        安排关闭(8000)
        return
      }
      if (大小 < 600) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '没有录到声音（录音过短），请点「重新录」重试。' }))
        安排关闭(8000)
        return
      }
      if (!结果.blob || 结果.blob.size < 1500) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '没有采集到声音，请检查麦克风是否可用后重试。' }))
        return
      }
      if (时长 < 300) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音太短，请多说几秒再停止。' }))
        return
      }
      // 峰值一直贴着 0：麦克风多半被静音 / 选成了虚拟设备 / 系统输入源不对。
      if ((态.peak || 0) < 0.008) {
        语音.态.set((旧) => ({
          ...旧,
          phase: 'error',
          error: 补设备提示(`没有检测到声音${态.micLabel ? `（当前麦克风：${态.micLabel}）` : ''}。请检查系统声音设置里的输入设备是否被静音，或改为默认麦克风后重试。`, 态.micLabel),
        }))
        安排关闭(10000)
        return
      }
      语音.片段 = { blob: 结果.blob, mime: 结果.mime, durationMs: 时长 }
      语音.态.set((旧) => ({
        ...旧,
        phase: 'choose',
        durationMs: 时长,
        bytes: 大小,
        mime: 结果.mime,
        choice: 偏好.get().config.rememberVoiceChoice === false ? '' : 记住的选择(),
        error: '',
        hint: '',
      }))
    }

    function 取消录音() {
      语音.代 += 1
      清理录音()
      语音.片段 = null
      语音.插入位 = null
      if (语音.关闭定时) { clearTimeout(语音.关闭定时); 语音.关闭定时 = null }
      语音.态.set({ ...语音.态.get(), phase: 'idle', seconds: 0, level: 0, hint: '', error: '', text: '', pendingText: '', path: '' })
    }

    function 关闭语音面板() {
      语音.代 += 1
      清理录音()
      语音.片段 = null
      语音.插入位 = null
      if (语音.关闭定时) { clearTimeout(语音.关闭定时); 语音.关闭定时 = null }
      语音.态.set({ ...语音.态.get(), phase: 'idle', seconds: 0, level: 0, hint: '', error: '', text: '', pendingText: '', path: '' })
    }

    /** 往输入框插文字：先按录音开始时的光标，再按当前光标；都不行就复制到剪贴板。 */
    function 插入文本(inputActions, 文本) {
      const 值 = String(文本 == null ? '' : 文本)
      if (!值) return false
      const 试 = (位) => {
        try { return inputActions?.insertText?.(值, 位) === true } catch { return false }
      }
      if (试(语音.插入位)) return true
      let 当前 = null
      try { 当前 = inputActions?.captureInsertion?.() ?? null } catch { 当前 = null }
      if (试(当前)) return true
      try { navigator.clipboard?.writeText?.(值) } catch { /* 剪贴板也可能被拒 */ }
      return false
    }

    /** 语音文件附件名：语音-YYYYMMDD-HHMMSS.webm（给人看的、可读的）。 */
    function 语音附件名(时间, mime) {
      const 两 = (数) => String(数).padStart(2, '0')
      const 时刻 = new Date(时间 || Date.now())
      const 日期 = `${时刻.getFullYear()}${两(时刻.getMonth() + 1)}${两(时刻.getDate())}`
      const 时钟 = `${两(时刻.getHours())}${两(时刻.getMinutes())}${两(时刻.getSeconds())}`
      return `语音-${日期}-${时钟}${语音扩展(mime)}`
    }

    // 浏览器侧的内核会话服务；apply 时拿到上下文后才能解析。
    let 插件上下文 = null

    /** 取会话作用域里的 conversation 服务（内核的草稿附件都挂在这里）。 */
    function 取会话对话(sessionId, 上下文 = 插件上下文) {
      try {
        const 会话 = 上下文?.get?.('sessions')
        if (会话 && typeof 会话.scope === 'function' && sessionId) {
          const 作用域 = 会话.scope(String(sessionId))
          const 对话 = 作用域?.get?.('conversation')
          if (对话) return 对话
        }
      } catch { /* 不同版本的内核可能没有 sessions */ }
      try { return 上下文?.get?.('conversation') ?? null } catch { return null }
    }

    /**
     * 把录音作为「文件」挂到输入框草稿里（内核 ComposerAttachments 支持 file 卡片）。
     * 成功返回 true；任何一步不成立都返回 false，调用方退回「插入路径文字」。
     */
    function 挂语音附件(inputActions, sessionId, blob, mime, 文件名, 上下文 = 插件上下文) {
      try {
        if (!blob || typeof File !== 'function') return false
        if (!inputActions || typeof inputActions.addAttachments !== 'function') return false
        const 对话 = 取会话对话(sessionId, 上下文)
        if (!对话 || typeof 对话.createDrafts !== 'function') return false
        const 文件 = new File([blob], 文件名 || 语音附件名(Date.now(), mime), { type: mime || 'audio/webm' })
        const 草稿们 = 对话.createDrafts(String(sessionId), [文件], true)
        const 标识们 = Array.isArray(草稿们) ? 草稿们.map((项) => 项 && 项.id).filter(Boolean) : []
        if (标识们.length === 0) return false
        return inputActions.addAttachments(标识们) === true
      } catch (错误) {
        try { console.warn('[dsh-fish-service] 语音附件失败', 错误) } catch { /* 忽略 */ }
        return false
      }
    }

    function 语音扩展(mime) {
      const 类型 = String(mime || '').toLowerCase()
      if (类型.includes('wav')) return '.wav'
      if (类型.includes('ogg') || 类型.includes('opus')) return '.ogg'
      if (类型.includes('mp4') || 类型.includes('m4a')) return '.m4a'
      return '.webm'
    }

    async function 转文字(inputActions) {
      const 态 = 语音.态.get()
      if (!语音.片段 || 态.phase === 'transcribing' || 态.phase === 'uploading') return
      const 代 = 语音.代
      const 配置 = 偏好.get().config || {}
      语音.态.set((旧) => ({ ...旧, phase: 'transcribing', error: '', hint: '' }))
      const 表单 = new FormData()
      表单.append('file', 语音.片段.blob, `voice${语音扩展(语音.片段.mime)}`)
      表单.append('durationMs', String(语音.片段.durationMs || 0))
      表单.append('language', 配置.asrLanguage || 'auto')
      const r = await postForm('/transcribe-upload', 表单)
      if (代 !== 语音.代) return
      if (!r || !r.ok) {
        语音.态.set((旧) => ({
          ...旧,
          phase: 'choose',
          error: 补设备提示((r && r.hint) || '转写失败，请稍后重试。', 旧.micLabel),
        }))
        return
      }
      const 文本 = String(r.text || '').trim()
      if (!文本) {
        语音.态.set((旧) => ({
          ...旧,
          phase: 'choose',
          error: 补设备提示('没有识别出文字，可以重新录制。', 旧.micLabel),
        }))
        return
      }
      const 插入成功 = 插入文本(inputActions, 文本)
      记住选择('text')
      // 文字已经在输入框里了，面板不必再弹出来。
      if (插入成功) {
        关闭语音面板()
        return
      }
      语音.片段 = null
      语音.插入位 = null
      语音.态.set((旧) => ({
        ...旧,
        phase: 'done',
        text: 文本,
        pendingText: 文本,
        elapsedMs: Number(r.ms) || 0,
        choice: 'text',
        error: '',
        hint: `已转写 ${文本.length} 字，但没能插进输入框；文字已复制到剪贴板，也可点「重试插入」。`,
      }))
      安排关闭(12000)
    }

    async function 保留语音(inputActions, sessionId) {
      if (!语音.片段) return
      const 代 = 语音.代
      const 目标会话 = String(sessionId || 语音.态.get().sessionId || '')
      语音.态.set((旧) => ({ ...旧, phase: 'uploading', error: '', hint: '' }))
      const 表单 = new FormData()
      表单.append('file', 语音.片段.blob, `voice${语音扩展(语音.片段.mime)}`)
      表单.append('durationMs', String(语音.片段.durationMs || 0))
      const r = await postForm('/voice-upload', 表单)
      if (代 !== 语音.代) return
      if (!r || !r.ok) {
        语音.态.set((旧) => ({ ...旧, phase: 'choose', error: (r && r.hint) || '音频保存失败，请稍后重试。' }))
        return
      }
      const 路径 = String(r.path || '')
      const 文件名 = 语音附件名(Date.now(), 语音.片段.mime)
      const 附件成功 = 挂语音附件(inputActions, 目标会话, 语音.片段.blob, 语音.片段.mime, 文件名)
      const 插入成功 = 附件成功 ? false : 插入文本(inputActions, `（语音附件：${路径}）\n`)
      记住选择('audio')
      // 附件卡片已经出现在输入框里，面板不必再弹。
      if (附件成功) {
        关闭语音面板()
        return
      }
      语音.插入位 = null
      语音.态.set((旧) => ({
        ...旧,
        phase: 'done',
        path: 路径,
        text: '',
        pendingText: '',
        choice: 'audio',
        error: '',
        hint: 插入成功
          ? `录音已保存在本机：${路径}\n没能加到输入框附件，已把保存位置插入输入框（可删除）。`
          : `录音已保存在本机：${路径}\n保存位置未能插入输入框，已复制到剪贴板。`,
      }))
      安排关闭(12000)
    }

    // ---------------- 语音输入：麦克风按钮 ----------------

    function 麦克风按钮(props) {
      const { sessionId, inputActions } = props || {}
      const 态 = useStore(语音.态)
      const 偏好态 = useStore(偏好)
      const 语音开 = 界面开关开(偏好态.config, '语音识别')

      React.useEffect(() => {
        保活(true)
        if (!偏好.get().载入) void 载入偏好()
        return () => 保活(false)
      }, [])

      // 本地识图的最后一步：按钮把「文件名 + 描述」入队，这里负责插进草稿。
      // 拦截组件不依赖 inputActions 是否透传，走模块级队列 + input.right 组件消费；
      // 插入失败沿用 插入文本 的剪贴板兜底，并回填一行提示。
      const 视觉待办 = useStore(视觉通知)
      React.useEffect(() => {
        if (!sessionId || !inputActions) return
        const 结果 = 消费待插入(sessionId, (文本) => 插入文本(inputActions, 文本))
        if (结果.失败 > 0) 写识图提示(sessionId, '识图结果没能插入输入框，已复制到剪贴板。')
      }, [视觉待办, sessionId, inputActions])
      // 通知偶尔丢失（组件刚挂载 / 切换会话）时再兜一次底。
      React.useEffect(() => {
        if (!sessionId || !inputActions) return undefined
        const 定时 = setInterval(() => {
          if (!待插入.length) return
          const 结果 = 消费待插入(sessionId, (文本) => 插入文本(inputActions, 文本))
          if (结果.失败 > 0) 写识图提示(sessionId, '识图结果没能插入输入框，已复制到剪贴板。')
        }, 1500)
        return () => clearInterval(定时)
      }, [sessionId, inputActions])

      // 总开关关掉时立刻停掉正在进行的录音并收起面板；框选朗读/翻译不受影响。
      React.useEffect(() => {
        if (语音开) return
        const 现 = 语音.态.get()
        if (现.phase === 'recording') void 停止录音()
        else if (现.phase !== 'idle') 取消录音()
        关闭语音面板()
      }, [语音开])

      if (!语音开) return null

      const 本会话 = !态.sessionId || !sessionId || 态.sessionId === sessionId
      const 录音中 = 本会话 && 态.phase === 'recording'
      const 请求中 = 本会话 && 态.phase === 'requesting'
      const 离线 = 偏好态.在线 === false

      const 点 = () => {
        if (录音中) { void 停止录音(); return }
        if (态.phase === 'recording') return
        if (态.phase === 'idle' || 态.phase === 'error') { void 开始录音({ sessionId, inputActions }); return }
        // 面板开着时再点麦克风 = 关掉面板（录音中除外，上面已处理）。
        if (!录音中) 关闭语音面板()
      }

      const 标题 = 录音中 ? `正在录音 ${格式时间(态.seconds)}，点击结束`
        : 请求中 ? '正在请求麦克风…'
          : 离线 ? '语音输入（本地 AI 未启动）'
            : '语音输入：点击开始录音'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          'data-rec': 录音中 ? '1' : undefined,
          title: 标题,
          'aria-label': 标题,
          'aria-pressed': 录音中 ? 'true' : 'false',
          // 别让点击按钮夺走编辑器焦点：captureInsertion() 要拿的是当前草稿选区。
          onMouseDown: (事件) => { try { 事件.preventDefault() } catch { /* 忽略 */ } },
          onClick: 点,
        },
          录音中 ? h('span', { className: 'fish-dot' }) : 请求中 ? 图标转圈() : 图标麦克风(),
          录音中 ? h('span', { style: { fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, 格式时间(态.seconds)) : null))
    }

    // ---------------- 本地识图：输入框旁的独立按钮 ----------------
    // 点按钮选图片，在本机识别成文字后按顺序插入输入框；
    // 图片不进草稿、不上传、不进模型。官方附件栏保持原样，不注册、不顶替。

    function 识图扩展(mime) {
      const 类型 = String(mime || '').toLowerCase()
      if (类型.includes('png')) return '.png'
      if (类型.includes('webp')) return '.webp'
      if (类型.includes('gif')) return '.gif'
      if (类型.includes('bmp')) return '.bmp'
      return '.jpg'
    }

    const 图片扩展们 = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']

    /** 浏览器 File 是不是图片：先看 MIME，再看扩展名（有些来源的 type 是空的）。 */
    function 是图片文件(文件) {
      if (!文件) return false
      const 类型 = String(文件.type || '').toLowerCase()
      if (类型.startsWith('image/')) return true
      const 名 = String(文件.name || '').toLowerCase()
      return 图片扩展们.some((扩展) => 名.endsWith(扩展))
    }

    /** 偏好里的「本地识图」是否开着（默认开）。 */
    function 本地识图开(配置) {
      return !(配置 && 配置.localDescribe === false)
    }

    // 界面注入开关：设置页「界面」分区的四个勾选；配置里明确关闭才关，旧配置缺字段按开。
    const 界面开关键 = {
      语音识别: 'uiVoiceInput',
      本地识图: 'uiVision',
      性能监控: 'uiMetrics',
      自动朗读: 'uiAutoRead',
    }

    /** 某个界面注入功能是否开着（名称可写中文名或配置键；默认开）。 */
    function 界面开关开(配置, 名称) {
      const 键 = 界面开关键[名称] || 名称
      const 值 = 配置 && typeof 配置 === 'object' ? 配置[键] : undefined
      if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
      return true
    }

    // 识图档位：与服务端 lib/vision-presets.js 对齐；客户端只用它做下拉和参数兜底。
    const 识图档位们 = [
      { id: 'brief', 名: '简短' },
      { id: 'standard', 名: '标准' },
      { id: 'detailed', 名: '详细' },
      { id: 'text', 名: '只看文字' },
    ]
    const 识图档位选项 = 识图档位们.map((档) => ({ value: 档.id, label: 档.名 }))

    /** 把档位 id 或中文名收成 id；认不出来返回空串，由调用方回落默认档。 */
    function 规范识图档位(值) {
      const 文 = String(值 == null ? '' : 值).trim().toLowerCase()
      if (!文) return ''
      const 按id = 识图档位们.find((档) => 档.id === 文)
      if (按id) return 按id.id
      const 按名 = 识图档位们.find((档) => 档.名 === 文)
      return 按名 ? 按名.id : ''
    }

    /** 点了识图按钮却不能识别时给一句短提示；能识别返回空串。 */
    function 识图阻塞原因(状态) {
      if (!本地识图开(状态 && 状态.config ? 状态.config : {})) return '本地识图已关闭，可在本地 AI 设置里打开。'
      if (状态 && 状态.载入 === true && 状态.在线 === false) return '本地 AI 未连接，请先启动。'
      return ''
    }

    /** 拼一段插进输入框的文字：文件名 + 描述；描述为空返回空串。 */
    function 拼图片描述(文件名, 描述) {
      const 名 = String(文件名 || '').trim() || '图片'
      const 文 = String(描述 == null ? '' : 描述).trim()
      return 文 ? `［图片：${名}］\n${文}\n` : ''
    }

    // 待插入队列：识图按钮识别后先入队（{sessionId, text, at}），由输入框右侧组件消费插入。
    const 待插入 = []
    const 待插入上限 = 8
    // 入队后通知 input.right 组件来消费（订阅计数）。
    const 视觉通知 = 造store(0)
    // 输入框右侧组件回填的提示（例如插入失败）。
    const 识图提示 = 造store({ 会话: '', 文案: '' })
    let 识图提示代 = 0
    function 写识图提示(会话, 文案, 毫秒 = 8000) {
      const 代 = (识图提示代 += 1)
      识图提示.set({ 会话: String(会话 || ''), 文案: String(文案 || '') })
      if (!文案) return
      setTimeout(() => {
        if (代 === 识图提示代) 识图提示.set({ 会话: '', 文案: '' })
      }, Math.max(1200, 毫秒))
    }

    function 入队待插入(项) {
      const 文本 = String((项 && 项.text) || '')
      if (!文本) return false
      if (待插入.length >= 待插入上限) 待插入.shift()
      待插入.push({ sessionId: String((项 && 项.sessionId) || ''), text: 文本, at: Date.now() })
      return true
    }

    /** 取走属于本会话（或没标会话）的待插入文字；取出即删除。 */
    function 取待插入(sessionId) {
      const 出 = []
      for (let 序 = 待插入.length - 1; 序 >= 0; 序 -= 1) {
        const 项 = 待插入[序]
        if (项.sessionId && sessionId && 项.sessionId !== sessionId) continue
        出.unshift(项.text)
        待插入.splice(序, 1)
      }
      return 出
    }

    /** 消费队列：逐条交给插入函数；失败的文字已在插入函数里走剪贴板兜底。 */
    function 消费待插入(sessionId, 插入) {
      let 成功 = 0
      let 失败 = 0
      for (const 文本 of 取待插入(sessionId)) {
        let 好 = false
        try { 好 = 插入(文本) === true } catch { 好 = false }
        if (好) 成功 += 1
        else 失败 += 1
      }
      return { 成功, 失败 }
    }

    /** 认一张图：把字节交给 /describe-upload；会话识图用单独的提示词，不传档位。 */
    async function 本地识别一张(图) {
      const 表单 = new FormData()
      表单.append('file', new Blob([图.字节], { type: 图.类型 || 'application/octet-stream' }), 图.名 || `image${识图扩展(图.类型)}`)
      表单.append('mode', 'caption')
      表单.append('scope', 'session')
      const 结果 = await postForm('/describe-upload', 表单)
      const 文字 = String((结果 && 结果.text) || '').trim()
      if (!结果 || !结果.ok || !文字) {
        return { ok: false, hint: String((结果 && 结果.hint) || '识图失败') }
      }
      return { ok: true, 文字 }
    }

    // ---------------- 本地识图：输入框旁的独立按钮 ----------------
    // 点按钮选图片；图片只在本机识别，不进草稿、不上传、不进模型。
    // 每张图的「文件名 + 描述」按顺序进待插入队列，由输入框右侧组件（麦克风）统一消费插入。

    function 本地识图按钮(props) {
      const { sessionId } = props || {}
      const 偏好态 = useStore(偏好)
      const 识图开 = 界面开关开(偏好态.config, '本地识图')
      const 提示态 = useStore(识图提示)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')
      const 文件框 = React.useRef(null)
      const 计时 = React.useRef(null)

      React.useEffect(() => {
        载入偏好()
        return () => { if (计时.current) clearTimeout(计时.current) }
      }, [])

      if (!识图开) return null

      const 告诉 = (文案) => {
        设说(文案)
        if (计时.current) clearTimeout(计时.current)
        if (文案) 计时.current = setTimeout(() => 设说(''), 6000)
      }

      const 选文件 = () => {
        try { 文件框.current && 文件框.current.click() } catch { /* 忽略 */ }
      }

      const 处理 = async (文件们) => {
        if (忙) return
        const 原因 = 识图阻塞原因(偏好态)
        if (原因) { 告诉(原因); return }
        if (!sessionId) { 告诉('当前会话还不能插入文字。'); return }
        const 图们 = Array.from(文件们 || []).filter(是图片文件)
        if (!图们.length) { 告诉('只支持图片文件。'); return }
        设忙(true)
        let 成功 = 0
        let 失败 = 0
        try {
          for (let 序 = 0; 序 < 图们.length; 序 += 1) {
            告诉(`正在本地识别…（${序 + 1} / ${图们.length}）`)
            try {
              const 文件 = 图们[序]
              const 图 = {
                字节: await 文件.arrayBuffer(),
                类型: String(文件.type || ''),
                名: String(文件.name || '') || `image${识图扩展(文件.type)}`,
              }
              const 结果 = await 本地识别一张(图)
              if (!结果.ok) throw new Error(结果.hint || '识图失败')
              if (!入队待插入({ sessionId, text: 拼图片描述(图.名, 结果.文字) })) throw new Error('入队失败')
              视觉通知.set((值) => 值 + 1)
              成功 += 1
            } catch {
              失败 += 1
            }
          }
        } finally {
          设忙(false)
          告诉(失败
            ? (成功 ? `识图完成：${成功} 张成功，${失败} 张失败。` : '识图失败，请稍后再试。')
            : `已识别 ${成功} 张。`)
        }
      }

      const 提示文 = 提示态.文案 && (!提示态.会话 || !sessionId || 提示态.会话 === sessionId) ? 提示态.文案 : ''
      const 文案 = 说 || 提示文
      const 标题 = 忙 ? '正在本地识图…' : '本地识图：选择图片'

      return h(React.Fragment, null,
        h('input', {
          ref: 文件框,
          type: 'file',
          accept: 'image/*',
          multiple: true,
          tabIndex: -1,
          style: { display: 'none' },
          onChange: (事件) => {
            const 文件们 = 事件.target.files ? Array.from(事件.target.files) : []
            事件.target.value = ''
            if (文件们.length) void 处理(文件们)
          },
        }),
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          disabled: 忙,
          title: 标题,
          'aria-label': '本地识图',
          // 别抢走输入框的焦点，否则插入位置会跳。
          onMouseDown: (事件) => { try { 事件.preventDefault() } catch { /* 忽略 */ } },
          onClick: 选文件,
        }, 忙 ? 图标转圈() : 图标图片()),
        文案 ? h('div', { className: 'fish-vision-toast', role: 'status' }, 文案) : null)
    }

    function 格式时间(秒数) {
      const 总 = Math.max(0, Math.trunc(Number(秒数) || 0))
      const 分 = Math.floor(总 / 60)
      const 秒 = 总 % 60
      return `${分}:${String(秒).padStart(2, '0')}`
    }

    // ---------------- 语音输入：三选一面板（composer overlay） ----------------

    function 波形({ 电平, 录音中 }) {
      const 条 = []
      for (let i = 0; i < 18; i++) {
        const 起伏 = 0.35 + ((i * 37) % 10) / 14
        const 高 = 3 + Math.min(1, (录音中 ? 电平 : 0) * 起伏) * 19
        条.push(h('i', { key: i, style: { height: `${Math.max(3, 高)}px` } }))
      }
      return h('span', { className: 'fish-wave', 'aria-hidden': true }, 条)
    }

    function 语音面板(props) {
      const { sessionId, inputActions } = props || {}
      const 态 = useStore(语音.态)
      const 偏好态 = useStore(偏好)
      const 语音开 = 界面开关开(偏好态.config, '语音识别')

      React.useEffect(() => {
        保活(true)
        return () => {
          保活(false)
          // 切换会话/卸载输入框时别把录音丢在后台跑（最多能录 5 分钟）。
          const 现 = 语音.态.get()
          if (现.phase === 'recording' && (!sessionId || 现.sessionId === sessionId)) 取消录音()
        }
      }, [sessionId])

      // 总开关关掉时面板不再出现，正在录的音也一并停掉。
      React.useEffect(() => {
        if (语音开) return
        const 现 = 语音.态.get()
        if (现.phase === 'recording') void 停止录音()
        关闭语音面板()
      }, [语音开])

      if (!语音开) return null

      // 录音中没有 sessionId 也要显示（会话说变就变），面板只服务当前会话。
      if (态.phase === 'idle') return null
      if (态.sessionId && sessionId && 态.sessionId !== sessionId) return null

      const 记住 = 偏好.get().config.rememberVoiceChoice !== false ? 记住的选择() : ''
      const 高亮 = (选择) => (态.choice || 记住) === 选择
      const 忙碌 = 态.phase === 'uploading' || 态.phase === 'transcribing'
      const 可取消 = 态.phase !== 'recording' && !忙碌

      const 标题 = 态.phase === 'requesting' ? '正在请求麦克风…'
        : 态.phase === 'recording' ? '正在录音'
          : 态.phase === 'choose' ? `录音已完成（${格式时间(Math.round((态.durationMs || 0) / 1000))}）`
            : 态.phase === 'transcribing' ? '正在转写…'
              : 态.phase === 'uploading' ? '正在保存录音…'
                : 态.phase === 'done' ? '完成'
                  : '语音输入'

      const 行 = []

      if (态.phase === 'requesting') {
        行.push(h('div', { key: 'req', className: 'fish-panel-dim' }, '浏览器会询问是否允许使用麦克风，允许后开始录音。'))
      }

      if (态.phase === 'recording') {
        行.push(h('div', { key: 'rec', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { className: 'fish-dot' }),
          h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, 格式时间(态.seconds)),
          h(波形, { 电平: 态.level, 录音中: true }),
          h('span', { className: 'fish-panel-dim' }, '录音中｜最长 5 分钟')))
        行.push(h('div', { key: 'mic', className: 'fish-panel-dim', style: { marginTop: 4 } },
          `音量 ${Math.min(100, Math.round((态.level || 0) * 100))}%`
            + (态.micLabel ? `｜麦克风：${态.micLabel}` : '')
            + ((态.level || 0) < 0.01 && (态.seconds || 0) > 1 ? '（几乎没有声音，请检查麦克风）' : '')))
        if (态.hint) {
          行.push(h('div', { key: 'mic-hint', className: 'fish-panel-dim', style: { marginTop: 4 } }, 态.hint))
        }
        行.push(h('div', { key: 'acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', 'data-primary': '1', onClick: () => void 停止录音() }, '停止并选择'),
          h('button', { type: 'button', className: 'fish-btn', onClick: 取消录音 }, '取消录音')))
      }

      if (态.phase === 'choose') {
        行.push(h('div', { key: 'tip', className: 'fish-panel-dim' }, '请选择这段录音的用法。'))
        行.push(h('div', { key: 'choose', className: 'fish-panel-row' },
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': 高亮('text') ? '1' : undefined,
            onClick: () => void 转文字(inputActions),
          }, '转文字'),
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': 高亮('audio') ? '1' : undefined,
            onClick: () => void 保留语音(inputActions, sessionId),
          }, '作为附件'),
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': 高亮('cancel') ? '1' : undefined,
            onClick: () => { 记住选择('cancel'); 取消录音() },
          }, '取消')))
        行.push(h('div', { key: 'sub', className: 'fish-panel-dim' }, '上次的选择会高亮，但不会自动执行；转成的文字会插入光标处，「作为附件」会把录音作为文件加到输入框。'))
      }

      if (忙碌) {
        行.push(h('div', { key: 'busy', style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'fish-spin', style: { display: 'inline-flex' } }, 图标转圈()),
          h('span', null, 态.phase === 'transcribing' ? '正在转写，首次使用需要加载模型，可能要等一会儿…' : '正在保存录音…')))
        行.push(h('div', { key: 'busy-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: 关闭语音面板 }, '关闭面板（转写继续在后台进行）')))
      }

        if (态.phase === 'done') {
        行.push(h('div', { key: 'hint', className: 'fish-ok', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, 态.hint))
        if (态.pendingText) {
          行.push(h('div', { key: 'pending', className: 'fish-panel-dim', style: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 110, overflow: 'auto' } }, 态.pendingText))
          行.push(h('div', { key: 'pending-acts', className: 'fish-panel-row' },
            h('button', {
              type: 'button', className: 'fish-btn', 'data-primary': '1',
              onClick: () => {
                const 成 = 插入文本(inputActions, 态.pendingText)
                语音.态.set((旧) => ({ ...旧, hint: 成 ? `已插入 ${态.pendingText.length} 字。` : '仍无法插入；文字已复制到剪贴板，请按 Ctrl+V 粘贴。', pendingText: 成 ? '' : 态.pendingText }))
              },
            }, '重试插入'),
            h('button', {
              type: 'button', className: 'fish-btn',
              onClick: () => { try { navigator.clipboard?.writeText?.(态.pendingText) } catch { /* 忽略 */ } },
            }, '复制文字')))
        }
        行.push(h('div', { key: 'done-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: 关闭语音面板 }, '关闭')))
      }

      if (态.phase === 'error') {
        行.push(h('div', { key: 'err', className: 'fish-err', style: { whiteSpace: 'pre-wrap' } }, 态.error || '未能完成'))
        行.push(h('div', { key: 'err-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: 关闭语音面板 }, '关闭'),
          h('button', { type: 'button', className: 'fish-btn', 'data-primary': '1', onClick: () => { 关闭语音面板(); void 开始录音({ sessionId, inputActions }) } }, '重新录')))
      }

      if (态.error && 态.phase !== 'error' && !忙碌) {
        行.push(h('div', { key: 'err2', className: 'fish-err', style: { marginTop: 4 } }, 态.error))
      }

      return h(React.Fragment, null,
        h('div', { className: 'fish-panel', role: 'dialog', 'aria-label': '语音输入' },
          h('div', { className: 'fish-panel-title' },
            h('span', { style: { display: 'inline-flex' } }, 态.phase === 'recording' ? h('span', { className: 'fish-dot' }) : 图标麦克风(15)),
            h('span', null, 标题),
            h('span', { style: { flex: 1 } }),
            可取消 ? h('button', {
              type: 'button', className: 'fish-iconbtn', title: '关闭', 'aria-label': '关闭',
              onClick: 关闭语音面板,
            }, h('span', { style: { fontSize: 15, lineHeight: 1 } }, '×')) : null),
          行,
          h('div', { className: 'fish-panel-dim', style: { marginTop: 8 } },
            偏好态.在线 === false
              ? '本地 AI 未启动，转写暂不可用，请先启动。'
              : '录音只在本机处理，不联网，也不产生额外费用。')))
    }

    // ---------------- 自动朗读开关（输入框左侧） ----------------

    function 自动朗读开关(props) {
      const 偏好态 = useStore(偏好)
      const 自动朗读开 = 界面开关开(偏好态.config, '自动朗读')
      const [忙, 设忙] = React.useState(false)
      const 会话键 = String(props?.sessionId || '')
      const 可设置 = 会话键合法(会话键)

      React.useEffect(() => {
        保活(true)
        if (!偏好.get().载入) void 载入偏好()
        return () => 保活(false)
      }, [])

      if (!自动朗读开) return null

      const 开 = 读会话自动朗读(偏好态.config, 会话键)
      // 偏好还没读回来时不写：否则空表会把其它会话已有的设置覆盖掉。
      const 就绪 = 可设置 && 偏好态.载入
      const 切 = async () => {
        if (忙 || !就绪) return
        设忙(true)
        const 新配置 = 写会话自动朗读(偏好.get().config || {}, 会话键, !开)
        const r = await post('/save', { config: { autoReadSessions: 新配置.autoReadSessions } })
        设忙(false)
        if (r && r.ok) {
          偏好.set((旧) => ({
            ...旧,
            config: r.config
              ? { ...(旧.config || {}), ...r.config }
              : { ...(旧.config || {}), autoReadSessions: 新配置.autoReadSessions },
          }))
        }
      }
      const 标题 = !可设置 ? '当前会话暂不支持单独设置自动朗读'
        : !偏好态.载入 ? '正在读取自动朗读设置…'
          : 开 ? '本会话自动朗读已开启，点击关闭'
            : '本会话自动朗读已关闭，点击开启'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          'data-on': 开 ? '1' : undefined,
          title: 标题,
          'aria-label': 标题,
          'aria-pressed': 开 ? 'true' : 'false',
          disabled: 忙 || !就绪,
          onClick: 切,
        }, 图标发声(14), h('span', { style: { fontSize: 11.5 } }, 开 ? '自动朗读 开' : '自动朗读 关')))
    }

    // ================================================================
    // 设置页（P1 状态 + P2 朗读 / 语音输入）
    // ================================================================

    const S = {
      wrap: {
        padding: '12px 14px 28px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.94))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      // 页面级操作条：吸在设置面板滚动区顶部，滚到运行日志时也能保存或测试。
      bar: {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 14px',
        margin: '-12px -14px 10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: '12px 12px 0 0',
      },
      barRow: { display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' },
      barActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      h1: { fontSize: 17, fontWeight: 700, margin: '0 0 4px' },
      h: { fontSize: 15, fontWeight: 650, margin: '16px 0 8px' },
      h2: { fontSize: 13.5, fontWeight: 650, margin: '0 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      ask: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        marginLeft: 4,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: 10,
        lineHeight: 1,
        opacity: 0.62,
        cursor: 'help',
        userSelect: 'none',
        verticalAlign: 'text-bottom',
      },
      link: {
        border: 0,
        padding: 0,
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        opacity: 0.62,
        cursor: 'pointer',
        textDecoration: 'underline',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 150, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 200 },
      hint: { opacity: 0.58, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 160,
        boxSizing: 'border-box',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 20,
        fontSize: 11.5,
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      danger: { color: '#c0392b', fontSize: 12 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '5px 9px',
        fontSize: 12,
        minWidth: 120,
      },
      logs: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 11.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 300,
        overflow: 'auto',
        background: 'rgba(0,0,0,.06)',
        borderRadius: 6,
        padding: 8,
      },
    }

    const 能力中文 = {
      tts: '文字转语音',
      asr: '语音识别',
      translate: '翻译',
      separate: '人声分离',
      vision: '视觉关键帧',
      media: '媒体探测',
      download: '下载',
      jobs: '任务队列',
    }
    const 翻译语言下拉 = [
      { value: 'zh', label: '中文' },
      { value: 'en', label: '英文' },
      { value: 'ja', label: '日文' },
      { value: 'ko', label: '韩文' },
      { value: 'yue', label: '粤语' },
    ]

    const 原因中文 = {
      service_down: '本地 AI 未启动',
      model_missing: '模型未下载',
      not_supported: '当前版本不支持',
      api_incompatible: '版本不兼容',
    }

    // 设置页给用户看的字段名；环境变量覆盖提示只显示中文名。
    const 配置中文 = {
      baseUrl: '服务地址',
      apiVersion: '服务版本',
      requestTimeoutMs: '请求超时',
      asrTimeoutMs: '语音识别超时',
      visionTimeoutMs: '视觉分析超时',
      localDescribe: '本地识图',
      visionPresets: '工具识图提示词',
      visionDefaultPreset: '工具识图默认档',
      visionSessionPrompt: '会话识图提示词',
      healthIntervalMs: '状态检查间隔',
      ttsVoice: '默认音色',
      ttsSpeed: '语速',
      readMaxChars: '单次最大字数',
      readConcurrency: '同时生成',
      readSkipCode: '去掉代码块',
      autoRead: '新会话默认自动朗读',
      recordMime: '录音格式',
      recordDeviceId: '输入设备',
      asrLanguage: '识别语言',
      rememberVoiceChoice: '记住上次选择',
      cacheDir: '缓存目录',
      cacheMaxMb: '缓存上限',
      cacheTtlHours: '缓存保留时长',
      enabled: '总开关',
      enabledCapabilities: '启用的能力',
      installDir: '安装目录',
      logLevel: '日志级别',
      token: '访问令牌',
      uiAutoRead: '自动朗读',
      uiMetrics: '性能监控',
      uiVision: '本地识图',
      uiVoiceInput: '语音识别',
    }

    // 多行提示词输入框：和单行输入同一套边框，只是允许拉高。
    S.text = {
      ...S.input,
      minHeight: 72,
      resize: 'vertical',
      lineHeight: 1.6,
      fontFamily: 'inherit',
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)

    /** 「?」提示控件：文案短了说不清时，鼠标悬浮（或键盘聚焦）展开完整说明。 */
    const 问号 = (说明) => h('span', {
      style: S.ask,
      role: 'img',
      tabIndex: 0,
      title: 说明,
      'aria-label': 说明,
    }, '?')

    /**
     * 一行设置。说明只保留一种形式，二选一：
     *   字符串        → 控件下方一行短句；
     *   { 问: '…' }   → 标签后的「?」，悬浮展开。
     */
    const 行 = (标签, 控件, 说明) => {
      const 问文 = 说明 && typeof 说明 === 'object' && typeof 说明.问 === 'string' ? 说明.问 : ''
      const 短句 = typeof 说明 === 'string' ? 说明 : ''
      return h('div', { style: S.row },
        h('div', { style: S.lab },
          h('span', null, 标签),
          问文 ? 问号(问文) : null),
        h('div', { style: S.ctl }, 控件, 短句 ? 提示(短句) : null))
    }

    /** 可折叠的一块内容：默认收起，标题旁给一行摘要，避免大段内容铺满设置页。 */
    function 折叠块(props) {
      const { 摘要, 默认展开 = false, 展开字样 = '展开', 收起字样 = '收起', children } = props || {}
      const [开, 设开] = React.useState(默认展开)
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: S.dim }, 摘要 || ''),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: S.link,
            'aria-expanded': 开 ? 'true' : 'false',
            onClick: () => 设开(!开),
          }, 开 ? 收起字样 : 展开字样)),
        h('div', { style: { display: 开 ? 'block' : 'none', marginTop: 8 } }, children))
    }

    function 输入(值, onChange, 占位 = '', 类型 = 'text') {
      return h('input', {
        style: S.input,
        type: 类型,
        value: 值 == null ? '' : String(值),
        placeholder: 占位,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function 多行(值, onChange, 占位 = '') {
      return h('textarea', {
        style: S.text,
        rows: 4,
        value: 值 == null ? '' : String(值),
        placeholder: 占位,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function 下拉(值, 选项, onChange) {
      return h('select', {
        className: 'fish-select',
        style: S.small,
        value: 值 == null ? '' : String(值),
        onChange: (e) => onChange(e.target.value),
      }, 选项.map((项) => h('option', { key: 项.value, value: 项.value }, 项.label)))
    }

    function 勾(值, onChange) {
      return h('input', { type: 'checkbox', checked: Boolean(值), onChange: (e) => onChange(e.target.checked) })
    }

    function 状态点(ok, 文本) {
      return h('span', { style: { ...S.badge, ...(ok ? S.ok : S.danger) } }, 文本)
    }

    function Section() {
      const [态, 设态] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      // 当前正在执行的动作，让吸顶按钮显示「正在保存…」这类状态。
      const [动作, 设动作] = React.useState('')
      const [说, 设说] = React.useState('')
      const [日志, 设日志] = React.useState(null)
      const [缓存统计, 设缓存统计] = React.useState(null)
      const 语音态 = useStore(语音.态)
      const 设备态 = useStore(设备)

      const 拉 = async () => {
        const s = await get('/state')
        if (s && s.ok) {
          设态(s)
          偏好.set((旧) => ({
            ...旧,
            载入: true,
            在线: Boolean(s.health && s.health.reachable),
            config: s.config || {},
            健康: s.health || null,
            音色: Array.isArray(s.voices) ? s.voices : [],
            插件: s.plugin || {},
          }))
        }
      }
      React.useEffect(() => { 拉() }, [])
      React.useEffect(() => {
        if (脏) return undefined
        const t = setInterval(拉, 5000)
        return () => clearInterval(t)
      }, [脏])
      const 配置 = (态 && 态.config) || {}
      const 健康 = (态 && 态.health) || {}
      const 缓存 = (态 && 态.cache) || {}
      const 能力表 = (态 && 态.capabilities) || {}
      const 音色们 = Array.isArray(态 && 态.voices) ? 态.voices : []
      const 在线 = Boolean(健康.reachable)
      const 兼容 = 健康.compatible !== false

      const 改 = (键, 值) => {
        设态((旧) => (旧 ? { ...旧, config: { ...(旧.config || {}), [键]: 值 } } : 旧))
        设脏(true)
      }

      const 存 = async () => {
        设忙(true); 设动作('保存'); 设说('正在保存…')
        const r = await post('/save', { config: 配置 })
        设忙(false); 设动作('')
        if (r && r.ok) {
          设脏(false)
          设说((r.warnings && r.warnings.length) ? `已保存（${r.warnings.join('；')}）` : '已保存。')
          if (r.config) {
            偏好.set((旧) => ({ ...旧, config: { ...r.config } }))
          }
          await 拉()
        } else {
          设说('保存失败：' + String((r && (r.hint || r.message)) || '请稍后重试。'))
        }
      }

      const 测试 = async () => {
        设忙(true); 设动作('测试'); 设说('正在测试连接…')
        const r = await post('/test', { timeoutMs: 4000 })
        设忙(false); 设动作('')
        if (r && r.ok) 设说(`连接正常，延迟 ${r.latencyMs || 0} 毫秒。`)
        else 设说(`连接失败：${(r && r.hint) || '本地 AI 未启动，请先启动。'}`)
        await 拉()
      }

      // 重新读取：把服务状态和缓存统计重新取一遍，按钮上显示正在读取。
      const 重读 = async () => {
        设忙(true); 设动作('读取'); 设说('正在重新读取…')
        await 拉()
        await 拉缓存统计()
        设忙(false); 设动作(''); 设说('')
      }

      const 看日志 = async () => {
        设忙(true)
        const r = await get('/logs?lines=200')
        设忙(false)
        设日志(r && r.ok ? r.lines : null)
      }

      const 拉缓存统计 = async () => {
        const r = await get('/cache/stats')
        if (r && r.ok) 设缓存统计(r)
      }

      const 清缓存 = async () => {
        设忙(true)
        const r = await post('/cache/clear', { kind: 'tts' })
        设忙(false)
        if (r && r.ok) {
          const mb = Math.round(((r.bytes || 0) / 1024 / 1024) * 10) / 10
          设说(`已清空朗读缓存（${r.files || 0} 个文件，释放 ${mb} MB）。下次朗读会重新生成语音。`)
        } else {
          设说(`清空缓存失败：${(r && r.hint) || '请稍后重试。'}`)
        }
        await 拉()
        await 拉缓存统计()
      }

      const 清过期 = async () => {
        设忙(true)
        const r = await post('/cache/cleanup', {})
        设忙(false)
        if (r && r.ok) {
          const mb = Math.round(((r.bytesFreed || 0) / 1024 / 1024) * 10) / 10
          设说(`已清理过期缓存 ${r.expired || 0} 个、超出上限 ${r.lru || 0} 个，释放 ${mb} MB。`)
        } else {
          设说(`清理缓存失败：${(r && r.hint) || '请稍后重试。'}`)
        }
        await 拉()
        await 拉缓存统计()
      }

      React.useEffect(() => { void 拉缓存统计() }, [])

      const 音色目录 = (态 && typeof 态.voicesDirectory === 'string') ? 态.voicesDirectory : ''

      const 打开缓存目录 = async () => {
        const r = await post('/open-folder', { path: String(配置.cacheDir || 缓存.dir || '').trim() })
        if (r && r.ok) 设说('已在文件管理器中打开缓存目录。')
        else 设说(`打开文件夹失败：${(r && r.hint) || '请手动打开。'}`)
      }

      // 音色目录只从服务实时取；服务离线时按钮禁用，不缓存路径。
      const 打开音色目录 = async () => {
        if (!音色目录 || !在线) return
        const r = await post('/open-folder', { path: 音色目录 })
        if (r && r.ok) 设说('已在文件管理器中打开音色目录。')
        else 设说(`打开文件夹失败：${(r && r.hint) || '请手动打开。'}`)
      }

      const 打开管理界面 = async () => {
        const r = await post('/open-webui', {})
        if (r && r.ok) 设说('已在默认浏览器中打开管理界面。')
        else 设说(`打开管理界面失败：${(r && r.hint) || '请稍后重试。'}`)
      }

      if (!态) {
        return h('div', { className: 'fish-service-settings', style: S.wrap },
          h('div', { style: S.h1 }, '本地 AI'),
          h('div', { style: S.dim }, '正在读取状态…'))
      }

      const 能力名们 = Object.keys(能力中文)
      const 可用数 = 能力名们.filter((名) => 能力表[名] && 能力表[名].available).length
      const 能力块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '能力'),
        h('div', { style: { ...S.dim, marginBottom: 6 } },
          `${可用数} / ${能力名们.length} 项可用`),
        h(折叠块, {
          摘要: '',
          默认展开: 可用数 < 能力名们.length,
          展开字样: '查看各项',
          收起字样: '收起',
        },
          h('div', { style: S.chips }, 能力名们.map((名) => {
            const 信息 = 能力表[名] || {}
            const 可用 = Boolean(信息.available)
            const 原因 = 信息.reason ? (原因中文[信息.reason] || '原因未知') : ''
            return h('div', { key: 名, style: S.chip },
              h('div', { style: { fontWeight: 600 } }, 能力中文[名]),
              h('div', { style: 可用 ? S.ok : S.danger },
                可用 ? `可用${信息.loaded ? '（已加载）' : ''}` : `不可用（${原因 || '原因未知'}）`))
          })),
          能力表.tts && !能力表.tts.available && 能力表.tts.reason === 'service_down'
            ? h('div', { style: { ...S.danger, marginTop: 8 } }, '本地 AI 未启动，请先启动。')
            : null))

      // 识图：开关控制输入框旁的「本地识图」按钮；会话识图与工具识图各用各的提示词，互不覆盖。
      const 预设表 = 配置.visionPresets && typeof 配置.visionPresets === 'object'
        && !Array.isArray(配置.visionPresets) ? 配置.visionPresets : {}
      // 「留空 = 用内置默认」，所以把默认提示词直接显示成占位文字。
      const 识图默认 = (态 && 态.visionDefaults && typeof 态.visionDefaults === 'object') ? 态.visionDefaults : {}
      const 会话识图默认 = typeof 识图默认.session === 'string' ? 识图默认.session : ''
      const 档位默认 = (档) => (识图默认.presets && typeof 识图默认.presets[档.id] === 'string' ? 识图默认.presets[档.id] : '')
      const 改提示词 = (档, 值) => {
        改('visionPresets', { ...预设表, [档]: 值 })
      }
      const 识图块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '识图'),
        行('本地识图', 勾(配置.localDescribe !== false, (值) => 改('localDescribe', 值)),
          '打开后，输入框旁的「本地识图」按钮可用。第一次识别要等模型加载。'),
        行('会话识图',
          多行(配置.visionSessionPrompt, (值) => 改('visionSessionPrompt', 值), 会话识图默认),
          '输入框旁的按钮识图时用这段提示词；留空用内置默认。'),
        行('工具默认档位', 下拉(规范识图档位(配置.visionDefaultPreset) || 'detailed', 识图档位选项,
          (值) => 改('visionDefaultPreset', 值)),
        '工具识图没指定档位时用这一档。'),
        h(折叠块, { 摘要: '工具提示词', 展开字样: '修改', 收起字样: '收起' },
          h('div', null, 识图档位们.map((档) => h('div', { key: 档.id, style: { marginBottom: 10 } },
            h('div', { style: { fontSize: 12.5, marginBottom: 2 } }, 档.名),
            多行(预设表[档.id], (值) => 改提示词(档.id, 值), 档位默认(档)))))))

      const 音色选项 = [{ value: 配置.ttsVoice || 'dafeiyu', label: 配置.ttsVoice || 'dafeiyu' }]
      for (const 名 of 音色们) {
        if (!音色选项.some((x) => x.value === 名)) 音色选项.push({ value: 名, label: 名 })
      }

      const 服务块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '服务连接'),
        行('服务地址', 输入(配置.baseUrl, (v) => 改('baseUrl', v), ''),
          { 问: '一般不用改；改了地址后点「测试连接」确认。' }),
        行('请求超时（秒）', h('input', {
          style: S.small, type: 'number', min: 1, max: 1800,
          value: Math.round((Number(配置.requestTimeoutMs) || 180000) / 1000),
          onChange: (e) => 改('requestTimeoutMs', Number(e.target.value) * 1000),
        }), { 问: '只影响一般请求；识别、分离与视觉分析另有更长的等待时间。' }),
        行('总开关', 勾(配置.enabled !== false, (v) => 改('enabled', v)),
          '关闭后朗读与语音输入都不可用。'),
        行('管理界面',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              style: S.btn,
              onClick: 打开管理界面,
              disabled: !在线 || 忙,
            }, '打开管理界面'),
            状态点(在线, 在线 ? '在线' : '离线')),
          在线 ? '' : '先启动本地 AI 再打开。'),
        (态.envOverrides && 态.envOverrides.length)
          ? h('div', { style: { ...S.danger, marginTop: 4 } },
              `以下设置已由系统统一指定，在设置页修改不会生效：${态.envOverrides.map((名) => 配置中文[名] || '其他设置').join('、')}`)
          : null)

      const 朗读块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '朗读'),
        行('默认音色',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            下拉(配置.ttsVoice || 'dafeiyu', 音色选项, (v) => 改('ttsVoice', v)),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: !在线 || !音色目录 || 忙,
              title: !在线 ? '本地 AI 未启动' : (!音色目录 ? '还没读到音色目录' : '在文件管理器中打开音色文件夹'),
              onClick: 打开音色目录,
            }, '打开文件夹')),
         在线 ? '把音色文件放进去，列表会自动更新。' : '本地 AI 未启动，启动后可打开音色文件夹。'),
        行('语速', h('input', {
          style: S.small, type: 'number', min: 0.5, max: 2, step: 0.05,
          value: 配置.ttsSpeed ?? 1,
          onChange: (e) => 改('ttsSpeed', Number(e.target.value)),
        })),
        行('去掉代码块', 勾(配置.readSkipCode !== false, (v) => 改('readSkipCode', v)),
          '关闭后只提示「代码块，共 N 行」。'),
        行('单次最大字数', h('input', {
          style: S.small, type: 'number', min: 200, max: 5000, step: 100,
          value: 配置.readMaxChars ?? 2000,
          onChange: (e) => 改('readMaxChars', Number(e.target.value)),
        }), { 问: '超过 2 万字的部分不朗读；长内容会自动分段。' }),
        行('同时生成', h('input', {
          style: S.small, type: 'number', min: 1, max: 4, step: 1,
          value: 配置.readConcurrency ?? 2,
          onChange: (e) => 改('readConcurrency', Number(e.target.value)),
        }), { 问: '数值越大出声越快、更占显存；卡顿时调低。' }),
        行('新会话默认自动朗读', 勾(配置.autoRead === true, (v) => 改('autoRead', v)),
          { 问: '只影响未单独设置过的会话；每个会话可单独开关。' }),
        行('后台也自动朗读', 勾(配置.autoReadInBackground !== false, (v) => 改('autoReadInBackground', v)),
          '切到后台或最小化时仍会朗读，会占用扬声器，可能打扰他人。'))

      const 已选设备标识 = String(配置.recordDeviceId || '')
      const 设备选项 = [{ value: '', label: '系统默认' }]
      for (const 项 of 设备态.列表) {
        if (!设备选项.some((x) => x.value === 项.deviceId)) 设备选项.push({ value: 项.deviceId, label: 项.label })
      }
      let 已选设备名 = '系统默认'
      if (已选设备标识) {
        const 命中 = 设备选项.find((x) => x.value === 已选设备标识)
        已选设备名 = (命中 && 命中.label)
          || (设备态.最近标识 === 已选设备标识 ? 设备态.最近名称 : '')
          || '名称未确认（请刷新设备列表）'
        if (!命中) 设备选项.push({ value: 已选设备标识, label: 已选设备名 })
      }
      const 录音中 = 语音态.phase === 'recording'
      const 输入音量 = 录音中 ? `${Math.min(100, Math.round((语音态.level || 0) * 100))}%` : '—'
      const 设备状态 = `已选：${已选设备名}｜上次录音：${设备态.最近名称 || '—'}｜当前音量：${输入音量}`

      const 语音块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '语音输入'),
        行('输入设备',
          h('div', null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              下拉(已选设备标识, 设备选项, (v) => 改('recordDeviceId', v)),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: 设备态.枚举中,
                onClick: () => { void 刷新设备列表() },
              }, 设备态.枚举中 ? '读取中…' : '刷新设备列表')),
            h('div', { style: { marginTop: 2 } },
              设备状态,
              设备态.提示 ? h('div', { style: { marginTop: 2 } }, 设备态.提示) : null)),
          { 问: '有多支麦克风或录音无声时可指定；虚拟设备常录不到人声。' }),
        行('录音格式', 下拉(配置.recordMime || 'auto', [
          { value: 'auto', label: '自动（推荐）' },
          { value: 'webm', label: '体积较小' },
          { value: 'wav', label: '体积较大' },
        ], (v) => 改('recordMime', v)), { 问: '转写结果异常时，换一种格式再试。' }),
        行('识别语言', 下拉(配置.asrLanguage || 'auto', [
          { value: 'auto', label: '自动判断' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'ja', label: '日文' },
        ], (v) => 改('asrLanguage', v))),
        行('记住上次选择', 勾(配置.rememberVoiceChoice !== false, (v) => 改('rememberVoiceChoice', v)),
          '只高亮上次的选项，不会自动执行。'),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          '录音最长 5 分钟、最大 25MB。'))

      const 缓存块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '缓存'),
        h('div', { style: S.dim },
          `当前占用 ${缓存.mb || 0} MB，共 ${缓存.files || 0} 个文件。`),
        h(折叠块, {
          摘要: 缓存统计
            ? `已复用 ${缓存统计.hits || 0} 次，复用率 ${Math.round((缓存统计.hitRate || 0) * 1000) / 10}%`
            : '统计读取中…',
          展开字样: '查看明细',
          收起字样: '收起明细',
        },
          行('保存位置',
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              输入(配置.cacheDir, (v) => 改('cacheDir', v), ''),
              h('button', { type: 'button', style: S.btn, onClick: 打开缓存目录, disabled: 忙 }, '打开文件夹')),
            { 问: '朗读音频、分离音轨、关键帧和保留的录音都在这里。' }),
          行('缓存上限（MB）', h('input', {
            style: S.small, type: 'number', min: 256, max: 10240, step: 256,
            value: 配置.cacheMaxMb ?? 2048,
            onChange: (e) => 改('cacheMaxMb', Number(e.target.value)),
          }), '超出上限时先删最久没用的文件。'),
          行('保留时长（小时）', h('input', {
            style: S.small, type: 'number', min: 1, max: 720, step: 1,
            value: 配置.cacheTtlHours ?? 72,
            onChange: (e) => 改('cacheTtlHours', Number(e.target.value)),
          }), '过期的文件会自动清理。'),
          h('div', { style: { ...S.dim, marginTop: 4 } },
            '已缓存音频：' + (缓存统计
              ? `${缓存统计.files || 0} 段 / ${(Math.round(((缓存统计.bytes || 0) / 1024 / 1024) * 10) / 10)} MB；`
                + `复用 ${缓存统计.hits || 0} 次、重新生成 ${缓存统计.misses || 0} 次（本次运行以来）`
              : '统计读取中…'))),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btn, onClick: 清缓存, disabled: 忙 }, '清空朗读缓存'),
          h('button', { type: 'button', style: S.btn, onClick: 清过期, disabled: 忙 }, '清理过期缓存')),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '清空后下次朗读会重新生成。'))

      const 翻译块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '翻译'),
        行('第一语言',
          下拉(配置.primaryLanguage || 'zh', 翻译语言下拉, (v) => 改('primaryLanguage', v)),
          '原文不是第一语言时，译成第一语言。'),
        行('第二语言',
          下拉(配置.secondaryLanguage || 'en', 翻译语言下拉, (v) => 改('secondaryLanguage', v)),
          '原文已经是第一语言时，译成第二语言。'),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '没指定目标语言时按上面的规则自动选择。'))

      // 界面：四个注入开关放一个可折叠分区，避免设置页一上来就很长。
      const 界面块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '界面'),
        h(折叠块, {
          摘要: '输入框里的按钮与状态',
          展开字样: '查看开关',
          收起字样: '收起',
        },
          行('语音识别', 勾(配置.uiVoiceInput !== false, (v) => 改('uiVoiceInput', v)),
            '关闭后输入框不再显示麦克风按钮。'),
          行('本地识图', 勾(配置.uiVision !== false, (v) => 改('uiVision', v)),
            '关闭后输入框不再显示识图按钮。'),
          行('性能监控', 勾(配置.uiMetrics !== false, (v) => 改('uiMetrics', v)),
            '关闭后输入框不再显示显存与任务状态。'),
          行('自动朗读', 勾(配置.uiAutoRead !== false, (v) => 改('uiAutoRead', v)),
            '关闭后所有会话都不再自动朗读，手动朗读不受影响。')))

      // 吸顶操作条：标题、在线状态和页面级按钮都在这里，内容在它下面滚动。
      const 操作条 = h('div', { style: S.bar },
        h('div', { style: S.barRow },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } },
            h('div', { style: { ...S.h1, margin: 0 } }, '本地 AI'),
            h('span', { style: { ...S.badge, ...(在线 ? S.ok : S.danger) } },
              在线 ? `在线${兼容 ? '' : '（版本不兼容）'} · v${健康.serviceVersion || '?'}` : '未启动'),
            h('span', { style: S.dim }, `插件 v${(态.plugin && 态.plugin.version) || '?'}`)),
          h('div', { style: S.barActions },
            h('button', { type: 'button', style: S.btnOn, onClick: 存, disabled: 忙 },
              忙 && 动作 === '保存' ? '正在保存…' : '保存设置'),
            h('button', { type: 'button', style: S.btn, onClick: 测试, disabled: 忙 },
              忙 && 动作 === '测试' ? '正在测试…' : '测试连接'),
            h('button', { type: 'button', style: S.btn, onClick: 重读, disabled: 忙 },
              忙 && 动作 === '读取' ? '正在读取…' : '重新读取'))),
        h('div', { style: S.dim }, '保存后立即生效，不用重启。'),
        说 ? h('div', { style: { ...(/失败|无法|错误|不可用|不能/.test(String(说)) ? S.danger : S.ok), marginTop: 2 } }, 说) : null)

      const 状态块 = h('div', { style: S.card },
        h('div', { style: S.dim },
          `延迟 ${健康.latencyMs || 0} 毫秒`
          + (健康.vram ? `｜显存 ${健康.vram.freeMb || 0}/${健康.vram.totalMb || 0} MB` : '')
          + `｜最近检查 ${健康.checkedAt ? new Date(健康.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          '朗读、语音输入与各项能力都在本机完成，不联网，也不产生额外费用。'),
        (健康.lastError && 健康.lastError.hint)
          ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近错误：${健康.lastError.hint}`)
          : null,
        (态.errors && 态.errors.length)
          ? h('div', { style: { ...S.dim, marginTop: 4 } },
              `最近有 ${态.errors.length} 条错误，最新：${态.errors[态.errors.length - 1].hint || '未知错误'}`)
          : null)

      const 日志块 = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { style: { ...S.h2, margin: 0 } }, '运行日志'),
          h('span', { style: S.dim }, '最近 200 行'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.dim }, '日志级别'),
          下拉(配置.logLevel || 'info', [
            { value: 'debug', label: '详细' },
            { value: 'info', label: '一般' },
            { value: 'warn', label: '仅警告' },
            { value: 'error', label: '仅错误' },
          ], (v) => 改('logLevel', v)),
          h('button', { type: 'button', style: S.btn, onClick: 看日志, disabled: 忙 }, '读取日志')),
        h('pre', { style: S.logs }, 日志 ? 日志.join('\n') : '（点「读取日志」查看）'),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '遇到问题时读取并复制给维护者。'))

      return h('div', { className: 'fish-service-settings', style: S.wrap },
        操作条,
        状态块,
        界面块,
        能力块,
        识图块,
        朗读块,
        翻译块,
        语音块,
        服务块,
        缓存块,
        日志块)
    }

    // ---------------- 本地 AI 状态胶囊（输入框左侧工具行） ----------------

    const 指标轮询毫秒 = 2000

    /** MB → GB，一位小数；缺失/非法按 0。 */
    function 格式化GB(兆字节) {
      const 数 = Number(兆字节)
      return (Number.isFinite(数) && 数 > 0 ? 数 / 1024 : 0).toFixed(1)
    }

    function 格式化显存(已用, 总量) {
      return `${格式化GB(已用)} / ${格式化GB(总量)} GB`
    }

    function 格式化模型(模型们) {
      const 列表 = (Array.isArray(模型们) ? 模型们 : [])
        .map((项) => String(项 == null ? '' : 项).trim())
        .filter(Boolean)
      return 列表.length ? `已加载 ${列表.join(' / ')}` : '无模型'
    }

    function 任务总数(队列) {
      const 排队 = Math.max(0, Math.trunc(Number(队列 && 队列.queued) || 0))
      const 运行 = Math.max(0, Math.trunc(Number(队列 && 队列.running) || 0))
      return 排队 + 运行
    }

    /** 胶囊文案里的任务段：有任务显示总数，没有显示空闲。 */
    function 格式化胶囊任务(队列) {
      const 总数 = 任务总数(队列)
      return 总数 > 0 ? `${总数} 任务` : '空闲'
    }

    /** 浮层里的队列行：「运行 1 · 排队 0」。 */
    function 格式化任务(队列) {
      const 排队 = Math.max(0, Math.trunc(Number(队列 && 队列.queued) || 0))
      const 运行 = Math.max(0, Math.trunc(Number(队列 && 队列.running) || 0))
      return 排队 + 运行 > 0 ? `运行 ${运行} · 排队 ${排队}` : '空闲'
    }

    function 格式化时长(秒) {
      const 总 = Math.max(0, Math.floor(Number(秒) || 0))
      const 天 = Math.floor(总 / 86400)
      const 小时 = Math.floor((总 % 86400) / 3600)
      const 分钟 = Math.floor((总 % 3600) / 60)
      if (天 > 0) return `${天} 天 ${小时} 小时`
      if (小时 > 0) return `${小时} 小时 ${分钟} 分`
      if (分钟 > 0) return `${分钟} 分钟`
      return `${总} 秒`
    }

    /** 按类型分桶 → 「tts 2 · asr 1」；空桶显示「无」。 */
    function 格式化类型明细(表) {
      const 项 = []
      if (表 && typeof 表 === 'object' && !Array.isArray(表)) {
        for (const [类型, 数] of Object.entries(表)) {
          const 计数 = Math.trunc(Number(数) || 0)
          if (计数 > 0) 项.push(`${类型} ${计数}`)
        }
      }
      return 项.length ? 项.join(' · ') : '无'
    }

    /** 显存占比分档：>95 危险、>85 警告，其余正常。 */
    function 显存色(百分比) {
      const 数 = Math.max(0, Math.min(100, Number(百分比) || 0))
      if (数 > 95) return 'danger'
      if (数 > 85) return 'warn'
      return ''
    }

    function 格式化视觉(视觉) {
      return `${视觉 && 视觉.loaded === true ? '已加载' : '未加载'} · ${视觉 && 视觉.ready === true ? '已就绪' : '未就绪'}`
    }

    function 指标离线(态) {
      return Boolean(态 && 态.载入 && (!态.数据 || 态.数据.ok !== true))
    }

    function 指标胶囊() {
      const 偏好态 = useStore(偏好)
      const 指标开 = 界面开关开(偏好态.config, '性能监控')
      const [态, 设态] = React.useState({ 载入: false, 数据: null })
      const [展开, 设展开] = React.useState(false)
      const [提示, 设提示] = React.useState('')
      const [忙, 设忙] = React.useState(false)
      const 根 = React.useRef(null)

      const 拉 = React.useCallback(async () => {
        // 页面隐藏时暂停轮询；恢复可见由 visibilitychange 立刻补一次。
        if (typeof document !== 'undefined' && document.hidden) return
        const 数据 = await get('/metrics')
        设态({ 载入: true, 数据: 数据 && typeof 数据 === 'object' ? 数据 : null })
      }, [])

      React.useEffect(() => {
        if (!指标开) {
          设态({ 载入: false, 数据: null })
          return undefined
        }
        let 定时器 = 0
        void 拉()
        定时器 = setInterval(() => { void 拉() }, 指标轮询毫秒)
        const 页面可见 = () => { if (!document.hidden) void 拉() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', 页面可见)
        return () => {
          clearInterval(定时器)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', 页面可见)
        }
      }, [拉, 指标开])

      React.useEffect(() => {
        if (!展开 || typeof document === 'undefined') return undefined
        const 点外面 = (事件) => {
          const 节点 = 根.current
          if (节点 && 事件 && 事件.target && 节点.contains(事件.target)) return
          设展开(false)
        }
        const 按Esc = (事件) => { if (事件 && 事件.key === 'Escape') 设展开(false) }
        document.addEventListener('pointerdown', 点外面, true)
        document.addEventListener('keydown', 按Esc, true)
        return () => {
          document.removeEventListener('pointerdown', 点外面, true)
          document.removeEventListener('keydown', 按Esc, true)
        }
      }, [展开])

      if (!指标开) return null

      const 打开管理 = async (事件) => {
        事件?.stopPropagation?.()
        设忙(true)
        设提示('')
        const 结果 = await post('/open-webui', {})
        设忙(false)
        if (!结果 || 结果.ok !== true) 设提示((结果 && 结果.hint) || '打开管理界面失败，请稍后再试。')
      }

      const 刷新 = async (事件) => {
        事件?.stopPropagation?.()
        设忙(true)
        设提示('')
        await 拉()
        设忙(false)
      }

      const 离线 = 指标离线(态)
      const 在线 = Boolean(态.载入 && !离线 && 态.数据 && 态.数据.ok === true)
      const 数据 = (在线 && 态.数据) || {}
      const gpu = 数据.gpu || {}
      const 占比 = Math.max(0, Math.min(100, Math.trunc(Number(gpu.percent) || 0)))
      const 等级 = 显存色(占比)
      const 胶囊文字 = !态.载入
        ? '连接中'
        : 离线
          ? '本地 AI 未启动'
          : `显存 ${占比}%｜${格式化胶囊任务(数据.queue)}`

      const 明细 = (标签, 值) => h('div', { className: 'fish-metrics-row' },
        h('span', { className: 'fish-metrics-key' }, 标签),
        h('span', { className: 'fish-metrics-val' }, 值))

      const 浮层 = h('div', {
        className: 'fish-metrics-pop',
        role: 'dialog',
        'aria-label': '本地 AI 详情',
        onClick: (事件) => 事件.stopPropagation(),
      },
        h('div', { className: 'fish-metrics-head' },
          h('span', { className: 'fish-metrics-title' }, '本地 AI'),
          h('span', { className: 'fish-metrics-dim' }, 在线 ? `v${数据.service?.version || '?'}` : '')),
        !态.载入
          ? h('div', { className: 'fish-metrics-empty' }, '正在读取…')
          : 离线
            ? h('div', { className: 'fish-metrics-empty' }, '启动服务后可查看。')
            : h(React.Fragment, null,
                h('div', { className: 'fish-metrics-gpu' },
                  明细('显卡', gpu.name || '未知'),
                  明细('显存', `${格式化显存(gpu.usedMb, gpu.totalMb)}（${占比}%）`),
                  h('div', { className: 'fish-metrics-bar', 'data-level': 等级 || undefined },
                    h('i', { style: { width: `${占比}%` } })),
                  明细('可用', `${格式化GB(gpu.freeMb)} GB`)),
                明细('模型', 格式化模型(数据.modelsLoaded)),
                明细('视觉', 格式化视觉(数据.vision)),
                h('div', { className: 'fish-metrics-sep' }),
                明细('队列', 格式化任务(数据.queue)),
                明细('排队明细', 格式化类型明细(数据.queue?.queuedByKind)),
                明细('运行明细', 格式化类型明细(数据.queue?.runningByKind)),
                明细('当前类型', 数据.scheduler?.currentKind || '无'),
                明细('调度模型', 数据.scheduler?.loadedModel || '无'),
                明细('运行时长', 格式化时长(数据.service?.uptimeSeconds))),
        提示 ? h('div', { className: 'fish-metrics-hint' }, 提示) : null,
        h('div', { className: 'fish-metrics-actions' },
          离线 ? null : h('button', {
            type: 'button',
            className: 'fish-btn',
            disabled: 忙,
            onClick: 打开管理,
          }, '打开管理界面'),
          h('button', { type: 'button', className: 'fish-btn', disabled: 忙, onClick: 刷新 }, '刷新')))

      return h('div', {
        ref: 根,
        className: 'fish-metrics',
        'data-offline': 离线 ? '1' : undefined,
      },
        h('button', {
          type: 'button',
          className: 'fish-metrics-pill',
          'data-level': 等级 || undefined,
          onClick: () => 设展开((值) => !值),
          'aria-expanded': 展开 ? 'true' : 'false',
          'aria-label': '本地 AI 状态',
          title: 离线 ? '本地 AI 未启动' : '查看本地 AI 详情',
        },
          h('span', { className: 'fish-metrics-dot', 'aria-hidden': true }),
          h('span', { className: 'fish-metrics-text' }, 胶囊文字)),
        展开 ? 浮层 : null)
    }

    // ---------------- 右栏「双语翻译」：分段、缓存、面板 ----------------

    const 翻译TabID = 'dsh-fish-service/translate'
    const 翻译TabKind = 'fish-translate'
    const 翻译语言名称 = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', yue: '粤语' }

    const 段字数上限 = 800
    const 每批段数上限 = 20
    const 每批字数上限 = 8000
    const 翻译缓存上限 = 2000
    // 后台任务每批更小：模型冷启动时单批耗时可控，串行提交不叠并发。
    const 任务每批段数 = 6
    const 任务每批字数 = 1500
    const 任务轮询毫秒 = 1000
    const 任务冷启动毫秒 = 8000
    const 任务总时长上限 = 10 * 60 * 1000
    // 一次只跑一批：冷启动时多批并发会把模型加载挤在一起。
    const 可取译文 = 1

    // 与 lib/lang.js 的 检测语言 同规则（本地字符范围判断，不请求模型）。
    function 检测语言(文本) {
      let 假名 = 0
      let 谚文 = 0
      let 汉字 = 0
      let 拉丁 = 0
      for (const 字 of String(文本 || '')) {
        const 码 = 字.codePointAt(0)
        if ((码 >= 0x3040 && 码 <= 0x30ff) || (码 >= 0x31f0 && 码 <= 0x31ff)) 假名 += 1
        else if ((码 >= 0xac00 && 码 <= 0xd7af) || (码 >= 0x1100 && 码 <= 0x11ff)) 谚文 += 1
        else if ((码 >= 0x4e00 && 码 <= 0x9fff) || (码 >= 0x3400 && 码 <= 0x4dbf) || (码 >= 0xf900 && 码 <= 0xfaff)) 汉字 += 1
        else if ((码 >= 0x41 && 码 <= 0x5a) || (码 >= 0x61 && 码 <= 0x7a) || (码 >= 0xc0 && 码 <= 0x24f)) 拉丁 += 1
      }
      if (假名 > 0) return 'ja'
      if (谚文 > 0) return 'ko'
      if (汉字 > 0) return 'zh'
      if (拉丁 > 0) return 'en'
      return null
    }

    function 翻译语言标签(代码) {
      return 翻译语言名称[代码] || String(代码 || '')
    }

    function 取翻译方向配置(配置) {
      const 第一 = 翻译语言名称[配置 && 配置.primaryLanguage] ? 配置.primaryLanguage : 'zh'
      const 第二 = 翻译语言名称[配置 && 配置.secondaryLanguage] ? 配置.secondaryLanguage : 'en'
      return { 第一, 第二 }
    }

    // 需求规则：原文语言不是第一语言就翻成第一语言，否则翻成第二语言；测不出来按第一语言。
    function 选翻译方向(文本, 配置) {
      const { 第一, 第二 } = 取翻译方向配置(配置)
      const 检测到 = 检测语言(文本)
      const 目标 = !检测到 ? 第一 : 检测到 === 第一 ? 第二 : 第一
      return { source: 检测到 || 'auto', target: 目标, detected: 检测到 }
    }

    function 翻译方向文案(方向) {
      const 源 = 方向 && 方向.source === 'auto' ? '自动检测' : 翻译语言标签(方向 && 方向.source)
      return `${源} → ${翻译语言标签(方向 && 方向.target)}`
    }

    // 按钮下面那行规则说明；lead 要求一行、20 字左右、不可点选。
    function 翻译规则文案(配置) {
      const { 第一, 第二 } = 取翻译方向配置(配置)
      return `自动：非${翻译语言标签(第一)} → ${翻译语言标签(第一)}，${翻译语言标签(第一)} → ${翻译语言标签(第二)}`
    }

    const 句末标点 = '。！？!?；;…'
    const 收尾字符 = '」』"”’）)】]'
    const 最短短语 = 10

    // 分段语义与 TTS 的 splitForSpeech 一致：单换行、句末标点都是边界，
    // 标点跟着前一句；不足最短短语的碎片并到相邻段；单片超上限才硬切。
    // 与 TTS 的区别：这里不能改字——不补标点、不吞空白，拼回去必须与原文逐字一致。
    // 返回 [{前导, 文本, 尾}]，组装译文把「前导 + 译文 + 尾」贴回即为原文。
    function 切段(文本) {
      const 原文 = String(文本 || '')
      if (!原文) return []

      // 1) 基础片段：单换行与句末标点都切开，两侧空白留给前导/尾。
      const 原始 = []
      let 片段起 = 0
      for (let i = 0; i <= 原文.length; i += 1) {
        const 到末尾 = i === 原文.length
        const 换行 = !到末尾 && 原文[i] === '\n'
        const 句末 = !到末尾 && !换行 && 句末标点.includes(原文[i])
        if (!到末尾 && !换行 && !句末) continue
        let 止 = i
        if (句末) {
          止 = i + 1
          while (止 < 原文.length && 收尾字符.includes(原文[止])) 止 += 1
        }
        // 只保留非空白内容：两端的空白归前导/尾，中间的空白（含换行）留在文本里。
        let 内容起 = 片段起
        while (内容起 < 止 && /\s/.test(原文[内容起])) 内容起 += 1
        let 内容止 = 止
        while (内容止 > 内容起 && /\s/.test(原文[内容止 - 1])) 内容止 -= 1
        if (内容起 < 内容止) 原始.push({ 起: 内容起, 止: 内容止 })
        片段起 = 换行 ? i + 1 : 止
        if (句末) i = 止 - 1
      }
      if (!原始.length) return [{ 前导: 原文, 文本: '', 尾: '' }]

      // 2) 太短的碎片不单独成段：优先并下一段，最后一段并到上一段。
      const 合并 = []
      let i = 0
      while (i < 原始.length) {
        let 区间 = 原始[i]
        i += 1
        while (区间.止 - 区间.起 < 最短短语 && i < 原始.length) {
          区间 = { 起: 区间.起, 止: 原始[i].止 }
          i += 1
        }
        合并.push(区间)
      }
      if (合并.length >= 2 && 合并[合并.length - 1].止 - 合并[合并.length - 1].起 < 最短短语) {
        const 末 = 合并.pop()
        合并[合并.length - 1].止 = 末.止
      }

      // 3) 只有单片超过上限才硬切：尽量在逗号/顿号/空格后断开，实在没有就按字数切。
      const 区间们 = []
      for (const 区间 of 合并) {
        if (区间.止 - 区间.起 <= 段字数上限) {
          区间们.push(区间)
          continue
        }
        let 起 = 区间.起
        while (区间.止 - 起 > 段字数上限) {
          const 窗口 = 原文.slice(起, 起 + 段字数上限)
          const 逗号 = Math.max(
            窗口.lastIndexOf('，'),
            窗口.lastIndexOf(','),
            窗口.lastIndexOf('、'),
            窗口.lastIndexOf(' '),
            窗口.lastIndexOf('\t'),
            窗口.lastIndexOf('\n'),
          )
          let 切 = 起 + 段字数上限
          if (逗号 > 段字数上限 * 0.6) 切 = 起 + 逗号 + 1
          if (切 > 起 && 切 < 区间.止 && /[\uDC00-\uDFFF]/.test(原文[切]) && /[\uD800-\uDBFF]/.test(原文[切 - 1])) 切 -= 1
          区间们.push({ 起, 止: 切 })
          起 = 切
        }
        if (起 < 区间.止) 区间们.push({ 起, 止: 区间.止 })
      }

      // 4) 区间还原成「前导/文本/尾」：段间空白归前一段的尾，首段前导是最前面的空白。
      const 段们 = []
      区间们.forEach((区间, 索引) => {
        const 前导 = 索引 === 0 ? 原文.slice(0, 区间.起) : ''
        const 尾 = 索引 + 1 < 区间们.length ? 原文.slice(区间.止, 区间们[索引 + 1].起) : 原文.slice(区间.止)
        段们.push({ 前导, 文本: 原文.slice(区间.起, 区间.止), 尾 })
      })
      return 段们
    }

    function 组装译文(段们, 译文表) {
      return 段们.map((段, 索引) => `${段.前导 || ''}${译文表[索引] == null ? '' : 译文表[索引]}${段.尾 || ''}`).join('')
    }

    // 缓存键带方向：同一段中文翻英文和翻日文的译文不能混用。
    const 翻译缓存 = new Map()

    function 缓存键(方向, 文本) {
      const 源 = (方向 && 方向.source) || 'auto'
      const 目标 = (方向 && 方向.target) || ''
      return `${源}→${目标}\u0000${文本}`
    }

    function 读缓存(方向, 文本) {
      const 键 = 缓存键(方向, 文本)
      if (!翻译缓存.has(键)) return undefined
      const 译文 = 翻译缓存.get(键)
      翻译缓存.delete(键)
      翻译缓存.set(键, 译文)
      return 译文
    }

    function 写缓存(方向, 文本, 译文) {
      const 键 = 缓存键(方向, 文本)
      翻译缓存.delete(键)
      翻译缓存.set(键, 译文)
      while (翻译缓存.size > 翻译缓存上限) {
        const 最旧 = 翻译缓存.keys().next().value
        翻译缓存.delete(最旧)
      }
    }

    function 清空翻译缓存() {
      翻译缓存.clear()
    }

    // 规划：空段不翻；命中缓存的段直接用，剩下的才要请求。
    function 规划翻译(段们, 方向) {
      const 译文表 = 段们.map(() => '')
      const 待翻 = []
      段们.forEach((段, 索引) => {
        if (!段.文本) return
        const 命中 = 读缓存(方向, 段.文本)
        if (命中 !== undefined) {
          译文表[索引] = 命中
          return
        }
        待翻.push({ 索引, 文本: 段.文本 })
      })
      return { 译文表, 待翻 }
    }

    function 规划批次(待翻, 段数上限 = 每批段数上限, 字数上限 = 每批字数上限) {
      const 批们 = []
      let 当前 = []
      let 字数 = 0
      for (const 项 of 待翻) {
        if (当前.length && (当前.length >= 段数上限 || 字数 + 项.文本.length > 字数上限)) {
          批们.push(当前)
          当前 = []
          字数 = 0
        }
        当前.push(项)
        字数 += 项.文本.length
      }
      if (当前.length) 批们.push(当前)
      return 批们
    }

    // ---------------- 分段映射 ----------------
    //
    // 分段们[i] = { 原文起, 原文止, 原文快照, 译文起, 译文止, 已译 }
    //   - 原文起/止：第 i 段正文在「原文侧」文本里的区间（不含前导空白和句尾空白）；
    //   - 译文起/止：对应译文在另一侧文本里的区间；
    //   - 原文快照：上次翻译时这段的原文，用来判断这段改没改；
    //   - 已译：这段是否已经有译文可沿用。
    // 编辑时只把区间折过去，不重排分段；删除/移动分段时再按区间重建两侧文本。

    // 两次文本之间「最小改动区间」：把中间那段换掉。
    function 求编辑范围(旧文本, 新文本) {
      const 旧 = String(旧文本 || '')
      const 新 = String(新文本 || '')
      const 最短 = Math.min(旧.length, 新.length)
      let 起 = 0
      while (起 < 最短 && 旧[起] === 新[起]) 起 += 1
      let 尾 = 0
      while (尾 < 最短 - 起 && 旧[旧.length - 1 - 尾] === 新[新.length - 1 - 尾]) 尾 += 1
      return { 起, 旧止: 旧.length - 尾, 新止: 新.length - 尾 }
    }

    // 把旧文本里的一个下标折到新文本里；改区间内部的边界贴到改动末尾。
    function 映射位置(位置, 编辑) {
      // 纯插入：插在 p 之后的所有边界后移；只有整篇最开头（p=0）的插入算进第一段，
      // 否则开头新写的字会掉进前导空白、永远不参与翻译。
      if (编辑.起 === 编辑.旧止) {
        if (位置 === 0 && 编辑.起 === 0) return 0
        return 位置 >= 编辑.起 ? 位置 + (编辑.新止 - 编辑.旧止) : 位置
      }
      if (位置 <= 编辑.起) return 位置
      if (位置 >= 编辑.旧止) return 位置 + (编辑.新止 - 编辑.旧止)
      return 编辑.新止
    }

    // 侧 = '原文' | '译文'：只调这一侧的区间，另一侧不动。
    function 调整分段偏移(分段们, 侧, 旧文本, 新文本) {
      if (!Array.isArray(分段们) || !分段们.length) return 分段们
      const 编辑 = 求编辑范围(旧文本, 新文本)
      if (编辑.起 === 编辑.旧止 && 编辑.起 === 编辑.新止) return 分段们
      const 起键 = 侧 === '原文' ? '原文起' : '译文起'
      const 止键 = 侧 === '原文' ? '原文止' : '译文止'
      const 长 = String(新文本 || '').length
      return 分段们.map((项) => {
        const 起 = Math.min(长, Math.max(0, 映射位置(项[起键], 编辑)))
        const 止 = Math.min(长, Math.max(起, 映射位置(项[止键], 编辑)))
        return { ...项, [起键]: 起, [止键]: 止 }
      })
    }

    // 把整段文本按分段区间拆成「前导们 + 内容们」；前导们 比 内容们 多一项。
    function 切片段(文本, 分段们, 起键, 止键) {
      const 原文 = String(文本 || '')
      const 前导们 = []
      const 内容们 = []
      let 游标 = 0
      for (const 项 of 分段们) {
        const 起 = Math.min(原文.length, Math.max(游标, 项[起键]))
        const 止 = Math.min(原文.length, Math.max(起, 项[止键]))
        前导们.push(原文.slice(游标, 起))
        内容们.push(原文.slice(起, 止))
        游标 = 止
      }
      前导们.push(原文.slice(游标))
      return { 前导们, 内容们 }
    }

    // 取某一侧的渲染片段；没有有效映射时返回 null（此时不显示分段高亮）。
    // 原文坐标记在 映射侧：同步态下 原文侧 为 null，但映射仍然可用。
    function 取侧片段(状态, 侧) {
      const 分段们 = 状态 && 状态.分段们
      const 映射侧 = 状态 && (状态.映射侧 || 状态.原文侧)
      if (!Array.isArray(分段们) || !分段们.length || !映射侧) return null
      const 文本 = String(状态[侧] || '')
      if (侧 === 映射侧) return 切片段(文本, 分段们, '原文起', '原文止')
      return 切片段(文本, 分段们, '译文起', '译文止')
    }

    function 映射有效(状态) {
      const 映射侧 = 状态 && (状态.映射侧 || 状态.原文侧)
      if (!映射侧) return false
      const 分段们 = 状态.分段们
      if (!Array.isArray(分段们) || !分段们.length) return false
      const 另一侧 = 映射侧 === '上' ? '下' : '上'
      const 原文文本 = String(状态[映射侧] || '')
      const 译文文本 = String(状态[另一侧] || '')
      for (const 项 of 分段们) {
        if (!项 || 项.原文起 > 项.原文止 || 项.译文起 > 项.译文止) return false
        if (项.原文起 < 0 || 项.译文起 < 0) return false
        if (项.原文止 > 原文文本.length || 项.译文止 > 译文文本.length) return false
      }
      return true
    }

    // 由「切段结果 + 每段译文」拼出两侧文本和分段映射；已译表决定哪段可沿用。
    function 拼接分段(段们, 译文表, 已译表) {
      const 原文块 = []
      const 译文块 = []
      const 分段们 = []
      let 原游标 = 0
      let 译游标 = 0
      段们.forEach((段, 索引) => {
        const 前导 = String(段.前导 || '')
        const 正文 = String(段.文本 || '')
        const 尾 = String(段.尾 || '')
        const 译文 = 译文表[索引] == null ? '' : String(译文表[索引])
        const 原文起 = 原游标 + 前导.length
        const 原文止 = 原文起 + 正文.length
        const 译文起 = 译游标 + 前导.length
        const 译文止 = 译文起 + 译文.length
        原文块.push(前导, 正文, 尾)
        译文块.push(前导, 译文, 尾)
        原游标 = 原文止 + 尾.length
        译游标 = 译文止 + 尾.length
        分段们.push({
          原文起,
          原文止,
          原文快照: 正文,
          译文起,
          译文止,
          已译: 已译表 ? Boolean(已译表[索引]) : true,
        })
      })
      return { 原文文本: 原文块.join(''), 译文文本: 译文块.join(''), 分段们 }
    }

    function 同方向(甲, 乙) {
      return Boolean(甲 && 乙 && 甲.source === 乙.source && 甲.target === 乙.target)
    }

    // 这次要翻什么：方向按原文侧现算；没改过的段先沿用 state 里的译文，
    // 再查全局缓存，都没有的才进待翻。待翻的段先用上一版译文占位，
    // 中途失败/取消时框里不会整段变空。
    function 建翻译计划(状态, 配置) {
      if (!状态 || !状态.原文侧) return null
      const 侧 = 状态.原文侧
      const 另一侧 = 侧 === '上' ? '下' : '上'
      const 原文 = String(状态[侧] || '')
      if (!原文.trim()) return null
      const 方向 = 选翻译方向(原文, 配置)
      const 段们 = 切段(原文)
      const 旧分段们 = Array.isArray(状态.分段们) && 状态.分段们.length ? 状态.分段们 : []
      const 旧译文 = String(状态[另一侧] || '')
      const 可沿用 = 同方向(状态.方向, 方向) && 旧分段们.length > 0
      const 译文表 = 段们.map(() => '')
      const 已译 = 段们.map(() => false)
      const 待翻 = []
      const 已用 = new Set()
      段们.forEach((段, 索引) => {
        if (!段.文本) {
          译文表[索引] = ''
          已译[索引] = true
          return
        }
        if (可沿用) {
          for (let k = 0; k < 旧分段们.length; k += 1) {
            const 项 = 旧分段们[k]
            if (已用.has(k) || !项.已译 || 项.原文快照 !== 段.文本) continue
            译文表[索引] = 旧译文.slice(项.译文起, 项.译文止)
            已译[索引] = true
            已用.add(k)
            return
          }
        }
        const 缓存 = 读缓存(方向, 段.文本)
        if (缓存 !== undefined) {
          译文表[索引] = 缓存
          已译[索引] = true
          return
        }
        const 旧项 = 旧分段们.length ? 旧分段们[索引] : null
        if (旧项 && 旧项.已译) 译文表[索引] = 旧译文.slice(旧项.译文起, 旧项.译文止)
        待翻.push({ 索引, 文本: 段.文本 })
      })
      const 总段数 = 段们.filter((段) => 段.文本).length
      return {
        侧,
        另一侧,
        原文,
        方向,
        段们,
        译文表,
        已译,
        待翻,
        总段数,
        沿用数: 总段数 - 待翻.length,
      }
    }

    function 计划映射(计划) {
      return 拼接分段(计划.段们, 计划.译文表, 计划.已译)
    }

    function 翻译开始状态(旧, 计划) {
      const 结果 = 计划映射(计划)
      return {
        ...旧,
        阶段: '翻译中',
        提示: '',
        成功: '',
        方向: 计划.方向,
        原文侧: 计划.侧,
        映射侧: 计划.侧,
        进度: { 完成: 0, 总数: 计划.待翻.length },
        [计划.侧]: 计划.原文,
        [计划.另一侧]: 结果.译文文本,
        分段们: 结果.分段们,
      }
    }

    function 翻译成功状态(旧, 计划) {
      const 结果 = 计划映射(计划)
      const 沿用文案 = 计划.沿用数 ? `（${计划.沿用数} 段沿用上次）` : ''
      return {
        ...旧,
        // 翻完回同步态：两框对应且都可编辑，原文侧清空，谁再编辑谁就是新的原文。
        阶段: '同步',
        原文侧: null,
        映射侧: 计划.侧,
        提示: '',
        进度: null,
        方向: 计划.方向,
        [计划.侧]: 计划.原文,
        [计划.另一侧]: 结果.译文文本,
        分段们: 结果.分段们,
        成功: `${翻译方向文案(计划.方向)} · 已翻译 ${计划.总段数} 段${沿用文案}`,
      }
    }

    function 翻译中断状态(旧, 计划, _阶段, 提示) {
      const 结果 = 计划映射(计划)
      return {
        ...旧,
        // 失败 / 取消都退回「修改中」：原文侧保留，已翻好的段留在框里，按钮显示继续翻译。
        阶段: '修改中',
        原文侧: 计划.侧,
        映射侧: 计划.侧,
        提示: 提示 || '',
        成功: '',
        进度: null,
        [计划.侧]: 计划.原文,
        [计划.另一侧]: 结果.译文文本,
        分段们: 结果.分段们,
      }
    }

    const 翻译重试码 = ['service_down', 'model_loading', 'busy', 'timeout', 'upstream_error']
    // 服务端任务状态 -> 面板阶段。done 后还要取一次结果，所以叫「整理译文」。
    const 任务阶段文案 = {
      queued: '排队中',
      running: '翻译中',
      done: '整理译文',
      failed: '翻译失败',
      canceled: '已取消',
    }
    const 冷启动提示 = '正在加载翻译模型，第一次会慢一点（约 40 秒）'

    // 只跑待翻的批，一次一批（可取译文=1），每批走异步任务：提交 → 轮询 → 取结果。
    // post / get / 等待 / 运行 / 现在 都由调用方注入，单元测试可以完全不走网络。
    async function 执行翻译(计划, 依赖 = {}) {
      const 发送 =
        typeof 依赖.post === 'function'
          ? 依赖.post
          : (路径, 体, 选项) => post(路径, 体, 选项 || {})
      const 取状态 =
        typeof 依赖.get === 'function'
          ? 依赖.get
          : (路径) => get(路径)
      const 运行 = 依赖.运行 || { 已取消: false, 控制器: null }
      const 推送 = typeof 依赖.推送 === 'function' ? 依赖.推送 : () => {}
      const 等待 = typeof 依赖.等待 === 'function' ? 依赖.等待 : (毫秒) => new Promise((好) => setTimeout(好, 毫秒))
      const 现在 = typeof 依赖.现在 === 'function' ? 依赖.现在 : () => Date.now()
      const 轮询毫秒 = Number.isFinite(依赖.轮询毫秒) ? Math.max(0, 依赖.轮询毫秒) : 任务轮询毫秒
      const 冷启动毫秒 = Number.isFinite(依赖.冷启动毫秒) ? Math.max(0, 依赖.冷启动毫秒) : 任务冷启动毫秒
      const 总时长上限 = Number.isFinite(依赖.总时长上限) ? Math.max(0, 依赖.总时长上限) : 任务总时长上限
      // 任务批比同步批小：冷启动时单批耗时可控。
      const 批们 = 规划批次(计划.待翻, 任务每批段数, 任务每批字数)
      let 完成 = 0
      let 失败 = ''
      let 回退 = false
      const 开始 = 现在()

      const 通知 = (阶段, 提示 = '') => {
        推送(完成, { 阶段, 提示, 已用: Math.max(0, 现在() - 开始), 总数: 计划.待翻.length })
      }

      const 写回一段 = (项, 译文) => {
        if (typeof 译文 === 'string' && 译文) {
          计划.译文表[项.索引] = 译文
          计划.已译[项.索引] = true
          写缓存(计划.方向, 项.文本, 译文)
          完成 += 1
          return true
        }
        失败 = '这次没翻完，可以点继续翻译重试'
        return false
      }

      // 回退分支：旧版服务的同步批量接口，超时放宽到 3 分钟。
      const 同步一批 = async (批) => {
        const 体 = {
          texts: 批.map((项) => ({ id: 项.索引, text: 项.文本 })),
          source: 计划.方向.source,
          target: 计划.方向.target,
          timeoutMs: 180000,
        }
        const 选项 = 运行.控制器 ? { signal: 运行.控制器.signal } : undefined
        let 结果
        try {
          结果 = await 发送('/translate/batch', 体, 选项)
        } catch {
          结果 = null
        }
        if (运行.已取消) return
        if (!结果) {
          失败 = '连接本地 AI 失败，可以点继续翻译重试'
          return
        }
        if (结果.ok && Array.isArray(结果.results)) {
          const 按索引 = new Map()
          for (const 条 of 结果.results) 按索引.set(String(条 && 条.id), 条)
          for (const 项 of 批) {
            const 条 = 按索引.get(String(项.索引))
            if (条 && !条.error && typeof 条.translated === 'string') 写回一段(项, 条.translated)
            else 失败 = (条 && 条.error && 条.error.hint) || '这次没翻完，可以点继续翻译重试'
          }
          通知('翻译中')
          return
        }
        失败 = (结果.ok ? '' : 结果.hint) || '这次没翻完，可以点继续翻译重试'
      }

      const 提交一批 = async (批) => {
        const 体 = {
          texts: 批.map((项) => 项.文本),
          source: 计划.方向.source,
          target: 计划.方向.target,
        }
        const 选项 = 运行.控制器 ? { signal: 运行.控制器.signal } : undefined
        const 发一次 = async () => {
          try {
            return await 发送('/translate/jobs', 体, 选项)
          } catch {
            return null
          }
        }
        let 结果 = await 发一次()
        if (运行.已取消) return { 已取消: true }
        if (结果 && !结果.ok && 翻译重试码.includes(结果.code)) {
          await 等待(800)
          if (运行.已取消) return { 已取消: true }
          结果 = await 发一次()
        }
        if (!结果) return { ok: false, hint: '提交翻译任务失败，可以点继续翻译重试' }
        if (结果.ok && 结果.id) return { ok: true, id: String(结果.id) }
        // 旧版服务没有任务接口：整轮改用同步批量。
        if (结果.code === 'not_supported') return { 回退: true }
        return { ok: false, hint: 结果.hint || '提交翻译任务失败，可以点继续翻译重试', code: 结果.code }
      }

      const 尽力取消 = async (任务id) => {
        if (!任务id) return
        try {
          await 发送('/translate/jobs/cancel', { id: 任务id })
        } catch {
          // 取消失败不阻塞面板停止。
        }
      }

      // 轮询一个任务直到终态；返回 { done } / { 失败 } / { 已取消 }。
      const 等任务 = async (任务id) => {
        运行.任务id = 任务id
        let 阶段 = 'queued'
        let 连不上 = 0
        for (;;) {
          if (运行.已取消) {
            运行.任务id = null
            await 尽力取消(任务id)
            return { 已取消: true }
          }
          const 已用 = Math.max(0, 现在() - 开始)
          if (已用 > 总时长上限) {
            运行.任务id = null
            失败 = '翻译等太久了，已停下；翻好的段落都保留着'
            await 尽力取消(任务id)
            return { 失败: true }
          }
          // 冷启动（模型加载 + 首次编译）超过 8 秒给明确提示，别让人以为卡死。
          if (已用 >= 冷启动毫秒 && (阶段 === 'queued' || 阶段 === 'running')) {
            通知('准备模型', 冷启动提示)
          } else {
            通知(任务阶段文案[阶段] || '排队中')
          }
          let 状态
          try {
            状态 = await 取状态(`/translate/jobs/status?id=${encodeURIComponent(任务id)}`)
          } catch {
            状态 = null
          }
          if (运行.已取消) {
            运行.任务id = null
            await 尽力取消(任务id)
            return { 已取消: true }
          }
          if (状态 && 状态.ok) {
            连不上 = 0
            阶段 = String(状态.state || 'running')
            if (阶段 === 'done') return { done: true }
            if (阶段 === 'failed') {
              失败 = (状态.error && typeof 状态.error === 'string' && 状态.error) || '翻译任务失败了，可以点继续翻译重试'
              return { 失败: true }
            }
            if (阶段 === 'canceled') return { 已取消: true }
          } else {
            连不上 += 1
            const 确定性错误 = 状态 && 状态.code && 状态.code !== 'upstream_error'
            if (确定性错误) {
              失败 = 状态.hint || '翻译任务中断了，可以点继续翻译重试'
              return { 失败: true }
            }
            if (连不上 >= 5) {
              失败 = '与本地 AI 的连接中断了，翻好的段落都保留着'
              return { 失败: true }
            }
          }
          await 等待(轮询毫秒)
        }
      }

      const 取译文 = async (任务id) => {
        try {
          const 结果 = await 取状态(`/translate/jobs/result?id=${encodeURIComponent(任务id)}`)
          if (结果 && 结果.ok && Array.isArray(结果.texts)) return 结果.texts
          return null
        } catch {
          return null
        }
      }

      for (const 批 of 批们) {
        if (运行.已取消 || 失败) break
        if (回退) {
          await 同步一批(批)
          continue
        }
        通知('提交中')
        const 提交 = await 提交一批(批)
        if (提交.已取消 || 运行.已取消) {
          运行.任务id = null
          break
        }
        if (提交.回退) {
          // 第一批复用同一份文本走同步接口，后续批也留在同步路径。
          回退 = true
          await 同步一批(批)
          continue
        }
        if (!提交.ok) {
          失败 = 提交.hint
          break
        }
        const 状态 = await 等任务(提交.id)
        if (状态.已取消) break
        if (状态.失败) break
        const 译文们 = await 取译文(提交.id)
        运行.任务id = null
        if (!译文们) {
          失败 = '没取到译文，可以点继续翻译重试'
          break
        }
        for (let i = 0; i < 批.length; i += 1) 写回一段(批[i], 译文们[i])
        通知('翻译中')
      }

      if (运行.已取消) await 尽力取消(运行.任务id)
      return { 完成, 失败, 已取消: Boolean(运行.已取消), 请求批次: 批们.length, 回退 }
    }

    // ---------------- 分段删除 / 移动（只改文本和映射，不请求翻译） ----------------

    function 删除片段项(片段, 索引) {
      const 段数 = 片段.内容们.length
      片段.内容们.splice(索引, 1)
      if (索引 < 段数 - 1) 片段.前导们.splice(索引 + 1, 1)
      else 片段.前导们.splice(索引, 1)
    }

    function 交换片段项(片段, 甲, 乙) {
      const 临时 = 片段.内容们[甲]
      片段.内容们[甲] = 片段.内容们[乙]
      片段.内容们[乙] = 临时
    }

    // 片段们 -> 两侧文本 + 新分段映射；原文快照/已译跟着原来的段走。
    function 由片段建映射(原文片段, 译文片段, 来源, 旧分段们) {
      const 段数 = 原文片段.内容们.length
      const 分段们 = []
      let 原文本 = 原文片段.前导们[0] || ''
      let 译文本 = 译文片段.前导们[0] || ''
      for (let i = 0; i < 段数; i += 1) {
        const 内容原 = 原文片段.内容们[i] || ''
        const 内容译 = 译文片段.内容们[i] || ''
        const 原文起 = 原文本.length
        const 原文止 = 原文起 + 内容原.length
        const 译文起 = 译文本.length
        const 译文止 = 译文起 + 内容译.length
        原文本 += 内容原 + (原文片段.前导们[i + 1] || '')
        译文本 += 内容译 + (译文片段.前导们[i + 1] || '')
        const 旧 = 旧分段们[来源[i]]
        分段们.push({
          原文起,
          原文止,
          原文快照: 旧 ? 旧.原文快照 : 内容原,
          译文起,
          译文止,
          已译: 旧 ? 旧.已译 : false,
        })
      }
      return { 原文文本: 原文本, 译文文本: 译文本, 分段们 }
    }

    // 操作 = '删除' | '上移' | '下移'；只动本地状态，不调用翻译服务。
    function 分段操作(状态, 操作, 索引) {
      if (!状态 || 状态.阶段 === '翻译中') return 状态
      if (!映射有效(状态)) return 状态
      const 分段们 = 状态.分段们
      const 位置 = Number(索引)
      if (!Number.isInteger(位置) || 位置 < 0 || 位置 >= 分段们.length) return 状态
      const 映射侧 = 状态.映射侧 || 状态.原文侧
      if (!映射侧) return 状态
      const 另一侧 = 映射侧 === '上' ? '下' : '上'
      const 原文片段 = 切片段(状态[映射侧], 分段们, '原文起', '原文止')
      const 译文片段 = 切片段(状态[另一侧], 分段们, '译文起', '译文止')
      const 来源 = 分段们.map((_, i) => i)
      if (操作 === '删除') {
        删除片段项(原文片段, 位置)
        删除片段项(译文片段, 位置)
        来源.splice(位置, 1)
      } else if (操作 === '上移' && 位置 > 0) {
        交换片段项(原文片段, 位置, 位置 - 1)
        交换片段项(译文片段, 位置, 位置 - 1)
        const 临时 = 来源[位置]
        来源[位置] = 来源[位置 - 1]
        来源[位置 - 1] = 临时
      } else if (操作 === '下移' && 位置 < 分段们.length - 1) {
        交换片段项(原文片段, 位置, 位置 + 1)
        交换片段项(译文片段, 位置, 位置 + 1)
        const 临时 = 来源[位置]
        来源[位置] = 来源[位置 + 1]
        来源[位置 + 1] = 临时
      } else {
        return 状态
      }
      const 映射 = 由片段建映射(原文片段, 译文片段, 来源, 分段们)
      if (!映射.原文文本.trim() && !映射.译文文本.trim()) return 翻译空状态()
      return {
        ...状态,
        [映射侧]: 映射.原文文本,
        [另一侧]: 映射.译文文本,
        分段们: 映射.分段们,
        成功: '',
        // 同步态里做结构编辑：把映射锚定的一侧定为原文，之后可以直接点翻译。
        ...(状态.阶段 === '同步' ? { 阶段: '修改中', 原文侧: 映射侧 } : {}),
      }
    }

    // ---------------- 状态机 ----------------

    // 三态（只有三档，旧的「空闲 / 待翻译 / 失败 / 已取消」不再使用）：
    //   同步：两框内容互相对应，都可编辑；此时没有「原文侧」。
    //   修改中：被编辑的那侧是原文，另一侧只读；原文清空回同步。
    //   翻译中：两侧都只读。
    // 映射的原文坐标记在 映射侧：同步态下 原文侧 为 null，但映射侧保留，
    // 所以分段高亮 / 上移 / 下移 / 删除在同步态仍然可用。

    function 翻译空状态() {
      return { 上: '', 下: '', 原文侧: null, 阶段: '同步', 提示: '', 进度: null, 方向: null, 成功: '', 分段们: null, 映射侧: null }
    }

    // 把映射的原文侧换到另一侧：文本一个字都不动，只交换每段的坐标。
    function 翻转映射(状态, 新原文侧) {
      const 分段们 = 状态 && 状态.分段们
      if (!Array.isArray(分段们) || !分段们.length) return 分段们 || null
      const 旧原文侧 = 状态.映射侧 || 状态.原文侧
      if (!旧原文侧 || 旧原文侧 === 新原文侧) return 分段们
      const 新原文文本 = String(状态[新原文侧] || '')
      return 分段们.map((项) => ({
        ...项,
        原文起: 项.译文起,
        原文止: 项.译文止,
        译文起: 项.原文起,
        译文止: 项.原文止,
        原文快照: 新原文文本.slice(项.译文起, 项.译文止),
      }))
    }

    // 「改这一侧」：只换原文 / 译文的角色，两边文本都不动。
    function 切换原文侧(状态) {
      if (!状态 || 状态.阶段 !== '修改中' || !状态.原文侧) return 状态
      const 新侧 = 状态.原文侧 === '上' ? '下' : '上'
      return {
        ...状态,
        原文侧: 新侧,
        映射侧: 新侧,
        分段们: 翻转映射(状态, 新侧),
        方向: null,
        进度: null,
        提示: '',
        成功: '',
      }
    }

    // 编辑规则：
    //   - 翻译中谁都不能改；
    //   - 同步态写入非空内容的那一侧成为原文，另一侧锁成译文输出；
    //   - 修改中只认原文侧，改译文侧直接拒绝；原文清空回到同步；
    //   - 分段映射跟着改动折偏移，没改过的段留给下次沿用。
    function 翻译编辑(状态, 侧, 值) {
      if (!状态 || 状态.阶段 === '翻译中') return 状态
      const 文本 = String(值 == null ? '' : 值)
      const 另一侧 = 侧 === '上' ? '下' : '上'
      const 下个 = { ...状态, [侧]: 文本, 提示: '', 成功: '' }
      const 清空 = !文本.trim()

      if (状态.阶段 === '修改中') {
        if (侧 !== 状态.原文侧) return 状态
        if (清空) {
          return { ...下个, 阶段: '同步', 原文侧: null, 映射侧: null, 分段们: null, 方向: null, 进度: null }
        }
        return {
          ...下个,
          阶段: '修改中',
          映射侧: 侧,
          分段们: 调整分段偏移(状态.分段们, '原文', 状态[侧], 文本),
        }
      }

      // 同步态：空编辑保持同步；写入非空内容的那侧成为原文。
      if (清空) {
        return { ...下个, 阶段: '同步', 原文侧: null, 映射侧: null, 分段们: null, 方向: null, 进度: null }
      }
      let 分段们 = 状态.分段们
      let 旧文本 = 状态[侧]
      if (Array.isArray(分段们) && 分段们.length && 状态.映射侧 && 状态.映射侧 !== 侧) {
        分段们 = 翻转映射(状态, 侧)
        旧文本 = String(状态[侧] || '')
      }
      return {
        ...下个,
        阶段: '修改中',
        原文侧: 侧,
        映射侧: 侧,
        分段们: Array.isArray(分段们) && 分段们.length ? 调整分段偏移(分段们, '原文', 旧文本, 文本) : null,
        进度: null,
      }
    }

    function 翻译锁定侧(状态) {
      if (!状态 || 状态.阶段 !== '修改中' || !状态.原文侧) return null
      return 状态.原文侧 === '上' ? '下' : '上'
    }

    function 翻译可执行(状态) {
      if (!状态 || 状态.阶段 !== '修改中' || !状态.原文侧) return false
      return Boolean(String(状态[状态.原文侧] || '').trim())
    }

    function 翻译按钮文字(状态) {
      if (!状态) return '翻译'
      if (状态.阶段 === '翻译中') return '正在翻译…'
      if (状态.阶段 === '修改中' && 状态.提示) return '继续翻译'
      return '翻译'
    }

    // 每个会话留一份草稿：切走再切回来，原文和已翻好的译文都还在。
    const 翻译草稿 = new Map()

    // 悬停只做预览高亮，点击才选中；选中状态不因鼠标移开而消失。
    function 分段空交互() {
      return { 悬停: null, 选中: null }
    }

    function 分段交互(交互, 事件) {
      const 当前 = 交互 || 分段空交互()
      const 类型 = 事件 && 事件.类型
      const 索引 = 事件 && Number.isInteger(事件.索引) ? 事件.索引 : null
      if (类型 === '悬停') return { ...当前, 悬停: 索引 }
      if (类型 === '点击') return { ...当前, 悬停: 索引, 选中: 索引 == null || 当前.选中 === 索引 ? null : 索引 }
      return { ...当前, 选中: null }
    }

    // 固定工具条：无选中时只给提示，选中后按钮按首尾边界禁用。
    function 分段工具条(分段数, 选中, 处理, 取消选中) {
      const 总 = Math.max(0, Math.trunc(Number(分段数) || 0))
      const 有效 = 选中 != null && 选中 >= 0 && 选中 < 总 ? 选中 : null
      if (有效 == null) {
        return [h('span', { key: '提示', className: 'fish-panel-dim' }, '点一下分段，可上移 / 下移 / 删除')]
      }
      const 按钮 = (键, 文字, 可用, 标题, 操作) =>
        h(
          'button',
          {
            key: 键,
            type: 'button',
            className: 操作 === '删除' ? 'fish-btn fish-tr-del' : 'fish-btn',
            disabled: !可用,
            title: 标题,
            onClick: 可用 && 处理 ? () => 处理(操作, 有效) : undefined,
          },
          文字,
        )
      return [
        h('span', { key: '位置', className: 'fish-panel-dim' }, `第 ${有效 + 1}/${总} 段`),
        按钮('上移', '上移', 有效 > 0, '与上一段交换位置', '上移'),
        按钮('下移', '下移', 有效 < 总 - 1, '与下一段交换位置', '下移'),
        按钮('删除', '删除', true, '删除这一段，两侧一起删除', '删除'),
        h('button', { key: '取消选择', type: 'button', className: 'fish-btn', onClick: 取消选中 || undefined }, '取消选择'),
      ]
    }

    function 翻译面板(props) {
      const 会话键 = String((props && props.sessionId) || '')
      const 偏好态 = useStore(偏好)
      const [状态, 设状态] = React.useState(() => 翻译草稿.get(会话键) || 翻译空状态())
      const [交互, 设交互] = React.useState(分段空交互)
      const 状态引用 = React.useRef(状态)
      状态引用.current = 状态
      const 运行 = React.useRef(null)
      const 框引用 = React.useRef({ 上: null, 下: null })
      const 镜引用 = React.useRef({ 上: null, 下: null })

      React.useEffect(() => {
        翻译草稿.set(会话键, 状态)
        if (翻译草稿.size > 20) {
          const 最旧 = 翻译草稿.keys().next().value
          if (最旧 !== 会话键) 翻译草稿.delete(最旧)
        }
      }, [会话键, 状态])

      React.useEffect(() => {
        if (!偏好.get().载入) void 载入偏好()
        return () => {
          const 在跑 = 运行.current
          if (在跑) {
            在跑.已取消 = true
            if (在跑.控制器) 在跑.控制器.abort()
            if (在跑.任务id) void post('/translate/jobs/cancel', { id: 在跑.任务id })
          }
          运行.current = null
        }
      }, [])

      const 配置 = (偏好态 && 偏好态.config) || {}
      const 翻译中 = 状态.阶段 === '翻译中'
      const 锁定 = 翻译锁定侧(状态)
      const 有映射 = 映射有效(状态)
      const 分段数 = Array.isArray(状态.分段们) ? 状态.分段们.length : 0
      const 悬停段 = 有映射 && 交互.悬停 != null && 交互.悬停 >= 0 && 交互.悬停 < 分段数 ? 交互.悬停 : null
      const 选中段 = 有映射 && 交互.选中 != null && 交互.选中 >= 0 && 交互.选中 < 分段数 ? 交互.选中 : null

      // 段数可能随编辑/翻译变化，派发前先把越界的旧选中清掉。
      const 交互事件 = (事件) => {
        设交互((旧) => 分段交互({ ...旧, 选中: 旧.选中 != null && 旧.选中 < 分段数 ? 旧.选中 : null }, 事件))
      }

      const 编辑 = (侧, 值) => {
        设交互((旧) => ({ ...旧, 悬停: null }))
        设状态((旧) => 翻译编辑(旧, 侧, 值))
      }

      const 取消 = () => {
        const 在跑 = 运行.current
        if (!在跑) return
        在跑.已取消 = true
        if (在跑.控制器) 在跑.控制器.abort()
        // 只停本地轮询不够，顺手让服务端别继续占着队列。
        if (在跑.任务id) {
          const 任务id = 在跑.任务id
          在跑.任务id = null
          void post('/translate/jobs/cancel', { id: 任务id })
        }
      }

      const 处理分段 = (操作, 索引) => {
        if (操作 === '取消选中') {
          设交互((旧) => ({ ...旧, 选中: null }))
          return
        }
        const 当前 = 状态引用.current
        if (当前.阶段 === '翻译中') return
        if (操作 === '删除') {
          const 问 = typeof window !== 'undefined' && typeof window.confirm === 'function'
          if (问 && !window.confirm('删除这一段？两侧对应内容会一起删除，无法撤销。')) return
        }
        设状态((旧) => 分段操作(旧, 操作, 索引))
        // 移动后选中跟着这段走；删除后回到未选。
        设交互((旧) => (操作 === '删除' ? 分段空交互() : { 悬停: null, 选中: 操作 === '上移' ? 索引 - 1 : 索引 + 1 }))
      }

      // 「改这一侧」：把锁定侧换成原文，只换角色、不动文本。
      const 切换侧 = () => {
        const 当前 = 状态引用.current
        if (当前.阶段 === '翻译中' || !当前.原文侧) return
        设状态((旧) => 切换原文侧(旧))
        设交互((旧) => ({ ...旧, 悬停: null }))
      }

      const 翻译 = async () => {
        const 当前 = 状态引用.current
        const 计划 = 建翻译计划(当前, 配置)
        if (!计划) return
        设交互(分段空交互())
        const 运行对象 = {
          已取消: false,
          控制器: typeof AbortController === 'function' ? new AbortController() : null,
          任务id: null,
        }
        运行.current = 运行对象
        设状态((旧) => 翻译开始状态(旧, 计划))
        const 推送 = (完成, 信息 = {}) => {
          设状态((旧) => ({
            ...翻译开始状态(旧, 计划),
            提示: 信息.提示 || '',
            进度: {
              完成,
              总数: 计划.待翻.length,
              阶段: 信息.阶段 || '翻译中',
              已用: 信息.已用 || 0,
            },
          }))
        }
        const 结果 = await 执行翻译(计划, { 运行: 运行对象, 推送 })
        运行.current = null
        if (运行对象.已取消 || (结果 && 结果.已取消)) {
          设状态((旧) => 翻译中断状态(旧, 计划, '已取消', '已取消，已翻好的部分保留'))
          return
        }
        if (结果 && 结果.失败) {
          设状态((旧) => 翻译中断状态(旧, 计划, '失败', 结果.失败))
          return
        }
        设状态((旧) => 翻译成功状态(旧, 计划))
      }

      // 鼠标坐标落在哪一段：textarea 收事件，背后的 mirror 负责量出每段的位置。
      const 命中分段 = (侧, 事件) => {
        const 当前 = 状态引用.current
        if (!事件 || !映射有效(当前)) return null
        const 框 = 框引用.current[侧]
        const 镜 = 镜引用.current[侧]
        if (!框 || !镜 || typeof 镜.querySelectorAll !== 'function') return null
        const 宽 = 框.clientWidth
        if (宽 > 0 && 镜.style.width !== `${宽}px`) 镜.style.width = `${宽}px`
        if (镜.scrollTop !== 框.scrollTop) 镜.scrollTop = 框.scrollTop
        if (镜.scrollLeft !== 框.scrollLeft) 镜.scrollLeft = 框.scrollLeft
        const 点X = 事件.clientX
        const 点Y = 事件.clientY
        for (const 节点 of 镜.querySelectorAll('[data-seg]')) {
          for (const 矩形 of 节点.getClientRects()) {
            if (点X >= 矩形.left && 点X <= 矩形.right && 点Y >= 矩形.top && 点Y <= 矩形.bottom) {
              return Number(节点.getAttribute('data-seg'))
            }
          }
        }
        return null
      }

      const 同步滚动 = (侧) => {
        const 框 = 框引用.current[侧]
        const 镜 = 镜引用.current[侧]
        if (!框 || !镜) return
        镜.scrollTop = 框.scrollTop
        镜.scrollLeft = 框.scrollLeft
      }

      // 点两个框和工具条以外的空白：取消选中。
      const 点空白 = (事件) => {
        const 目标 = 事件 && 事件.target
        if (!目标) return
        const 类 = typeof 目标.className === 'string' ? 目标.className : ''
        if (类.includes('fish-tr-textarea')) return
        if (目标.closest && 目标.closest('.fish-tr-edit, .fish-tr-segbar, .fish-tr-actions')) return
        设交互((旧) => ({ ...旧, 悬停: null, 选中: null }))
      }

      const 渲染镜像 = (侧) => {
        const 片段 = 取侧片段(状态, 侧)
        if (!片段) return null
        const 子们 = []
        for (let i = 0; i < 片段.内容们.length; i += 1) {
          子们.push(片段.前导们[i] || '')
          子们.push(
            h(
              'span',
              {
                key: `段${i}`,
                className: 'fish-tr-seg',
                'data-seg': i,
                'data-active': 悬停段 === i ? '1' : undefined,
                'data-selected': 选中段 === i ? '1' : undefined,
              },
              片段.内容们[i] || '',
            ),
          )
        }
        子们.push(片段.前导们[片段.内容们.length] || '')
        return 子们
      }

      const 侧标签 = (侧) => {
        if (状态.阶段 === '同步' || !状态.原文侧) return '可输入'
        return 侧 === 状态.原文侧 ? '原文' : '译文'
      }
      const 侧说明 = (侧) => {
        if (翻译中) return '正在翻译，暂时不能编辑'
        if (!状态.原文侧) return ''
        if (侧 === 状态.原文侧) return '这边是原文'
        return '译文输出，翻译完成前不可编辑'
      }
      const 占位 = (侧) => {
        if (!状态.原文侧 || 侧 === 状态.原文侧) return '输入或粘贴要翻译的文字'
        return '点「翻译」后，译文出现在这里'
      }

      const 可执行 = 翻译可执行(状态)
      const 空文本 = !String(状态.上 || '').trim() && !String(状态.下 || '').trim()
      const 禁用原因 = 可执行 || 翻译中 || !空文本 ? '' : '先输入要翻译的文字'
      const 按钮标题 = 翻译中
        ? '正在翻译，请稍候'
        : 可执行
          ? undefined
          : 状态.阶段 === '同步' && !空文本
            ? '先在一个框里改点内容，改过的那一侧会成为原文'
            : '先输入要翻译的文字'
      const 进度 = (翻译中 && 状态.进度) || null
      const 进度阶段 = 进度 && 进度.阶段 && 进度.阶段 !== '翻译中' ? 进度.阶段 : ''
      const 已用秒 = 进度 && 进度.已用 >= 1000 ? Math.round(进度.已用 / 1000) : 0
      const 进度线 = 进度
        ? [`正在翻译 ${进度.完成 || 0}/${进度.总数 || 0} 段`, 进度阶段, 已用秒 ? `已用 ${已用秒} 秒` : '']
            .filter(Boolean)
            .join(' · ')
        : ''

      const 一栏 = (侧) =>
        h(
          'div',
          {
            className: 'fish-tr-pane',
            'data-locked': 锁定 === 侧 ? '1' : undefined,
            'data-busy': 翻译中 ? '1' : undefined,
          },
          h(
            'div',
            { className: 'fish-tr-head' },
            h('span', { className: 'fish-tr-role' }, 侧标签(侧)),
            h('span', { className: 'fish-panel-dim' }, 侧说明(侧)),
            锁定 === 侧
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'fish-tr-switch',
                    title: '把这侧改成原文，另一侧作为译文输出',
                    onClick: 切换侧,
                  },
                  '改这一侧',
                )
              : null,
          ),
          h(
            'div',
            { className: 'fish-tr-edit' },
            有映射 ? h('div', { className: 'fish-tr-mirror', 'aria-hidden': 'true', ref: (节点) => { 镜引用.current[侧] = 节点 } }, 渲染镜像(侧)) : null,
            h('textarea', {
              className: 'fish-tr-textarea',
              value: 状态[侧],
              readOnly: 翻译中 || 锁定 === 侧,
              disabled: false,
              placeholder: 占位(侧),
              'aria-label': `${侧标签(侧)}框`,
              ref: (节点) => { 框引用.current[侧] = 节点 },
              onMouseMove: (事件) => 交互事件({ 类型: '悬停', 索引: 命中分段(侧, 事件) }),
              onMouseLeave: () => 交互事件({ 类型: '悬停', 索引: null }),
              onClick: (事件) => 交互事件({ 类型: '点击', 索引: 命中分段(侧, 事件) }),
              onScroll: () => 同步滚动(侧),
              onChange: (事件) => 编辑(侧, 事件.target.value),
            }),
          ),
        )

      const 分段条 =
        有映射 && !翻译中
          ? h(
              'div',
              { className: 'fish-tr-segbar', 'data-idle': 选中段 == null ? '1' : undefined },
              分段工具条(分段数, 选中段, 处理分段, () => 处理分段('取消选中', null)),
            )
          : null

      const 提示是错误 = Boolean(状态.提示) && !String(状态.提示).startsWith('已取消')
      const 提示 = 状态.提示
        ? h('div', { className: 提示是错误 ? 'fish-err fish-tr-note' : 'fish-panel-dim fish-tr-note', role: 'status' }, 状态.提示)
        : 状态.成功
          ? h('div', { className: 'fish-ok fish-tr-note', role: 'status' }, 状态.成功)
          : 禁用原因
            ? h('div', { className: 'fish-panel-dim fish-tr-note' }, 禁用原因)
            : null

      return h(
        'div',
        {
          className: 'fish-tr',
          onMouseDown: 点空白,
          // Esc 取消选中：焦点可能在文本框、按钮或工具条上，统一在卡片根上接。
          onKeyDown: (事件) => {
            if (事件 && 事件.key === 'Escape') 交互事件({ 类型: '取消' })
          },
        },
        // 顶部固定操作区：操作行 / 提示 / 规则 / 分段工具条，不随输入框滚动。
        h(
          'div',
          { className: 'fish-tr-top' },
          h(
            'div',
            { className: 'fish-tr-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'fish-btn',
                'data-primary': '1',
                disabled: !可执行,
                title: 按钮标题,
                'aria-busy': 翻译中 ? 'true' : undefined,
                onClick: () => void 翻译(),
              },
              翻译中 ? 图标转圈(13) : null,
              翻译按钮文字(状态),
            ),
            翻译中 ? h('button', { type: 'button', className: 'fish-btn', onClick: 取消 }, '取消') : null,
            进度线 ? h('span', { className: 'fish-panel-dim', role: 'status' }, 进度线) : null,
          ),
          提示,
          h('div', { className: 'fish-panel-dim fish-tr-note' }, 翻译规则文案(配置)),
          分段条,
        ),
        h('div', { className: 'fish-tr-grid' }, 一栏('上'), 一栏('下')),
      )
    }

    function 翻译图标({ size = 26, className } = {}) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          className,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3.4 5.2h8.2M7.5 3.4v1.8M10.4 5.2c-.7 2.8-2.3 5.3-4.5 7.1M5.2 9.4c1.4 1.8 3.1 3.1 5 3.8' }),
        h('path', { d: 'M12.6 19.6 16.2 10h.9l3.6 9.6M13.9 16.2h5.2' }),
      )
    }

    // 槽位/右栏在 DSH 启动早期可能还没就绪，短轮询等待；返回的清理函数会把
    // 已注册的东西反注册，并清掉还没触发的重试定时器。
    const 就绪重试间隔毫秒 = 250
    const 就绪最多次数 = 40
    function 等就绪(尝试) {
      let 次数 = 0
      let 定时 = null
      let 已取消 = false
      let 清理 = null
      const 跑 = () => {
        if (已取消) return
        const 结果 = 尝试()
        if (结果 === null) {
          if (次数 < 就绪最多次数) {
            次数 += 1
            定时 = setTimeout(跑, 就绪重试间隔毫秒)
          } else {
            try { console.warn('[dsh-fish-service] 服务没就绪，注册已放弃') } catch { /* 忽略 */ }
          }
          return
        }
        清理 = typeof 结果 === 'function' ? 结果 : null
      }
      跑()
      return () => {
        已取消 = true
        if (定时) { clearTimeout(定时); 定时 = null }
        if (清理) {
          try { 清理() } catch { /* 已卸载 */ }
          清理 = null
        }
      }
    }

    // 右栏「开始」页的卡片：注册一个 tab 类型 + guide 条目，body 走 sidebar.right.pane.tab 槽。
    function 注册右栏(ctx) {
      return 等就绪(() => {
        let 右栏 = null
        try {
          右栏 = ctx.get('sidebarRightTabs')
        } catch {
          右栏 = null
        }
        if ((!右栏 || typeof 右栏.register !== 'function') && ctx && ctx.sidebarRightTabs) 右栏 = ctx.sidebarRightTabs
        if (!右栏 || typeof 右栏.register !== 'function') return null
        try {
          const 摘 = 右栏.register({
            id: 翻译TabID,
            kind: 翻译TabKind,
            title: () => '双语翻译',
            keepMounted: true,
            guide: [
              {
                id: 'translate',
                order: 35,
                title: () => '双语翻译',
                description: () => '两段文字对着翻，长的只重译改过的地方',
                icon: 翻译图标,
              },
            ],
          })
          return typeof 摘 === 'function' ? 摘 : () => {}
        } catch (错误) {
          try { console.warn('[dsh-fish-service] 注册双语翻译卡片失败', 错误) } catch { /* 忽略 */ }
          return () => {}
        }
      })
    }

    // ---------------- 注册 ----------------

    function 注册(ctx, 槽位, 配置项, 组件) {
      try {
        return slots注册(ctx, 槽位, 配置项, 组件)
      } catch (error) {
        // 槽位在这个 DSH 版本不存在时不要让整个插件挂掉。
        try { console.warn('[dsh-fish-service] 注册槽位失败', 槽位, error) } catch { /* 忽略 */ }
        return () => {}
      }
    }

    function slots注册(ctx, 槽位, 配置项, 组件) {
      return 等就绪(() => {
        const slots = ctx.get('slots')
        if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return null
        try {
          const 摘 = slots.inject(槽位, () => slots.register({ name: 槽位, ...配置项 }, 组件))
          return typeof 摘 === 'function' ? 摘 : () => {}
        } catch {
          // 槽位本身可能还没注册，等下一轮再试。
          return null
        }
      })
    }

    /**
     * 框选文字：先注册「选中后打开工具条」的交互，再注册 keyed 槽位。
     * 两个都成功，DSH 才会在选中文字时渲染工具条。
     */
    function 注册选中交互(ctx) {
      const 摘 = []
      try {
        const ui = ctx.get('uiConversation')
        const 交互 = ui && ui.interactions
        if (交互 && typeof 交互.register === 'function') {
          const disposer = 交互.register({
            id: 选中交互ID,
            onInteraction(请求) {
              if (!请求 || 请求.trigger !== 'selection') return
              const 文本 = typeof 请求.readText === 'function' ? 请求.readText() : null
              if (文本 === null || !String(文本).trim()) return
              if (typeof 请求.open === 'function') 请求.open()
            },
          }, '选中文字的朗读与翻译')
          if (typeof disposer === 'function') 摘.push(disposer)
        }
      } catch (error) {
        try { console.warn('[dsh-fish-service] 注册选中交互失败', error) } catch { /* 忽略 */ }
      }
      try {
        const slots = ctx.get('slots')
        if (slots && typeof slots.register === 'function' && typeof slots.inject === 'function') {
          const disposer = slots.inject('conversation.chat.text-interaction', () => slots.register({
            name: 'conversation.chat.text-interaction',
            key: 选中交互ID,
          }, 选中工具条))
          if (typeof disposer === 'function') 摘.push(disposer)
        }
      } catch (error) {
        try { console.warn('[dsh-fish-service] 注册选中文字槽位失败', error) } catch { /* 忽略 */ }
      }
      return () => {
        for (const 函数 of 摘.splice(0)) {
          try { 函数() } catch { /* 已卸载 */ }
        }
      }
    }

    function apply(ctx) {
      插件上下文 = ctx
      const 清理们 = []
      const 收 = (清理) => { if (typeof 清理 === 'function') 清理们.push(清理) }
      收(注入样式())
      // 设置页：P1 的「本地 AI」tab（P2 在同一个页面里加分区的）。
      收(注册(ctx, 'settings.section', { id: 'fish-service', order: 57, label: () => '本地 AI' }, Section))
      // 消息级朗读按钮：助手消息操作行（复制按钮右边）。
      收(注册(ctx, 'conversation.chat.assistant-actions', { id: 'fish-read', order: 21, label: () => '朗读' }, 朗读按钮))
      // 输入框右侧：麦克风（开始/结束录音）。
      收(注册(ctx, 'conversation.input.right', { id: 'fish-mic', order: 32, label: () => '语音输入' }, 麦克风按钮))
      // 输入框右侧：本地识图按钮（点选图片；图片不进草稿）。
      收(注册(ctx, 'conversation.input.right', { id: 'fish-vision', order: 31, label: () => '本地识图' }, 本地识图按钮))
      // 输入框上方浮层：录音状态 + 三选一面板（DSH 的 overlay 就挂在这里）。
      收(注册(ctx, 'conversation.input.overlay', { id: 'fish-voice', order: 40, label: () => '语音输入面板' }, 语音面板))
      // 输入框左侧：自动朗读开关。
      收(注册(ctx, 'conversation.input.left', { id: 'fish-auto-read', order: 45, label: () => '自动朗读' }, 自动朗读开关))
      // 输入框左侧：本地 AI 状态胶囊（显存 / 任务，点开看详情）。
      收(注册(ctx, 'conversation.input.left', { id: 'fish-metrics', order: 40, label: () => '本地 AI 状态' }, 指标胶囊))
      // 框选文字：朗读 / 翻译（需要同时注册 interaction 与 keyed 槽位）。
      收(注册选中交互(ctx))
      // 右栏「开始」页：双语翻译卡片（guide 入口 + 面板 body）。
      // inject 拿到当前会话 id，面板据此给每个会话留一份草稿。
      收(注册(ctx, 'sidebar.right.pane.tab', { key: 翻译TabID, inject: (会话) => ({ sessionId: 会话 }) }, 翻译面板))
      收(注册右栏(ctx))

      // 预热一次偏好（不阻塞）；失败也无所谓，组件挂载时会再拉。
      void 载入偏好()

      // 按注册的反序释放：槽位/交互/右栏 tab、未触发的重试定时器、样式节点。
      const 卸载 = () => {
        for (const 清理 of 清理们.splice(0).reverse()) {
          try { 清理() } catch { /* 已卸载 */ }
        }
      }
      try {
        ctx.effect?.(() => 卸载)
      } catch {
        // 老宿主没有 effect 时只能靠页面整体销毁；不影响注册本身。
      }
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供单元测试直接验证的纯函数；浏览器运行时不使用。
    exports.__testing = {
      读会话自动朗读,
      写会话自动朗读,
      读后台自动朗读,
      是否自动朗读,
      会话自动朗读上限,
      会话键合法,
      构建录音约束,
      规整录音时长,
      打开麦克风,
      设备不可用错误,
      是虚拟设备名称,
      虚拟设备提示,
      注册选中交互,
      选中交互ID,
      识图扩展,
      是图片文件,
      本地识图开,
      界面开关开,
      界面开关键,
      偏好,
      麦克风按钮,
      本地识图按钮,
      语音面板,
      自动朗读开关,
      指标胶囊,
      识图档位们,
      识图档位选项,
      规范识图档位,
      识图阻塞原因,
      拼图片描述,
      入队待插入,
      取待插入,
      消费待插入,
      格式化GB,
      格式化显存,
      格式化模型,
      格式化任务,
      格式化胶囊任务,
      任务总数,
      格式化时长,
      格式化类型明细,
      显存色,
      格式化视觉,
      指标离线,
      语音附件名,
      取会话对话,
      挂语音附件,
      检测语言,
      选翻译方向,
      翻译方向文案,
      翻译规则文案,
      翻译语言标签,
      切段,
      组装译文,
      规划翻译,
      规划批次,
      取翻译方向配置,
      求编辑范围,
      映射位置,
      调整分段偏移,
      切片段,
      取侧片段,
      映射有效,
      拼接分段,
      翻转映射,
      切换原文侧,
      同方向,
      建翻译计划,
      执行翻译,
      任务阶段文案,
      冷启动提示,
      翻译开始状态,
      翻译成功状态,
      翻译中断状态,
      分段操作,
      分段空交互,
      分段交互,
      分段工具条,
      翻译草稿,
      缓存键,
      读缓存,
      写缓存,
      清空翻译缓存,
      翻译空状态,
      翻译编辑,
      翻译锁定侧,
      翻译可执行,
      翻译按钮文字,
      翻译面板,
      Section,
    }
    return module.exports
  },
})
