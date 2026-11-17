// 设置页「服务端」一键部署：状态区、预检→开始→轮询、取消、自定义参数、日志、接管。
//
// client.js 是浏览器插件（window.__ModuleLoader__），这里用 vm + 迷你 React 载入，
// 真跑 installChunk 的渲染与点击；fetch 用假实现，请求路径与 body 都记下来断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const B = '/dsh-fish-service'

const catalog = [
  { capability: 'tts', name: '', label: 'IndexTTS-2.5', title: '语音合成', priority: 'required', sizeMb: 8075 },
  { capability: 'asr', name: '', label: 'SenseVoiceSmall', title: '语音识别', priority: 'required', sizeMb: 897 },
  { capability: 'separate', name: 'htdemucs', label: 'htdemucs', title: '人声分离', priority: 'recommended', sizeMb: 80 },
  { capability: 'translate', name: '', label: 'NLLB-200', title: '翻译', priority: 'optional', sizeMb: 2368 },
]

function fixture(overrides = {}) {
  return {
    ok: true,
    installMode: 'unknown',
    installDir: 'C:\\Users\\fish\\AppData\\Local\\localai-service',
    defaultInstallDir: 'C:\\Users\\fish\\AppData\\Local\\localai-service',
    state: 'idle',
    phase: '',
    percent: 0,
    message: '',
    startedAt: null,
    finishedAt: null,
    error: null,
    logTail: [],
    steps: [],
    task: null,
    lastState: null,
    service: { baseUrl: 'http://127.0.0.1:7880', reachable: false, serviceVersion: '', apiVersion: '' },
    catalog,
    defaultModels: ['tts', 'asr', 'separate'],
    logFile: 'C:\\Users\\fish\\.dsh\\fish-service-install.log',
    stateFile: 'C:\\Users\\fish\\.dsh\\fish-service-install.json',
    ...overrides,
  }
}

const runningSteps = [
  { id: 'preflight', title: '检查环境', status: 'done', percent: 100, message: '环境检查通过' },
  { id: 'fetch-code', title: '下载服务端代码', status: 'running', percent: 40, message: '正在下载' },
  { id: 'venv', title: '创建虚拟环境', status: 'pending', percent: 0, message: '' },
]

function running(overrides = {}) {
  return fixture({
    state: 'running',
    percent: 22,
    message: '下载服务端代码',
    steps: runningSteps,
    ...overrides,
  })
}

// ---------------- 迷你 React：真跑函数组件、useState/useEffect（带依赖与清理） ----------------

function makeReact() {
  const runtimes = new WeakMap()
  const rendered = new Set()
  let dirty = false
  const stack = []

  function runtimeFor(fn) {
    let runtime = runtimes.get(fn)
    if (!runtime) {
      runtime = { cells: [], effects: [], next: [], idx: 0 }
      runtimes.set(fn, runtime)
    }
    return runtime
  }

  function current() {
    if (!stack.length) throw new Error('hook 不在组件里')
    return stack[stack.length - 1]
  }

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initialValue) => {
      const runtime = current()
      const index = runtime.idx++
      if (!(index in runtime.cells)) {
        runtime.cells[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      }
      const setValue = (value) => {
        const nextValue = typeof value === 'function' ? value(runtime.cells[index]) : value
        if (Object.is(nextValue, runtime.cells[index])) return
        runtime.cells[index] = nextValue
        dirty = true
      }
      return [runtime.cells[index], setValue]
    },
    useRef: (initialValue) => {
      const runtime = current()
      const index = runtime.idx++
      if (!(index in runtime.cells)) runtime.cells[index] = { current: initialValue }
      return runtime.cells[index]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (callback, deps) => {
      const runtime = current()
      runtime.next.push({ index: runtime.idx++, callback, deps })
    },
  }

  function sameDeps(previous, next) {
    if (!previous || !next) return false
    if (previous.length !== next.length) return false
    return previous.every((value, index) => Object.is(value, next[index]))
  }

  function commit() {
    for (const runtime of rendered) {
      for (const desired of runtime.next) {
        const previous = runtime.effects[desired.index]
        if (previous && sameDeps(previous.deps, desired.deps)) continue
        if (previous && typeof previous.cleanup === 'function') previous.cleanup()
        const entry = { deps: desired.deps, cleanup: null }
        runtime.effects[desired.index] = entry
        const result = desired.callback()
        if (typeof result === 'function') entry.cleanup = result
      }
      runtime.next = []
    }
    rendered.clear()
  }

  function flatten(list) {
    const output = []
    for (const item of list) {
      if (Array.isArray(item)) output.push(...flatten(item))
      else if (item != null) output.push(item)
    }
    return output
  }

  function expand(node) {
    if (node == null || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') {
      return { type: '#text', text: String(node), children: [] }
    }
    if (Array.isArray(node)) return flatten(node.map(expand))
    const { type, props } = node
    const raw = props ? props.children : undefined
    if (typeof type === 'function') {
      const runtime = runtimeFor(type)
      runtime.idx = 0
      runtime.next = []
      rendered.add(runtime)
      stack.push(runtime)
      let output
      try {
        output = type(props || {})
      } finally {
        stack.pop()
      }
      return expand(output)
    }
    if (type === React.Fragment || type === 'Fragment') return expand(raw)
    const childList = Array.isArray(raw) ? raw : (raw == null ? [] : [raw])
    return { type, props: props || {}, children: flatten(childList.map(expand)) }
  }

  function render(element) {
    dirty = false
    const tree = expand(element)
    commit()
    return tree
  }

  return { React, render, dirty: () => dirty }
}

