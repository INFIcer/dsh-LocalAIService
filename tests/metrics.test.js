// GET /dsh-fish-service/metrics：归一化、百分比、超时、1 秒缓存与离线分支。
//
// 上游用 startMock 起真的 node:http 服务（不连 7880）；路由通过 makeReq/makeRes 直接调用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../lib/routes.js'
import {
  normalizeSystem,
  normalizeTask,
  mergeMetrics,
  percent,
  fetchOneSide,
  makeMetricsReader,
  metricsDefaultCacheMs,
  metricsDefaultTimeoutMs,
} from '../lib/metrics.js'
import { makeReq, makeRes, startMock, sendJson } from './helpers.js'

const routePrefix = '/dsh-fish-service/metrics'

const systemResponse = {
  ok: true,
  gpu: { name: 'NVIDIA GeForce RTX 4070', used_mb: 7576, total_mb: 8192, free_mb: 616 },
  models_loaded: ['tts', 'vision'],
  service: { version: '2.5.0', uptime_seconds: 273600 },
  vision: { loaded: true, ready: true },
}

const taskResponse = {
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
function makeRouter({ base = '', fetchImpl, metricsTimeoutMs, metricsCacheMs } = {}) {
  const registry = new Map()
  const ctx = {
    webServer: {
      register(define) {
        registry.set(define.path, define.handler)
        return () => registry.delete(define.path)
      },
    },
  }
  const config = { baseUrl: base, token: '' }
  const configStore = { current: config, filePath: '', overrides: [] }
  const api = {
    config: { get: () => ({ ...config }) },
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
    config,
    registry,
    async call(path = routePrefix, { method = 'GET', headers = {} } = {}) {
      const handler = registry.get(path)
      assert.equal(typeof handler, 'function', `路由 ${path} 应已注册`)
      const req = await makeReq({ method, url: path, headers })
      const res = makeRes()
      await handler(req, res)
      return { res, json: res.json() }
    },
  }
}

/** 只响应系统/任务两个接口的 mock。 */
async function startMetricsService({ system = systemResponse, task = taskResponse } = {}) {
  return startMock((req, res, record, url) => {
    if (url.pathname === '/admin/system') {
      return system === null ? sendJson(res, 500, { ok: false }) : sendJson(res, 200, system)
    }
    if (url.pathname === '/jobs/stats') {
      return task === null ? sendJson(res, 500, { ok: false }) : sendJson(res, 200, task)
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' })
  })
}

// ---------------- 归一化 ----------------

test('归一化系统：完整响应映射成固定形状，百分比取整', () => {
  assert.deepEqual(normalizeSystem(systemResponse), {
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
  assert.deepEqual(normalizeSystem(undefined), {
    gpu: { name: '', usedMb: 0, totalMb: 0, freeMb: 0, percent: 0 },
    modelsLoaded: [],
    service: { version: '', uptimeSeconds: 0 },
    vision: { loaded: false, ready: false },
  })
  assert.deepEqual(normalizeSystem({ gpu: null, models_loaded: null, service: null, vision: null }), {
    gpu: { name: '', usedMb: 0, totalMb: 0, freeMb: 0, percent: 0 },
    modelsLoaded: [],
    service: { version: '', uptimeSeconds: 0 },
    vision: { loaded: false, ready: false },
  })
  // 只有总量时：已用 0，可用按 total - used 推出来。
  const partial = normalizeSystem({ gpu: { total_mb: 8192 }, service: { uptime_seconds: null } })
  assert.deepEqual(partial.gpu, { name: '', usedMb: 0, totalMb: 8192, freeMb: 8192, percent: 0 })
  assert.equal(partial.service.uptimeSeconds, 0)
  // 非数字和负数一律当 0；字符串数字仍接受。
  const invalid = normalizeSystem({ gpu: { used_mb: '4096', total_mb: -1, free_mb: 'NaN' } })
  assert.equal(invalid.gpu.usedMb, 4096)
  assert.equal(invalid.gpu.totalMb, 0)
  assert.equal(invalid.gpu.freeMb, 0)
})

test('归一化任务：优先顶层 queued_by_kind / running_by_kind', () => {
  assert.deepEqual(normalizeTask(taskResponse), {
    queue: { queued: 2, running: 1, queuedByKind: { tts: 2 }, runningByKind: { asr: 1 } },
    scheduler: { currentKind: 'asr', loadedModel: 'SenseVoiceSmall' },
  })
  // 兼容只有 by_kind 嵌套的旧形态。
  const prevShape = normalizeTask({
    queued: 1,
    running: 0,
    by_kind: { queued: { tts: 1 }, running: { asr: 2 } },
  })
  assert.deepEqual(prevShape.queue, { queued: 1, running: 0, queuedByKind: { tts: 1 }, runningByKind: { asr: 2 } })
  // 空对象 / null 给中性默认值，计数表丢掉 0 和非数字。
  assert.deepEqual(normalizeTask(null), {
    queue: { queued: 0, running: 0, queuedByKind: {}, runningByKind: {} },
    scheduler: { currentKind: '', loadedModel: '' },
  })
  assert.deepEqual(normalizeTask({ queued: 0, running: 0, queued_by_kind: { tts: 0, asr: 'x', vision: 2 } }).queue.queuedByKind,
    { vision: 2 })
})

test('百分比：0 总量返回 0，越界夹到 0~100，保留整数', () => {
  assert.equal(percent(7576, 8192), 92)
  assert.equal(percent(0, 8192), 0)
  assert.equal(percent(8192, 8192), 100)
  assert.equal(percent(9000, 8192), 100)
  assert.equal(percent(5, 0), 0)
  assert.equal(percent('x', null), 0)
  assert.equal(percent(-100, 8192), 0)
})

test('合并指标：两侧全失败才是 service_down，单侧成功照常返回', () => {
  assert.deepEqual(mergeMetrics(null, null, 0), { ok: false, code: 'service_down', hint: '本地 AI 未启动' })
  const oneSide = mergeMetrics(systemResponse, null, 12.7)
  assert.equal(oneSide.ok, true)
  assert.equal(oneSide.ms, 12.7)
  assert.deepEqual(oneSide.gpu, normalizeSystem(systemResponse).gpu)
  assert.deepEqual(oneSide.queue, { queued: 0, running: 0, queuedByKind: {}, runningByKind: {} })
  const otherOneSide = mergeMetrics(null, taskResponse, 5)
  assert.equal(otherOneSide.ok, true)
  assert.equal(otherOneSide.gpu.name, '')
  assert.deepEqual(otherOneSide.queue, normalizeTask(taskResponse).queue)
})

// ---------------- 抓一侧 ----------------

test('抓一侧：2xx 解析 JSON；非 2xx / 解析失败 / 网络错误返回 null', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ ok: true }) })
  assert.deepEqual(await fetchOneSide(ok, 'http://x/admin/system'), { ok: true })

  const bad = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(await fetchOneSide(bad, 'http://x/admin/system'), null)

  const parseBad = async () => ({ ok: true, json: async () => { throw new Error('bad json') } })
  assert.equal(await fetchOneSide(parseBad, 'http://x/admin/system'), null)

  const networkBad = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await fetchOneSide(networkBad, 'http://x/admin/system'), null)

  assert.equal(await fetchOneSide(null, 'http://x/admin/system'), null)
})

