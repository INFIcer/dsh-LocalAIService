// 客户端「本地 AI 状态胶囊」纯函数：显存/任务/模型/时长/类型明细的格式化与离线判断。
//
// client.js 是 DSH 浏览器插件（window.__ModuleLoader__），这里用 vm + React 替身载入，
// 直接验证挂在 exports.__testing 上的纯函数；DOM 渲染没有测试环境。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (define) => { factory = define.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  assert.equal(typeof factory, 'function')
  return factory(() => ({
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (initialValue) => [typeof initialValue === 'function' ? initialValue() : initialValue, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }))
}

const service = loadClient().__testing

test('格式化GB：MB → GB 一位小数，缺失按 0', () => {
  assert.equal(service.formatGB(0), '0.0')
  assert.equal(service.formatGB(7576), '7.4')
  assert.equal(service.formatGB(8192), '8.0')
  assert.equal(service.formatGB(4096), '4.0')
  assert.equal(service.formatGB('2048'), '2.0')
  assert.equal(service.formatGB(undefined), '0.0')
  assert.equal(service.formatGB(null), '0.0')
  assert.equal(service.formatGB(-5), '0.0')
  assert.equal(service.formatGB(Number.NaN), '0.0')
})

test('格式化显存：已用 / 总量 GB', () => {
  assert.equal(service.formatVram(7576, 8192), '7.4 / 8.0 GB')
  assert.equal(service.formatVram(0, 0), '0.0 / 0.0 GB')
  assert.equal(service.formatVram(undefined, undefined), '0.0 / 0.0 GB')
})

test('格式化模型：多个用 / 连，没有显示无模型', () => {
  assert.equal(service.formatModel(['tts']), '已加载 tts')
  assert.equal(service.formatModel(['tts', 'vision']), '已加载 tts / vision')
  assert.equal(service.formatModel([' tts ', '', null]), '已加载 tts')
  assert.equal(service.formatModel([]), '无模型')
  assert.equal(service.formatModel(null), '无模型')
  assert.equal(service.formatModel(undefined), '无模型')
})

test('任务数与胶囊文案：有任务显示总数，都 0 显示空闲', () => {
  assert.equal(service.taskTotalCount({ queued: 1, running: 2 }), 3)
  assert.equal(service.taskTotalCount({ queued: '2', running: undefined }), 2)
  assert.equal(service.taskTotalCount({}), 0)
  assert.equal(service.taskTotalCount(null), 0)
  assert.equal(service.formatCapsuleTask({ queued: 0, running: 0 }), '空闲')
  assert.equal(service.formatCapsuleTask({ queued: 0, running: 1 }), '1 任务')
  assert.equal(service.formatCapsuleTask({ queued: 2, running: 1 }), '3 任务')
  assert.equal(service.formatCapsuleTask(undefined), '空闲')
})

test('格式化任务：浮层显示 运行 / 排队', () => {
  assert.equal(service.formatTask({ queued: 0, running: 0 }), '空闲')
  assert.equal(service.formatTask({ queued: 0, running: 1 }), '运行 1 · 排队 0')
  assert.equal(service.formatTask({ queued: 2, running: 1 }), '运行 1 · 排队 2')
  assert.equal(service.formatTask(null), '空闲')
})

test('格式化时长：天 / 小时 / 分钟 / 秒', () => {
  assert.equal(service.formatDuration(0), '0 秒')
  assert.equal(service.formatDuration(59), '59 秒')
  assert.equal(service.formatDuration(60), '1 分钟')
  assert.equal(service.formatDuration(3720), '1 小时 2 分')
  assert.equal(service.formatDuration(90061), '1 天 1 小时')
  assert.equal(service.formatDuration(3 * 86400 + 5 * 3600), '3 天 5 小时')
  assert.equal(service.formatDuration(undefined), '0 秒')
  assert.equal(service.formatDuration(-10), '0 秒')
})

