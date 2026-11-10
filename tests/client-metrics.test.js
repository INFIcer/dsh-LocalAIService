// 客户端「本地 AI 状态胶囊」纯函数：显存/任务/模型/时长/类型明细的格式化与离线判断。
//
// client.js 是 DSH 浏览器插件（window.__ModuleLoader__），这里用 vm + React 替身载入，
// 直接验证挂在 exports.__testing 上的纯函数；DOM 渲染没有测试环境。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function 载入客户端() {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  assert.equal(typeof 工厂, 'function')
  return 工厂(() => ({
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (初值) => [typeof 初值 === 'function' ? 初值() : 初值, () => {}],
    useEffect: () => {},
    useRef: (值) => ({ current: 值 }),
    useCallback: (函数) => 函数,
  }))
}

const 测试 = 载入客户端().__testing

test('格式化GB：MB → GB 一位小数，缺失按 0', () => {
  assert.equal(测试.格式化GB(0), '0.0')
  assert.equal(测试.格式化GB(7576), '7.4')
  assert.equal(测试.格式化GB(8192), '8.0')
  assert.equal(测试.格式化GB(4096), '4.0')
  assert.equal(测试.格式化GB('2048'), '2.0')
  assert.equal(测试.格式化GB(undefined), '0.0')
  assert.equal(测试.格式化GB(null), '0.0')
  assert.equal(测试.格式化GB(-5), '0.0')
  assert.equal(测试.格式化GB(Number.NaN), '0.0')
})

test('格式化显存：已用 / 总量 GB', () => {
  assert.equal(测试.格式化显存(7576, 8192), '7.4 / 8.0 GB')
  assert.equal(测试.格式化显存(0, 0), '0.0 / 0.0 GB')
  assert.equal(测试.格式化显存(undefined, undefined), '0.0 / 0.0 GB')
})

test('格式化模型：多个用 / 连，没有显示无模型', () => {
  assert.equal(测试.格式化模型(['tts']), '已加载 tts')
  assert.equal(测试.格式化模型(['tts', 'vision']), '已加载 tts / vision')
  assert.equal(测试.格式化模型([' tts ', '', null]), '已加载 tts')
  assert.equal(测试.格式化模型([]), '无模型')
  assert.equal(测试.格式化模型(null), '无模型')
  assert.equal(测试.格式化模型(undefined), '无模型')
})

test('任务数与胶囊文案：有任务显示总数，都 0 显示空闲', () => {
  assert.equal(测试.任务总数({ queued: 1, running: 2 }), 3)
  assert.equal(测试.任务总数({ queued: '2', running: undefined }), 2)
  assert.equal(测试.任务总数({}), 0)
  assert.equal(测试.任务总数(null), 0)
  assert.equal(测试.格式化胶囊任务({ queued: 0, running: 0 }), '空闲')
  assert.equal(测试.格式化胶囊任务({ queued: 0, running: 1 }), '1 任务')
  assert.equal(测试.格式化胶囊任务({ queued: 2, running: 1 }), '3 任务')
  assert.equal(测试.格式化胶囊任务(undefined), '空闲')
})

test('格式化任务：浮层显示 运行 / 排队', () => {
  assert.equal(测试.格式化任务({ queued: 0, running: 0 }), '空闲')
  assert.equal(测试.格式化任务({ queued: 0, running: 1 }), '运行 1 · 排队 0')
  assert.equal(测试.格式化任务({ queued: 2, running: 1 }), '运行 1 · 排队 2')
  assert.equal(测试.格式化任务(null), '空闲')
})

test('格式化时长：天 / 小时 / 分钟 / 秒', () => {
  assert.equal(测试.格式化时长(0), '0 秒')
  assert.equal(测试.格式化时长(59), '59 秒')
  assert.equal(测试.格式化时长(60), '1 分钟')
  assert.equal(测试.格式化时长(3720), '1 小时 2 分')
  assert.equal(测试.格式化时长(90061), '1 天 1 小时')
  assert.equal(测试.格式化时长(3 * 86400 + 5 * 3600), '3 天 5 小时')
  assert.equal(测试.格式化时长(undefined), '0 秒')
  assert.equal(测试.格式化时长(-10), '0 秒')
})

test('格式化类型明细：有类型按「类型 数量」连起来，空给无', () => {
  assert.equal(测试.格式化类型明细({ tts: 2, asr: 1 }), 'tts 2 · asr 1')
  assert.equal(测试.格式化类型明细({ tts: 1.9 }), 'tts 1')
  assert.equal(测试.格式化类型明细({ tts: 0 }), '无')
  assert.equal(测试.格式化类型明细({}), '无')
  assert.equal(测试.格式化类型明细(null), '无')
  assert.equal(测试.格式化类型明细([1, 2]), '无')
})

test('显存色：>95 危险，>85 警告，其余正常', () => {
  assert.equal(测试.显存色(0), '')
  assert.equal(测试.显存色(85), '')
  assert.equal(测试.显存色(86), 'warn')
  assert.equal(测试.显存色(92), 'warn')
  assert.equal(测试.显存色(95), 'warn')
  assert.equal(测试.显存色(96), 'danger')
  assert.equal(测试.显存色(100), 'danger')
  assert.equal(测试.显存色('86'), 'warn')
  assert.equal(测试.显存色(undefined), '')
})

test('格式化视觉：加载 / 就绪两个状态都要说清', () => {
  assert.equal(测试.格式化视觉({ loaded: true, ready: true }), '已加载 · 已就绪')
  assert.equal(测试.格式化视觉({ loaded: true, ready: false }), '已加载 · 未就绪')
  assert.equal(测试.格式化视觉({}), '未加载 · 未就绪')
  assert.equal(测试.格式化视觉(null), '未加载 · 未就绪')
})

test('指标离线：只有拿到 ok:true 才算在线', () => {
  assert.equal(测试.指标离线({ 载入: true, 数据: { ok: false, code: 'service_down' } }), true)
  assert.equal(测试.指标离线({ 载入: true, 数据: { ok: false, code: 'upstream_error' } }), true)
  assert.equal(测试.指标离线({ 载入: true, 数据: null }), true)
  assert.equal(测试.指标离线({ 载入: false, 数据: null }), false)
  assert.equal(测试.指标离线({ 载入: true, 数据: { ok: true } }), false)
  assert.equal(测试.指标离线(null), false)
})