// ---------------- 载入 client.js 与假 fetch ----------------

function makeFetch(statuses, route) {
  const calls = []
  let statusIndex = 0
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(B, '')
    const method = String(init.method || 'GET').toUpperCase()
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method, body })
    const answer = (status, payload) => ({ ok: status < 400, status, json: async () => payload })
    if (path.startsWith('/install/status')) {
      const payload = statuses[Math.min(statusIndex, statuses.length - 1)]
      statusIndex += 1
      return answer(200, payload)
    }
    if (route) {
      const hit = route(path, method, body)
      if (hit) return answer(hit.status || 200, hit.json)
    }
    return answer(200, { ok: true })
  }
  return { fetchImpl, calls }
}

function load({ statuses = [fixture()], route = null } = {}) {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const mini = makeReact()
  const clock = {
    jobs: new Map(),
    nextId: 1,
    setInterval: (fn) => {
      const id = clock.nextId++
      clock.jobs.set(id, fn)
      return id
    },
    clearInterval: (id) => { clock.jobs.delete(id) },
  }
  const world = makeFetch(statuses, route)
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (define) => { factory = define.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    URL,
    fetch: world.fetchImpl,
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  assert.equal(typeof factory, 'function')
  const exported = factory(() => mini.React)
  return { exported, mini, clock, calls: world.calls }
}

// ---------------- 渲染树工具 ----------------

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.type === '#text') return node.text
  return (node.children || []).map(textOf).join(' ')
}

function findNode(tree, predicate) {
  let found = null
  walk(tree, (node) => {
    if (!found && predicate(node)) found = node
  })
  return found
}

function findButton(tree, label) {
  return findNode(tree, (node) => node.type === 'button' && textOf(node).includes(label))
}

function findTextInput(tree) {
  return findNode(tree, (node) => node.type === 'input' && node.props.type !== 'checkbox')
}

function findCheckbox(tree, label) {
  const holder = findNode(tree, (node) => node.type === 'label' && textOf(node).includes(label))
  assert.ok(holder, '没有找到勾选项：' + label)
  return holder.children.find((node) => node.type === 'input' && node.props.type === 'checkbox')
}

function mount(loaded, onStateRefresh) {
  const { exported, mini } = loaded
  const props = onStateRefresh ? { onStateRefresh } : {}
  return mini.React.createElement(exported.__testing.installChunk, props)
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 0))

async function settle(loaded, element, rounds = 8) {
  let tree = loaded.mini.render(element)
  for (let index = 1; index < rounds; index += 1) {
    await delay()
    tree = loaded.mini.render(element)
  }
  return tree
}

async function click(loaded, element, label) {
  // 先把挂载时的状态请求跑完，再找按钮；否则第一帧还在「正在读取安装状态」。
  const tree = await settle(loaded, element)
  const button = findButton(tree, label)
  assert.ok(button, '没有找到按钮：' + label + '；当前界面：' + textOf(tree).slice(0, 300))
  button.props.onClick({})
  return settle(loaded, element)
}

function statusCalls(loaded) {
  return loaded.calls.filter((call) => call.path === '/install/status')
}

// ---------------- 测试 ----------------

test('未装时显示「本机没有检测到本地 AI 服务」与一键部署', async () => {
  const loaded = load({ statuses: [fixture()] })
  const element = mount(loaded)
  const tree = await settle(loaded, element)

  assert.match(textOf(tree), /本机没有检测到本地 AI 服务/)
  assert.ok(findButton(tree, '一键部署'))
  assert.ok(findButton(tree, '接管已有服务'))
  assert.match(textOf(tree), /预计占用约 17 GB/)
  assert.equal(statusCalls(loaded).length, 1)
  assert.equal(loaded.calls.some((call) => call.path === '/install/preflight'), false)
  assert.equal(loaded.calls.some((call) => call.path === '/install/start'), false)
})