test('抓一侧：带 token 时用 Bearer，超时后返回 null 且不悬挂', async () => {
  let receivedHeader = null
  const rememberHeaders = async (_url, option) => {
    receivedHeader = option.headers
    return { ok: true, json: async () => ({ ok: true }) }
  }
  await fetchOneSide(rememberHeaders, 'http://x/admin/system', { token: 'secret' })
  assert.equal(receivedHeader.authorization, 'Bearer secret')

  const slow = (_url, option) => new Promise((_resolve, reject) => {
    option.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const begin = Date.now()
  const result = await fetchOneSide(slow, 'http://x/admin/system', { timeoutMs: 20 })
  assert.equal(result, null)
  assert.ok(Date.now() - begin < 1000, '超时应该按时返回')
})

// ---------------- 读取器缓存 ----------------

test('指标读取器：1 秒缓存命中不重复请求，过期后重抓，baseUrl 变了立即失效', async () => {
  let timestamp = 0
  const request = []
  const fakeFetch = async (url) => {
    request.push(url)
    return { ok: true, json: async () => (url.includes('/admin/system') ? systemResponse : taskResponse) }
  }
  let base = 'http://127.0.0.1:7880'
  const read = makeMetricsReader({
    getBaseUrl: () => base,
    fetchImpl: fakeFetch,
    now: () => timestamp,
    timeoutMs: 100,
  })

  const firstTime = await read.read()
  assert.equal(firstTime.ok, true)
  assert.equal(request.length, 2)
  assert.equal(request[0], 'http://127.0.0.1:7880/admin/system')
  assert.equal(request[1], 'http://127.0.0.1:7880/jobs/stats?limit=1')

  timestamp = 500
  const hit = await read.read()
  assert.equal(request.length, 2, '缓存期内不应再打上游')
  assert.equal(hit, firstTime)

  timestamp = metricsDefaultCacheMs + 1
  await read.read()
  assert.equal(request.length, 4, '缓存过期后应重抓两侧')

  base = 'http://127.0.0.1:7881'
  await read.read()
  assert.equal(request.length, 6, 'baseUrl 变化应让缓存失效')
  assert.ok(request[4].startsWith('http://127.0.0.1:7881/'))
})

test('指标读取器：没有 baseUrl 时直接离线，不打上游', async () => {
  let logged = 0
  const read = makeMetricsReader({
    getBaseUrl: () => '',
    fetchImpl: async () => { logged += 1; return { ok: true, json: async () => ({}) } },
  })
  assert.deepEqual(await read.read(), { ok: false, code: 'service_down', hint: '本地 AI 未启动' })
  assert.equal(logged, 0)
  assert.equal(metricsDefaultTimeoutMs, 3000)
})

// ---------------- 路由 ----------------

test('GET /metrics：并行抓两侧，返回归一化后的完整数据', async (t) => {
  const mock = await startMetricsService()
  t.after(() => mock.close())
  const env = makeRouter({ base: mock.url })

  const { res, json } = await env.call()
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(typeof json.ms, 'number')
  assert.ok(json.ms >= 0)
  const { ms: _ms, ...others } = json
  assert.deepEqual(others, {
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
  const mock = await startMetricsService()
  t.after(() => mock.close())
  const env = makeRouter({ base: mock.url })

  const firstTime = await env.call()
  const secondTime = await env.call()
  assert.equal(mock.requests.length, 2)
  assert.deepEqual(secondTime.json, firstTime.json)
})

test('GET /metrics：两侧都失败返回 200 + service_down，轮询方按离线处理', async (t) => {
  const mock = await startMetricsService({ system: null, task: null })
  t.after(() => mock.close())
  const env = makeRouter({ base: mock.url })

  const { res, json } = await env.call()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json, { ok: false, code: 'service_down', hint: '本地 AI 未启动' })
  assert.equal(mock.requests.length, 2)
})

test('GET /metrics：只有一侧成功时照常返回数据，另一侧字段缺失', async (t) => {
  const mock = await startMetricsService({ task: null })
  t.after(() => mock.close())
  const env = makeRouter({ base: mock.url })

  const { json } = await env.call()
  assert.equal(json.ok, true)
  assert.equal(json.gpu.percent, 92)
  assert.deepEqual(json.modelsLoaded, ['tts', 'vision'])
  assert.deepEqual(json.queue, { queued: 0, running: 0, queuedByKind: {}, runningByKind: {} })
  assert.deepEqual(json.scheduler, { currentKind: '', loadedModel: '' })
})

test('GET /metrics：非 GET 返回 405，跨源返回 403，都不打上游', async (t) => {
  const mock = await startMetricsService()
  t.after(() => mock.close())
  const env = makeRouter({ base: mock.url })

  const method = await env.call(routePrefix, { method: 'POST' })
  assert.equal(method.res.statusCode, 405)
  assert.equal(method.json.code, 'bad_request')

  const crossOrigin = await env.call(routePrefix, {
    headers: { origin: 'http://evil.example', host: '127.0.0.1:1499' },
  })
  assert.equal(crossOrigin.res.statusCode, 403)
  assert.equal(crossOrigin.json.code, 'bad_request')

  const sameOrigin = await env.call(routePrefix, {
    headers: { origin: `http://127.0.0.1:1499`, host: '127.0.0.1:1499' },
  })
  assert.equal(sameOrigin.res.statusCode, 200)

  assert.equal(mock.requests.length, 2, '只有同源 GET 会打上游')
})
