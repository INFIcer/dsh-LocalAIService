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

    const audioUrl = (path) => `${B}/audio?path=${encodeURIComponent(String(path || ''))}`

    // ---------------- 极简 store（跨槽位共享状态） ----------------

    function makeStore(initialValue) {
      let value = initialValue
      const listener = new Set()
      return {
        get: () => value,
        set(next) {
          value = typeof next === 'function' ? next(value) : next
          for (const fn of [...listener]) {
            try { fn(value) } catch { /* 单个订阅者出错不影响别人 */ }
          }
        },
        subscribe(fn) {
          listener.add(fn)
          return () => listener.delete(fn)
        },
      }
    }

    function useStore(store) {
      const [value, setValue] = React.useState(store.get)
      React.useEffect(() => {
        const halt = store.subscribe(setValue)
        setValue(store.get())
        return halt
      }, [store])
      return value
    }

    // ---------------- 插件偏好（来自 /state，设置页保存后同步更新） ----------------

    const prefs = makeStore({
      load: false,
      online: false,
      config: {},
      health: null,
      voice: [],
      plugin: {},
    })

    let prefsRequest = null
    function loadPrefs({ force = false } = {}) {
      if (prefsRequest && !force) return prefsRequest
      prefsRequest = get('/state').then((s) => {
        if (s && s.ok) {
          prefs.set((prev) => ({
            ...prev,
            load: true,
            online: Boolean(s.health && s.health.reachable),
            config: s.config || {},
            health: s.health || null,
            voice: Array.isArray(s.voices) ? s.voices : prev.voice,
            plugin: s.plugin || {},
          }))
        } else {
          prefs.set((prev) => ({ ...prev, load: true }))
        }
        return s
      }).catch(() => {
        prefsRequest = null
        return null
      })
      return prefsRequest
    }

    // ---------------- 按会话自动朗读（纯函数，便于单测） ----------------

    const autoReadSessionLimit = 200
    const validSessionKey = (key) => typeof key === 'string' && /^session-/.test(key)
    const truthy = (value) => value === true || value === 'true' || value === 1 || value === '1'

    /** 当前会话是否自动朗读：本会话有设置就用它，否则回落到全局默认（autoRead）。 */
    function readAutoReadSessions(config, sessionKey) {
      const configItem = config && typeof config === 'object' ? config : {}
      const table = configItem.autoReadSessions && typeof configItem.autoReadSessions === 'object'
        && !Array.isArray(configItem.autoReadSessions)
        ? configItem.autoReadSessions
        : null
      if (table && validSessionKey(sessionKey) && Object.prototype.hasOwnProperty.call(table, sessionKey)) {
        return truthy(table[sessionKey])
      }
      return truthy(configItem.autoRead)
    }

    /** 只改当前会话那一条，返回新配置；其它会话与全局默认保持不变。 */
    function writeAutoReadSessions(config, sessionKey, on) {
      const configItem = config && typeof config === 'object' ? config : {}
      if (!validSessionKey(sessionKey)) return configItem
      const table = configItem.autoReadSessions && typeof configItem.autoReadSessions === 'object'
        && !Array.isArray(configItem.autoReadSessions)
        ? { ...configItem.autoReadSessions }
        : {}
      // 先删再写：最近改过的会话排在最后，超过上限时优先淘汰最早的设置。
      delete table[sessionKey]
      table[sessionKey] = on === true || on === 'true'
      const keys = Object.keys(table)
      while (keys.length > autoReadSessionLimit) delete table[keys.shift()]
      return { ...configItem, autoReadSessions: table }
    }

    /** 后台朗读：旧配置没有该字段、或值无法识别时按开启；只有明确关闭才关。 */
    function readBackgroundAutoRead(config) {
      const value = config && typeof config === 'object' ? config.autoReadInBackground : undefined
      if (value === false || value === 'false' || value === 0 || value === '0') return false
      return true
    }

    /** 这条新回复是否自动朗读：会话开关必须开；页面在后台时还要「后台也自动朗读」开着。 */
    function shouldAutoRead(config, sessionKey, pageVisible) {
      if (!readAutoReadSessions(config, sessionKey)) return false
      if (pageVisible) return true
      return readBackgroundAutoRead(config)
    }

    // 有组件挂载时才轮询 /health（30 秒一次），没人看就不打扰服务。
    let heartbeat = null
    let mountCount = 0
    function keepAlive(on) {
      mountCount += on ? 1 : -1
      if (mountCount < 0) mountCount = 0
      if (on && !heartbeat) {
        heartbeat = setInterval(async () => {
          try {
            const r = await fetch(B + '/health', { cache: 'no-store' }).then((x) => x.json())
            if (r) prefs.set((prev) => ({ ...prev, online: Boolean(r.ok) }))
          } catch { /* 服务重启/DSH 关闭时忽略 */ }
        }, 30000)
      } else if (!on && mountCount === 0 && heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    }

    // ---------------- 朗读播放器（全局只有一个） ----------------
    //
    // 流式朗读（P2 性能修复）：
    //   1. POST /read/plan 立刻拿分段计划（不合成）；
    //   2. 按顺序请求 /read/segment，拿到第 1 段就开始播，同时预取下一段；
    //   3. 切换消息 / 再点一次 = stop()：递增代次 + abort 未完成的 segment 请求。
    // 这样长文不用等全部合成，首段出声明显更早；同一段重复朗读由服务端缓存直接命中。

    const play = {
      state: makeStore({ phase: 'idle', messageId: '', error: '', index: 0, total: 0 }),
      audio: null,
      prefetch: null,
      seq: 0,
      message: '',
      abort: null,

      stop(error = '') {
        this.seq += 1
        try { this.abort?.abort() } catch { /* 已经结束 */ }
        this.abort = null
        for (const audio of [this.audio, this.prefetch]) {
          if (!audio) continue
          try { audio.pause() } catch { /* 已经结束 */ }
          try { audio.removeAttribute('src'); audio.load() } catch { /* 忽略 */ }
        }
        this.audio = null
        this.prefetch = null
        this.message = ''
        this.state.set({ phase: 'idle', messageId: '', error: error, index: 0, total: 0 })
      },

      /** 流式合成并顺序播放；同一条消息再点一次 = 停止。 */
      async synthesizeAndPlay(messageId, text, config) {
        this.stop()
        const generation = ++this.seq
        const abort = typeof AbortController === 'function' ? new AbortController() : null
        this.abort = abort
        this.message = messageId
        this.state.set({ phase: 'synth', messageId, error: '', index: 0, total: 0 })

        const plan = await post('/read/plan', {
          text: text,
          voice: config.ttsVoice,
          speed: config.ttsSpeed,
          maxChars: config.readMaxChars,
        }, { signal: abort?.signal })
        if (generation !== this.seq) return
        if (!plan || !plan.ok) {
          this.abort = null
          this.state.set({ phase: 'error', messageId, error: (plan && plan.hint) || '朗读准备失败，请稍后重试。', index: 0, total: 0 })
          return
        }

        const segments = Array.isArray(plan.segments) ? plan.segments.filter((x) => x && typeof x.text === 'string') : []
        if (!segments.length) {
          this.abort = null
          this.state.set({ phase: 'error', messageId, error: '这条消息没有可朗读的文字。', index: 0, total: 0 })
          return
        }
        const totalSegments = segments.length
        const prompt = plan.truncated ? '（内容过长，仅朗读了前一部分）' : ''

        // 每段只请求一次；任务表让「预取」和「正在播的下一段」复用同一个请求。
        const task = new Map()
        const requestSegment = (i) => {
          if (!task.has(i)) {
            task.set(i, post('/read/segment', {
              index: Number.isInteger(segments[i].index) ? segments[i].index : i,
              total: totalSegments,
              text: segments[i].text,
              ...(plan.voice ? { voice: plan.voice } : {}),
              ...(plan.speed ? { speed: plan.speed } : {}),
            }, { signal: abort?.signal }))
          }
          return task.get(i)
        }

        // 第 1 段和第 2 段一起发出去：第 1 段一到就播，第 2 段在后台合成。
        // 第 1 段回来之前保持「合成中」转圈；回来后才切到「播放中 1/N」。
        void requestSegment(0)
        if (totalSegments > 1) void requestSegment(1)

        for (let i = 0; i < totalSegments; i++) {
          if (generation !== this.seq) return
          const r = await requestSegment(i)
          if (generation !== this.seq) return
          if (!r || !r.ok) {
            try { abort?.abort() } catch { /* 已经结束 */ }
            this.abort = null
            this.state.set({
              phase: 'error',
              messageId,
              error: (r && r.hint) || '朗读中断，请重试。',
              index: 0,
              total: 0,
            })
            return
          }
          this.state.set((prev) => ({ ...prev, phase: 'playing', error: '', hint: prompt, index: i + 1, total: totalSegments }))
          // 播放当前段之前先把下一段请求发出去，利用播放时间做预取。
          if (i + 1 < totalSegments) void requestSegment(i + 1)
          const error = await this.playOneSegment({ wavPath: r.wavPath }, generation)
          if (generation !== this.seq) return
          if (error) {
            try { abort?.abort() } catch { /* 已经结束 */ }
            this.abort = null
            this.state.set((prev) => ({ ...prev, phase: 'error', error: error, index: 0, total: 0 }))
            return
          }
        }
        if (generation === this.seq) {
          this.abort = null
          this.state.set({ phase: 'idle', messageId: '', error: '', hint: prompt, index: 0, total: 0 })
        }
      },

      playOneSegment(item, generation) {
        return new Promise((resolve) => {
          const audio = new Audio(audioUrl(item.wavPath))
          this.audio = audio
          let finish = false
          let check = null
          const collectTail = (error) => {
            if (finish) return
            finish = true
            if (check) { clearInterval(check); check = null }
            if (this.audio === audio) this.audio = null
            try { audio.pause() } catch { /* 忽略 */ }
            resolve(error)
          }
          audio.onended = () => collectTail('')
          audio.onerror = () => collectTail('音频无法播放，请再点一次朗读。')
          try {
            audio.play().then(() => { /* 开始播了 */ }).catch(() => {
              collectTail('浏览器阻止了自动播放，请再点一次朗读。')
            })
          } catch {
            collectTail('无法播放这段音频。')
          }
          // 播放器被 stop() 强行换掉时，别让 Promise 永远挂着。
          check = setInterval(() => {
            if (generation !== this.seq) collectTail('')
          }, 300)
        })
      },
    }

    // ---------------- 从聊天快照里取消息文字 ----------------

    function fetchRoundKeys(snapshot, turn) {
      try {
        const keys = snapshot && snapshot.locations && snapshot.locations.getTurn ? snapshot.locations.getTurn(turn) : null
        return Array.isArray(keys) ? keys : []
      } catch {
        return []
      }
    }

    function fetchNode(snapshot, key) {
      try {
        return snapshot && snapshot.nodes && snapshot.nodes.get ? snapshot.nodes.get(key) : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 在 Chat 快照里找「最终节点 messageId 等于本条消息」的轮次。
     * 消息定稿后轮次不会变，所以按 messageId 缓存轮次号；否则每条消息每次快照
     * 都扫全部轮次，长会话里会拖慢流式渲染。
     */
    const messageRoundCache = new Map()

    function findMessageRound(snapshot, messageId) {
      if (!snapshot || !messageId) return null
      const round = snapshot.timeline && Array.isArray(snapshot.timeline.turnOrder) ? snapshot.timeline.turnOrder : []
      const cache = messageRoundCache.get(messageId)
      // 先试缓存轮次；命中就只扫一轮。缓存失效（切会话/重建）时再扫全部。
      const candidate = cache !== undefined && round.includes(cache) ? [cache] : []
      for (const turn of candidate) {
        const keys = fetchRoundKeys(snapshot, turn)
        for (const key of keys) {
          const node = fetchNode(snapshot, key)
          if (!node || node.kind !== 'turn-tail') continue
          const final = node.data && node.data.closing && node.data.closing.finalNode
          if (final && final.messageId === messageId) {
            return {
              turn,
              keys,
              isLast: round[round.length - 1] === turn,
              chunks: Array.isArray(node.data.closing.blocks) ? node.data.closing.blocks : [],
            }
          }
        }
      }
      for (const turn of round) {
        if (candidate.length && turn === candidate[0]) continue
        const keys = fetchRoundKeys(snapshot, turn)
        for (const key of keys) {
          const node = fetchNode(snapshot, key)
          if (!node || node.kind !== 'turn-tail') continue
          const final = node.data && node.data.closing && node.data.closing.finalNode
          if (final && final.messageId === messageId) {
            messageRoundCache.set(messageId, turn)
            return {
              turn,
              keys,
              isLast: round[round.length - 1] === turn,
              chunks: Array.isArray(node.data.closing.blocks) ? node.data.closing.blocks : [],
            }
          }
        }
      }
      return null
    }

    function messagePosition(snapshot, messageId) {
      const hit = findMessageRound(snapshot, messageId)
      if (!hit) return ''
      return `${hit.turn}|${hit.isLast ? 1 : 0}`
    }

    function messageText(snapshot, messageId) {
      const hit = findMessageRound(snapshot, messageId)
      if (!hit) return ''
      // 只读「这一轮最终回复」的文本块（closing.blocks）；工具调用 / 思考 / 中间步骤都不读。
      const segment = []
      for (const chunk of hit.chunks) {
        if (chunk && chunk.kind === 'text' && typeof chunk.text === 'string') segment.push(chunk.text)
      }
      return segment.join('\n\n').trim()
    }

    /** 兜底：快照取不到时，从按钮所在的 DOM 行往上找最近的助手消息行。 */
    function domFetchText(element) {
      try {
        if (!element || typeof element.closest !== 'function') return ''
        const line = element.closest('[data-chat-flow-key]') || element.closest('[data-chat-anchor-key]')
        if (!line || !line.parentElement) return ''
        const list = line.parentElement
        let target = null
        for (let front = line.previousElementSibling; front; front = front.previousElementSibling) {
          if (front.getAttribute && front.getAttribute('data-chat-flow-kind') === 'assistant-step') { target = front; break }
        }
        if (!target) {
          const all = list.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
          target = all.length ? all[all.length - 1] : null
        }
        if (!target) return ''
        const text = String(target.innerText || '').trim()
        return text
      } catch {
        return ''
      }
    }

    // ---------------- 图标 + 样式 ----------------

    function iconSpeak(size = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, fill: 'none' },
        h('path', { d: 'M2.6 6.1h2.1L7.6 3.4v9.2L4.7 9.9H2.6z', fill: 'currentColor' }),
        h('path', { d: 'M10.1 5.4a3.4 3.4 0 0 1 0 5.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { d: 'M11.9 3.7a5.6 5.6 0 0 1 0 8.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    function iconPause(size = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 3.4, y: 2.8, width: 3.2, height: 10.4, rx: 1 }),
        h('rect', { x: 9.4, y: 2.8, width: 3.2, height: 10.4, rx: 1 }))
    }

    function iconSpinner(size = 15) {
      return h('svg', { className: 'fish-spin', viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, fill: 'none' },
        h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.25 }),
        h('path', { d: 'M8 2a6 6 0 0 1 6 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    function iconMic(size = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, fill: 'none' },
        h('rect', { x: 5.6, y: 1.8, width: 4.8, height: 8, rx: 2.4, fill: 'currentColor' }),
        h('path', { d: 'M3.6 7.6a4.4 4.4 0 0 0 8.8 0', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M8 12v2.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    function iconImage(size = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, fill: 'none' },
        h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 5.7, cy: 6.6, r: 1.15, fill: 'currentColor' }),
        h('path', { d: 'M2.6 12.2l3.1-3.1 2.1 2.1 1.9-1.7 3.7 3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', strokeLinecap: 'round' }))
    }

    function iconStop(size = 14) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 2.4 }))
    }

    const styleText = `
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
    let styleBorrow = 0
    function injectStyle() {
      try {
        if (typeof document === 'undefined') return () => {}
        let node = document.querySelector('style[data-fish-service="p2"]')
        const create = !node
        if (!node) {
          node = document.createElement('style')
          node.dataset.fishService = 'p2'
          node.textContent = styleText
          document.head.appendChild(node)
        }
        styleBorrow += 1
        return () => {
          styleBorrow = Math.max(0, styleBorrow - 1)
          if (create && styleBorrow === 0) {
            try { node.remove() } catch { /* 已从文档移除 */ }
          }
        }
      } catch {
        // 注入失败只影响外观，不影响功能。
        return () => {}
      }
    }

    // ---------------- 朗读按钮 ----------------

    const autoReadDone = new Set()
    // 每个会话「第一次看到时的最后一轮」：只有比它更新的回复才会自动朗读，
    // 这样打开旧会话 / 切回旧会话都不会把历史消息念一遍。
    const sessionInitialLastRound = new Map()

    function lastRound(snapshot) {
      try {
        const round = snapshot && snapshot.timeline && Array.isArray(snapshot.timeline.turnOrder) ? snapshot.timeline.turnOrder : []
        return round.length ? round[round.length - 1] : -1
      } catch {
        return -1
      }
    }

    /** props.useChat 缺失时的占位选择器：仍然按 hook 调用，保证 hook 数量稳定。 */
    function emptySelector() {
      const [empty] = React.useState('')
      return empty
    }

    function readButton(props) {
      const { messageId } = props || {}
      const playState = useStore(play.state)
      const prefsState = useStore(prefs)
      const button = React.useRef(null)
      const mountedLoaded = React.useRef(Boolean(prefs.get().load))

      // 槽位标准 props：useChat 一定有；真没有时退化成空选择器（不读快照，只走 DOM 兜底）。
      const useChat = typeof props?.useChat === 'function' ? props.useChat : emptySelector

      const text = useChat((snapshot) => messageText(snapshot, messageId))
      const position = useChat((snapshot) => messagePosition(snapshot, messageId))
      const lastTurn = useChat((snapshot) => lastRound(snapshot))
      const sessionKey = String(props?.sessionId || '')

      React.useEffect(() => {
        // 本轮所有消息按钮挂载时记录一次；之后新到的回复轮次会更大。
        if (!sessionInitialLastRound.has(sessionKey)) sessionInitialLastRound.set(sessionKey, lastTurn)
      }, [lastTurn, sessionKey])

      React.useEffect(() => {
        keepAlive(true)
        if (!prefs.get().load) void loadPrefs()
        return () => keepAlive(false)
      }, [])

      const ongoingThis = playState.messageId === messageId && (playState.phase === 'synth' || playState.phase === 'playing')
      const synthesizing = ongoingThis && playState.phase === 'synth'
      const playing = ongoingThis && playState.phase === 'playing'
      const autoRead = readAutoReadSessions(prefsState.config, sessionKey)
      const backgroundRead = readBackgroundAutoRead(prefsState.config)
      const globalAutoReadOn = uiSwitchOn(prefsState.config, 'autoRead')

      const fetchText = () => text || domFetchText(button.current)

      const tap = async () => {
        if (ongoingThis) {
          play.stop()
          return
        }
        const sourceText = fetchText()
        if (!sourceText) {
          play.state.set({ phase: 'error', messageId, error: '这条消息没有可朗读的文字。', index: 0, total: 0 })
          return
        }
        await play.synthesizeAndPlay(messageId, sourceText, prefs.get().config || {})
      }

      // 自动朗读：按当前会话的设置判断（未单独设置时回落到全局默认）；
      // 只在「偏好已加载 + 这条是最后一轮」时触发一次。窗口在后台时，
      // 是否朗读由「后台也自动朗读」决定（默认开）。
      React.useEffect(() => {
        if (!mountedLoaded.current) return
        if (!prefsState.load || !autoRead || !globalAutoReadOn) return
        if (!text || !position) return
        const [roundText, last] = String(position).split('|')
        if (last !== '1') return
        const round = Number(roundText)
        const initial = sessionInitialLastRound.get(sessionKey)
        if (Number.isFinite(round) && Number.isFinite(initial) && round <= initial) return
        if (autoReadDone.has(messageId)) return
        const pageVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
        if (!shouldAutoRead(prefsState.config, sessionKey, pageVisible)) return
        autoReadDone.add(messageId)
        void play.synthesizeAndPlay(messageId, text, prefs.get().config || {})
      }, [text, position, prefsState.load, autoRead, backgroundRead, globalAutoReadOn, messageId, sessionKey])

      const title = synthesizing ? '正在准备朗读，再点一次可取消'
        : playing ? '停止朗读'
          : prefsState.online === false ? '朗读这条回复（本地 AI 未启动）'
            : '朗读这条回复'

      const error = playState.messageId === messageId && playState.phase === 'error' ? playState.error : ''
      const prompt = playState.messageId === messageId && playState.hint && playState.phase !== 'error' ? playState.hint : ''

      return h(React.Fragment, null,
        h('button', {
          ref: button,
          type: 'button',
          className: 'fish-iconbtn',
          'data-on': playing ? '1' : undefined,
          title: title,
          'aria-label': title,
          'aria-busy': synthesizing ? 'true' : undefined,
          onClick: tap,
        },
          synthesizing ? iconSpinner() : playing ? iconPause() : iconSpeak(),
          playing && playState.total > 1 ? h('span', { style: { fontSize: 11 } }, `${playState.index}/${playState.total}`) : null),
        error ? h('span', { className: 'fish-err', role: 'status', style: { marginLeft: 6 } }, error) : null,
        prompt ? h('span', { className: 'fish-panel-dim', role: 'status', style: { marginLeft: 6 } }, prompt) : null)
    }

    // ---------------- 框选文字：朗读 / 翻译 ----------------

    const selectedInteractionID = 'fish-selection'
    const selectedPlayId = 'fish-selection'

    function selectedToolbar({ readText, dismiss, clearSelection }) {
      const prefsState = useStore(prefs)
      const online = prefsState.online !== false
      const [panel, setPanel] = React.useState(null)
      const container = React.useRef(null)

      const fetchText = () => {
        const text = typeof readText === 'function' ? readText() : ''
        return String(text == null ? '' : text).trim()
      }
      const collapse = () => {
        try { clearSelection?.() } catch { /* 选区已经没了 */ }
        try { dismiss?.() } catch { /* 工具条已经关了 */ }
      }

      // 点外面 / Esc 关闭；点工具条内部不触发，避免选区和复制被打断。
      React.useEffect(() => {
        const tapOutside = (event) => {
          if (container.current && event.target instanceof Node && container.current.contains(event.target)) return
          try { dismiss?.() } catch { /* 忽略 */ }
        }
        const onEscape = (event) => {
          if (event.key !== 'Escape') return
          try { dismiss?.() } catch { /* 忽略 */ }
        }
        document.addEventListener('pointerdown', tapOutside, true)
        document.addEventListener('keydown', onEscape, true)
        return () => {
          document.removeEventListener('pointerdown', tapOutside, true)
          document.removeEventListener('keydown', onEscape, true)
        }
      }, [dismiss])

      const read = () => {
        const text = fetchText()
        if (!text) return
        void play.synthesizeAndPlay(selectedPlayId, text, prefs.get().config || {})
        collapse()
      }

      const translation = async (original) => {
        const text = String(original || fetchText()).trim()
        if (!text) return
        setPanel({ original: text, loading: true, error: '', translated: '', copied: false })
        const result = await post('/translate', { text: text })
        if (!result || !result.ok) {
          setPanel({
            original: text,
            loading: false,
            error: (result && result.hint) || '翻译失败，请稍后重试。',
            translated: '',
            copied: false,
          })
          return
        }
        setPanel({ original: text, loading: false, error: '', translated: String(result.text || ''), copied: false })
      }

      const copy = async () => {
        if (!panel?.translated) return
        try {
          await navigator.clipboard.writeText(panel.translated)
          setPanel((prev) => (prev ? { ...prev, copied: true, error: '' } : prev))
        } catch {
          setPanel((prev) => (prev ? { ...prev, error: '复制失败，请手动选中译文复制。' } : prev))
        }
      }

      return h('div', {
        ref: container,
        className: 'fish-selbar',
        role: 'toolbar',
        'aria-label': '选中文字操作',
        // 保住当前选区：点按钮时不把选区换成按钮上的文字。
        onPointerDown: (event) => event.preventDefault(),
      },
        h('button', {
          type: 'button',
          disabled: !online,
          title: online ? '朗读选中的文字' : '本地 AI 未启动',
          onClick: read,
        }, '朗读'),
        h('button', {
          type: 'button',
          disabled: !online || Boolean(panel?.loading),
          title: online ? '翻译选中的文字' : '本地 AI 未启动',
          onClick: () => void translation(),
        }, '翻译'),
        !online ? h('span', { className: 'fish-selnote' }, '本地 AI 未启动') : null,
        panel
          ? h('div', { className: 'fish-selpanel' },
              panel.loading ? h('div', { className: 'fish-panel-dim', role: 'status' }, '翻译中…') : null,
              panel.error ? h('div', { className: 'fish-err', role: 'status' }, panel.error) : null,
              panel.translated ? h('div', { className: 'fish-seltext', role: 'status' }, panel.translated) : null,
              h('div', { className: 'fish-selrow' },
                !panel.loading && panel.error
                  ? h('button', { type: 'button', onClick: () => void translation(panel.original) }, '重试')
                  : null,
                panel.translated ? h('button', { type: 'button', onClick: copy }, panel.copied ? '已复制' : '复制') : null,
                h('button', { type: 'button', onClick: () => setPanel(null) }, '关闭')))
          : null)
    }

    // ---------------- 输入设备（纯函数，便于单测） ----------------

    /** 录音约束：空标识 = 跟随系统默认；非空则精确指定该设备。 */
    function buildRecordingConstraint(deviceId) {
      const deviceKey = typeof deviceId === 'string' ? deviceId.trim() : ''
      const audio = { echoCancellation: true, noiseSuppression: true }
      if (deviceKey) audio.deviceId = { exact: deviceKey }
      return { audio: audio }
    }

    /** 设备被拔掉、改名或约束不满足时，浏览器报这几个错误。 */
    function deviceUnavailableError(error) {
      const name = String(error?.name || '')
      return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError'
    }

    /**
     * 打开麦克风；指定了设备但设备不可用时自动回退到系统默认。
     * getUserMedia 由调用方注入，便于单测模拟浏览器行为。
     * 返回 { stream, fellBack }。
     */
    async function openMic(deviceId, getUserMedia) {
      const selected = typeof deviceId === 'string' ? deviceId.trim() : ''
      const request = typeof getUserMedia === 'function'
        ? getUserMedia
        : (constraint) => navigator.mediaDevices.getUserMedia(constraint)
      try {
        return { stream: await request(buildRecordingConstraint(selected)), fellBack: false }
      } catch (error) {
        if (!selected || !deviceUnavailableError(error)) throw error
        return { stream: await request(buildRecordingConstraint('')), fellBack: true }
      }
    }

    /** 设备名像虚拟声卡/采集卡时，提醒用户改选真实麦克风。 */
    const virtualDeviceTrait = /stream|virtual|cable|voicemeeter|vb-audio|loopback|stereo\s*mix|立体声混音/i

    function isVirtualDeviceName(label) {
      return typeof label === 'string' && virtualDeviceTrait.test(label)
    }

    function virtualDevicePrompt(label) {
      return isVirtualDeviceName(label)
        ? '当前输入设备可能是虚拟设备，请在设置里改选真实麦克风。'
        : ''
    }

    function padDevicePrompt(text, label) {
      const prompt = virtualDevicePrompt(label)
      return prompt ? `${text} ${prompt}` : text
    }

    // 输入设备列表与最近一次录音实际使用的设备（只在本次页面会话里，不持久化）。
    const device = makeStore({
      list: [],
      recentLabel: '',
      recentId: '',
      enumerating: false,
      prompt: '',
    })

    async function existingMicPermission() {
      try {
        if (!navigator.permissions?.query) return false
        const status = await navigator.permissions.query({ name: 'microphone' })
        return status.state === 'granted'
      } catch {
        return false
      }
    }

    /** 先申请权限（已有权限就直接枚举），再列出音频输入设备。 */
    async function refreshDeviceList() {
      if (device.get().enumerating) return
      device.set((prev) => ({ ...prev, enumerating: true, prompt: '' }))
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
          device.set((prev) => ({ ...prev, enumerating: false, prompt: '当前浏览器不支持选择麦克风。' }))
          return
        }
        if (!(await existingMicPermission())) {
          let stream
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch {
            device.set((prev) => ({ ...prev, list: [], enumerating: false, prompt: '未获得麦克风权限，无法列出设备。' }))
            return
          }
          try { stream?.getTracks?.().forEach((track) => track.stop()) } catch { /* 忽略 */ }
        }
        let all = []
        try { all = await navigator.mediaDevices.enumerateDevices() } catch { all = [] }
        const list = []
        for (const item of Array.isArray(all) ? all : []) {
          if (!item || item.kind !== 'audioinput') continue
          const id = String(item.deviceId || '')
          if (!id) continue
          const label = String(item.label || '').trim() || `麦克风 ${list.length + 1}`
          list.push({ deviceId: id, label: label })
        }
        if (!list.length) {
          device.set((prev) => ({ ...prev, list: [], enumerating: false, prompt: '未获得麦克风权限，无法列出设备。' }))
          return
        }
        device.set((prev) => ({ ...prev, list, enumerating: false, prompt: '' }))
      } catch {
        device.set((prev) => ({ ...prev, enumerating: false, prompt: '未获得麦克风权限，无法列出设备。' }))
      }
    }

    // ---------------- 录音器（MediaRecorder 优先，退化到 PCM/WAV） ----------------

    function haltStream(stream) {
      try { stream?.getTracks?.().forEach((track) => track.stop()) } catch { /* 忽略 */ }
    }

    function makeLevel(stream) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) throw new Error('no audio context')
        const context = new Ctx()
        try { void context.resume?.() } catch { /* 有些浏览器不需要/不允许 */ }
        const source = context.createMediaStreamSource(stream)
        const analyze = context.createAnalyser()
        analyze.fftSize = 256
        source.connect(analyze)
        const buffer = new Uint8Array(analyze.frequencyBinCount)
        return {
          readOut() {
            try {
              analyze.getByteTimeDomainData(buffer)
              let peak = 0
              for (const v of buffer) {
                const d = Math.abs(v - 128) / 128
                if (d > peak) peak = d
              }
              return Math.min(1, peak * 2.2)
            } catch { return 0 }
          },
          close() {
            try { source.disconnect(); analyze.disconnect(); context.close() } catch { /* 忽略 */ }
          },
        }
      } catch {
        return { readOut: () => 0, close() {} }
      }
    }

    function useMediaRecorder(stream, mime) {
      const record = new MediaRecorder(stream, { mimeType: mime })
      const chunk = []
      record.ondataavailable = (event) => { if (event.data && event.data.size) chunk.push(event.data) }
      const level = makeLevel(stream)
      record.start(250)
      let stop = false
      return {
        mime,
        readOutLevel: () => level.readOut(),
        async stop() {
          if (!stop) {
            stop = true
            await new Promise((resolve) => {
              record.onstop = resolve
              try { record.stop() } catch { resolve() }
            })
          }
          level.close()
          haltStream(stream)
          return { blob: new Blob(chunk, { type: mime }), mime }
        },
        cancel() {
          try { stop = true; record.stop() } catch { /* 忽略 */ }
          level.close()
          haltStream(stream)
        },
      }
    }

    function encodeWAV(sample, sampleRate) {
      const dataLen = sample.length
      const buffer = new ArrayBuffer(44 + dataLen * 2)
      const view = new DataView(buffer)
      const writeText = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
      writeText(0, 'RIFF')
      view.setUint32(4, 36 + dataLen * 2, true)
      writeText(8, 'WAVE')
      writeText(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeText(36, 'data')
      view.setUint32(40, dataLen * 2, true)
      let offset = 44
      for (let i = 0; i < dataLen; i++) {
        const s = Math.max(-1, Math.min(1, sample[i]))
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        offset += 2
      }
      return new Uint8Array(buffer)
    }

    function useWAV(stream) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return Promise.reject(new Error('浏览器不支持 WebAudio 录音'))
      const context = new Ctx()
      try { void context.resume?.() } catch { /* 忽略 */ }
      const source = context.createMediaStreamSource(stream)
      const node = context.createScriptProcessor(4096, 1, 1)
      const chunk = []
      let peak = 0
      node.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0)
        chunk.push(new Float32Array(data))
        let currentFrame = 0
        for (let i = 0; i < data.length; i++) {
          const d = Math.abs(data[i])
          if (d > currentFrame) currentFrame = d
        }
        peak = Math.max(peak, currentFrame)
      }
      source.connect(node)
      node.connect(context.destination)
      const sampleRate = context.sampleRate
      let stop = false
      const collectTail = () => {
        try { node.disconnect(); source.disconnect(); context.close() } catch { /* 忽略 */ }
        haltStream(stream)
      }
      return Promise.resolve({
        mime: 'audio/wav',
        readOutLevel: () => { const v = peak; peak = 0; return Math.min(1, v * 2.2) },
        async stop() {
          if (!stop) { stop = true; collectTail() }
          const totalLength = chunk.reduce((and, x) => and + x.length, 0)
          const merge = new Float32Array(totalLength)
          let offset = 0
          for (const x of chunk) { merge.set(x, offset); offset += x.length }
          return { blob: new Blob([encodeWAV(merge, sampleRate)], { type: 'audio/wav' }), mime: 'audio/wav' }
        },
        cancel() {
          if (!stop) { stop = true; collectTail() }
        },
      })
    }

    async function createRecorder(stream, format) {
      const prefsMime = format === 'webm' ? 'audio/webm;codecs=opus' : null
      const candidate = prefsMime ? [prefsMime] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      if (format !== 'wav' && typeof window.MediaRecorder === 'function') {
        const mime = candidate.find((x) => {
          try { return window.MediaRecorder.isTypeSupported(x) } catch { return false }
        })
        if (mime) return useMediaRecorder(stream, mime)
      }
      return useWAV(stream)
    }

    // ---------------- 语音输入状态机 ----------------

    const speech = {
      state: makeStore({
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
      recorder: null,
      timer: null,
      closeTimer: null,
      fragment: null,
      insertIndex: null,
      // 录音有异步步骤（要等用户点「允许麦克风」）；取消/关闭时递增它，
      // 晚到的 getUserMedia 结果发现代号变了就自己收掉，不会在关掉面板后又开始录。
      generation: 0,
    }

    const choiceKey = 'dsh-fish-service.voice-choice'

    function rememberedChoice() {
      try {
        const v = window.localStorage.getItem(choiceKey)
        return ['text', 'audio', 'cancel'].includes(v) ? v : ''
      } catch { return '' }
    }

    function rememberChoice(select) {
      if (prefs.get().config.rememberVoiceChoice === false) return
      try { window.localStorage.setItem(choiceKey, select) } catch { /* 无痕模式 */ }
    }

    function micError(error) {
      const name = String(error?.name || '')
      if (name === 'NotAllowedError' || name === 'SecurityError') return '未获得麦克风权限，请允许浏览器使用麦克风后重试。'
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '未找到麦克风，请连接麦克风后重试。'
      if (name === 'NotReadableError') return '麦克风正被其他程序占用，请关闭会议或录音软件后重试。'
      if (name === 'OverconstrainedError') return '麦克风不支持当前的录音设置，请改用系统默认设备后重试。'
      return '无法打开麦克风，请检查设备后重试。'
    }

    function cleanupRecording() {
      if (speech.timer) { clearInterval(speech.timer); speech.timer = null }
      if (speech.recorder) {
        try { speech.recorder.cancel?.() } catch { /* 忽略 */ }
        speech.recorder = null
      }
    }

    function scheduleClose(ms = 6000) {
      if (speech.closeTimer) clearTimeout(speech.closeTimer)
      speech.closeTimer = setTimeout(() => {
        speech.closeTimer = null
        closeSpeechPanel()
      }, ms)
    }

    // 录音上限：计时器到 300 秒就自动停，stop() 收尾还会多出几十毫秒。
    // 略超上限是正常的，按上限截断；只有明显超出（用户拿着录音没停）才判超限。
    const recordLimitMs = 5 * 60 * 1000
    const recordingLimitToleranceMs = 3000
    function clampRecordingDuration(duration, limit = recordLimitMs, tolerance = recordingLimitToleranceMs) {
      const value = Math.max(0, Number(duration) || 0)
      if (value > limit + tolerance) return { ok: false, durationMs: value, capped: false }
      return { ok: true, durationMs: Math.min(value, limit), capped: value >= limit }
    }

    async function startRecording(props) {
      // 语音识别总开关关掉时录音功能不可用（按钮已隐藏，这里再兜一次）。
      if (!uiSwitchOn(prefs.get().config, 'speechRecognition')) return
      const current = speech.state.get().phase
      if (current !== 'idle' && current !== 'error') return
      if (speech.closeTimer) { clearTimeout(speech.closeTimer); speech.closeTimer = null }
      cleanupRecording()
      const generation = ++speech.generation
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '当前浏览器不支持录音，请换用其他浏览器后重试。' }))
        scheduleClose()
        return
      }
      const config = prefs.get().config || {}
      const insertIndex = (() => {
        try { return props?.inputActions?.captureInsertion?.() ?? null } catch { return null }
      })()
      speech.insertIndex = insertIndex
      speech.state.set({
        ...speech.state.get(),
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
      speech.fragment = null
      let stream
      let revertDefault = false
      try {
        const open = await openMic(config.recordDeviceId || '')
        stream = open.stream
        revertDefault = open.fellBack === true
      } catch (error) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: micError(error) }))
        scheduleClose(8000)
        return
      }
      if (generation !== speech.generation) {
        haltStream(stream)
        return
      }
      let micName = ''
      let micId = ''
      try {
        const track = stream.getAudioTracks?.()[0]
        micName = String(track?.label || '')
        micId = String(track?.getSettings?.()?.deviceId || '')
      } catch { micName = ''; micId = '' }
      speech.state.set((prevPos) => ({
        ...prevPos,
        micLabel: micName,
        hint: revertDefault ? '所选麦克风不可用，已改用系统默认设备。' : '',
      }))
      device.set((prevPos) => ({
        ...prevPos,
        recentLabel: micName || prevPos.recentLabel,
        recentId: micId || prevPos.recentId,
      }))
      try {
        const recorder = await createRecorder(stream, config.recordMime || 'auto')
        if (generation !== speech.generation) {
          recorder.cancel?.()
          haltStream(stream)
          return
        }
        speech.recorder = recorder
        const begin = Date.now()
        speech.state.set((prev) => ({ ...prev, phase: 'recording', startedAt: begin, mime: recorder.mime }))
        speech.timer = setInterval(() => {
          const seconds = Math.floor((Date.now() - begin) / 1000)
          const levelValue = recorder.readOutLevel()
        speech.state.set((prev) => (prev.phase === 'recording'
          ? { ...prev, seconds: seconds, level: levelValue, peak: Math.max(prev.peak || 0, levelValue) }
          : prev))
          if (seconds >= 300) void stopRecording()
        }, 200)
      } catch {
        cleanupRecording()
        haltStream(stream)
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '录音启动失败，请检查麦克风后重试。' }))
        scheduleClose(8000)
      }
    }

    async function stopRecording() {
      const state = speech.state.get()
      if (state.phase !== 'recording' || !speech.recorder) return
      const generation = speech.generation
      if (speech.timer) { clearInterval(speech.timer); speech.timer = null }
      const recorder = speech.recorder
      speech.recorder = null
      let result
      try {
        result = await recorder.stop()
      } catch {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '结束录音失败，请重试。' }))
        scheduleClose(8000)
        return
      }
      // 等待 MediaRecorder 收尾期间用户可能已经取消/关了面板。
      if (generation !== speech.generation) return
      const clamp = clampRecordingDuration(Date.now() - Number(state.startedAt || Date.now()))
      if (!clamp.ok) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '录音超过 5 分钟已停止，请分段录制。' }))
        scheduleClose(8000)
        return
      }
      const duration = clamp.durationMs
      const size = result.blob.size
      if (size > 25 * 1024 * 1024) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '录音超过 25MB 已停止，请缩短录音时长。' }))
        scheduleClose(8000)
        return
      }
      if (size < 600) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '没有录到声音（录音过短），请点「重新录」重试。' }))
        scheduleClose(8000)
        return
      }
      if (!result.blob || result.blob.size < 1500) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '没有采集到声音，请检查麦克风是否可用后重试。' }))
        return
      }
      if (duration < 300) {
        speech.state.set((prev) => ({ ...prev, phase: 'error', error: '录音太短，请多说几秒再停止。' }))
        return
      }
      // 峰值一直贴着 0：麦克风多半被静音 / 选成了虚拟设备 / 系统输入源不对。
      if ((state.peak || 0) < 0.008) {
        speech.state.set((prev) => ({
          ...prev,
          phase: 'error',
          error: padDevicePrompt(`没有检测到声音${state.micLabel ? `（当前麦克风：${state.micLabel}）` : ''}。请检查系统声音设置里的输入设备是否被静音，或改为默认麦克风后重试。`, state.micLabel),
        }))
        scheduleClose(10000)
        return
      }
      speech.fragment = { blob: result.blob, mime: result.mime, durationMs: duration }
      speech.state.set((prev) => ({
        ...prev,
        phase: 'choose',
        durationMs: duration,
        bytes: size,
        mime: result.mime,
        choice: prefs.get().config.rememberVoiceChoice === false ? '' : rememberedChoice(),
        error: '',
        hint: '',
      }))
    }

    function cancelRecording() {
      speech.generation += 1
      cleanupRecording()
      speech.fragment = null
      speech.insertIndex = null
      if (speech.closeTimer) { clearTimeout(speech.closeTimer); speech.closeTimer = null }
      speech.state.set({ ...speech.state.get(), phase: 'idle', seconds: 0, level: 0, hint: '', error: '', text: '', pendingText: '', path: '' })
    }

    function closeSpeechPanel() {
      speech.generation += 1
      cleanupRecording()
      speech.fragment = null
      speech.insertIndex = null
      if (speech.closeTimer) { clearTimeout(speech.closeTimer); speech.closeTimer = null }
      speech.state.set({ ...speech.state.get(), phase: 'idle', seconds: 0, level: 0, hint: '', error: '', text: '', pendingText: '', path: '' })
    }

    /** 往输入框插文字：先按录音开始时的光标，再按当前光标；都不行就复制到剪贴板。 */
    function insertText(inputActions, text) {
      const value = String(text == null ? '' : text)
      if (!value) return false
      const attempt = (pos) => {
        try { return inputActions?.insertText?.(value, pos) === true } catch { return false }
      }
      if (attempt(speech.insertIndex)) return true
      let current = null
      try { current = inputActions?.captureInsertion?.() ?? null } catch { current = null }
      if (attempt(current)) return true
      try { navigator.clipboard?.writeText?.(value) } catch { /* 剪贴板也可能被拒 */ }
      return false
    }

    /** 语音文件附件名：语音-YYYYMMDD-HHMMSS.webm（给人看的、可读的）。 */
    function speechAttachmentName(time, mime) {
      const pad2 = (count) => String(count).padStart(2, '0')
      const timestamp = new Date(time || Date.now())
      const date = `${timestamp.getFullYear()}${pad2(timestamp.getMonth() + 1)}${pad2(timestamp.getDate())}`
      const clock = `${pad2(timestamp.getHours())}${pad2(timestamp.getMinutes())}${pad2(timestamp.getSeconds())}`
      return `语音-${date}-${clock}${speechExt(mime)}`
    }

    // 浏览器侧的内核会话服务；apply 时拿到上下文后才能解析。
    let pluginContext = null

    /** 取会话作用域里的 conversation 服务（内核的草稿附件都挂在这里）。 */
    function fetchSessionConversation(sessionId, context = pluginContext) {
      try {
        const session = context?.get?.('sessions')
        if (session && typeof session.scope === 'function' && sessionId) {
          const scope = session.scope(String(sessionId))
          const conversation = scope?.get?.('conversation')
          if (conversation) return conversation
        }
      } catch { /* 不同版本的内核可能没有 sessions */ }
      try { return context?.get?.('conversation') ?? null } catch { return null }
    }

    /**
     * 把录音作为「文件」挂到输入框草稿里（内核 ComposerAttachments 支持 file 卡片）。
     * 成功返回 true；任何一步不成立都返回 false，调用方退回「插入路径文字」。
     */
    function attachSpeechAttachment(inputActions, sessionId, blob, mime, fileName, context = pluginContext) {
      try {
        if (!blob || typeof File !== 'function') return false
        if (!inputActions || typeof inputActions.addAttachments !== 'function') return false
        const conversation = fetchSessionConversation(sessionId, context)
        if (!conversation || typeof conversation.createDrafts !== 'function') return false
        const file = new File([blob], fileName || speechAttachmentName(Date.now(), mime), { type: mime || 'audio/webm' })
        const drafts = conversation.createDrafts(String(sessionId), [file], true)
        const ids = Array.isArray(drafts) ? drafts.map((item) => item && item.id).filter(Boolean) : []
        if (ids.length === 0) return false
        return inputActions.addAttachments(ids) === true
      } catch (error) {
        try { console.warn('[dsh-fish-service] 语音附件失败', error) } catch { /* 忽略 */ }
        return false
      }
    }

    function speechExt(mime) {
      const type = String(mime || '').toLowerCase()
      if (type.includes('wav')) return '.wav'
      if (type.includes('ogg') || type.includes('opus')) return '.ogg'
      if (type.includes('mp4') || type.includes('m4a')) return '.m4a'
      return '.webm'
    }

    async function toText(inputActions) {
      const state = speech.state.get()
      if (!speech.fragment || state.phase === 'transcribing' || state.phase === 'uploading') return
      const generation = speech.generation
      const config = prefs.get().config || {}
      speech.state.set((prev) => ({ ...prev, phase: 'transcribing', error: '', hint: '' }))
      const form = new FormData()
      form.append('file', speech.fragment.blob, `voice${speechExt(speech.fragment.mime)}`)
      form.append('durationMs', String(speech.fragment.durationMs || 0))
      form.append('language', config.asrLanguage || 'auto')
      const r = await postForm('/transcribe-upload', form)
      if (generation !== speech.generation) return
      if (!r || !r.ok) {
        speech.state.set((prev) => ({
          ...prev,
          phase: 'choose',
          error: padDevicePrompt((r && r.hint) || '转写失败，请稍后重试。', prev.micLabel),
        }))
        return
      }
      const text = String(r.text || '').trim()
      if (!text) {
        speech.state.set((prev) => ({
          ...prev,
          phase: 'choose',
          error: padDevicePrompt('没有识别出文字，可以重新录制。', prev.micLabel),
        }))
        return
      }
      const insertSuccess = insertText(inputActions, text)
      rememberChoice('text')
      // 文字已经在输入框里了，面板不必再弹出来。
      if (insertSuccess) {
        closeSpeechPanel()
        return
      }
      speech.fragment = null
      speech.insertIndex = null
      speech.state.set((prev) => ({
        ...prev,
        phase: 'done',
        text: text,
        pendingText: text,
        elapsedMs: Number(r.ms) || 0,
        choice: 'text',
        error: '',
        hint: `已转写 ${text.length} 字，但没能插进输入框；文字已复制到剪贴板，也可点「重试插入」。`,
      }))
      scheduleClose(12000)
    }

    async function keepSpeech(inputActions, sessionId) {
      if (!speech.fragment) return
      const generation = speech.generation
      const targetSession = String(sessionId || speech.state.get().sessionId || '')
      speech.state.set((prev) => ({ ...prev, phase: 'uploading', error: '', hint: '' }))
      const form = new FormData()
      form.append('file', speech.fragment.blob, `voice${speechExt(speech.fragment.mime)}`)
      form.append('durationMs', String(speech.fragment.durationMs || 0))
      const r = await postForm('/voice-upload', form)
      if (generation !== speech.generation) return
      if (!r || !r.ok) {
        speech.state.set((prev) => ({ ...prev, phase: 'choose', error: (r && r.hint) || '音频保存失败，请稍后重试。' }))
        return
      }
      const path = String(r.path || '')
      const fileName = speechAttachmentName(Date.now(), speech.fragment.mime)
      const attachmentSuccess = attachSpeechAttachment(inputActions, targetSession, speech.fragment.blob, speech.fragment.mime, fileName)
      const insertSuccess = attachmentSuccess ? false : insertText(inputActions, `（语音附件：${path}）\n`)
      rememberChoice('audio')
      // 附件卡片已经出现在输入框里，面板不必再弹。
      if (attachmentSuccess) {
        closeSpeechPanel()
        return
      }
      speech.insertIndex = null
      speech.state.set((prev) => ({
        ...prev,
        phase: 'done',
        path: path,
        text: '',
        pendingText: '',
        choice: 'audio',
        error: '',
        hint: insertSuccess
          ? `录音已保存在本机：${path}\n没能加到输入框附件，已把保存位置插入输入框（可删除）。`
          : `录音已保存在本机：${path}\n保存位置未能插入输入框，已复制到剪贴板。`,
      }))
      scheduleClose(12000)
    }

    // ---------------- 语音输入：麦克风按钮 ----------------

    function micButton(props) {
      const { sessionId, inputActions } = props || {}
      const state = useStore(speech.state)
      const prefsState = useStore(prefs)
      const speechOn = uiSwitchOn(prefsState.config, 'speechRecognition')

      React.useEffect(() => {
        keepAlive(true)
        if (!prefs.get().load) void loadPrefs()
        return () => keepAlive(false)
      }, [])

      // 本地识图的最后一步：按钮把「文件名 + 描述」入队，这里负责插进草稿。
      // 拦截组件不依赖 inputActions 是否透传，走模块级队列 + input.right 组件消费；
      // 插入失败沿用 插入文本 的剪贴板兜底，并回填一行提示。
      const visualTodo = useStore(visualNotice)
      React.useEffect(() => {
        if (!sessionId || !inputActions) return
        const result = consumePendingInsert(sessionId, (text) => insertText(inputActions, text))
        if (result.fail > 0) writeVisionPrompt(sessionId, '识图结果没能插入输入框，已复制到剪贴板。')
      }, [visualTodo, sessionId, inputActions])
      // 通知偶尔丢失（组件刚挂载 / 切换会话）时再兜一次底。
      React.useEffect(() => {
        if (!sessionId || !inputActions) return undefined
        const timer = setInterval(() => {
          if (!pendingInsert.length) return
          const result = consumePendingInsert(sessionId, (text) => insertText(inputActions, text))
          if (result.fail > 0) writeVisionPrompt(sessionId, '识图结果没能插入输入框，已复制到剪贴板。')
        }, 1500)
        return () => clearInterval(timer)
      }, [sessionId, inputActions])

      // 总开关关掉时立刻停掉正在进行的录音并收起面板；框选朗读/翻译不受影响。
      React.useEffect(() => {
        if (speechOn) return
        const present = speech.state.get()
        if (present.phase === 'recording') void stopRecording()
        else if (present.phase !== 'idle') cancelRecording()
        closeSpeechPanel()
      }, [speechOn])

      if (!speechOn) return null

      const thisSession = !state.sessionId || !sessionId || state.sessionId === sessionId
      const recording = thisSession && state.phase === 'recording'
      const requesting = thisSession && state.phase === 'requesting'
      const offline = prefsState.online === false

      const tap = () => {
        if (recording) { void stopRecording(); return }
        if (state.phase === 'recording') return
        if (state.phase === 'idle' || state.phase === 'error') { void startRecording({ sessionId, inputActions }); return }
        // 面板开着时再点麦克风 = 关掉面板（录音中除外，上面已处理）。
        if (!recording) closeSpeechPanel()
      }

      const title = recording ? `正在录音 ${formatTime(state.seconds)}，点击结束`
        : requesting ? '正在请求麦克风…'
          : offline ? '语音输入（本地 AI 未启动）'
            : '语音输入：点击开始录音'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          'data-rec': recording ? '1' : undefined,
          title: title,
          'aria-label': title,
          'aria-pressed': recording ? 'true' : 'false',
          // 别让点击按钮夺走编辑器焦点：captureInsertion() 要拿的是当前草稿选区。
          onMouseDown: (event) => { try { event.preventDefault() } catch { /* 忽略 */ } },
          onClick: tap,
        },
          recording ? h('span', { className: 'fish-dot' }) : requesting ? iconSpinner() : iconMic(),
          recording ? h('span', { style: { fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, formatTime(state.seconds)) : null))
    }

    // ---------------- 本地识图：输入框旁的独立按钮 ----------------
    // 点按钮选图片，在本机识别成文字后按顺序插入输入框；
    // 图片不进草稿、不上传、不进模型。官方附件栏保持原样，不注册、不顶替。

    function visionExt(mime) {
      const type = String(mime || '').toLowerCase()
      if (type.includes('png')) return '.png'
      if (type.includes('webp')) return '.webp'
      if (type.includes('gif')) return '.gif'
      if (type.includes('bmp')) return '.bmp'
      return '.jpg'
    }

    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']

    /** 浏览器 File 是不是图片：先看 MIME，再看扩展名（有些来源的 type 是空的）。 */
    function isImageFile(file) {
      if (!file) return false
      const type = String(file.type || '').toLowerCase()
      if (type.startsWith('image/')) return true
      const name = String(file.name || '').toLowerCase()
      return imageExts.some((ext) => name.endsWith(ext))
    }

    /** 偏好里的「本地识图」是否开着（默认关）。 */
    function localVisionOn(config) {
      return !(config && config.localDescribe === false)
    }

    // 界面注入开关：设置页「界面」分区的四个勾选；配置里明确关闭才关，旧配置缺字段按开。
    const uiSwitchKey = {
      speechRecognition: 'uiVoiceInput',
      localVision: 'uiVision',
      performanceMonitor: 'uiMetrics',
      autoRead: 'uiAutoRead',
    }

    /** 某个界面注入功能是否开着（名称写组件名或配置键；默认开）。 */
    function uiSwitchOn(config, label) {
      const key = uiSwitchKey[label] || label
      const value = config && typeof config === 'object' ? config[key] : undefined
      if (value === false || value === 'false' || value === 0 || value === '0') return false
      return true
    }

    // 识图档位：与服务端 lib/vision-presets.js 对齐；客户端只用它做下拉和参数兜底。
    const visionPresets = [
      { id: 'brief', name: '简短' },
      { id: 'standard', name: '标准' },
      { id: 'detailed', name: '详细' },
      { id: 'text', name: '只看文字' },
    ]
    const visionPresetOption = visionPresets.map((preset) => ({ value: preset.id, label: preset.name }))

    /** 把档位 id 或中文名收成 id；认不出来返回空串，由调用方回落默认档。 */
    function normalizeVisionPreset(value) {
      const text = String(value == null ? '' : value).trim().toLowerCase()
      if (!text) return ''
      const byId = visionPresets.find((preset) => preset.id === text)
      if (byId) return byId.id
      const byName = visionPresets.find((preset) => preset.name === text)
      return byName ? byName.id : ''
    }

    /** 点了识图按钮却不能识别时给一句短提示；能识别返回空串。 */
    function visionBlockReason(status) {
      if (!localVisionOn(status && status.config ? status.config : {})) return '本地识图已关闭，可在本地 AI 设置里打开。'
      if (status && status.load === true && status.online === false) return '本地 AI 未连接，请先启动。'
      return ''
    }

    /** 拼一段插进输入框的文字：文件名 + 描述；描述为空返回空串。 */
    function composeImageDesc(fileName, desc) {
      const name = String(fileName || '').trim() || '图片'
      const text = String(desc == null ? '' : desc).trim()
      return text ? `［图片：${name}］\n${text}\n` : ''
    }

    // 待插入队列：识图按钮识别后先入队（{sessionId, text, at}），由输入框右侧组件消费插入。
    const pendingInsert = []
    const pendingInsertLimit = 8
    // 入队后通知 input.right 组件来消费（订阅计数）。
    const visualNotice = makeStore(0)
    // 输入框右侧组件回填的提示（例如插入失败）。
    const visionPrompt = makeStore({ session: '', copy: '' })
    let visionPromptGeneration = 0
    function writeVisionPrompt(session, copy, ms = 8000) {
      const generation = (visionPromptGeneration += 1)
      visionPrompt.set({ session: String(session || ''), copy: String(copy || '') })
      if (!copy) return
      setTimeout(() => {
        if (generation === visionPromptGeneration) visionPrompt.set({ session: '', copy: '' })
      }, Math.max(1200, ms))
    }

    function enqueuePendingInsert(item) {
      const text = String((item && item.text) || '')
      if (!text) return false
      if (pendingInsert.length >= pendingInsertLimit) pendingInsert.shift()
      pendingInsert.push({ sessionId: String((item && item.sessionId) || ''), text: text, at: Date.now() })
      return true
    }

    /** 取走属于本会话（或没标会话）的待插入文字；取出即删除。 */
    function fetchPendingInsert(sessionId) {
      const output = []
      for (let order = pendingInsert.length - 1; order >= 0; order -= 1) {
        const item = pendingInsert[order]
        if (item.sessionId && sessionId && item.sessionId !== sessionId) continue
        output.unshift(item.text)
        pendingInsert.splice(order, 1)
      }
      return output
    }

    /** 消费队列：逐条交给插入函数；失败的文字已在插入函数里走剪贴板兜底。 */
    function consumePendingInsert(sessionId, insert) {
      let success = 0
      let fail = 0
      for (const text of fetchPendingInsert(sessionId)) {
        let ok = false
        try { ok = insert(text) === true } catch { ok = false }
        if (ok) success += 1
        else fail += 1
      }
      return { success, fail }
    }

    /** 认一张图：把字节交给 /describe-upload；会话识图用单独的提示词，不传档位。 */
    async function localRecognizeOne(image) {
      const form = new FormData()
      form.append('file', new Blob([image.byte], { type: image.type || 'application/octet-stream' }), image.name || `image${visionExt(image.type)}`)
      form.append('mode', 'caption')
      form.append('scope', 'session')
      const result = await postForm('/describe-upload', form)
      const text = String((result && result.text) || '').trim()
      if (!result || !result.ok || !text) {
        return { ok: false, hint: String((result && result.hint) || '识图失败') }
      }
      return { ok: true, text }
    }

    // ---------------- 本地识图：输入框旁的独立按钮 ----------------
    // 点按钮选图片；图片只在本机识别，不进草稿、不上传、不进模型。
    // 每张图的「文件名 + 描述」按顺序进待插入队列，由输入框右侧组件（麦克风）统一消费插入。

    function localVisionButton(props) {
      const { sessionId } = props || {}
      const prefsState = useStore(prefs)
      const visionOn = uiSwitchOn(prefsState.config, 'localVision')
      const promptState = useStore(visionPrompt)
      const [busy, setBusy] = React.useState(false)
      const [say, setSay] = React.useState('')
      const fileInput = React.useRef(null)
      const tick = React.useRef(null)

      React.useEffect(() => {
        loadPrefs()
        return () => { if (tick.current) clearTimeout(tick.current) }
      }, [])

      if (!visionOn) return null

      const tell = (copy) => {
        setSay(copy)
        if (tick.current) clearTimeout(tick.current)
        if (copy) tick.current = setTimeout(() => setSay(''), 6000)
      }

      const pickFile = () => {
        try { fileInput.current && fileInput.current.click() } catch { /* 忽略 */ }
      }

      const handle = async (files) => {
        if (busy) return
        const reason = visionBlockReason(prefsState)
        if (reason) { tell(reason); return }
        if (!sessionId) { tell('当前会话还不能插入文字。'); return }
        const images = Array.from(files || []).filter(isImageFile)
        if (!images.length) { tell('只支持图片文件。'); return }
        setBusy(true)
        let success = 0
        let fail = 0
        try {
          for (let order = 0; order < images.length; order += 1) {
            tell(`正在本地识别…（${order + 1} / ${images.length}）`)
            try {
              const file = images[order]
              const image = {
                byte: await file.arrayBuffer(),
                type: String(file.type || ''),
                name: String(file.name || '') || `image${visionExt(file.type)}`,
              }
              const result = await localRecognizeOne(image)
              if (!result.ok) throw new Error(result.hint || '识图失败')
              if (!enqueuePendingInsert({ sessionId, text: composeImageDesc(image.name, result.text) })) throw new Error('入队失败')
              visualNotice.set((value) => value + 1)
              success += 1
            } catch {
              fail += 1
            }
          }
        } finally {
          setBusy(false)
          tell(fail
            ? (success ? `识图完成：${success} 张成功，${fail} 张失败。` : '识图失败，请稍后再试。')
            : `已识别 ${success} 张。`)
        }
      }

      const promptText = promptState.copy && (!promptState.session || !sessionId || promptState.session === sessionId) ? promptState.copy : ''
      const copy = say || promptText
      const title = busy ? '正在本地识图…' : '本地识图：选择图片'

      return h(React.Fragment, null,
        h('input', {
          ref: fileInput,
          type: 'file',
          accept: 'image/*',
          multiple: true,
          tabIndex: -1,
          style: { display: 'none' },
          onChange: (event) => {
            const files = event.target.files ? Array.from(event.target.files) : []
            event.target.value = ''
            if (files.length) void handle(files)
          },
        }),
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          disabled: busy,
          title: title,
          'aria-label': '本地识图',
          // 别抢走输入框的焦点，否则插入位置会跳。
          onMouseDown: (event) => { try { event.preventDefault() } catch { /* 忽略 */ } },
          onClick: pickFile,
        }, busy ? iconSpinner() : iconImage()),
        copy ? h('div', { className: 'fish-vision-toast', role: 'status' }, copy) : null)
    }

    function formatTime(secondsCount) {
      const total = Math.max(0, Math.trunc(Number(secondsCount) || 0))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    }

    // ---------------- 语音输入：三选一面板（composer overlay） ----------------

    function waveform({ level, recording }) {
      const entry = []
      for (let i = 0; i < 18; i++) {
        const wobble = 0.35 + ((i * 37) % 10) / 14
        const high = 3 + Math.min(1, (recording ? level : 0) * wobble) * 19
        entry.push(h('i', { key: i, style: { height: `${Math.max(3, high)}px` } }))
      }
      return h('span', { className: 'fish-wave', 'aria-hidden': true }, entry)
    }

    function speechPanel(props) {
      const { sessionId, inputActions } = props || {}
      const state = useStore(speech.state)
      const prefsState = useStore(prefs)
      const speechOn = uiSwitchOn(prefsState.config, 'speechRecognition')

      React.useEffect(() => {
        keepAlive(true)
        return () => {
          keepAlive(false)
          // 切换会话/卸载输入框时别把录音丢在后台跑（最多能录 5 分钟）。
          const present = speech.state.get()
          if (present.phase === 'recording' && (!sessionId || present.sessionId === sessionId)) cancelRecording()
        }
      }, [sessionId])

      // 总开关关掉时面板不再出现，正在录的音也一并停掉。
      React.useEffect(() => {
        if (speechOn) return
        const present = speech.state.get()
        if (present.phase === 'recording') void stopRecording()
        closeSpeechPanel()
      }, [speechOn])

      if (!speechOn) return null

      // 录音中没有 sessionId 也要显示（会话说变就变），面板只服务当前会话。
      if (state.phase === 'idle') return null
      if (state.sessionId && sessionId && state.sessionId !== sessionId) return null

      const remember = prefs.get().config.rememberVoiceChoice !== false ? rememberedChoice() : ''
      const highlight = (select) => (state.choice || remember) === select
      const busy = state.phase === 'uploading' || state.phase === 'transcribing'
      const cancellable = state.phase !== 'recording' && !busy

      const title = state.phase === 'requesting' ? '正在请求麦克风…'
        : state.phase === 'recording' ? '正在录音'
          : state.phase === 'choose' ? `录音已完成（${formatTime(Math.round((state.durationMs || 0) / 1000))}）`
            : state.phase === 'transcribing' ? '正在转写…'
              : state.phase === 'uploading' ? '正在保存录音…'
                : state.phase === 'done' ? '完成'
                  : '语音输入'

      const line = []

      if (state.phase === 'requesting') {
        line.push(h('div', { key: 'req', className: 'fish-panel-dim' }, '浏览器会询问是否允许使用麦克风，允许后开始录音。'))
      }

      if (state.phase === 'recording') {
        line.push(h('div', { key: 'rec', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { className: 'fish-dot' }),
          h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, formatTime(state.seconds)),
          h(waveform, { level: state.level, recording: true }),
          h('span', { className: 'fish-panel-dim' }, '录音中｜最长 5 分钟')))
        line.push(h('div', { key: 'mic', className: 'fish-panel-dim', style: { marginTop: 4 } },
          `音量 ${Math.min(100, Math.round((state.level || 0) * 100))}%`
            + (state.micLabel ? `｜麦克风：${state.micLabel}` : '')
            + ((state.level || 0) < 0.01 && (state.seconds || 0) > 1 ? '（几乎没有声音，请检查麦克风）' : '')))
        if (state.hint) {
          line.push(h('div', { key: 'mic-hint', className: 'fish-panel-dim', style: { marginTop: 4 } }, state.hint))
        }
        line.push(h('div', { key: 'acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', 'data-primary': '1', onClick: () => void stopRecording() }, '停止并选择'),
          h('button', { type: 'button', className: 'fish-btn', onClick: cancelRecording }, '取消录音')))
      }

      if (state.phase === 'choose') {
        line.push(h('div', { key: 'tip', className: 'fish-panel-dim' }, '请选择这段录音的用法。'))
        line.push(h('div', { key: 'choose', className: 'fish-panel-row' },
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': highlight('text') ? '1' : undefined,
            onClick: () => void toText(inputActions),
          }, '转文字'),
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': highlight('audio') ? '1' : undefined,
            onClick: () => void keepSpeech(inputActions, sessionId),
          }, '作为附件'),
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': highlight('cancel') ? '1' : undefined,
            onClick: () => { rememberChoice('cancel'); cancelRecording() },
          }, '取消')))
        line.push(h('div', { key: 'sub', className: 'fish-panel-dim' }, '上次的选择会高亮，但不会自动执行；转成的文字会插入光标处，「作为附件」会把录音作为文件加到输入框。'))
      }

      if (busy) {
        line.push(h('div', { key: 'busy', style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'fish-spin', style: { display: 'inline-flex' } }, iconSpinner()),
          h('span', null, state.phase === 'transcribing' ? '正在转写，首次使用需要加载模型，可能要等一会儿…' : '正在保存录音…')))
        line.push(h('div', { key: 'busy-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: closeSpeechPanel }, '关闭面板（转写继续在后台进行）')))
      }

        if (state.phase === 'done') {
        line.push(h('div', { key: 'hint', className: 'fish-ok', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, state.hint))
        if (state.pendingText) {
          line.push(h('div', { key: 'pending', className: 'fish-panel-dim', style: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 110, overflow: 'auto' } }, state.pendingText))
          line.push(h('div', { key: 'pending-acts', className: 'fish-panel-row' },
            h('button', {
              type: 'button', className: 'fish-btn', 'data-primary': '1',
              onClick: () => {
                const made = insertText(inputActions, state.pendingText)
                speech.state.set((prev) => ({ ...prev, hint: made ? `已插入 ${state.pendingText.length} 字。` : '仍无法插入；文字已复制到剪贴板，请按 Ctrl+V 粘贴。', pendingText: made ? '' : state.pendingText }))
              },
            }, '重试插入'),
            h('button', {
              type: 'button', className: 'fish-btn',
              onClick: () => { try { navigator.clipboard?.writeText?.(state.pendingText) } catch { /* 忽略 */ } },
            }, '复制文字')))
        }
        line.push(h('div', { key: 'done-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: closeSpeechPanel }, '关闭')))
      }

      if (state.phase === 'error') {
        line.push(h('div', { key: 'err', className: 'fish-err', style: { whiteSpace: 'pre-wrap' } }, state.error || '未能完成'))
        line.push(h('div', { key: 'err-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: closeSpeechPanel }, '关闭'),
          h('button', { type: 'button', className: 'fish-btn', 'data-primary': '1', onClick: () => { closeSpeechPanel(); void startRecording({ sessionId, inputActions }) } }, '重新录')))
      }

      if (state.error && state.phase !== 'error' && !busy) {
        line.push(h('div', { key: 'err2', className: 'fish-err', style: { marginTop: 4 } }, state.error))
      }

      return h(React.Fragment, null,
        h('div', { className: 'fish-panel', role: 'dialog', 'aria-label': '语音输入' },
          h('div', { className: 'fish-panel-title' },
            h('span', { style: { display: 'inline-flex' } }, state.phase === 'recording' ? h('span', { className: 'fish-dot' }) : iconMic(15)),
            h('span', null, title),
            h('span', { style: { flex: 1 } }),
            cancellable ? h('button', {
              type: 'button', className: 'fish-iconbtn', title: '关闭', 'aria-label': '关闭',
              onClick: closeSpeechPanel,
            }, h('span', { style: { fontSize: 15, lineHeight: 1 } }, '×')) : null),
          line,
          h('div', { className: 'fish-panel-dim', style: { marginTop: 8 } },
            prefsState.online === false
              ? '本地 AI 未启动，转写暂不可用，请先启动。'
              : '录音只在本机处理，不联网，也不产生额外费用。')))
    }

    // ---------------- 自动朗读开关（输入框左侧） ----------------

    function autoReadSwitch(props) {
      const prefsState = useStore(prefs)
      const autoReadOn = uiSwitchOn(prefsState.config, 'autoRead')
      const [busy, setBusy] = React.useState(false)
      const sessionKey = String(props?.sessionId || '')
      const configurable = validSessionKey(sessionKey)

      React.useEffect(() => {
        keepAlive(true)
        if (!prefs.get().load) void loadPrefs()
        return () => keepAlive(false)
      }, [])

      if (!autoReadOn) return null

      const on = readAutoReadSessions(prefsState.config, sessionKey)
      // 偏好还没读回来时不写：否则空表会把其它会话已有的设置覆盖掉。
      const ready = configurable && prefsState.load
      const toggle = async () => {
        if (busy || !ready) return
        setBusy(true)
        const nextConfig = writeAutoReadSessions(prefs.get().config || {}, sessionKey, !on)
        const r = await post('/save', { config: { autoReadSessions: nextConfig.autoReadSessions } })
        setBusy(false)
        if (r && r.ok) {
          prefs.set((prev) => ({
            ...prev,
            config: r.config
              ? { ...(prev.config || {}), ...r.config }
              : { ...(prev.config || {}), autoReadSessions: nextConfig.autoReadSessions },
          }))
        }
      }
      const title = !configurable ? '当前会话暂不支持单独设置自动朗读'
        : !prefsState.load ? '正在读取自动朗读设置…'
          : on ? '本会话自动朗读已开启，点击关闭'
            : '本会话自动朗读已关闭，点击开启'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          'data-on': on ? '1' : undefined,
          title: title,
          'aria-label': title,
          'aria-pressed': on ? 'true' : 'false',
          disabled: busy || !ready,
          onClick: toggle,
        }, iconSpeak(14), h('span', { style: { fontSize: 11.5 } }, on ? '自动朗读 开' : '自动朗读 关')))
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

    const capabilityLabelZh = {
      tts: '文字转语音',
      asr: '语音识别',
      translate: '翻译',
      separate: '人声分离',
      vision: '视觉关键帧',
      media: '媒体探测',
      download: '下载',
      jobs: '任务队列',
    }
    const translationLanguageDropdown = [
      { value: 'zh', label: '中文' },
      { value: 'en', label: '英文' },
      { value: 'ja', label: '日文' },
      { value: 'ko', label: '韩文' },
      { value: 'yue', label: '粤语' },
    ]

    const reasonLabelZh = {
      service_down: '本地 AI 未启动',
      model_missing: '模型未下载',
      not_supported: '当前版本不支持',
      api_incompatible: '版本不兼容',
    }

    // 设置页给用户看的字段名；环境变量覆盖提示只显示中文名。
    const configLabelZh = {
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

    const prompt = (text) => h('div', { style: S.hint }, text)

    /** 「?」提示控件：文案短了说不清时，鼠标悬浮（或键盘聚焦）展开完整说明。 */
    const questionMark = (description) => h('span', {
      style: S.ask,
      role: 'img',
      tabIndex: 0,
      title: description,
      'aria-label': description,
    }, '?')

    /**
     * 一行设置。说明只保留一种形式，二选一：
     *   字符串        → 控件下方一行短句；
     *   { 问: '…' }   → 标签后的「?」，悬浮展开。
     */
    const line = (tag, widget, description) => {
      const askText = description && typeof description === 'object' && typeof description.ask === 'string' ? description.ask : ''
      const shortSentence = typeof description === 'string' ? description : ''
      return h('div', { style: S.row },
        h('div', { style: S.lab },
          h('span', null, tag),
          askText ? questionMark(askText) : null),
        h('div', { style: S.ctl }, widget, shortSentence ? prompt(shortSentence) : null))
    }

    /** 可折叠的一块内容：默认收起，标题旁给一行摘要，避免大段内容铺满设置页。 */
    function foldChunk(props) {
      const { digest, defaultExpand = false, expandLabel = '展开', collapseLabel = '收起', children } = props || {}
      const [on, setOn] = React.useState(defaultExpand)
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: S.dim }, digest || ''),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: S.link,
            'aria-expanded': on ? 'true' : 'false',
            onClick: () => setOn(!on),
          }, on ? collapseLabel : expandLabel)),
        h('div', { style: { display: on ? 'block' : 'none', marginTop: 8 } }, children))
    }

    function input(value, onChange, placeholder = '', type = 'text') {
      return h('input', {
        style: S.input,
        type: type,
        value: value == null ? '' : String(value),
        placeholder: placeholder,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function multiline(value, onChange, placeholder = '') {
      return h('textarea', {
        style: S.text,
        rows: 4,
        value: value == null ? '' : String(value),
        placeholder: placeholder,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function dropdown(value, option, onChange) {
      return h('select', {
        className: 'fish-select',
        style: S.small,
        value: value == null ? '' : String(value),
        onChange: (e) => onChange(e.target.value),
      }, option.map((item) => h('option', { key: item.value, value: item.value }, item.label)))
    }

    function check(value, onChange) {
      return h('input', { type: 'checkbox', checked: Boolean(value), onChange: (e) => onChange(e.target.checked) })
    }

    function statusTap(ok, text) {
      return h('span', { style: { ...S.badge, ...(ok ? S.ok : S.danger) } }, text)
    }

    function Section() {
      const [state, setState] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      // 当前正在执行的动作，让吸顶按钮显示「正在保存…」这类状态。
      const [action, setAction] = React.useState('')
      const [say, setSay] = React.useState('')
      const [log, setLog] = React.useState(null)
      const [cacheStats, setCacheStats] = React.useState(null)
      const speechState = useStore(speech.state)
      const deviceState = useStore(device)

      const pull = async () => {
        const s = await get('/state')
        if (s && s.ok) {
          setState(s)
          prefs.set((prev) => ({
            ...prev,
            load: true,
            online: Boolean(s.health && s.health.reachable),
            config: s.config || {},
            health: s.health || null,
            voice: Array.isArray(s.voices) ? s.voices : [],
            plugin: s.plugin || {},
          }))
        }
      }
      React.useEffect(() => { pull() }, [])
      React.useEffect(() => {
        if (dirty) return undefined
        const t = setInterval(pull, 5000)
        return () => clearInterval(t)
      }, [dirty])
      const config = (state && state.config) || {}
      const health = (state && state.health) || {}
      const cache = (state && state.cache) || {}
      const capabilityTable = (state && state.capabilities) || {}
      const voices = Array.isArray(state && state.voices) ? state.voices : []
      const online = Boolean(health.reachable)
      const compatible = health.compatible !== false

      const update = (key, value) => {
        setState((prev) => (prev ? { ...prev, config: { ...(prev.config || {}), [key]: value } } : prev))
        setDirty(true)
      }

      const storeValue = async () => {
        setBusy(true); setAction('保存'); setSay('正在保存…')
        const r = await post('/save', { config: config })
        setBusy(false); setAction('')
        if (r && r.ok) {
          setDirty(false)
          setSay((r.warnings && r.warnings.length) ? `已保存（${r.warnings.join('；')}）` : '已保存。')
          if (r.config) {
            prefs.set((prev) => ({ ...prev, config: { ...r.config } }))
          }
          await pull()
        } else {
          setSay('保存失败：' + String((r && (r.hint || r.message)) || '请稍后重试。'))
        }
      }

      const service = async () => {
        setBusy(true); setAction('测试'); setSay('正在测试连接…')
        const r = await post('/test', { timeoutMs: 4000 })
        setBusy(false); setAction('')
        if (r && r.ok) setSay(`连接正常，延迟 ${r.latencyMs || 0} 毫秒。`)
        else setSay(`连接失败：${(r && r.hint) || '本地 AI 未启动，请先启动。'}`)
        await pull()
      }

      // 重新读取：把服务状态和缓存统计重新取一遍，按钮上显示正在读取。
      const reread = async () => {
        setBusy(true); setAction('读取'); setSay('正在重新读取…')
        await pull()
        await pullCacheStats()
        setBusy(false); setAction(''); setSay('')
      }

      const viewLog = async () => {
        setBusy(true)
        const r = await get('/logs?lines=200')
        setBusy(false)
        setLog(r && r.ok ? r.lines : null)
      }

      const pullCacheStats = async () => {
        const r = await get('/cache/stats')
        if (r && r.ok) setCacheStats(r)
      }

      const clearCache = async () => {
        setBusy(true)
        const r = await post('/cache/clear', { kind: 'tts' })
        setBusy(false)
        if (r && r.ok) {
          const mb = Math.round(((r.bytes || 0) / 1024 / 1024) * 10) / 10
          setSay(`已清空朗读缓存（${r.files || 0} 个文件，释放 ${mb} MB）。下次朗读会重新生成语音。`)
        } else {
          setSay(`清空缓存失败：${(r && r.hint) || '请稍后重试。'}`)
        }
        await pull()
        await pullCacheStats()
      }

      const clearExpired = async () => {
        setBusy(true)
        const r = await post('/cache/cleanup', {})
        setBusy(false)
        if (r && r.ok) {
          const mb = Math.round(((r.bytesFreed || 0) / 1024 / 1024) * 10) / 10
          setSay(`已清理过期缓存 ${r.expired || 0} 个、超出上限 ${r.lru || 0} 个，释放 ${mb} MB。`)
        } else {
          setSay(`清理缓存失败：${(r && r.hint) || '请稍后重试。'}`)
        }
        await pull()
        await pullCacheStats()
      }

      React.useEffect(() => { void pullCacheStats() }, [])

      const voiceDir = (state && typeof state.voicesDirectory === 'string') ? state.voicesDirectory : ''

      const openCacheDir = async () => {
        const r = await post('/open-folder', { path: String(config.cacheDir || cache.dir || '').trim() })
        if (r && r.ok) setSay('已在文件管理器中打开缓存目录。')
        else setSay(`打开文件夹失败：${(r && r.hint) || '请手动打开。'}`)
      }

      // 音色目录只从服务实时取；服务离线时按钮禁用，不缓存路径。
      const openVoiceDir = async () => {
        if (!voiceDir || !online) return
        const r = await post('/open-folder', { path: voiceDir })
        if (r && r.ok) setSay('已在文件管理器中打开音色目录。')
        else setSay(`打开文件夹失败：${(r && r.hint) || '请手动打开。'}`)
      }

      const openAdminUi = async () => {
        const r = await post('/open-webui', {})
        if (r && r.ok) setSay('已在默认浏览器中打开管理界面。')
        else setSay(`打开管理界面失败：${(r && r.hint) || '请稍后重试。'}`)
      }

      if (!state) {
        return h('div', { className: 'fish-service-settings', style: S.wrap },
          h('div', { style: S.h1 }, '本地 AI'),
          h('div', { style: S.dim }, '正在读取状态…'))
      }

      const capabilityNames = Object.keys(capabilityLabelZh)
      const availableCount = capabilityNames.filter((name) => capabilityTable[name] && capabilityTable[name].available).length
      const capabilityChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '能力'),
        h('div', { style: { ...S.dim, marginBottom: 6 } },
          `${availableCount} / ${capabilityNames.length} 项可用`),
        h(foldChunk, {
          digest: '',
          defaultExpand: availableCount < capabilityNames.length,
          expandLabel: '查看各项',
          collapseLabel: '收起',
        },
          h('div', { style: S.chips }, capabilityNames.map((name) => {
            const info = capabilityTable[name] || {}
            const available = Boolean(info.available)
            const reason = info.reason ? (reasonLabelZh[info.reason] || '原因未知') : ''
            return h('div', { key: name, style: S.chip },
              h('div', { style: { fontWeight: 600 } }, capabilityLabelZh[name]),
              h('div', { style: available ? S.ok : S.danger },
                available ? `可用${info.loaded ? '（已加载）' : ''}` : `不可用（${reason || '原因未知'}）`))
          })),
          capabilityTable.tts && !capabilityTable.tts.available && capabilityTable.tts.reason === 'service_down'
            ? h('div', { style: { ...S.danger, marginTop: 8 } }, '本地 AI 未启动，请先启动。')
            : null))

      // 识图：开关控制输入框旁的「本地识图」按钮；会话识图与工具识图各用各的提示词，互不覆盖。
      const presetsTable = config.visionPresets && typeof config.visionPresets === 'object'
        && !Array.isArray(config.visionPresets) ? config.visionPresets : {}
      // 「留空 = 用内置默认」，所以把默认提示词直接显示成占位文字。
      const visionDefault = (state && state.visionDefaults && typeof state.visionDefaults === 'object') ? state.visionDefaults : {}
      const sessionVisionDefault = typeof visionDefault.session === 'string' ? visionDefault.session : ''
      const presetLevelDefault = (preset) => (visionDefault.presets && typeof visionDefault.presets[preset.id] === 'string' ? visionDefault.presets[preset.id] : '')
      const updatePrompt = (preset, value) => {
        update('visionPresets', { ...presetsTable, [preset]: value })
      }
      const visionChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '识图'),
        line('本地识图', check(config.localDescribe !== false, (value) => update('localDescribe', value)),
          '打开后，输入框旁的「本地识图」按钮可用。第一次识别要等模型加载。'),
        line('会话识图',
          multiline(config.visionSessionPrompt, (value) => update('visionSessionPrompt', value), sessionVisionDefault),
          '输入框旁的按钮识图时用这段提示词；留空用内置默认。'),
        line('工具默认档位', dropdown(normalizeVisionPreset(config.visionDefaultPreset) || 'detailed', visionPresetOption,
          (value) => update('visionDefaultPreset', value)),
        '工具识图没指定档位时用这一档。'),
        h(foldChunk, { digest: '工具提示词', expandLabel: '修改', collapseLabel: '收起' },
          h('div', null, visionPresets.map((preset) => h('div', { key: preset.id, style: { marginBottom: 10 } },
            h('div', { style: { fontSize: 12.5, marginBottom: 2 } }, preset.name),
            multiline(presetsTable[preset.id], (value) => updatePrompt(preset.id, value), presetLevelDefault(preset)))))))

      const voiceOption = [{ value: config.ttsVoice || 'dafeiyu', label: config.ttsVoice || 'dafeiyu' }]
      for (const name of voices) {
        if (!voiceOption.some((x) => x.value === name)) voiceOption.push({ value: name, label: name })
      }

      const serviceChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '服务连接'),
        line('服务地址', input(config.baseUrl, (v) => update('baseUrl', v), ''),
          { ask: '一般不用改；改了地址后点「测试连接」确认。' }),
        line('请求超时（秒）', h('input', {
          style: S.small, type: 'number', min: 1, max: 1800,
          value: Math.round((Number(config.requestTimeoutMs) || 180000) / 1000),
          onChange: (e) => update('requestTimeoutMs', Number(e.target.value) * 1000),
        }), { ask: '只影响一般请求；识别、分离与视觉分析另有更长的等待时间。' }),
        line('总开关', check(config.enabled !== false, (v) => update('enabled', v)),
          '关闭后朗读与语音输入都不可用。'),
        line('管理界面',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              style: S.btn,
              onClick: openAdminUi,
              disabled: !online || busy,
            }, '打开管理界面'),
            statusTap(online, online ? '在线' : '离线')),
          online ? '' : '先启动本地 AI 再打开。'),
        (state.envOverrides && state.envOverrides.length)
          ? h('div', { style: { ...S.danger, marginTop: 4 } },
              `以下设置已由系统统一指定，在设置页修改不会生效：${state.envOverrides.map((name) => configLabelZh[name] || '其他设置').join('、')}`)
          : null)

      const readChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '朗读'),
        line('默认音色',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            dropdown(config.ttsVoice || 'dafeiyu', voiceOption, (v) => update('ttsVoice', v)),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: !online || !voiceDir || busy,
              title: !online ? '本地 AI 未启动' : (!voiceDir ? '还没读到音色目录' : '在文件管理器中打开音色文件夹'),
              onClick: openVoiceDir,
            }, '打开文件夹')),
         online ? '把音色文件放进去，列表会自动更新。' : '本地 AI 未启动，启动后可打开音色文件夹。'),
        line('语速', h('input', {
          style: S.small, type: 'number', min: 0.5, max: 2, step: 0.05,
          value: config.ttsSpeed ?? 1,
          onChange: (e) => update('ttsSpeed', Number(e.target.value)),
        })),
        line('单次最大字数', h('input', {
          style: S.small, type: 'number', min: 200, max: 5000, step: 100,
          value: config.readMaxChars ?? 2000,
          onChange: (e) => update('readMaxChars', Number(e.target.value)),
        }), { ask: '超过 2 万字的部分不朗读；长内容会自动分段。' }),
        line('同时生成', h('input', {
          style: S.small, type: 'number', min: 1, max: 4, step: 1,
          value: config.readConcurrency ?? 2,
          onChange: (e) => update('readConcurrency', Number(e.target.value)),
        }), { ask: '数值越大出声越快、更占显存；卡顿时调低。' }),
        line('新会话默认自动朗读', check(config.autoRead === true, (v) => update('autoRead', v)),
          { ask: '只影响未单独设置过的会话；每个会话可单独开关。' }),
        line('后台也自动朗读', check(config.autoReadInBackground !== false, (v) => update('autoReadInBackground', v)),
          '切到后台或最小化时仍会朗读，会占用扬声器，可能打扰他人。'))

      const selectedDeviceId = String(config.recordDeviceId || '')
      const deviceOption = [{ value: '', label: '系统默认' }]
      for (const item of deviceState.list) {
        if (!deviceOption.some((x) => x.value === item.deviceId)) deviceOption.push({ value: item.deviceId, label: item.label })
      }
      let selectedDeviceName = '系统默认'
      if (selectedDeviceId) {
        const hit = deviceOption.find((x) => x.value === selectedDeviceId)
        selectedDeviceName = (hit && hit.label)
          || (deviceState.recentId === selectedDeviceId ? deviceState.recentLabel : '')
          || '名称未确认（请刷新设备列表）'
        if (!hit) deviceOption.push({ value: selectedDeviceId, label: selectedDeviceName })
      }
      const recording = speechState.phase === 'recording'
      const inputVolume = recording ? `${Math.min(100, Math.round((speechState.level || 0) * 100))}%` : '—'
      const deviceStatus = `已选：${selectedDeviceName}｜上次录音：${deviceState.recentLabel || '—'}｜当前音量：${inputVolume}`

      const speechChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '语音输入'),
        line('输入设备',
          h('div', null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              dropdown(selectedDeviceId, deviceOption, (v) => update('recordDeviceId', v)),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: deviceState.enumerating,
                onClick: () => { void refreshDeviceList() },
              }, deviceState.enumerating ? '读取中…' : '刷新设备列表')),
            h('div', { style: { marginTop: 2 } },
              deviceStatus,
              deviceState.prompt ? h('div', { style: { marginTop: 2 } }, deviceState.prompt) : null)),
          { ask: '有多支麦克风或录音无声时可指定；虚拟设备常录不到人声。' }),
        line('录音格式', dropdown(config.recordMime || 'auto', [
          { value: 'auto', label: '自动（推荐）' },
          { value: 'webm', label: '体积较小' },
          { value: 'wav', label: '体积较大' },
        ], (v) => update('recordMime', v)), { ask: '转写结果异常时，换一种格式再试。' }),
        line('识别语言', dropdown(config.asrLanguage || 'auto', [
          { value: 'auto', label: '自动判断' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'ja', label: '日文' },
        ], (v) => update('asrLanguage', v))),
        line('记住上次选择', check(config.rememberVoiceChoice !== false, (v) => update('rememberVoiceChoice', v)),
          '只高亮上次的选项，不会自动执行。'),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          '录音最长 5 分钟、最大 25MB。'))

      const cacheChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '缓存'),
        h('div', { style: S.dim },
          `当前占用 ${cache.mb || 0} MB，共 ${cache.files || 0} 个文件。`),
        h(foldChunk, {
          digest: cacheStats
            ? `已复用 ${cacheStats.hits || 0} 次，复用率 ${Math.round((cacheStats.hitRate || 0) * 1000) / 10}%`
            : '统计读取中…',
          expandLabel: '查看明细',
          collapseLabel: '收起明细',
        },
          line('保存位置',
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              input(config.cacheDir, (v) => update('cacheDir', v), ''),
              h('button', { type: 'button', style: S.btn, onClick: openCacheDir, disabled: busy }, '打开文件夹')),
            { ask: '朗读音频、分离音轨、关键帧和保留的录音都在这里。' }),
          line('缓存上限（MB）', h('input', {
            style: S.small, type: 'number', min: 256, max: 10240, step: 256,
            value: config.cacheMaxMb ?? 2048,
            onChange: (e) => update('cacheMaxMb', Number(e.target.value)),
          }), '超出上限时先删最久没用的文件。'),
          line('保留时长（小时）', h('input', {
            style: S.small, type: 'number', min: 1, max: 720, step: 1,
            value: config.cacheTtlHours ?? 72,
            onChange: (e) => update('cacheTtlHours', Number(e.target.value)),
          }), '过期的文件会自动清理。'),
          h('div', { style: { ...S.dim, marginTop: 4 } },
            '已缓存音频：' + (cacheStats
              ? `${cacheStats.files || 0} 段 / ${(Math.round(((cacheStats.bytes || 0) / 1024 / 1024) * 10) / 10)} MB；`
                + `复用 ${cacheStats.hits || 0} 次、重新生成 ${cacheStats.misses || 0} 次（本次运行以来）`
              : '统计读取中…'))),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btn, onClick: clearCache, disabled: busy }, '清空朗读缓存'),
          h('button', { type: 'button', style: S.btn, onClick: clearExpired, disabled: busy }, '清理过期缓存')),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '清空后下次朗读会重新生成。'))

      const translationChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '翻译'),
        line('第一语言',
          dropdown(config.primaryLanguage || 'zh', translationLanguageDropdown, (v) => update('primaryLanguage', v)),
          '原文不是第一语言时，译成第一语言。'),
        line('第二语言',
          dropdown(config.secondaryLanguage || 'en', translationLanguageDropdown, (v) => update('secondaryLanguage', v)),
          '原文已经是第一语言时，译成第二语言。'),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '没指定目标语言时按上面的规则自动选择。'))

      // 界面：四个注入开关放一个可折叠分区，避免设置页一上来就很长。
      const uiChunk = h('div', { style: S.card },
        h('div', { style: S.h2 }, '界面'),
        h(foldChunk, {
          digest: '输入框里的按钮与状态',
          expandLabel: '查看开关',
          collapseLabel: '收起',
        },
          line('语音识别', check(config.uiVoiceInput !== false, (v) => update('uiVoiceInput', v)),
            '关闭后输入框不再显示麦克风按钮。'),
          line('本地识图', check(config.uiVision !== false, (v) => update('uiVision', v)),
            '关闭后输入框不再显示识图按钮。'),
          line('性能监控', check(config.uiMetrics !== false, (v) => update('uiMetrics', v)),
            '关闭后输入框不再显示显存与任务状态。'),
          line('自动朗读', check(config.uiAutoRead !== false, (v) => update('uiAutoRead', v)),
            '关闭后所有会话都不再自动朗读，手动朗读不受影响。')))

      // 吸顶操作条：标题、在线状态和页面级按钮都在这里，内容在它下面滚动。
      const actionBar = h('div', { style: S.bar },
        h('div', { style: S.barRow },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } },
            h('div', { style: { ...S.h1, margin: 0 } }, '本地 AI'),
            h('span', { style: { ...S.badge, ...(online ? S.ok : S.danger) } },
              online ? `在线${compatible ? '' : '（版本不兼容）'} · v${health.serviceVersion || '?'}` : '未启动'),
            h('span', { style: S.dim }, `插件 v${(state.plugin && state.plugin.version) || '?'}`)),
          h('div', { style: S.barActions },
            h('button', { type: 'button', style: S.btnOn, onClick: storeValue, disabled: busy },
              busy && action === '保存' ? '正在保存…' : '保存设置'),
            h('button', { type: 'button', style: S.btn, onClick: service, disabled: busy },
              busy && action === '测试' ? '正在测试…' : '测试连接'),
            h('button', { type: 'button', style: S.btn, onClick: reread, disabled: busy },
              busy && action === '读取' ? '正在读取…' : '重新读取'))),
        h('div', { style: S.dim }, '保存后立即生效，不用重启。'),
        say ? h('div', { style: { ...(/失败|无法|错误|不可用|不能/.test(String(say)) ? S.danger : S.ok), marginTop: 2 } }, say) : null)

      const statusChunk = h('div', { style: S.card },
        h('div', { style: S.dim },
          `延迟 ${health.latencyMs || 0} 毫秒`
          + (health.vram ? `｜显存 ${health.vram.freeMb || 0}/${health.vram.totalMb || 0} MB` : '')
          + `｜最近检查 ${health.checkedAt ? new Date(health.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          '朗读、语音输入与各项能力都在本机完成，不联网，也不产生额外费用。'),
        (health.lastError && health.lastError.hint)
          ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近错误：${health.lastError.hint}`)
          : null,
        (state.errors && state.errors.length)
          ? h('div', { style: { ...S.dim, marginTop: 4 } },
              `最近有 ${state.errors.length} 条错误，最新：${state.errors[state.errors.length - 1].hint || '未知错误'}`)
          : null)

      const logChunk = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { style: { ...S.h2, margin: 0 } }, '运行日志'),
          h('span', { style: S.dim }, '最近 200 行'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.dim }, '日志级别'),
          dropdown(config.logLevel || 'info', [
            { value: 'debug', label: '详细' },
            { value: 'info', label: '一般' },
            { value: 'warn', label: '仅警告' },
            { value: 'error', label: '仅错误' },
          ], (v) => update('logLevel', v)),
          h('button', { type: 'button', style: S.btn, onClick: viewLog, disabled: busy }, '读取日志')),
        h('pre', { style: S.logs }, log ? log.join('\n') : '（点「读取日志」查看）'),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '遇到问题时读取并复制给维护者。'))

      return h('div', { className: 'fish-service-settings', style: S.wrap },
        actionBar,
        statusChunk,
        uiChunk,
        capabilityChunk,
        visionChunk,
        readChunk,
        translationChunk,
        speechChunk,
        serviceChunk,
        cacheChunk,
        logChunk)
    }

    // ---------------- 本地 AI 状态胶囊（输入框左侧工具行） ----------------

    const metricsPollMs = 2000

    /** MB → GB，一位小数；缺失/非法按 0。 */
    function formatGB(megabyte) {
      const count = Number(megabyte)
      return (Number.isFinite(count) && count > 0 ? count / 1024 : 0).toFixed(1)
    }

    function formatVram(used, totalAmount) {
      return `${formatGB(used)} / ${formatGB(totalAmount)} GB`
    }

    function formatModel(models) {
      const list = (Array.isArray(models) ? models : [])
        .map((item) => String(item == null ? '' : item).trim())
        .filter(Boolean)
      return list.length ? `已加载 ${list.join(' / ')}` : '无模型'
    }

    function taskTotalCount(queue) {
      const queued = Math.max(0, Math.trunc(Number(queue && queue.queued) || 0))
      const run = Math.max(0, Math.trunc(Number(queue && queue.running) || 0))
      return queued + run
    }

    /** 胶囊文案里的任务段：有任务显示总数，没有显示空闲。 */
    function formatCapsuleTask(queue) {
      const totalCount = taskTotalCount(queue)
      return totalCount > 0 ? `${totalCount} 任务` : '空闲'
    }

    /** 浮层里的队列行：「运行 1 · 排队 0」。 */
    function formatTask(queue) {
      const queued = Math.max(0, Math.trunc(Number(queue && queue.queued) || 0))
      const run = Math.max(0, Math.trunc(Number(queue && queue.running) || 0))
      return queued + run > 0 ? `运行 ${run} · 排队 ${queued}` : '空闲'
    }

    function formatDuration(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds) || 0))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return `${days} 天 ${hours} 小时`
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      if (minutes > 0) return `${minutes} 分钟`
      return `${total} 秒`
    }

    /** 按类型分桶 → 「tts 2 · asr 1」；空桶显示「无」。 */
    function formatTypeDetail(table) {
      const item = []
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        for (const [type, count] of Object.entries(table)) {
          const counter = Math.trunc(Number(count) || 0)
          if (counter > 0) item.push(`${type} ${counter}`)
        }
      }
      return item.length ? item.join(' · ') : '无'
    }

    /** 显存占比分档：>95 危险、>85 警告，其余正常。 */
    function vramColor(percent) {
      const count = Math.max(0, Math.min(100, Number(percent) || 0))
      if (count > 95) return 'danger'
      if (count > 85) return 'warn'
      return ''
    }

    function formatVisual(visual) {
      return `${visual && visual.loaded === true ? '已加载' : '未加载'} · ${visual && visual.ready === true ? '已就绪' : '未就绪'}`
    }

    function metricsOffline(state) {
      return Boolean(state && state.load && (!state.data || state.data.ok !== true))
    }

    function metricsCapsule() {
      const prefsState = useStore(prefs)
      const metricsOn = uiSwitchOn(prefsState.config, 'performanceMonitor')
      const [state, setState] = React.useState({ load: false, data: null })
      const [expand, setExpand] = React.useState(false)
      const [prompt, setPrompt] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const root = React.useRef(null)

      const pull = React.useCallback(async () => {
        // 页面隐藏时暂停轮询；恢复可见由 visibilitychange 立刻补一次。
        if (typeof document !== 'undefined' && document.hidden) return
        const data = await get('/metrics')
        setState({ load: true, data: data && typeof data === 'object' ? data : null })
      }, [])

      React.useEffect(() => {
        if (!metricsOn) {
          setState({ load: false, data: null })
          return undefined
        }
        let timer = 0
        void pull()
        timer = setInterval(() => { void pull() }, metricsPollMs)
        const pageVisible = () => { if (!document.hidden) void pull() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', pageVisible)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', pageVisible)
        }
      }, [pull, metricsOn])

      React.useEffect(() => {
        if (!expand || typeof document === 'undefined') return undefined
        const tapOutside = (event) => {
          const node = root.current
          if (node && event && event.target && node.contains(event.target)) return
          setExpand(false)
        }
        const onEscape = (event) => { if (event && event.key === 'Escape') setExpand(false) }
        document.addEventListener('pointerdown', tapOutside, true)
        document.addEventListener('keydown', onEscape, true)
        return () => {
          document.removeEventListener('pointerdown', tapOutside, true)
          document.removeEventListener('keydown', onEscape, true)
        }
      }, [expand])

      if (!metricsOn) return null

      const openAdmin = async (event) => {
        event?.stopPropagation?.()
        setBusy(true)
        setPrompt('')
        const result = await post('/open-webui', {})
        setBusy(false)
        if (!result || result.ok !== true) setPrompt((result && result.hint) || '打开管理界面失败，请稍后再试。')
      }

      const refresh = async (event) => {
        event?.stopPropagation?.()
        setBusy(true)
        setPrompt('')
        await pull()
        setBusy(false)
      }

      const offline = metricsOffline(state)
      const online = Boolean(state.load && !offline && state.data && state.data.ok === true)
      const data = (online && state.data) || {}
      const gpu = data.gpu || {}
      const ratio = Math.max(0, Math.min(100, Math.trunc(Number(gpu.percent) || 0)))
      const grade = vramColor(ratio)
      const capsuleText = !state.load
        ? '连接中'
        : offline
          ? '本地 AI 未启动'
          : `显存 ${ratio}%｜${formatCapsuleTask(data.queue)}`

      const detail = (tag, value) => h('div', { className: 'fish-metrics-row' },
        h('span', { className: 'fish-metrics-key' }, tag),
        h('span', { className: 'fish-metrics-val' }, value))

      const overlay = h('div', {
        className: 'fish-metrics-pop',
        role: 'dialog',
        'aria-label': '本地 AI 详情',
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { className: 'fish-metrics-head' },
          h('span', { className: 'fish-metrics-title' }, '本地 AI'),
          h('span', { className: 'fish-metrics-dim' }, online ? `v${data.service?.version || '?'}` : '')),
        !state.load
          ? h('div', { className: 'fish-metrics-empty' }, '正在读取…')
          : offline
            ? h('div', { className: 'fish-metrics-empty' }, '启动服务后可查看。')
            : h(React.Fragment, null,
                h('div', { className: 'fish-metrics-gpu' },
                  detail('显卡', gpu.name || '未知'),
                  detail('显存', `${formatVram(gpu.usedMb, gpu.totalMb)}（${ratio}%）`),
                  h('div', { className: 'fish-metrics-bar', 'data-level': grade || undefined },
                    h('i', { style: { width: `${ratio}%` } })),
                  detail('可用', `${formatGB(gpu.freeMb)} GB`)),
                detail('模型', formatModel(data.modelsLoaded)),
                detail('视觉', formatVisual(data.vision)),
                h('div', { className: 'fish-metrics-sep' }),
                detail('队列', formatTask(data.queue)),
                detail('排队明细', formatTypeDetail(data.queue?.queuedByKind)),
                detail('运行明细', formatTypeDetail(data.queue?.runningByKind)),
                detail('当前类型', data.scheduler?.currentKind || '无'),
                detail('调度模型', data.scheduler?.loadedModel || '无'),
                detail('运行时长', formatDuration(data.service?.uptimeSeconds))),
        prompt ? h('div', { className: 'fish-metrics-hint' }, prompt) : null,
        h('div', { className: 'fish-metrics-actions' },
          offline ? null : h('button', {
            type: 'button',
            className: 'fish-btn',
            disabled: busy,
            onClick: openAdmin,
          }, '打开管理界面'),
          h('button', { type: 'button', className: 'fish-btn', disabled: busy, onClick: refresh }, '刷新')))

      return h('div', {
        ref: root,
        className: 'fish-metrics',
        'data-offline': offline ? '1' : undefined,
      },
        h('button', {
          type: 'button',
          className: 'fish-metrics-pill',
          'data-level': grade || undefined,
          onClick: () => setExpand((value) => !value),
          'aria-expanded': expand ? 'true' : 'false',
          'aria-label': '本地 AI 状态',
          title: offline ? '本地 AI 未启动' : '查看本地 AI 详情',
        },
          h('span', { className: 'fish-metrics-dot', 'aria-hidden': true }),
          h('span', { className: 'fish-metrics-text' }, capsuleText)),
        expand ? overlay : null)
    }

    // ---------------- 右栏「双语翻译」：分段、缓存、面板 ----------------

    const translationTabID = 'dsh-fish-service/translate'
    const translationTabKind = 'fish-translate'
    const translationLanguageNames = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', yue: '粤语' }

    const segmentCharsLimit = 800
    const perBatchSegmentCountLimit = 20
    const perBatchCharsLimit = 8000
    const translationCacheLimit = 2000
    // 后台任务每批更小：模型冷启动时单批耗时可控，串行提交不叠并发。
    const taskPerBatchSegmentCount = 6
    const taskPerBatchChars = 1500
    const taskPollMs = 1000
    const taskColdStartMs = 8000
    const taskTotalDurationLimit = 10 * 60 * 1000
    // 一次只跑一批：冷启动时多批并发会把模型加载挤在一起。
    const canFetchTranslated = 1

    // 与 lib/lang.js 的 检测语言 同规则（本地字符范围判断，不请求模型）。
    function detectLanguage(text) {
      let kana = 0
      let hangul = 0
      let han = 0
      let latin = 0
      for (const char of String(text || '')) {
        const code = char.codePointAt(0)
        if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) kana += 1
        else if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) hangul += 1
        else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) han += 1
        else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) latin += 1
      }
      if (kana > 0) return 'ja'
      if (hangul > 0) return 'ko'
      if (han > 0) return 'zh'
      if (latin > 0) return 'en'
      return null
    }

    function translationLanguageTag(code) {
      return translationLanguageNames[code] || String(code || '')
    }

    function fetchTranslationDirectionConfig(config) {
      const primary = translationLanguageNames[config && config.primaryLanguage] ? config.primaryLanguage : 'zh'
      const secondary = translationLanguageNames[config && config.secondaryLanguage] ? config.secondaryLanguage : 'en'
      return { primary, secondary }
    }

    // 需求规则：原文语言不是第一语言就翻成第一语言，否则翻成第二语言；测不出来按第一语言。
    function pickTranslationDirection(text, config) {
      const { primary, secondary } = fetchTranslationDirectionConfig(config)
      const detectTo = detectLanguage(text)
      const target = !detectTo ? primary : detectTo === primary ? secondary : primary
      return { source: detectTo || 'auto', target: target, detected: detectTo }
    }

    function translationDirectionCopy(direction) {
      const source = direction && direction.source === 'auto' ? '自动检测' : translationLanguageTag(direction && direction.source)
      return `${source} → ${translationLanguageTag(direction && direction.target)}`
    }

    // 按钮下面那行规则说明；lead 要求一行、20 字左右、不可点选。
    function translationRuleCopy(config) {
      const { primary, secondary } = fetchTranslationDirectionConfig(config)
      return `自动：非${translationLanguageTag(primary)} → ${translationLanguageTag(primary)}，${translationLanguageTag(primary)} → ${translationLanguageTag(secondary)}`
    }

    const sentenceEndPunct = '。！？!?；;…'
    const collectTailChr = '」』"”’）)】]'
    const shortestPhrase = 10

    // 分段语义与 TTS 的 splitForSpeech 一致：单换行、句末标点都是边界，
    // 标点跟着前一句；不足最短短语的碎片并到相邻段；单片超上限才硬切。
    // 与 TTS 的区别：这里不能改字——不补标点、不吞空白，拼回去必须与原文逐字一致。
    // 返回 [{前导, 文本, 尾}]，组装译文把「前导 + 译文 + 尾」贴回即为原文。
    function splitSegment(text) {
      const original = String(text || '')
      if (!original) return []

      // 1) 基础片段：单换行与句末标点都切开，两侧空白留给前导/尾。
      const raw = []
      let fragmentStart = 0
      for (let i = 0; i <= original.length; i += 1) {
        const toEnd = i === original.length
        const swapLine = !toEnd && original[i] === '\n'
        const sentenceEnd = !toEnd && !swapLine && sentenceEndPunct.includes(original[i])
        if (!toEnd && !swapLine && !sentenceEnd) continue
        let end = i
        if (sentenceEnd) {
          end = i + 1
          while (end < original.length && collectTailChr.includes(original[end])) end += 1
        }
        // 只保留非空白内容：两端的空白归前导/尾，中间的空白（含换行）留在文本里。
        let contentStart = fragmentStart
        while (contentStart < end && /\s/.test(original[contentStart])) contentStart += 1
        let contentEnd = end
        while (contentEnd > contentStart && /\s/.test(original[contentEnd - 1])) contentEnd -= 1
        if (contentStart < contentEnd) raw.push({ start: contentStart, end: contentEnd })
        fragmentStart = swapLine ? i + 1 : end
        if (sentenceEnd) i = end - 1
      }
      if (!raw.length) return [{ leading: original, text: '', tail: '' }]

      // 2) 太短的碎片不单独成段：优先并下一段，最后一段并到上一段。
      const merge = []
      let i = 0
      while (i < raw.length) {
        let range = raw[i]
        i += 1
        while (range.end - range.start < shortestPhrase && i < raw.length) {
          range = { start: range.start, end: raw[i].end }
          i += 1
        }
        merge.push(range)
      }
      if (merge.length >= 2 && merge[merge.length - 1].end - merge[merge.length - 1].start < shortestPhrase) {
        const last = merge.pop()
        merge[merge.length - 1].end = last.end
      }

      // 3) 只有单片超过上限才硬切：尽量在逗号/顿号/空格后断开，实在没有就按字数切。
      const ranges = []
      for (const range of merge) {
        if (range.end - range.start <= segmentCharsLimit) {
          ranges.push(range)
          continue
        }
        let start = range.start
        while (range.end - start > segmentCharsLimit) {
          const window = original.slice(start, start + segmentCharsLimit)
          const commaMark = Math.max(
            window.lastIndexOf('，'),
            window.lastIndexOf(','),
            window.lastIndexOf('、'),
            window.lastIndexOf(' '),
            window.lastIndexOf('\t'),
            window.lastIndexOf('\n'),
          )
          let toggle = start + segmentCharsLimit
          if (commaMark > segmentCharsLimit * 0.6) toggle = start + commaMark + 1
          if (toggle > start && toggle < range.end && /[\uDC00-\uDFFF]/.test(original[toggle]) && /[\uD800-\uDBFF]/.test(original[toggle - 1])) toggle -= 1
          ranges.push({ start, end: toggle })
          start = toggle
        }
        if (start < range.end) ranges.push({ start, end: range.end })
      }

      // 4) 区间还原成「前导/文本/尾」：段间空白归前一段的尾，首段前导是最前面的空白。
      const segments = []
      ranges.forEach((range, index) => {
        const leading = index === 0 ? original.slice(0, range.start) : ''
        const tail = index + 1 < ranges.length ? original.slice(range.end, ranges[index + 1].start) : original.slice(range.end)
        segments.push({ leading, text: original.slice(range.start, range.end), tail })
      })
      return segments
    }

    function assembleTranslated(segments, translatedTable) {
      return segments.map((segment, index) => `${segment.leading || ''}${translatedTable[index] == null ? '' : translatedTable[index]}${segment.tail || ''}`).join('')
    }

    // 缓存键带方向：同一段中文翻英文和翻日文的译文不能混用。
    const translationCache = new Map()

    function cacheKey(direction, text) {
      const source = (direction && direction.source) || 'auto'
      const target = (direction && direction.target) || ''
      return `${source}→${target}\u0000${text}`
    }

    function readCache(direction, text) {
      const key = cacheKey(direction, text)
      if (!translationCache.has(key)) return undefined
      const translated = translationCache.get(key)
      translationCache.delete(key)
      translationCache.set(key, translated)
      return translated
    }

    function writeCache(direction, text, translated) {
      const key = cacheKey(direction, text)
      translationCache.delete(key)
      translationCache.set(key, translated)
      while (translationCache.size > translationCacheLimit) {
        const oldest = translationCache.keys().next().value
        translationCache.delete(oldest)
      }
    }

    function clearTranslationCache() {
      translationCache.clear()
    }

    // 规划：空段不翻；命中缓存的段直接用，剩下的才要请求。
    function planTranslation(segments, direction) {
      const translatedTable = segments.map(() => '')
      const pending = []
      segments.forEach((segment, index) => {
        if (!segment.text) return
        const hit = readCache(direction, segment.text)
        if (hit !== undefined) {
          translatedTable[index] = hit
          return
        }
        pending.push({ index, text: segment.text })
      })
      return { translatedTable, pending }
    }

    function planBatchNo(pending, segmentCountLimit = perBatchSegmentCountLimit, charsLimit = perBatchCharsLimit) {
      const batches = []
      let current = []
      let chars = 0
      for (const item of pending) {
        if (current.length && (current.length >= segmentCountLimit || chars + item.text.length > charsLimit)) {
          batches.push(current)
          current = []
          chars = 0
        }
        current.push(item)
        chars += item.text.length
      }
      if (current.length) batches.push(current)
      return batches
    }

    // ---------------- 分段映射 ----------------
    //
    // pieces[i] = { originalStart, originalEnd, originalSnapshot, translatedStart, translatedEnd, translated }
    //   - originalStart/End：第 i 段正文在「原文侧」文本里的区间（不含前导空白和句尾空白）；
    //   - translatedStart/End：对应译文在另一侧文本里的区间；
    //   - originalSnapshot：上次翻译时这段的原文，用来判断这段改没改；
    //   - translated：这段是否已经有译文可沿用。
    // 编辑时只把区间折过去，不重排分段；删除/移动分段时再按区间重建两侧文本。

    // 两次文本之间「最小改动区间」：把中间那段换掉。
    function getEditRange(prevText, nextText) {
      const prev = String(prevText || '')
      const next = String(nextText || '')
      const shortest = Math.min(prev.length, next.length)
      let start = 0
      while (start < shortest && prev[start] === next[start]) start += 1
      let tail = 0
      while (tail < shortest - start && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1
      return { start, prevEnd: prev.length - tail, nextEnd: next.length - tail }
    }

    // 把旧文本里的一个下标折到新文本里；改区间内部的边界贴到改动末尾。
    function mapPosition(position, edit) {
      // 纯插入：插在 p 之后的所有边界后移；只有整篇最开头（p=0）的插入算进第一段，
      // 否则开头新写的字会掉进前导空白、永远不参与翻译。
      if (edit.start === edit.prevEnd) {
        if (position === 0 && edit.start === 0) return 0
        return position >= edit.start ? position + (edit.nextEnd - edit.prevEnd) : position
      }
      if (position <= edit.start) return position
      if (position >= edit.prevEnd) return position + (edit.nextEnd - edit.prevEnd)
      return edit.nextEnd
    }

    // side = 'original' | 'translated'：只调这一侧的区间，另一侧不动。
    function adjustPieceOffset(pieces, side, prevText, nextText) {
      if (!Array.isArray(pieces) || !pieces.length) return pieces
      const edit = getEditRange(prevText, nextText)
      if (edit.start === edit.prevEnd && edit.start === edit.nextEnd) return pieces
      const startKey = side === 'original' ? 'originalStart' : 'translatedStart'
      const endKey = side === 'original' ? 'originalEnd' : 'translatedEnd'
      const length = String(nextText || '').length
      return pieces.map((item) => {
        const start = Math.min(length, Math.max(0, mapPosition(item[startKey], edit)))
        const end = Math.min(length, Math.max(start, mapPosition(item[endKey], edit)))
        return { ...item, [startKey]: start, [endKey]: end }
      })
    }

    // 把整段文本按分段区间拆成「前导们 + 内容们」；前导们 比 内容们 多一项。
    function switchFragment(text, pieces, startKey, endKey) {
      const original = String(text || '')
      const leadings = []
      const contents = []
      let cursor = 0
      for (const item of pieces) {
        const start = Math.min(original.length, Math.max(cursor, item[startKey]))
        const end = Math.min(original.length, Math.max(start, item[endKey]))
        leadings.push(original.slice(cursor, start))
        contents.push(original.slice(start, end))
        cursor = end
      }
      leadings.push(original.slice(cursor))
      return { leadings, contents }
    }

    // 取某一侧的渲染片段；没有有效映射时返回 null（此时不显示分段高亮）。
    // 原文坐标记在 映射侧：同步态下 原文侧 为 null，但映射仍然可用。
    function fetchSideFragment(status, side) {
      const pieces = status && status.pieces
      const sideMap = status && (status.sideMap || status.originalSide)
      if (!Array.isArray(pieces) || !pieces.length || !sideMap) return null
      const text = String(status[side] || '')
      if (side === sideMap) return switchFragment(text, pieces, 'originalStart', 'originalEnd')
      return switchFragment(text, pieces, 'translatedStart', 'translatedEnd')
    }

    function mapValid(status) {
      const sideMap = status && (status.sideMap || status.originalSide)
      if (!sideMap) return false
      const pieces = status.pieces
      if (!Array.isArray(pieces) || !pieces.length) return false
      const otherOneSide = sideMap === 'upper' ? 'lower' : 'upper'
      const originalText = String(status[sideMap] || '')
      const translatedText = String(status[otherOneSide] || '')
      for (const item of pieces) {
        if (!item || item.originalStart > item.originalEnd || item.translatedStart > item.translatedEnd) return false
        if (item.originalStart < 0 || item.translatedStart < 0) return false
        if (item.originalEnd > originalText.length || item.translatedEnd > translatedText.length) return false
      }
      return true
    }

    // 由「切段结果 + 每段译文」拼出两侧文本和分段映射；已译表决定哪段可沿用。
    function joinSegments(segments, translatedTable, translatedSet) {
      const originalChunk = []
      const translationChunk = []
      const pieces = []
      let origCursor = 0
      let translateCursor = 0
      segments.forEach((segment, index) => {
        const leading = String(segment.leading || '')
        const bodyText = String(segment.text || '')
        const tail = String(segment.tail || '')
        const translated = translatedTable[index] == null ? '' : String(translatedTable[index])
        const originalStart = origCursor + leading.length
        const originalEnd = originalStart + bodyText.length
        const translatedStart = translateCursor + leading.length
        const translatedEnd = translatedStart + translated.length
        originalChunk.push(leading, bodyText, tail)
        translationChunk.push(leading, translated, tail)
        origCursor = originalEnd + tail.length
        translateCursor = translatedEnd + tail.length
        pieces.push({
          originalStart,
          originalEnd,
          originalSnapshot: bodyText,
          translatedStart,
          translatedEnd,
          translated: translatedSet ? Boolean(translatedSet[index]) : true,
        })
      })
      return { originalText: originalChunk.join(''), translatedText: translationChunk.join(''), pieces }
    }

    function sameDirection(alpha, beta) {
      return Boolean(alpha && beta && alpha.source === beta.source && alpha.target === beta.target)
    }

    // 这次要翻什么：方向按原文侧现算；没改过的段先沿用 state 里的译文，
    // 再查全局缓存，都没有的才进待翻。待翻的段先用上一版译文占位，
    // 中途失败/取消时框里不会整段变空。
    function buildTranslationPlan(status, config) {
      if (!status || !status.originalSide) return null
      const side = status.originalSide
      const otherOneSide = side === 'upper' ? 'lower' : 'upper'
      const original = String(status[side] || '')
      if (!original.trim()) return null
      const direction = pickTranslationDirection(original, config)
      const segments = splitSegment(original)
      const prevPieces = Array.isArray(status.pieces) && status.pieces.length ? status.pieces : []
      const prevTranslated = String(status[otherOneSide] || '')
      const canReuse = sameDirection(status.direction, direction) && prevPieces.length > 0
      const translatedTable = segments.map(() => '')
      const translated = segments.map(() => false)
      const pending = []
      const used = new Set()
      segments.forEach((segment, index) => {
        if (!segment.text) {
          translatedTable[index] = ''
          translated[index] = true
          return
        }
        if (canReuse) {
          for (let k = 0; k < prevPieces.length; k += 1) {
            const item = prevPieces[k]
            if (used.has(k) || !item.translated || item.originalSnapshot !== segment.text) continue
            translatedTable[index] = prevTranslated.slice(item.translatedStart, item.translatedEnd)
            translated[index] = true
            used.add(k)
            return
          }
        }
        const cache = readCache(direction, segment.text)
        if (cache !== undefined) {
          translatedTable[index] = cache
          translated[index] = true
          return
        }
        const prevItem = prevPieces.length ? prevPieces[index] : null
        if (prevItem && prevItem.translated) translatedTable[index] = prevTranslated.slice(prevItem.translatedStart, prevItem.translatedEnd)
        pending.push({ index, text: segment.text })
      })
      const totalSegmentCount = segments.filter((segment) => segment.text).length
      return {
        side,
        otherOneSide,
        original,
        direction,
        segments,
        translatedTable,
        translated,
        pending,
        totalSegmentCount,
        reuseCount: totalSegmentCount - pending.length,
      }
    }

    function planMap(plan) {
      return joinSegments(plan.segments, plan.translatedTable, plan.translated)
    }

    function translationBeginStatus(prev, plan) {
      const result = planMap(plan)
      return {
        ...prev,
        phase: '翻译中',
        prompt: '',
        success: '',
        direction: plan.direction,
        originalSide: plan.side,
        sideMap: plan.side,
        progress: { done: 0, totalCount: plan.pending.length },
        [plan.side]: plan.original,
        [plan.otherOneSide]: result.translatedText,
        pieces: result.pieces,
      }
    }

    function translationSuccessStatus(prev, plan) {
      const result = planMap(plan)
      const reuseCopy = plan.reuseCount ? `（${plan.reuseCount} 段沿用上次）` : ''
      return {
        ...prev,
        // 翻完回同步态：两框对应且都可编辑，原文侧清空，谁再编辑谁就是新的原文。
        phase: '同步',
        originalSide: null,
        sideMap: plan.side,
        prompt: '',
        progress: null,
        direction: plan.direction,
        [plan.side]: plan.original,
        [plan.otherOneSide]: result.translatedText,
        pieces: result.pieces,
        success: `${translationDirectionCopy(plan.direction)} · 已翻译 ${plan.totalSegmentCount} 段${reuseCopy}`,
      }
    }

    function translationAbortState(prev, plan, _phase, prompt) {
      const result = planMap(plan)
      return {
        ...prev,
        // 失败 / 取消都退回「修改中」：原文侧保留，已翻好的段留在框里，按钮显示继续翻译。
        phase: '修改中',
        originalSide: plan.side,
        sideMap: plan.side,
        prompt: prompt || '',
        success: '',
        progress: null,
        [plan.side]: plan.original,
        [plan.otherOneSide]: result.translatedText,
        pieces: result.pieces,
      }
    }

    const translationRetryCode = ['service_down', 'model_loading', 'busy', 'timeout', 'upstream_error']
    // 服务端任务状态 -> 面板阶段。done 后还要取一次结果，所以叫「整理译文」。
    const taskPhaseCopy = {
      queued: '排队中',
      running: '翻译中',
      done: '整理译文',
      failed: '翻译失败',
      canceled: '已取消',
    }
    const coldStartPrompt = '正在加载翻译模型，第一次会慢一点（约 40 秒）'

    // 只跑待翻的批，一次一批（可取译文=1），每批走异步任务：提交 → 轮询 → 取结果。
    // post / get / 等待 / 运行 / 现在 都由调用方注入，单元测试可以完全不走网络。
    async function runTranslation(plan, dep = {}) {
      const send =
        typeof dep.post === 'function'
          ? dep.post
          : (path, body, option) => post(path, body, option || {})
      const fetchStatus =
        typeof dep.get === 'function'
          ? dep.get
          : (path) => get(path)
      const run = dep.run || { canceled: false, controller: null }
      const push = typeof dep.push === 'function' ? dep.push : () => {}
      const wait = typeof dep.wait === 'function' ? dep.wait : (ms) => new Promise((ok) => setTimeout(ok, ms))
      const now = typeof dep.now === 'function' ? dep.now : () => Date.now()
      const pollMs = Number.isFinite(dep.pollMs) ? Math.max(0, dep.pollMs) : taskPollMs
      const coldStartMs = Number.isFinite(dep.coldStartMs) ? Math.max(0, dep.coldStartMs) : taskColdStartMs
      const totalDurationLimit = Number.isFinite(dep.totalDurationLimit) ? Math.max(0, dep.totalDurationLimit) : taskTotalDurationLimit
      // 任务批比同步批小：冷启动时单批耗时可控。
      const batches = planBatchNo(plan.pending, taskPerBatchSegmentCount, taskPerBatchChars)
      let done = 0
      let fail = ''
      let revert = false
      const begin = now()

      const notice = (phase, prompt = '') => {
        push(done, { phase, prompt, used: Math.max(0, now() - begin), totalCount: plan.pending.length })
      }

      const writeBackOneSegment = (item, translated) => {
        if (typeof translated === 'string' && translated) {
          plan.translatedTable[item.index] = translated
          plan.translated[item.index] = true
          writeCache(plan.direction, item.text, translated)
          done += 1
          return true
        }
        fail = '这次没翻完，可以点继续翻译重试'
        return false
      }

      // 回退分支：旧版服务的同步批量接口，超时放宽到 3 分钟。
      const syncOneBatch = async (batch) => {
        const body = {
          texts: batch.map((item) => ({ id: item.index, text: item.text })),
          source: plan.direction.source,
          target: plan.direction.target,
          timeoutMs: 180000,
        }
        const option = run.controller ? { signal: run.controller.signal } : undefined
        let result
        try {
          result = await send('/translate/batch', body, option)
        } catch {
          result = null
        }
        if (run.canceled) return
        if (!result) {
          fail = '连接本地 AI 失败，可以点继续翻译重试'
          return
        }
        if (result.ok && Array.isArray(result.results)) {
          const byIndex = new Map()
          for (const entry of result.results) byIndex.set(String(entry && entry.id), entry)
          for (const item of batch) {
            const entry = byIndex.get(String(item.index))
            if (entry && !entry.error && typeof entry.translated === 'string') writeBackOneSegment(item, entry.translated)
            else fail = (entry && entry.error && entry.error.hint) || '这次没翻完，可以点继续翻译重试'
          }
          notice('翻译中')
          return
        }
        fail = (result.ok ? '' : result.hint) || '这次没翻完，可以点继续翻译重试'
      }

      const submitOneBatch = async (batch) => {
        const body = {
          texts: batch.map((item) => item.text),
          source: plan.direction.source,
          target: plan.direction.target,
        }
        const option = run.controller ? { signal: run.controller.signal } : undefined
        const emitOneOnce = async () => {
          try {
            return await send('/translate/jobs', body, option)
          } catch {
            return null
          }
        }
        let result = await emitOneOnce()
        if (run.canceled) return { canceled: true }
        if (result && !result.ok && translationRetryCode.includes(result.code)) {
          await wait(800)
          if (run.canceled) return { canceled: true }
          result = await emitOneOnce()
        }
        if (!result) return { ok: false, hint: '提交翻译任务失败，可以点继续翻译重试' }
        if (result.ok && result.id) return { ok: true, id: String(result.id) }
        // 旧版服务没有任务接口：整轮改用同步批量。
        if (result.code === 'not_supported') return { revert: true }
        return { ok: false, hint: result.hint || '提交翻译任务失败，可以点继续翻译重试', code: result.code }
      }

      const bestEffortCancel = async (taskId) => {
        if (!taskId) return
        try {
          await send('/translate/jobs/cancel', { id: taskId })
        } catch {
          // 取消失败不阻塞面板停止。
        }
      }

      // 轮询一个任务直到终态；返回 { done } / { 失败 } / { 已取消 }。
      const awaitTask = async (taskId) => {
        run.taskId = taskId
        let phase = 'queued'
        let unreachable = 0
        for (;;) {
          if (run.canceled) {
            run.taskId = null
            await bestEffortCancel(taskId)
            return { canceled: true }
          }
          const used = Math.max(0, now() - begin)
          if (used > totalDurationLimit) {
            run.taskId = null
            fail = '翻译等太久了，已停下；翻好的段落都保留着'
            await bestEffortCancel(taskId)
            return { fail: true }
          }
          // 冷启动（模型加载 + 首次编译）超过 8 秒给明确提示，别让人以为卡死。
          if (used >= coldStartMs && (phase === 'queued' || phase === 'running')) {
            notice('准备模型', coldStartPrompt)
          } else {
            notice(taskPhaseCopy[phase] || '排队中')
          }
          let status
          try {
            status = await fetchStatus(`/translate/jobs/status?id=${encodeURIComponent(taskId)}`)
          } catch {
            status = null
          }
          if (run.canceled) {
            run.taskId = null
            await bestEffortCancel(taskId)
            return { canceled: true }
          }
          if (status && status.ok) {
            unreachable = 0
            phase = String(status.state || 'running')
            if (phase === 'done') return { done: true }
            if (phase === 'failed') {
              fail = (status.error && typeof status.error === 'string' && status.error) || '翻译任务失败了，可以点继续翻译重试'
              return { fail: true }
            }
            if (phase === 'canceled') return { canceled: true }
          } else {
            unreachable += 1
            const deterministicError = status && status.code && status.code !== 'upstream_error'
            if (deterministicError) {
              fail = status.hint || '翻译任务中断了，可以点继续翻译重试'
              return { fail: true }
            }
            if (unreachable >= 5) {
              fail = '与本地 AI 的连接中断了，翻好的段落都保留着'
              return { fail: true }
            }
          }
          await wait(pollMs)
        }
      }

      const fetchTranslated = async (taskId) => {
        try {
          const result = await fetchStatus(`/translate/jobs/result?id=${encodeURIComponent(taskId)}`)
          if (result && result.ok && Array.isArray(result.texts)) return result.texts
          return null
        } catch {
          return null
        }
      }

      for (const batch of batches) {
        if (run.canceled || fail) break
        if (revert) {
          await syncOneBatch(batch)
          continue
        }
        notice('提交中')
        const submit = await submitOneBatch(batch)
        if (submit.canceled || run.canceled) {
          run.taskId = null
          break
        }
        if (submit.revert) {
          // 第一批复用同一份文本走同步接口，后续批也留在同步路径。
          revert = true
          await syncOneBatch(batch)
          continue
        }
        if (!submit.ok) {
          fail = submit.hint
          break
        }
        const status = await awaitTask(submit.id)
        if (status.canceled) break
        if (status.fail) break
        const translations = await fetchTranslated(submit.id)
        run.taskId = null
        if (!translations) {
          fail = '没取到译文，可以点继续翻译重试'
          break
        }
        for (let i = 0; i < batch.length; i += 1) writeBackOneSegment(batch[i], translations[i])
        notice('翻译中')
      }

      if (run.canceled) await bestEffortCancel(run.taskId)
      return { done, fail, canceled: Boolean(run.canceled), requestBatchNo: batches.length, revert }
    }

    // ---------------- 分段删除 / 移动（只改文本和映射，不请求翻译） ----------------

    function deleteFragmentItem(fragment, index) {
      const segmentCount = fragment.contents.length
      fragment.contents.splice(index, 1)
      if (index < segmentCount - 1) fragment.leadings.splice(index + 1, 1)
      else fragment.leadings.splice(index, 1)
    }

    function swapFragmentItem(fragment, alpha, beta) {
      const temp = fragment.contents[alpha]
      fragment.contents[alpha] = fragment.contents[beta]
      fragment.contents[beta] = temp
    }

    // 片段们 -> 两侧文本 + 新分段映射；原文快照/已译跟着原来的段走。
    function buildMapFromFragments(originalFragment, translatedFragment, origin, prevPieces) {
      const segmentCount = originalFragment.contents.length
      const pieces = []
      let sourceText = originalFragment.leadings[0] || ''
      let translatedCurrent = translatedFragment.leadings[0] || ''
      for (let i = 0; i < segmentCount; i += 1) {
        const contentOrig = originalFragment.contents[i] || ''
        const contentTranslate = translatedFragment.contents[i] || ''
        const originalStart = sourceText.length
        const originalEnd = originalStart + contentOrig.length
        const translatedStart = translatedCurrent.length
        const translatedEnd = translatedStart + contentTranslate.length
        sourceText += contentOrig + (originalFragment.leadings[i + 1] || '')
        translatedCurrent += contentTranslate + (translatedFragment.leadings[i + 1] || '')
        const prev = prevPieces[origin[i]]
        pieces.push({
          originalStart,
          originalEnd,
          originalSnapshot: prev ? prev.originalSnapshot : contentOrig,
          translatedStart,
          translatedEnd,
          translated: prev ? prev.translated : false,
        })
      }
      return { originalText: sourceText, translatedText: translatedCurrent, pieces }
    }

    // 操作 = '删除' | '上移' | '下移'；只动本地状态，不调用翻译服务。
    function pieceAction(status, action, index) {
      if (!status || status.phase === '翻译中') return status
      if (!mapValid(status)) return status
      const pieces = status.pieces
      const position = Number(index)
      if (!Number.isInteger(position) || position < 0 || position >= pieces.length) return status
      const sideMap = status.sideMap || status.originalSide
      if (!sideMap) return status
      const otherOneSide = sideMap === 'upper' ? 'lower' : 'upper'
      const originalFragment = switchFragment(status[sideMap], pieces, 'originalStart', 'originalEnd')
      const translatedFragment = switchFragment(status[otherOneSide], pieces, 'translatedStart', 'translatedEnd')
      const origin = pieces.map((_, i) => i)
      if (action === '删除') {
        deleteFragmentItem(originalFragment, position)
        deleteFragmentItem(translatedFragment, position)
        origin.splice(position, 1)
      } else if (action === '上移' && position > 0) {
        swapFragmentItem(originalFragment, position, position - 1)
        swapFragmentItem(translatedFragment, position, position - 1)
        const temp = origin[position]
        origin[position] = origin[position - 1]
        origin[position - 1] = temp
      } else if (action === '下移' && position < pieces.length - 1) {
        swapFragmentItem(originalFragment, position, position + 1)
        swapFragmentItem(translatedFragment, position, position + 1)
        const temp = origin[position]
        origin[position] = origin[position + 1]
        origin[position + 1] = temp
      } else {
        return status
      }
      const map = buildMapFromFragments(originalFragment, translatedFragment, origin, pieces)
      if (!map.originalText.trim() && !map.translatedText.trim()) return translationEmptyStatus()
      return {
        ...status,
        [sideMap]: map.originalText,
        [otherOneSide]: map.translatedText,
        pieces: map.pieces,
        success: '',
        // 同步态里做结构编辑：把映射锚定的一侧定为原文，之后可以直接点翻译。
        ...(status.phase === '同步' ? { phase: '修改中', originalSide: sideMap } : {}),
      }
    }

    // ---------------- 状态机 ----------------

    // 三态（只有三档，旧的「空闲 / 待翻译 / 失败 / 已取消」不再使用）：
    //   同步：两框内容互相对应，都可编辑；此时没有「原文侧」。
    //   修改中：被编辑的那侧是原文，另一侧只读；原文清空回同步。
    //   翻译中：两侧都只读。
    // 映射的原文坐标记在 映射侧：同步态下 原文侧 为 null，但映射侧保留，
    // 所以分段高亮 / 上移 / 下移 / 删除在同步态仍然可用。

    function translationEmptyStatus() {
      return { upper: '', lower: '', originalSide: null, phase: '同步', prompt: '', progress: null, direction: null, success: '', pieces: null, sideMap: null }
    }

    // 把映射的原文侧换到另一侧：文本一个字都不动，只交换每段的坐标。
    function flipToMap(status, nextOriginalSide) {
      const pieces = status && status.pieces
      if (!Array.isArray(pieces) || !pieces.length) return pieces || null
      const prevOriginalSide = status.sideMap || status.originalSide
      if (!prevOriginalSide || prevOriginalSide === nextOriginalSide) return pieces
      const nextOriginalText = String(status[nextOriginalSide] || '')
      return pieces.map((item) => ({
        ...item,
        originalStart: item.translatedStart,
        originalEnd: item.translatedEnd,
        translatedStart: item.originalStart,
        translatedEnd: item.originalEnd,
        originalSnapshot: nextOriginalText.slice(item.translatedStart, item.translatedEnd),
      }))
    }

    // 「改这一侧」：只换原文 / 译文的角色，两边文本都不动。
    function switchSwapOriginalSide(status) {
      if (!status || status.phase !== '修改中' || !status.originalSide) return status
      const nextSide = status.originalSide === 'upper' ? 'lower' : 'upper'
      return {
        ...status,
        originalSide: nextSide,
        sideMap: nextSide,
        pieces: flipToMap(status, nextSide),
        direction: null,
        progress: null,
        prompt: '',
        success: '',
      }
    }

    // 编辑规则：
    //   - 翻译中谁都不能改；
    //   - 同步态写入非空内容的那一侧成为原文，另一侧锁成译文输出；
    //   - 修改中只认原文侧，改译文侧直接拒绝；原文清空回到同步；
    //   - 分段映射跟着改动折偏移，没改过的段留给下次沿用。
    function translationEdit(status, side, value) {
      if (!status || status.phase === '翻译中') return status
      const text = String(value == null ? '' : value)
      const otherOneSide = side === 'upper' ? 'lower' : 'upper'
      const nextOne = { ...status, [side]: text, prompt: '', success: '' }
      const clear = !text.trim()

      if (status.phase === '修改中') {
        if (side !== status.originalSide) return status
        if (clear) {
          return { ...nextOne, phase: '同步', originalSide: null, sideMap: null, pieces: null, direction: null, progress: null }
        }
        return {
          ...nextOne,
          phase: '修改中',
          sideMap: side,
          pieces: adjustPieceOffset(status.pieces, 'original', status[side], text),
        }
      }

      // 同步态：空编辑保持同步；写入非空内容的那侧成为原文。
      if (clear) {
        return { ...nextOne, phase: '同步', originalSide: null, sideMap: null, pieces: null, direction: null, progress: null }
      }
      let pieces = status.pieces
      let prevText = status[side]
      if (Array.isArray(pieces) && pieces.length && status.sideMap && status.sideMap !== side) {
        pieces = flipToMap(status, side)
        prevText = String(status[side] || '')
      }
      return {
        ...nextOne,
        phase: '修改中',
        originalSide: side,
        sideMap: side,
        pieces: Array.isArray(pieces) && pieces.length ? adjustPieceOffset(pieces, 'original', prevText, text) : null,
        progress: null,
      }
    }

    function translationLockedSide(status) {
      if (!status || status.phase !== '修改中' || !status.originalSide) return null
      return status.originalSide === 'upper' ? 'lower' : 'upper'
    }

    function translationCanRun(status) {
      if (!status || status.phase !== '修改中' || !status.originalSide) return false
      return Boolean(String(status[status.originalSide] || '').trim())
    }

    function translationButtonLabel(status) {
      if (!status) return '翻译'
      if (status.phase === '翻译中') return '正在翻译…'
      if (status.phase === '修改中' && status.prompt) return '继续翻译'
      return '翻译'
    }

    // 每个会话留一份草稿：切走再切回来，原文和已翻好的译文都还在。
    const translationDraft = new Map()

    // 悬停只做预览高亮，点击才选中；选中状态不因鼠标移开而消失。
    function pieceEmptyInteraction() {
      return { hover: null, selected: null }
    }

    function pieceInteraction(interaction, event) {
      const current = interaction || pieceEmptyInteraction()
      const type = event && event.type
      const index = event && Number.isInteger(event.index) ? event.index : null
      if (type === '悬停') return { ...current, hover: index }
      if (type === '点击') return { ...current, hover: index, selected: index == null || current.selected === index ? null : index }
      return { ...current, selected: null }
    }

    // 固定工具条：无选中时只给提示，选中后按钮按首尾边界禁用。
    function pieceToolbar(pieceCount, selected, handle, cancelSelected) {
      const total = Math.max(0, Math.trunc(Number(pieceCount) || 0))
      const valid = selected != null && selected >= 0 && selected < total ? selected : null
      if (valid == null) {
        return [h('span', { key: '提示', className: 'fish-panel-dim' }, '点一下分段，可上移 / 下移 / 删除')]
      }
      const button = (key, text, available, title, action) =>
        h(
          'button',
          {
            key: key,
            type: 'button',
            className: action === '删除' ? 'fish-btn fish-tr-del' : 'fish-btn',
            disabled: !available,
            title: title,
            onClick: available && handle ? () => handle(action, valid) : undefined,
          },
          text,
        )
      return [
        h('span', { key: '位置', className: 'fish-panel-dim' }, `第 ${valid + 1}/${total} 段`),
        button('上移', '上移', valid > 0, '与上一段交换位置', '上移'),
        button('下移', '下移', valid < total - 1, '与下一段交换位置', '下移'),
        button('删除', '删除', true, '删除这一段，两侧一起删除', '删除'),
        h('button', { key: '取消选择', type: 'button', className: 'fish-btn', onClick: cancelSelected || undefined }, '取消选择'),
      ]
    }

    function translationPanel(props) {
      const sessionKey = String((props && props.sessionId) || '')
      const prefsState = useStore(prefs)
      const [status, setStatus] = React.useState(() => translationDraft.get(sessionKey) || translationEmptyStatus())
      const [interaction, setInteraction] = React.useState(pieceEmptyInteraction)
      const statusRef = React.useRef(status)
      statusRef.current = status
      const run = React.useRef(null)
      const inputRef = React.useRef({ upper: null, lower: null })
      const mirrorRef = React.useRef({ upper: null, lower: null })

      React.useEffect(() => {
        translationDraft.set(sessionKey, status)
        if (translationDraft.size > 20) {
          const oldest = translationDraft.keys().next().value
          if (oldest !== sessionKey) translationDraft.delete(oldest)
        }
      }, [sessionKey, status])

      React.useEffect(() => {
        if (!prefs.get().load) void loadPrefs()
        return () => {
          const running = run.current
          if (running) {
            running.canceled = true
            if (running.controller) running.controller.abort()
            if (running.taskId) void post('/translate/jobs/cancel', { id: running.taskId })
          }
          run.current = null
        }
      }, [])

      const config = (prefsState && prefsState.config) || {}
      const translating = status.phase === '翻译中'
      const lock = translationLockedSide(status)
      const hasMap = mapValid(status)
      const pieceCount = Array.isArray(status.pieces) ? status.pieces.length : 0
      const hoverSegment = hasMap && interaction.hover != null && interaction.hover >= 0 && interaction.hover < pieceCount ? interaction.hover : null
      const selectedSegment = hasMap && interaction.selected != null && interaction.selected >= 0 && interaction.selected < pieceCount ? interaction.selected : null

      // 段数可能随编辑/翻译变化，派发前先把越界的旧选中清掉。
      const interactionEvent = (event) => {
        setInteraction((prev) => pieceInteraction({ ...prev, selected: prev.selected != null && prev.selected < pieceCount ? prev.selected : null }, event))
      }

      const edit = (side, value) => {
        setInteraction((prev) => ({ ...prev, hover: null }))
        setStatus((prev) => translationEdit(prev, side, value))
      }

      const cancel = () => {
        const running = run.current
        if (!running) return
        running.canceled = true
        if (running.controller) running.controller.abort()
        // 只停本地轮询不够，顺手让服务端别继续占着队列。
        if (running.taskId) {
          const taskId = running.taskId
          running.taskId = null
          void post('/translate/jobs/cancel', { id: taskId })
        }
      }

      const handlePiece = (action, index) => {
        if (action === '取消选中') {
          setInteraction((prev) => ({ ...prev, selected: null }))
          return
        }
        const current = statusRef.current
        if (current.phase === '翻译中') return
        if (action === '删除') {
          const ask = typeof window !== 'undefined' && typeof window.confirm === 'function'
          if (ask && !window.confirm('删除这一段？两侧对应内容会一起删除，无法撤销。')) return
        }
        setStatus((prev) => pieceAction(prev, action, index))
        // 移动后选中跟着这段走；删除后回到未选。
        setInteraction((prev) => (action === '删除' ? pieceEmptyInteraction() : { hover: null, selected: action === '上移' ? index - 1 : index + 1 }))
      }

      // 「改这一侧」：把锁定侧换成原文，只换角色、不动文本。
      const switchSwapSide = () => {
        const current = statusRef.current
        if (current.phase === '翻译中' || !current.originalSide) return
        setStatus((prev) => switchSwapOriginalSide(prev))
        setInteraction((prev) => ({ ...prev, hover: null }))
      }

      const translation = async () => {
        const current = statusRef.current
        const plan = buildTranslationPlan(current, config)
        if (!plan) return
        setInteraction(pieceEmptyInteraction())
        const runObject = {
          canceled: false,
          controller: typeof AbortController === 'function' ? new AbortController() : null,
          taskId: null,
        }
        run.current = runObject
        setStatus((prev) => translationBeginStatus(prev, plan))
        const push = (done, info = {}) => {
          setStatus((prev) => ({
            ...translationBeginStatus(prev, plan),
            prompt: info.prompt || '',
            progress: {
              done,
              totalCount: plan.pending.length,
              phase: info.phase || '翻译中',
              used: info.used || 0,
            },
          }))
        }
        const result = await runTranslation(plan, { run: runObject, push })
        run.current = null
        if (runObject.canceled || (result && result.canceled)) {
          setStatus((prev) => translationAbortState(prev, plan, '已取消', '已取消，已翻好的部分保留'))
          return
        }
        if (result && result.fail) {
          setStatus((prev) => translationAbortState(prev, plan, '失败', result.fail))
          return
        }
        setStatus((prev) => translationSuccessStatus(prev, plan))
      }

      // 鼠标坐标落在哪一段：textarea 收事件，背后的 mirror 负责量出每段的位置。
      const hitPiece = (side, event) => {
        const current = statusRef.current
        if (!event || !mapValid(current)) return null
        const input = inputRef.current[side]
        const mirror = mirrorRef.current[side]
        if (!input || !mirror || typeof mirror.querySelectorAll !== 'function') return null
        const width = input.clientWidth
        if (width > 0 && mirror.style.width !== `${width}px`) mirror.style.width = `${width}px`
        if (mirror.scrollTop !== input.scrollTop) mirror.scrollTop = input.scrollTop
        if (mirror.scrollLeft !== input.scrollLeft) mirror.scrollLeft = input.scrollLeft
        const tapX = event.clientX
        const tapY = event.clientY
        for (const node of mirror.querySelectorAll('[data-seg]')) {
          for (const rect of node.getClientRects()) {
            if (tapX >= rect.left && tapX <= rect.right && tapY >= rect.top && tapY <= rect.bottom) {
              return Number(node.getAttribute('data-seg'))
            }
          }
        }
        return null
      }

      const syncScroll = (side) => {
        const input = inputRef.current[side]
        const mirror = mirrorRef.current[side]
        if (!input || !mirror) return
        mirror.scrollTop = input.scrollTop
        mirror.scrollLeft = input.scrollLeft
      }

      // 点两个框和工具条以外的空白：取消选中。
      const tapBlank = (event) => {
        const target = event && event.target
        if (!target) return
        const category = typeof target.className === 'string' ? target.className : ''
        if (category.includes('fish-tr-textarea')) return
        if (target.closest && target.closest('.fish-tr-edit, .fish-tr-segbar, .fish-tr-actions')) return
        setInteraction((prev) => ({ ...prev, hover: null, selected: null }))
      }

      const renderMirror = (side) => {
        const fragment = fetchSideFragment(status, side)
        if (!fragment) return null
        const children = []
        for (let i = 0; i < fragment.contents.length; i += 1) {
          children.push(fragment.leadings[i] || '')
          children.push(
            h(
              'span',
              {
                key: `段${i}`,
                className: 'fish-tr-seg',
                'data-seg': i,
                'data-active': hoverSegment === i ? '1' : undefined,
                'data-selected': selectedSegment === i ? '1' : undefined,
              },
              fragment.contents[i] || '',
            ),
          )
        }
        children.push(fragment.leadings[fragment.contents.length] || '')
        return children
      }

      const sideTag = (side) => {
        if (status.phase === '同步' || !status.originalSide) return '可输入'
        return side === status.originalSide ? '原文' : '译文'
      }
      const sideDescription = (side) => {
        if (translating) return '正在翻译，暂时不能编辑'
        if (!status.originalSide) return ''
        if (side === status.originalSide) return '这边是原文'
        return '译文输出，翻译完成前不可编辑'
      }
      const placeholder = (side) => {
        if (!status.originalSide || side === status.originalSide) return '输入或粘贴要翻译的文字'
        return '点「翻译」后，译文出现在这里'
      }

      const canRun = translationCanRun(status)
      const emptyText = !String(status.upper || '').trim() && !String(status.lower || '').trim()
      const disabledReason = canRun || translating || !emptyText ? '' : '先输入要翻译的文字'
      const buttonTitle = translating
        ? '正在翻译，请稍候'
        : canRun
          ? undefined
          : status.phase === '同步' && !emptyText
            ? '先在一个框里改点内容，改过的那一侧会成为原文'
            : '先输入要翻译的文字'
      const progress = (translating && status.progress) || null
      const progressPhase = progress && progress.phase && progress.phase !== '翻译中' ? progress.phase : ''
      const usedSeconds = progress && progress.used >= 1000 ? Math.round(progress.used / 1000) : 0
      const progressBar = progress
        ? [`正在翻译 ${progress.done || 0}/${progress.totalCount || 0} 段`, progressPhase, usedSeconds ? `已用 ${usedSeconds} 秒` : '']
            .filter(Boolean)
            .join(' · ')
        : ''

      const oneColumn = (side) =>
        h(
          'div',
          {
            className: 'fish-tr-pane',
            'data-locked': lock === side ? '1' : undefined,
            'data-busy': translating ? '1' : undefined,
          },
          h(
            'div',
            { className: 'fish-tr-head' },
            h('span', { className: 'fish-tr-role' }, sideTag(side)),
            h('span', { className: 'fish-panel-dim' }, sideDescription(side)),
            lock === side
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'fish-tr-switch',
                    title: '把这侧改成原文，另一侧作为译文输出',
                    onClick: switchSwapSide,
                  },
                  '改这一侧',
                )
              : null,
          ),
          h(
            'div',
            { className: 'fish-tr-edit' },
            hasMap ? h('div', { className: 'fish-tr-mirror', 'aria-hidden': 'true', ref: (node) => { mirrorRef.current[side] = node } }, renderMirror(side)) : null,
            h('textarea', {
              className: 'fish-tr-textarea',
              value: status[side],
              readOnly: translating || lock === side,
              disabled: false,
              placeholder: placeholder(side),
              'aria-label': `${sideTag(side)}框`,
              ref: (node) => { inputRef.current[side] = node },
              onMouseMove: (event) => interactionEvent({ type: '悬停', index: hitPiece(side, event) }),
              onMouseLeave: () => interactionEvent({ type: '悬停', index: null }),
              onClick: (event) => interactionEvent({ type: '点击', index: hitPiece(side, event) }),
              onScroll: () => syncScroll(side),
              onChange: (event) => edit(side, event.target.value),
            }),
          ),
        )

      const pieceEntry =
        hasMap && !translating
          ? h(
              'div',
              { className: 'fish-tr-segbar', 'data-idle': selectedSegment == null ? '1' : undefined },
              pieceToolbar(pieceCount, selectedSegment, handlePiece, () => handlePiece('取消选中', null)),
            )
          : null

      const hintIsError = Boolean(status.prompt) && !String(status.prompt).startsWith('已取消')
      const prompt = status.prompt
        ? h('div', { className: hintIsError ? 'fish-err fish-tr-note' : 'fish-panel-dim fish-tr-note', role: 'status' }, status.prompt)
        : status.success
          ? h('div', { className: 'fish-ok fish-tr-note', role: 'status' }, status.success)
          : disabledReason
            ? h('div', { className: 'fish-panel-dim fish-tr-note' }, disabledReason)
            : null

      return h(
        'div',
        {
          className: 'fish-tr',
          onMouseDown: tapBlank,
          // Esc 取消选中：焦点可能在文本框、按钮或工具条上，统一在卡片根上接。
          onKeyDown: (event) => {
            if (event && event.key === 'Escape') interactionEvent({ type: '取消' })
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
                disabled: !canRun,
                title: buttonTitle,
                'aria-busy': translating ? 'true' : undefined,
                onClick: () => void translation(),
              },
              translating ? iconSpinner(13) : null,
              translationButtonLabel(status),
            ),
            translating ? h('button', { type: 'button', className: 'fish-btn', onClick: cancel }, '取消') : null,
            progressBar ? h('span', { className: 'fish-panel-dim', role: 'status' }, progressBar) : null,
          ),
          prompt,
          h('div', { className: 'fish-panel-dim fish-tr-note' }, translationRuleCopy(config)),
          pieceEntry,
        ),
        h('div', { className: 'fish-tr-grid' }, oneColumn('upper'), oneColumn('lower')),
      )
    }

    function translationIcon({ size = 26, className } = {}) {
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
    const readyRetryIntervalMs = 250
    const readyMaxCount = 40
    function awaitReady(tryOnce) {
      let count = 0
      let timer = null
      let canceled = false
      let cleanup = null
      const execute = () => {
        if (canceled) return
        const result = tryOnce()
        if (result === null) {
          if (count < readyMaxCount) {
            count += 1
            timer = setTimeout(execute, readyRetryIntervalMs)
          } else {
            try { console.warn('[dsh-fish-service] 服务没就绪，注册已放弃') } catch { /* 忽略 */ }
          }
          return
        }
        cleanup = typeof result === 'function' ? result : null
      }
      execute()
      return () => {
        canceled = true
        if (timer) { clearTimeout(timer); timer = null }
        if (cleanup) {
          try { cleanup() } catch { /* 已卸载 */ }
          cleanup = null
        }
      }
    }

    // 右栏「开始」页的卡片：注册一个 tab 类型 + guide 条目，body 走 sidebar.right.pane.tab 槽。
    function registerRightPanel(ctx) {
      return awaitReady(() => {
        let rightPanel = null
        try {
          rightPanel = ctx.get('sidebarRightTabs')
        } catch {
          rightPanel = null
        }
        if ((!rightPanel || typeof rightPanel.register !== 'function') && ctx && ctx.sidebarRightTabs) rightPanel = ctx.sidebarRightTabs
        if (!rightPanel || typeof rightPanel.register !== 'function') return null
        try {
          const summary = rightPanel.register({
            id: translationTabID,
            kind: translationTabKind,
            title: () => '双语翻译',
            keepMounted: true,
            guide: [
              {
                id: 'translate',
                order: 35,
                title: () => '双语翻译',
                description: () => '两段文字对着翻，长的只重译改过的地方',
                icon: translationIcon,
              },
            ],
          })
          return typeof summary === 'function' ? summary : () => {}
        } catch (error) {
          try { console.warn('[dsh-fish-service] 注册双语翻译卡片失败', error) } catch { /* 忽略 */ }
          return () => {}
        }
      })
    }

    // ---------------- 注册 ----------------

    function register(ctx, slot, configItem, component) {
      try {
        return slotsRegister(ctx, slot, configItem, component)
      } catch (error) {
        // 槽位在这个 DSH 版本不存在时不要让整个插件挂掉。
        try { console.warn('[dsh-fish-service] 注册槽位失败', slot, error) } catch { /* 忽略 */ }
        return () => {}
      }
    }

    function slotsRegister(ctx, slot, configItem, component) {
      return awaitReady(() => {
        const slots = ctx.get('slots')
        if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return null
        try {
          const summary = slots.inject(slot, () => slots.register({ name: slot, ...configItem }, component))
          return typeof summary === 'function' ? summary : () => {}
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
    function registerSelectedInteraction(ctx) {
      const summary = []
      try {
        const ui = ctx.get('uiConversation')
        const interaction = ui && ui.interactions
        if (interaction && typeof interaction.register === 'function') {
          const disposer = interaction.register({
            id: selectedInteractionID,
            onInteraction(request) {
              if (!request || request.trigger !== 'selection') return
              const text = typeof request.readText === 'function' ? request.readText() : null
              if (text === null || !String(text).trim()) return
              if (typeof request.open === 'function') request.open()
            },
          }, '选中文字的朗读与翻译')
          if (typeof disposer === 'function') summary.push(disposer)
        }
      } catch (error) {
        try { console.warn('[dsh-fish-service] 注册选中交互失败', error) } catch { /* 忽略 */ }
      }
      try {
        const slots = ctx.get('slots')
        if (slots && typeof slots.register === 'function' && typeof slots.inject === 'function') {
          const disposer = slots.inject('conversation.chat.text-interaction', () => slots.register({
            name: 'conversation.chat.text-interaction',
            key: selectedInteractionID,
          }, selectedToolbar))
          if (typeof disposer === 'function') summary.push(disposer)
        }
      } catch (error) {
        try { console.warn('[dsh-fish-service] 注册选中文字槽位失败', error) } catch { /* 忽略 */ }
      }
      return () => {
        for (const fn of summary.splice(0)) {
          try { fn() } catch { /* 已卸载 */ }
        }
      }
    }

    function apply(ctx) {
      pluginContext = ctx
      const cleanups = []
      const collect = (cleanup) => { if (typeof cleanup === 'function') cleanups.push(cleanup) }
      collect(injectStyle())
      // 设置页：P1 的「本地 AI」tab（P2 在同一个页面里加分区的）。
      collect(register(ctx, 'settings.section', { id: 'fish-service', order: 57, label: () => '本地 AI' }, Section))
      // 消息级朗读按钮：助手消息操作行（复制按钮右边）。
      collect(register(ctx, 'conversation.chat.assistant-actions', { id: 'fish-read', order: 21, label: () => '朗读' }, readButton))
      // 输入框右侧：麦克风（开始/结束录音）。
      collect(register(ctx, 'conversation.input.right', { id: 'fish-mic', order: 32, label: () => '语音输入' }, micButton))
      // 输入框右侧：本地识图按钮（点选图片；图片不进草稿）。
      collect(register(ctx, 'conversation.input.right', { id: 'fish-vision', order: 31, label: () => '本地识图' }, localVisionButton))
      // 输入框上方浮层：录音状态 + 三选一面板（DSH 的 overlay 就挂在这里）。
      collect(register(ctx, 'conversation.input.overlay', { id: 'fish-voice', order: 40, label: () => '语音输入面板' }, speechPanel))
      // 输入框左侧：自动朗读开关。
      collect(register(ctx, 'conversation.input.left', { id: 'fish-auto-read', order: 45, label: () => '自动朗读' }, autoReadSwitch))
      // 输入框左侧：本地 AI 状态胶囊（显存 / 任务，点开看详情）。
      collect(register(ctx, 'conversation.input.left', { id: 'fish-metrics', order: 40, label: () => '本地 AI 状态' }, metricsCapsule))
      // 框选文字：朗读 / 翻译（需要同时注册 interaction 与 keyed 槽位）。
      collect(registerSelectedInteraction(ctx))
      // 右栏「开始」页：双语翻译卡片（guide 入口 + 面板 body）。
      // inject 拿到当前会话 id，面板据此给每个会话留一份草稿。
      collect(register(ctx, 'sidebar.right.pane.tab', { key: translationTabID, inject: (session) => ({ sessionId: session }) }, translationPanel))
      collect(registerRightPanel(ctx))

      // 预热一次偏好（不阻塞）；失败也无所谓，组件挂载时会再拉。
      void loadPrefs()

      // 按注册的反序释放：槽位/交互/右栏 tab、未触发的重试定时器、样式节点。
      const dispose = () => {
        for (const cleanup of cleanups.splice(0).reverse()) {
          try { cleanup() } catch { /* 已卸载 */ }
        }
      }
      try {
        ctx.effect?.(() => dispose)
      } catch {
        // 老宿主没有 effect 时只能靠页面整体销毁；不影响注册本身。
      }
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供单元测试直接验证的纯函数；浏览器运行时不使用。
    exports.__testing = {
      readAutoReadSessions,
      writeAutoReadSessions,
      readBackgroundAutoRead,
      shouldAutoRead,
      autoReadSessionLimit,
      validSessionKey,
      buildRecordingConstraint,
      clampRecordingDuration,
      openMic,
      deviceUnavailableError,
      isVirtualDeviceName,
      virtualDevicePrompt,
      registerSelectedInteraction,
      selectedInteractionID,
      readButton,
      visionExt,
      isImageFile,
      localVisionOn,
      uiSwitchOn,
      uiSwitchKey,
      prefs,
      micButton,
      localVisionButton,
      speechPanel,
      autoReadSwitch,
      metricsCapsule,
      visionPresets,
      visionPresetOption,
      normalizeVisionPreset,
      visionBlockReason,
      composeImageDesc,
      enqueuePendingInsert,
      fetchPendingInsert,
      consumePendingInsert,
      formatGB,
      formatVram,
      formatModel,
      formatTask,
      formatCapsuleTask,
      taskTotalCount,
      formatDuration,
      formatTypeDetail,
      vramColor,
      formatVisual,
      metricsOffline,
      speechAttachmentName,
      fetchSessionConversation,
      attachSpeechAttachment,
      detectLanguage,
      pickTranslationDirection,
      translationDirectionCopy,
      translationRuleCopy,
      translationLanguageTag,
      splitSegment,
      assembleTranslated,
      planTranslation,
      planBatchNo,
      fetchTranslationDirectionConfig,
      getEditRange,
      mapPosition,
      adjustPieceOffset,
      switchFragment,
      fetchSideFragment,
      mapValid,
      joinSegments,
      flipToMap,
      switchSwapOriginalSide,
      sameDirection,
      buildTranslationPlan,
      runTranslation,
      taskPhaseCopy,
      coldStartPrompt,
      translationBeginStatus,
      translationSuccessStatus,
      translationAbortState,
      pieceAction,
      pieceEmptyInteraction,
      pieceInteraction,
      pieceToolbar,
      translationDraft,
      cacheKey,
      readCache,
      writeCache,
      clearTranslationCache,
      translationEmptyStatus,
      translationEdit,
      translationLockedSide,
      translationCanRun,
      translationButtonLabel,
      translationPanel,
      Section,
    }
    return module.exports
  },
})