test('预检有 blocker：不调用 start，按中文列出每条原因', async () => {
  const loaded = load({
    statuses: [fixture()],
    route: (path) => {
      if (path !== '/install/preflight') return null
      return {
        status: 400,
        json: {
          ok: false,
          code: 'bad_request',
          hint: '预检未通过。',
          blockers: [
            { code: 'python_missing', hint: '没有找到可用的 Python 3.11~3.13。', detail: 'py=3.10' },
            { code: 'disk_space', hint: '安装目录所在的 D 盘空间不足。' },
          ],
          warnings: [],
        },
      }
    },
  })
  const element = mount(loaded)
  const tree = await click(loaded, element, '一键部署')
  const text = textOf(tree)

  assert.match(text, /环境检查没有通过/)
  assert.match(text, /没有找到可用的 Python 3.11~3.13。/)
  assert.match(text, /py=3.10/)
  assert.match(text, /安装目录所在的 D 盘空间不足。/)
  assert.ok(findButton(tree, '重试预检'))
  assert.equal(loaded.calls.some((call) => call.path === '/install/preflight'), true)
  assert.equal(loaded.calls.some((call) => call.path === '/install/start'), false)
})

test('一键部署：预检通过 → 开始 → 轮询步骤，成功后停止轮询并提示已保存设置', async () => {
  const succeeded = fixture({ state: 'succeeded', percent: 100, message: '安装完成' })
  const loaded = load({
    statuses: [fixture(), running(), succeeded],
    route: (path) => {
      if (path === '/install/preflight') {
        return {
          status: 200,
          json: {
            ok: true,
            blockers: [],
            warnings: [{ code: 'ffmpeg_missing', hint: '未找到 ffmpeg：视频关键帧不可用。' }],
          },
        }
      }
      if (path === '/install/start') {
        return { status: 200, json: { ok: true, taskId: 'task1', state: 'running', steps: runningSteps } }
      }
      return null
    },
  })
  let refreshed = 0
  const element = mount(loaded, () => { refreshed += 1 })

  let tree = await click(loaded, element, '一键部署')
  let text = textOf(tree)
  assert.match(text, /正在安装/)
  assert.match(text, /下载服务端代码/)
  assert.match(text, /22%/)
  assert.match(text, /未找到 ffmpeg：视频关键帧不可用。/)
  assert.equal(loaded.clock.jobs.size, 1, 'running 时应有一个状态轮询定时器')
  const beforePoll = statusCalls(loaded).length
  assert.equal(beforePoll, 2, '挂载一次 + 开始后补一次')

  loaded.clock.jobs.forEach((job) => job())
  tree = await settle(loaded, element)
  text = textOf(tree)
  assert.match(text, /部署完成/)
  assert.match(text, /已保存设置，插件已切换到该服务。/)
  assert.equal(refreshed, 1, '成功后要重新拉一次 /state')
  assert.equal(loaded.clock.jobs.size, 0, '成功后轮询必须停掉')

  const afterPoll = statusCalls(loaded).length
  loaded.clock.jobs.forEach((job) => job())
  await settle(loaded, element)
  assert.equal(statusCalls(loaded).length, afterPoll, '停止后不应再请求状态')
})

test('取消安装：先二次确认，确认后调用 /install/cancel 并显示取消结果', async () => {
  const canceled = fixture({ state: 'canceled', percent: 22, message: '安装已取消' })
  const loaded = load({
    statuses: [fixture(), running(), canceled],
    route: (path) => {
      if (path === '/install/preflight') return { status: 200, json: { ok: true, blockers: [], warnings: [] } }
      if (path === '/install/start') return { status: 200, json: { ok: true, taskId: 'task1', state: 'running', steps: runningSteps } }
      if (path === '/install/cancel') {
        return {
          status: 200,
          json: { ok: true, canceled: true, taskId: 'task1', state: 'canceling', message: '正在取消安装并清理本次创建的文件。' },
        }
      }
      return null
    },
  })
  const element = mount(loaded)

  let tree = await click(loaded, element, '一键部署')
  tree = await click(loaded, element, '取消')
  assert.match(textOf(tree), /会中断并清理本次安装（已下载的模型保留）。/)
  assert.equal(loaded.calls.some((call) => call.path === '/install/cancel'), false, '确认前不能发取消请求')

  tree = await click(loaded, element, '确认取消')
  const cancelCall = loaded.calls.find((call) => call.path === '/install/cancel')
  assert.ok(cancelCall)
  assert.equal(cancelCall.method, 'POST')
  assert.deepEqual(cancelCall.body, {})
  assert.match(textOf(tree), /安装已取消，已清理本次创建的文件。/)
  assert.match(textOf(tree), /安装已取消，可以重新部署。/)
  assert.equal(loaded.clock.jobs.size, 0, '取消完成后要停掉状态轮询')
})

