// 设置页 Section 的渲染回归：用假 React 真跑一遍组件，输入真实的 /state 结构，
// 任何组件抛错都会在这里暴露（DSH 里被错误边界吞掉，只剩空白页）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const realStatus = {
  ok: true,
  plugin: { name: 'dsh-LocalAIService', version: '0.6.0' },
  config: {
    baseUrl: 'http://127.0.0.1:7880',
    autoRead: true,
    autoReadInBackground: true,
    readVoice: 'dafeiyu',
    readSpeed: 1,
    readMaxChars: 2000,
    readConcurrency: 2,
    readDropCode: true,
    localDescribe: true,
    visionPresets: {},
    visionSessionPrompt: '',
    primaryLanguage: 'zh',
    secondaryLanguage: 'en',
    cacheDir: 'C:\\Users\\Administrator\\.dsh\\fish-service-cache',
  },
  health: {
    ok: true,
    reachable: true,
    compatible: true,
    checkedAt: '2026-11-10T16:00:47.682Z',
    latencyMs: 70,
    serviceVersion: '2.5.0',
    apiVersion: '1',
    vram: { freeMb: 5981, totalMb: 8192, marginMb: 512 },
    consecutiveFailures: 0,
  },
  capabilities: {
    tts: { available: true, loaded: false },
    asr: { available: true, loaded: true },
    translate: { available: true, loaded: false },
    separate: { available: true, loaded: false },
    vision: { available: true, loaded: false },
    media: { available: true, loaded: false },
    download: { available: true, loaded: false },
    jobs: { available: true, loaded: false },
  },
  voices: ['Karenina', '大肥鱼'],
  voicesDirectory: 'E:\\LocalAIService\\voices',
  visionDefaults: {
    presets: {
      brief: '请用一两句简洁的中文描述这张图片里有什么。',
      standard: '请用一段话把这张图片说清楚。',
      detailed: '请按下面的分条要求描述这张图片：主体、场景、物体、文字、构图。',
      text: '请识别并原样输出图片中的文字。',
    },
    session: '请按下面的分条要求描述这张图片：主体、场景、物体、文字、构图。',
  },
  cache: { files: 0, bytes: 0 },
  errors: [],
  envOverrides: [],
}

/** 极简 React：useState 真的会触发重渲染，useEffect 在每次提交后执行一次。 */
function fakeReact() {
  const cell = new WeakMap()
  const sideEffect = new Map()
  const stack = []
  let dirty = false
  // 非空时把渲染出的宿主节点按出现顺序记下来（找按钮/断言结构用）。
  let collector = null

  function fetchFrame(fn) {
    let remember = cell.get(fn)
    if (!remember) {
      remember = { cells: [], idx: 0, lastTimeHookCount: 0 }
      cell.set(fn, remember)
    }
    remember.idx = 0
    remember.thisHookCount = 0
    return remember
  }

  function frame() {
    if (stack.length === 0) throw new Error('hook 不在组件里')
    return stack[stack.length - 1]
  }

  /** 取下一个 hook 槽位；顺带模拟 React #310：本次渲染的 hook 不能比上次多。 */
  function fetchCell() {
    const f = frame()
    const i = f.idx++
    if (!f.firstRun && i >= f.lastTimeHookCount) {
      throw new Error(`React #310：组件渲染的钩子比上次多（第 ${i + 1} 个）`)
    }
    return { f, i }
  }

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initialValue) => {
      const { f, i } = fetchCell()
      if (!(i in f.cells)) f.cells[i] = typeof initialValue === 'function' ? initialValue() : initialValue
      const setValue = (value) => {
        const nextOne = typeof value === 'function' ? value(f.cells[i]) : value
        if (Object.is(nextOne, f.cells[i])) return
        f.cells[i] = nextOne
        dirty = true
      }
      return [f.cells[i], setValue]
    },
    useRef: (initialValue) => {
      const { f, i } = fetchCell()
      if (!(i in f.cells)) f.cells[i] = { current: initialValue }
      return f.cells[i]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (cb) => {
      const { f, i } = fetchCell()
      const key = f.fn
      let table = sideEffect.get(key)
      if (!table) {
        table = new Map()
        sideEffect.set(key, table)
      }
      table.set(i, cb)
    },
  }

  function renderComponent(fn, props) {
    const remember = fetchFrame(fn)
    remember.fn = fn
    remember.firstRun = remember.lastTimeHookCount === 0 && !remember.renderedBefore
    stack.push(remember)
    try {
      return fn(props)
    } finally {
      remember.renderedBefore = true
      remember.lastTimeHookCount = Math.max(remember.lastTimeHookCount, remember.idx)
      stack.pop()
    }
  }

  function expand(node, text) {
    if (node == null || node === false) return
    if (typeof node === 'string' || typeof node === 'number') {
      text.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) expand(child, text)
      return
    }
    const { type, props } = node
    if (collector) collector.push(node)
    if (typeof type === 'function') {
      expand(renderComponent(type, props), text)
      return
    }
    expand(props?.children, text)
  }

  function submit(root) {
    dirty = false
    const text = []
    expand(root, text)
    return text.join(' ')
  }

  /** 与 submit 一样渲染，但同时返回节点列表（需要按类型找按钮时用）。 */
  function submitTree(root) {
    dirty = false
    const text = []
    const nodes = []
    const previous = collector
    collector = nodes
    try {
      expand(root, text)
    } finally {
      collector = previous
    }
    return { text: text.join(' '), nodes }
  }

  function runSideEffect() {
    for (const table of sideEffect.values()) {
      for (const cb of table.values()) {
        const result = cb()
        if (result && typeof result.then === 'function') result.catch(() => {})
      }
    }
    sideEffect.clear()
  }

  return { React, submit, submitTree, runSideEffect, dirty: () => dirty }
}

