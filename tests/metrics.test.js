// GET /dsh-fish-service/metrics：归一化、百分比、超时、1 秒缓存与离线分支。
//
// 上游用 startMock 起真的 node:http 服务（不连 7880）；路由通过 makeReq/makeRes 直接调用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../lib/routes.js'
import {
  归一化系统,
  归一化任务,
  合并指标,
  百分比,
  抓一侧,
  造指标读取器,
  指标缓存毫秒,
  指标超时毫秒,
} from '../lib/metrics.js'
import { makeReq, makeRes, startMock, sendJson } from './helpers.js'

const 路由前缀 = '/dsh-fish-service/metrics'

const 系统响应 = {
  ok: true,
  gpu: { name: 'NVIDIA GeForce RTX 4070', used_mb: 7576, total_mb: 8192, free_mb: 616 },
  models_loaded: ['tts', 'vision'],
  service: { version: '2.5.0', uptime_seconds: 273600 },
  vision: { loaded: true, ready: true },
}

const 任务响应 = {
  ok: true,
  total: 3,
  queued: 2,
  running: 1,
  by_kind: { tts: 2, asr: 1 },
  queued_by_kind: { tts: 2 },
  running_by_kind: { asr: 1 },
  scheduler: { current_kind: 'asr', loaded_model: 'SenseVoiceSmall' },
}

/** 最小路由环境：只实现 /metrics 用到的 api / configStore / webServer。 */
function 造路由({ 底座 = '', fetchImpl, metricsTimeoutMs, metricsCacheMs } = {}) {
  const 注册表 = new Map()
  const ctx = {
    webServer: {
      register(定义) {
        注册表.set(定义.path, 定义.handler)
        return () => 注册表.delete(定义.path)
      },
    },
  }
  const 配置 = { baseUrl: 底座, token: '' }
  const configStore = { current: 配置, filePath: '', overrides: [] }
  const api = {
    config: { get: () => ({ ...配置 }) },
    recentErrors: () => [],
    voices: async () => [],
  }
  const capabilities = { current: () => null, refresh: async () => null, status: () => ({}) }
  const cache = { usage: () => ({}), dirPath: '' }
  const logger = { error() {}, warn() {}, info() {}, debug() {} }

  registerRoutes({
    ctx,
    api,
    configStore,
    capabilities,
    cache,
    logger,
    version: '0.1.0',
    fetchImpl,
    metricsTimeoutMs,
    metricsCacheMs,
  })

  return {
    配置,
    注册表,
    async call(path = 路由前缀, { method = 'GET', headers = {} } = {}) {
      const handler = 注册表.get(path)
      assert.equal(typeof handler, 'function', `路由 ${path} 应已注册`)
      const req = await makeReq({ method, url: path, headers })
      const res = makeRes()
      await handler(req, res)
      return { res, json: res.json() }
    },
  }
}