test('自定义面板：目录/跳过显卡/模型同时传给 preflight 与 start', async () => {
  const loaded = load({
    statuses: [fixture(), running({ percent: 1, message: '准备安装' })],
    route: (path) => {
      if (path === '/install/preflight') return { status: 200, json: { ok: true, blockers: [], warnings: [] } }
      if (path === '/install/start') return { status: 200, json: { ok: true, taskId: 't', state: 'running', steps: runningSteps } }
      return null
    },
  })
  const element = mount(loaded)
  let tree = await click(loaded, element, '自定义')
  assert.match(textOf(tree), /安装目录/)
  assert.match(textOf(tree), /下载模型/)
  assert.match(textOf(tree), /翻译 2368 MB/)

  findTextInput(tree).props.onChange({ target: { value: 'D:\\ai\\localai' } })
  tree = await settle(loaded, element)
  findCheckbox(tree, '跳过显卡依赖').props.onChange({ target: { checked: true } })
  tree = await settle(loaded, element)
  findCheckbox(tree, '翻译 2368 MB').props.onChange({ target: { checked: false } })
  tree = await settle(loaded, element)

  tree = await click(loaded, element, '开始安装')
  const preflight = loaded.calls.find((call) => call.path === '/install/preflight')
  const start = loaded.calls.find((call) => call.path === '/install/start')
  assert.ok(preflight)
  assert.ok(start)
  assert.deepEqual(preflight.body, { installDir: 'D:\\ai\\localai' })
  assert.equal(start.body.installDir, 'D:\\ai\\localai')
  assert.equal(start.body.skipEngine, true)
  assert.deepEqual(start.body.models, ['tts', 'asr', 'separate'])
})

test('改过自定义面板后，一键部署使用同一套参数', async () => {
  const loaded = load({
    statuses: [fixture(), running({ percent: 1, message: '准备安装' })],
    route: (path) => {
      if (path === '/install/preflight') return { status: 200, json: { ok: true, blockers: [], warnings: [] } }
      if (path === '/install/start') return { status: 200, json: { ok: true, taskId: 't', state: 'running', steps: runningSteps } }
      return null
    },
  })
  const element = mount(loaded)
  let tree = await click(loaded, element, '自定义')
  findTextInput(tree).props.onChange({ target: { value: 'E:\\localai' } })
  tree = await settle(loaded, element)
  findCheckbox(tree, '跳过显卡依赖').props.onChange({ target: { checked: true } })
  tree = await settle(loaded, element)
  findCheckbox(tree, '翻译 2368 MB').props.onChange({ target: { checked: false } })
  await settle(loaded, element)

  await click(loaded, element, '一键部署')
  const preflight = loaded.calls.find((call) => call.path === '/install/preflight')
  const start = loaded.calls.find((call) => call.path === '/install/start')
  assert.equal(preflight.body.installDir, 'E:\\localai')
  assert.equal(start.body.installDir, 'E:\\localai')
  assert.equal(start.body.skipEngine, true)
  assert.deepEqual(start.body.models, ['tts', 'asr', 'separate'])
})

test('日志：默认显示 logTail，展开时调用 /install/logs?lines=200', async () => {
  const loaded = load({
    statuses: [running({ logTail: ['[t] tail-a', '[t] tail-b'] })],
    route: (path) => {
      if (path === '/install/logs?lines=200') {
        return { status: 200, json: { ok: true, file: 'C:\\log\\install.log', lines: ['[t] full-a', '[t] full-b'], task: null } }
      }
      return null
    },
  })
  const element = mount(loaded)
  let tree = await settle(loaded, element)
  assert.match(textOf(tree), /tail-a/)
  assert.match(textOf(tree), /查看完整日志/)

  tree = await click(loaded, element, '查看完整日志')
  const logCall = loaded.calls.find((call) => call.path === '/install/logs?lines=200')
  assert.ok(logCall)
  assert.equal(logCall.method, 'GET')
  assert.match(textOf(tree), /full-a/)
  assert.match(textOf(tree), /收起日志/)
})