test('格式化类型明细：有类型按「类型 数量」连起来，空给无', () => {
  assert.equal(service.formatTypeDetail({ tts: 2, asr: 1 }), 'tts 2 · asr 1')
  assert.equal(service.formatTypeDetail({ tts: 1.9 }), 'tts 1')
  assert.equal(service.formatTypeDetail({ tts: 0 }), '无')
  assert.equal(service.formatTypeDetail({}), '无')
  assert.equal(service.formatTypeDetail(null), '无')
  assert.equal(service.formatTypeDetail([1, 2]), '无')
})

test('显存色：>95 危险，>85 警告，其余正常', () => {
  assert.equal(service.vramColor(0), '')
  assert.equal(service.vramColor(85), '')
  assert.equal(service.vramColor(86), 'warn')
  assert.equal(service.vramColor(92), 'warn')
  assert.equal(service.vramColor(95), 'warn')
  assert.equal(service.vramColor(96), 'danger')
  assert.equal(service.vramColor(100), 'danger')
  assert.equal(service.vramColor('86'), 'warn')
  assert.equal(service.vramColor(undefined), '')
})

test('格式化视觉：加载 / 就绪两个状态都要说清', () => {
  assert.equal(service.formatVisual({ loaded: true, ready: true }), '已加载 · 已就绪')
  assert.equal(service.formatVisual({ loaded: true, ready: false }), '已加载 · 未就绪')
  assert.equal(service.formatVisual({}), '未加载 · 未就绪')
  assert.equal(service.formatVisual(null), '未加载 · 未就绪')
})

test('指标离线：只有拿到 ok:true 才算在线', () => {
  assert.equal(service.metricsOffline({ load: true, data: { ok: false, code: 'service_down' } }), true)
  assert.equal(service.metricsOffline({ load: true, data: { ok: false, code: 'upstream_error' } }), true)
  assert.equal(service.metricsOffline({ load: true, data: null }), true)
  assert.equal(service.metricsOffline({ load: false, data: null }), false)
  assert.equal(service.metricsOffline({ load: true, data: { ok: true } }), false)
  assert.equal(service.metricsOffline(null), false)
})

test('释放显存文案：已释放 / 没有可释放 / 跳过忙碌模型', () => {
  assert.equal(
    service.vramReleaseCopy({ ok: true, released: ['tts', 'separate'], skipped: [] }),
    '已释放：语音合成、人声分离。',
  )
  assert.equal(service.vramReleaseCopy({ ok: true, released: [], skipped: [] }), '没有可释放的模型。')
  assert.equal(
    service.vramReleaseCopy({ ok: true, released: ['tts'], skipped: ['asr', 'vision'] }),
    '已释放：语音合成；有 2 个模型正在使用，已跳过。',
  )
  assert.equal(
    service.vramReleaseCopy({ ok: true, released: [], skipped: ['asr'] }),
    '没有可释放的模型；有 1 个模型正在使用，已跳过。',
  )
  // 服务端将来加新名字时原样展示，不吞掉。
  assert.equal(service.vramReleaseCopy({ ok: true, released: ['custom'], skipped: [] }), '已释放：custom。')
  assert.equal(service.vramReleaseCopy({ ok: true, released: ['tts', 'tts'], skipped: [] }), '已释放：语音合成。')
  assert.equal(service.vramReleaseCopy({ ok: true, released: ['', null], skipped: [''] }), '没有可释放的模型。')
  assert.equal(service.vramReleaseCopy(null), '没有可释放的模型。')
})

test('释放显存入口：胶囊面板与设置页都调用 /vram-unload', () => {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 两处入口：状态胶囊浮层、设置页状态卡片；按钮文案与说明各出现一次。
  assert.equal((sourceCode.match(/'释放显存'/g) || []).length, 2)
  assert.equal((sourceCode.match(/post\('\/vram-unload', \{\}\)/g) || []).length, 2)
  assert.match(sourceCode, /卸载当前没有任务在用的模型；正在跑的任务会跳过。/)
  assert.match(sourceCode, /vramReleaseCopy\(result\)/)
})