/** 只响应系统/任务两个接口的 mock。 */
async function 起指标服务({ 系统 = 系统响应, 任务 = 任务响应 } = {}) {
  return startMock((req, res, record, url) => {
    if (url.pathname === '/admin/system') {
      return 系统 === null ? sendJson(res, 500, { ok: false }) : sendJson(res, 200, 系统)
    }
    if (url.pathname === '/jobs/stats') {
      return 任务 === null ? sendJson(res, 500, { ok: false }) : sendJson(res, 200, 任务)
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' })
  })
}

// ---------------- 归一化 ----------------

test('归一化系统：完整响应映射成固定形状，百分比取整', () => {
  assert.deepEqual(归一化系统(系统响应), {
    gpu: {
      name: 'NVIDIA GeForce RTX 4070',
      usedMb: 7576,
      totalMb: 8192,
      freeMb: 616,
      percent: 92,
    },
    modelsLoaded: ['tts', 'vision'],
    service: { version: '2.5.0', uptimeSeconds: 273600 },
    vision: { loaded: true, ready: true },
  })
})

test('归一化系统：缺字段 / gpu 为 null 时给中性默认值', () => {
  assert.deepEqual(归一化系统(undefined), {
    gpu: { name: '', usedMb: 0, totalMb: 0, freeMb: 0, percent: 0 },
    modelsLoaded: [],
    service: { version: '', uptimeSeconds: 0 },
    vision: { loaded: false, ready: false },
  })
  assert.deepEqual(归一化系统({ gpu: null, models_loaded: null, service: null, vision: null }), {
    gpu: { name: '', usedMb: 0, totalMb: 0, freeMb: 0, percent: 0 },
    modelsLoaded: [],
    service: { version: '', uptimeSeconds: 0 },
    vision: { loaded: false, ready: false },
  })
  // 只有总量时：已用 0，可用按 total - used 推出来。
  const 部分 = 归一化系统({ gpu: { total_mb: 8192 }, service: { uptime_seconds: null } })
  assert.deepEqual(部分.gpu, { name: '', usedMb: 0, totalMb: 8192, freeMb: 8192, percent: 0 })
  assert.equal(部分.service.uptimeSeconds, 0)
  // 非数字和负数一律当 0；字符串数字仍接受。
  const 非法 = 归一化系统({ gpu: { used_mb: '4096', total_mb: -1, free_mb: 'NaN' } })
  assert.equal(非法.gpu.usedMb, 4096)
  assert.equal(非法.gpu.totalMb, 0)
  assert.equal(非法.gpu.freeMb, 0)
})

test('归一化任务：优先顶层 queued_by_kind / running_by_kind', () => {
  assert.deepEqual(归一化任务(任务响应), {
    queue: { queued: 2, running: 1, queuedByKind: { tts: 2 }, runningByKind: { asr: 1 } },
    scheduler: { currentKind: 'asr', loadedModel: 'SenseVoiceSmall' },
  })
  // 兼容只有 by_kind 嵌套的旧形态。
  const 旧形态 = 归一化任务({
    queued: 1,
    running: 0,
    by_kind: { queued: { tts: 1 }, running: { asr: 2 } },
  })
  assert.deepEqual(旧形态.queue, { queued: 1, running: 0, queuedByKind: { tts: 1 }, runningByKind: { asr: 2 } })
  // 空对象 / null 给中性默认值，计数表丢掉 0 和非数字。
  assert.deepEqual(归一化任务(null), {
    queue: { queued: 0, running: 0, queuedByKind: {}, runningByKind: {} },
    scheduler: { currentKind: '', loadedModel: '' },
  })
  assert.deepEqual(归一化任务({ queued: 0, running: 0, queued_by_kind: { tts: 0, asr: 'x', vision: 2 } }).queue.queuedByKind,
    { vision: 2 })
})

test('百分比：0 总量返回 0，越界夹到 0~100，保留整数', () => {
  assert.equal(百分比(7576, 8192), 92)
  assert.equal(百分比(0, 8192), 0)
  assert.equal(百分比(8192, 8192), 100)
  assert.equal(百分比(9000, 8192), 100)
  assert.equal(百分比(5, 0), 0)
  assert.equal(百分比('x', null), 0)
  assert.equal(百分比(-100, 8192), 0)
})

test('合并指标：两侧全失败才是 service_down，单侧成功照常返回', () => {
  assert.deepEqual(合并指标(null, null, 0), { ok: false, code: 'service_down', hint: '本地 AI 未启动' })
  const 单侧 = 合并指标(系统响应, null, 12.7)
  assert.equal(单侧.ok, true)
  assert.equal(单侧.ms, 12.7)
  assert.deepEqual(单侧.gpu, 归一化系统(系统响应).gpu)
  assert.deepEqual(单侧.queue, { queued: 0, running: 0, queuedByKind: {}, runningByKind: {} })
  const 另一侧 = 合并指标(null, 任务响应, 5)
  assert.equal(另一侧.ok, true)
  assert.equal(另一侧.gpu.name, '')
  assert.deepEqual(另一侧.queue, 归一化任务(任务响应).queue)
})

// ---------------- 抓一侧 ----------------

test('抓一侧：2xx 解析 JSON；非 2xx / 解析失败 / 网络错误返回 null', async () => {
  const 好 = async () => ({ ok: true, json: async () => ({ ok: true }) })
  assert.deepEqual(await 抓一侧(好, 'http://x/admin/system'), { ok: true })

  const 坏 = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(await 抓一侧(坏, 'http://x/admin/system'), null)

  const 解析坏 = async () => ({ ok: true, json: async () => { throw new Error('bad json') } })
  assert.equal(await 抓一侧(解析坏, 'http://x/admin/system'), null)

  const 网络坏 = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await 抓一侧(网络坏, 'http://x/admin/system'), null)

  assert.equal(await 抓一侧(null, 'http://x/admin/system'), null)
})