test('接管已有服务：调用 adopt，成功与失败都给中文结果', async () => {
  const loaded = load({
    statuses: [fixture()],
    route: (path) => {
      if (path !== '/install/adopt') return null
      return {
        status: 200,
        json: {
          ok: true,
          installMode: 'adopted',
          baseUrl: 'http://127.0.0.1:7880',
          serviceVersion: '2.5.0',
          apiVersion: '1',
          paths: null,
          tried: [],
        },
      }
    },
  })
  let refreshed = 0
  const element = mount(loaded, () => { refreshed += 1 })
  const tree = await click(loaded, element, '接管已有服务')

  const adoptCall = loaded.calls.find((call) => call.path === '/install/adopt')
  assert.ok(adoptCall)
  assert.equal(adoptCall.method, 'POST')
  assert.match(textOf(tree), /已接管 http:\/\/127\.0\.0\.1:7880（v2\.5\.0）/)
  assert.equal(refreshed, 1)
})

test('接管失败：502 service_down 翻译成可操作的提示', async () => {
  const loaded = load({
    statuses: [fixture()],
    route: (path) => {
      if (path !== '/install/adopt') return null
      return {
        status: 502,
        json: { ok: false, code: 'service_down', hint: '没有找到可接管的本地 AI 服务：7880 未监听。' },
      }
    },
  })
  const element = mount(loaded)
  const tree = await click(loaded, element, '接管已有服务')
  assert.match(textOf(tree), /接管失败：没有找到可接管的本地 AI 服务，请先启动服务后重试。/)
})

test('安装状态映射：running/succeeded/failed/canceled 优先于 installMode', async () => {
  const { exported } = load({ statuses: [fixture()] })
  const view = exported.__testing.installView
  assert.equal(view(fixture()).kind, 'unknown')
  assert.equal(view(fixture({ state: 'running' })).kind, 'running')
  assert.equal(view(fixture({ state: 'succeeded' })).kind, 'succeeded')
  assert.equal(view(fixture({ state: 'failed' })).kind, 'failed')
  assert.equal(view(fixture({ state: 'canceled' })).kind, 'canceled')
  assert.equal(view(fixture({ installMode: 'managed' })).kind, 'installed')
  const installed = view(fixture({ installMode: 'managed', lastState: { status: 'installed', serviceVersion: '2.5.0' } }))
  assert.equal(installed.kind, 'installed')
  assert.equal(installed.version, '2.5.0')
  const adopted = view(fixture({
    installMode: 'adopted',
    service: { baseUrl: 'http://127.0.0.1:7880', serviceVersion: '2.5.0' },
  }))
  assert.equal(adopted.kind, 'adopted')
  assert.equal(adopted.baseUrl, 'http://127.0.0.1:7880')
})

test('错误文案：网络失败、busy、service_down 都不把英文报错甩给用户', async () => {
  const { exported } = load({ statuses: [fixture()] })
  const copy = exported.__testing.installErrorText
  assert.equal(copy(null), '连不上插件后端，请确认 DSH 正常运行后重试。')
  assert.equal(copy({ ok: false, code: 'upstream_error', hint: 'fetch failed' }), '连不上插件后端，请确认 DSH 正常运行后重试。')
  assert.equal(copy({ ok: false, code: 'busy' }), '已经有一个安装任务在运行，请等待完成或先取消。')
  assert.equal(copy({ ok: false, code: 'service_down', hint: '7880 未监听' }), '没有找到可接管的本地 AI 服务，请先启动服务后重试。')
  assert.equal(copy({ ok: false, code: 'bad_request', hint: '安装目录不可写，请换一个目录。' }), '安装目录不可写，请换一个目录。')
})

test('409 busy：提示已有任务并接着轮询，不重复开始', async () => {
  const loaded = load({
    statuses: [fixture(), running()],
    route: (path) => {
      if (path === '/install/preflight') return { status: 200, json: { ok: true, blockers: [], warnings: [] } }
      if (path === '/install/start') {
        return {
          status: 409,
          json: { ok: false, code: 'busy', hint: '已经有一个安装任务在运行，请等待完成或先取消。' },
        }
      }
      return null
    },
  })
  const element = mount(loaded)
  const tree = await click(loaded, element, '一键部署')
  assert.match(textOf(tree), /已经有一个安装任务在运行，请等待完成或先取消。/)
  assert.match(textOf(tree), /正在安装/)
  assert.equal(loaded.clock.jobs.size, 1, 'busy 后应该接着轮询已有任务')
})