function load({ status = realStatus, metrics = null, startAnswer = null } = {}) {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory = null
  const fake = fakeReact()
  // 记下所有请求：断言「点了启动按钮确实 POST 到 /service/start」。
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (define) => { factory = define.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    // 组件里的轮询定时器在测试里不需要真的跑，否则进程不退出。
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async (address, init = {}) => {
      const path = String(address)
      calls.push({ path, method: String(init.method || 'GET').toUpperCase(), body: init.body })
      return {
        ok: true,
        json: async () => {
          if (path.includes('/state')) return status
          if (path.includes('/metrics')) return metrics || { ok: true }
          if (path.includes('/service/start')) return startAnswer || { ok: true }
          if (path.includes('/cache/stats')) return { ok: true, files: 0, bytes: 0 }
          if (path.includes('/logs')) return { ok: true, lines: [] }
          return { ok: true }
        },
      }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  assert.equal(typeof factory, 'function')
  const exported = factory(() => fake.React)
  return { exported, fake, calls }
}

test('设置页 Section 用真实 /state 能渲染出内容', async () => {
  const { exported, fake } = load()
  assert.equal(typeof exported.__testing.Section, 'function')

  let root = fake.submit(fake.React.createElement(exported.__testing.Section, {}))
  assert.match(root, /本地 AI/)

  // 跑一次 effect（会去拉 /state），再提交，模拟 DSH 里的真实流程。
  for (let round = 0; round < 8 && !root.includes('能力'); round += 1) {
    await new Promise((r) => setTimeout(r, 0))
    fake.runSideEffect()
    root = fake.submit(fake.React.createElement(exported.__testing.Section, {}))
  }

  assert.match(root, /能力/, `渲染结果应包含能力表，实际：${root.slice(0, 300)}`)
  assert.match(root, /8 \/ 8 项可用/)
  // 状态卡片里的「释放显存」入口与说明。
  assert.match(root, /释放显存/)
  assert.match(root, /卸载当前没有任务在用的模型；正在跑的任务会跳过。/)
})

test('设置页 Section 在服务离线（state ok:false 或 null）时不崩', async () => {
  const { exported, fake } = load({ status: { ok: false } })
  for (let round = 0; round < 6; round += 1) {
    await new Promise((r) => setTimeout(r, 0))
    fake.runSideEffect()
    fake.submit(fake.React.createElement(exported.__testing.Section, {}))
  }
  const text = fake.submit(fake.React.createElement(exported.__testing.Section, {}))
  assert.match(text, /本地 AI/)
})

// ---------------- 服务未启动时的「启动服务」入口 ----------------

const offlineStatus = {
  ...realStatus,
  health: { ...realStatus.health, ok: false, reachable: false, compatible: false, vram: null },
  capabilities: {},
  voices: [],
}

const metricsOffline = { ok: false, code: 'service_down', hint: '本地 AI 未启动' }

const metricsOnline = {
  ok: true,
  gpu: { name: 'RTX 4060', usedMb: 1024, totalMb: 8192, freeMb: 7168, percent: 13 },
  modelsLoaded: [],
  queue: { queued: 0, running: 0 },
  scheduler: { currentKind: '', loadedModel: '' },
  service: { version: '2.5.0', uptimeSeconds: 10 },
  vision: { loaded: false, ready: false },
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 0))

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}