test('抓一侧：带 token 时用 Bearer，超时后返回 null 且不悬挂', async () => {
  let 收到的头 = null
  const 记头 = async (_url, 选项) => {
    收到的头 = 选项.headers
    return { ok: true, json: async () => ({ ok: true }) }
  }
  await 抓一侧(记头, 'http://x/admin/system', { token: 'secret' })
  assert.equal(收到的头.authorization, 'Bearer secret')

  const 慢 = (_url, 选项) => new Promise((_resolve, reject) => {
    选项.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const 开始 = Date.now()
  const 结果 = await 抓一侧(慢, 'http://x/admin/system', { timeoutMs: 20 })
  assert.equal(结果, null)
  assert.ok(Date.now() - 开始 < 1000, '超时应该按时返回')
})

// ---------------- 读取器缓存 ----------------

test('指标读取器：1 秒缓存命中不重复请求，过期后重抓，baseUrl 变了立即失效', async () => {
  let 时刻 = 0
  const 请求 = []
  const 假fetch = async (url) => {
    请求.push(url)
    return { ok: true, json: async () => (url.includes('/admin/system') ? 系统响应 : 任务响应) }
  }
  let 底座 = 'http://127.0.0.1:7880'
  const 读 = 造指标读取器({
    getBaseUrl: () => 底座,
    fetchImpl: 假fetch,
    now: () => 时刻,
    timeoutMs: 100,
  })

  const 第一次 = await 读.read()
  assert.equal(第一次.ok, true)
  assert.equal(请求.length, 2)
  assert.equal(请求[0], 'http://127.0.0.1:7880/admin/system')
  assert.equal(请求[1], 'http://127.0.0.1:7880/jobs/stats?limit=1')

  时刻 = 500
  const 命中 = await 读.read()
  assert.equal(请求.length, 2, '缓存期内不应再打上游')
  assert.equal(命中, 第一次)

  时刻 = 指标缓存毫秒 + 1
  await 读.read()
  assert.equal(请求.length, 4, '缓存过期后应重抓两侧')

  底座 = 'http://127.0.0.1:7881'
  await 读.read()
  assert.equal(请求.length, 6, 'baseUrl 变化应让缓存失效')
  assert.ok(请求[4].startsWith('http://127.0.0.1:7881/'))
})

test('指标读取器：没有 baseUrl 时直接离线，不打上游', async () => {
  let 打了 = 0
  const 读 = 造指标读取器({
    getBaseUrl: () => '',
    fetchImpl: async () => { 打了 += 1; return { ok: true, json: async () => ({}) } },
  })
  assert.deepEqual(await 读.read(), { ok: false, code: 'service_down', hint: '本地 AI 未启动' })
  assert.equal(打了, 0)
  assert.equal(指标超时毫秒, 3000)
})

// ---------------- 路由 ----------------

test('GET /metrics：并行抓两侧，返回归一化后的完整数据', async (t) => {
  const mock = await 起指标服务()
  t.after(() => mock.close())
  const 环境 = 造路由({ 底座: mock.url })

  const { res, json } = await 环境.call()
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(typeof json.ms, 'number')
  assert.ok(json.ms >= 0)
  const { ms: _ms, ...其余 } = json
  assert.deepEqual(其余, {
    ok: true,
    gpu: { name: 'NVIDIA GeForce RTX 4070', usedMb: 7576, totalMb: 8192, freeMb: 616, percent: 92 },
    modelsLoaded: ['tts', 'vision'],
    queue: { queued: 2, running: 1, queuedByKind: { tts: 2 }, runningByKind: { asr: 1 } },
    scheduler: { currentKind: 'asr', loadedModel: 'SenseVoiceSmall' },
    service: { version: '2.5.0', uptimeSeconds: 273600 },
    vision: { loaded: true, ready: true },
  })
  assert.equal(mock.requests.length, 2)
  assert.deepEqual(mock.requests.map((x) => x.path).sort(), ['/admin/system', '/jobs/stats'])
  assert.ok(mock.requests.some((x) => x.url === '/jobs/stats?limit=1'), '任务统计要带 limit=1')
})

test('GET /metrics：1 秒内连续轮询命中缓存，不重复打服务端', async (t) => {
  const mock = await 起指标服务()
  t.after(() => mock.close())
  const 环境 = 造路由({ 底座: mock.url })

  const 第一次 = await 环境.call()
  const 第二次 = await 环境.call()
  assert.equal(mock.requests.length, 2)
  assert.deepEqual(第二次.json, 第一次.json)
})

test('GET /metrics：两侧都失败返回 200 + service_down，轮询方按离线处理', async (t) => {
  const mock = await 起指标服务({ 系统: null, 任务: null })
  t.after(() => mock.close())
  const 环境 = 造路由({ 底座: mock.url })

  const { res, json } = await 环境.call()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json, { ok: false, code: 'service_down', hint: '本地 AI 未启动' })
  assert.equal(mock.requests.length, 2)
})

test('GET /metrics：只有一侧成功时照常返回数据，另一侧字段缺失', async (t) => {
  const mock = await 起指标服务({ 任务: null })
  t.after(() => mock.close())
  const 环境 = 造路由({ 底座: mock.url })

  const { json } = await 环境.call()
  assert.equal(json.ok, true)
  assert.equal(json.gpu.percent, 92)
  assert.deepEqual(json.modelsLoaded, ['tts', 'vision'])
  assert.deepEqual(json.queue, { queued: 0, running: 0, queuedByKind: {}, runningByKind: {} })
  assert.deepEqual(json.scheduler, { currentKind: '', loadedModel: '' })
})

test('GET /metrics：非 GET 返回 405，跨源返回 403，都不打上游', async (t) => {
  const mock = await 起指标服务()
  t.after(() => mock.close())
  const 环境 = 造路由({ 底座: mock.url })

  const 方法 = await 环境.call(路由前缀, { method: 'POST' })
  assert.equal(方法.res.statusCode, 405)
  assert.equal(方法.json.code, 'bad_request')

  const 跨源 = await 环境.call(路由前缀, {
    headers: { origin: 'http://evil.example', host: '127.0.0.1:1499' },
  })
  assert.equal(跨源.res.statusCode, 403)
  assert.equal(跨源.json.code, 'bad_request')

  const 同源 = await 环境.call(路由前缀, {
    headers: { origin: `http://127.0.0.1:1499`, host: '127.0.0.1:1499' },
  })
  assert.equal(同源.res.statusCode, 200)

  assert.equal(mock.requests.length, 2, '只有同源 GET 会打上游')
})
