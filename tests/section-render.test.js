// 设置页 Section 的渲染回归：用假 React 真跑一遍组件，输入真实的 /state 结构，
// 任何组件抛错都会在这里暴露（DSH 里被错误边界吞掉，只剩空白页）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const 真实状态 = {
  ok: true,
  plugin: { name: 'dsh-fish-service', version: '0.6.0' },
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
function 造假React() {
  const 单元 = new WeakMap()
  const 副作用 = new Map()
  const 栈 = []
  let 脏 = false

  function 取帧(fn) {
    let 记 = 单元.get(fn)
    if (!记) {
      记 = { cells: [], idx: 0, 上次钩子数: 0 }
      单元.set(fn, 记)
    }
    记.idx = 0
    记.本次钩子数 = 0
    return 记
  }

  function 帧() {
    if (栈.length === 0) throw new Error('hook 不在组件里')
    return 栈[栈.length - 1]
  }

  /** 取下一个 hook 槽位；顺带模拟 React #310：本次渲染的 hook 不能比上次多。 */
  function 取格() {
    const f = 帧()
    const i = f.idx++
    if (!f.首次 && i >= f.上次钩子数) {
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
    useState: (初值) => {
      const { f, i } = 取格()
      if (!(i in f.cells)) f.cells[i] = typeof 初值 === 'function' ? 初值() : 初值
      const 设 = (值) => {
        const 下个 = typeof 值 === 'function' ? 值(f.cells[i]) : 值
        if (Object.is(下个, f.cells[i])) return
        f.cells[i] = 下个
        脏 = true
      }
      return [f.cells[i], 设]
    },
    useRef: (初值) => {
      const { f, i } = 取格()
      if (!(i in f.cells)) f.cells[i] = { current: 初值 }
      return f.cells[i]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (cb) => {
      const { f, i } = 取格()
      const 键 = f.fn
      let 表 = 副作用.get(键)
      if (!表) {
        表 = new Map()
        副作用.set(键, 表)
      }
      表.set(i, cb)
    },
  }

  function 渲染组件(fn, props) {
    const 记 = 取帧(fn)
    记.fn = fn
    记.首次 = 记.上次钩子数 === 0 && !记.已渲染过
    栈.push(记)
    try {
      return fn(props)
    } finally {
      记.已渲染过 = true
      记.上次钩子数 = Math.max(记.上次钩子数, 记.idx)
      栈.pop()
    }
  }

  function 展开(节点, 文本) {
    if (节点 == null || 节点 === false) return
    if (typeof 节点 === 'string' || typeof 节点 === 'number') {
      文本.push(String(节点))
      return
    }
    if (Array.isArray(节点)) {
      for (const 子 of 节点) 展开(子, 文本)
      return
    }
    const { type, props } = 节点
    if (typeof type === 'function') {
      展开(渲染组件(type, props), 文本)
      return
    }
    展开(props?.children, 文本)
  }

  function 提交(根) {
    脏 = false
    const 文本 = []
    展开(根, 文本)
    return 文本.join(' ')
  }

  function 执行副作用() {
    for (const 表 of 副作用.values()) {
      for (const cb of 表.values()) {
        const 结果 = cb()
        if (结果 && typeof 结果.then === 'function') 结果.catch(() => {})
      }
    }
    副作用.clear()
  }

  return { React, 提交, 执行副作用, 是脏: () => 脏 }
}

function 载入(状态 = 真实状态) {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 假 = 造假React()
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    // 组件里的轮询定时器在测试里不需要真的跑，否则进程不退出。
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async (地址) => ({
      ok: true,
      json: async () => {
        if (String(地址).includes('/state')) return 状态
        if (String(地址).includes('/cache/stats')) return { ok: true, files: 0, bytes: 0 }
        if (String(地址).includes('/logs')) return { ok: true, lines: [] }
        return { ok: true }
      },
    }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  assert.equal(typeof 工厂, 'function')
  const 导出 = 工厂(() => 假.React)
  return { 导出, 假 }
}

test('设置页 Section 用真实 /state 能渲染出内容', async () => {
  const { 导出, 假 } = 载入()
  assert.equal(typeof 导出.__testing.Section, 'function')

  let 根 = 假.提交(假.React.createElement(导出.__testing.Section, {}))
  assert.match(根, /本地 AI/)

  // 跑一次 effect（会去拉 /state），再提交，模拟 DSH 里的真实流程。
  for (let 轮 = 0; 轮 < 8 && !根.includes('能力'); 轮 += 1) {
    await new Promise((r) => setTimeout(r, 0))
    假.执行副作用()
    根 = 假.提交(假.React.createElement(导出.__testing.Section, {}))
  }

  assert.match(根, /能力/, `渲染结果应包含能力表，实际：${根.slice(0, 300)}`)
  assert.match(根, /8 \/ 8 项可用/)
})

test('设置页 Section 在服务离线（state ok:false 或 null）时不崩', async () => {
  const { 导出, 假 } = 载入({ ok: false })
  for (let 轮 = 0; 轮 < 6; 轮 += 1) {
    await new Promise((r) => setTimeout(r, 0))
    假.执行副作用()
    假.提交(假.React.createElement(导出.__testing.Section, {}))
  }
  const 文本 = 假.提交(假.React.createElement(导出.__testing.Section, {}))
  assert.match(文本, /本地 AI/)
})