function findButton(nodes, label) {
  return nodes.find((node) => node.type === 'button' && textOf(node).includes(label))
}

/** 胶囊读 prefs 里的界面开关；这里直接给一份「性能监控开着」的最小状态。 */
function mountCapsule(loaded) {
  const { exported, fake } = loaded
  exported.__testing.prefs.set({
    load: true,
    online: false,
    config: { uiMetrics: true },
    health: null,
    voice: [],
    plugin: {},
  })
  return fake.React.createElement(exported.__testing.metricsCapsule, {})
}

async function renderCapsule(loaded, element, rounds = 8) {
  let text = ''
  for (let round = 0; round < rounds; round += 1) {
    await delay()
    loaded.fake.runSideEffect()
    text = loaded.fake.submit(element)
  }
  return text
}

test('「启动服务」按钮：设置页与胶囊都只在服务未在线时渲染', async () => {
  const section = (loaded) => loaded.fake.React.createElement(loaded.exported.__testing.Section, {})
  const settleSection = async (loaded) => {
    let text = loaded.fake.submit(section(loaded))
    for (let round = 0; round < 8 && !text.includes('释放显存'); round += 1) {
      await delay()
      loaded.fake.runSideEffect()
      text = loaded.fake.submit(section(loaded))
    }
    return text
  }

  const offline = load({ status: offlineStatus })
  const offlineSection = await settleSection(offline)
  assert.match(offlineSection, /释放显存/)
  assert.match(offlineSection, /启动服务/)

  const online = load({ status: realStatus })
  const onlineSection = await settleSection(online)
  assert.match(onlineSection, /释放显存/)
  assert.doesNotMatch(onlineSection, /启动服务/)

  const capsuleOffline = load({ status: offlineStatus, metrics: metricsOffline })
  const offlineText = await renderCapsule(capsuleOffline, mountCapsule(capsuleOffline))
  assert.match(offlineText, /本地 AI 未启动/)
  assert.match(offlineText, /启动服务/)

  const capsuleOnline = load({ status: realStatus, metrics: metricsOnline })
  const onlineText = await renderCapsule(capsuleOnline, mountCapsule(capsuleOnline))
  assert.match(onlineText, /显存 13%/)
  assert.doesNotMatch(onlineText, /启动服务/)
})

test('胶囊「启动服务」：点击后 POST /service/start 并提示已启动', async () => {
  const loaded = load({
    status: offlineStatus,
    metrics: metricsOffline,
    startAnswer: { ok: true, started: true, dir: 'E:\\LocalAIService', mode: 'tray', waitedMs: 1200 },
  })
  const element = mountCapsule(loaded)
  await renderCapsule(loaded, element)

  const { nodes } = loaded.fake.submitTree(element)
  const button = findButton(nodes, '启动服务')
  assert.ok(button, '服务离线时胶囊旁应该有启动按钮')
  button.props.onClick({ stopPropagation() {} })

  let text = ''
  for (let round = 0; round < 8; round += 1) {
    await delay()
    loaded.fake.runSideEffect()
    text = loaded.fake.submit(element)
  }
  assert.match(text, /服务已启动。/)

  const startCall = loaded.calls.find((call) => call.path.endsWith('/service/start'))
  assert.ok(startCall, '应该请求 /service/start')
  assert.equal(startCall.method, 'POST')
  assert.equal(startCall.body, '{}')
})

