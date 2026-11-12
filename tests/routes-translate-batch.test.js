// 分段批量翻译路由：按 id 回填、空段不翻、单段失败不连累整批、方法/同源/错误码。
// 另含后台任务队列的 4 条路由：提交 / 状态 / 取结果 / 取消，以及旧版服务回退。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../lib/routes.js'
import { makeError } from '../lib/errors.js'
import { makeReq, makeRes } from './helpers.js'

const path = '/dsh-fish-service/translate/batch'
const sameOriginHeaders = { host: '127.0.0.1:10154', origin: 'http://127.0.0.1:10154' }

function setupEnv({ apiOverrides = {} } = {}) {
  const config = {
    baseUrl: 'http://127.0.0.1:7880',
    enabled: true,
    cacheDir: 'C:\\cache',
    cacheTtlHours: 72,
    cacheMaxMb: 2048,
    logLevel: 'info',
    primaryLanguage: 'zh',
    secondaryLanguage: 'en',
  }
  const calls = { translate: [] }
  const api = {
    config: { get: () => ({ ...config }), set: async () => ({ ok: true }) },
    translate: async (input, option) => {
      calls.translate.push({ input, option })
      const texts = Array.isArray(input) ? input : [input]
      return {
        ok: true,
        texts: texts.map((text) => `译:${text}`),
        source: (option && option.source) || 'auto',
        target: (option && option.target) || 'zh',
        engine: 'nllb',
        ms: 4,
      }
    },
    ...apiOverrides,
  }

  const route = new Map()
  const ctx = {
    webServer: {
      register: (define) => {
        route.set(define.path, define.handler)
        return () => route.delete(define.path)
      },
    },
  }
  registerRoutes({
    ctx,
    api,
    configStore: { current: config, save: (c) => c },
    capabilities: { current: () => ({ ok: true, capabilities: {} }), refresh: async () => ({ ok: true, capabilities: {} }), status: () => ({}) },
    cache: { usage: () => ({ dir: '', bytes: 0, mb: 0, files: 0, byKind: {}, ttlHours: 72, maxMb: 2048 }) },
    logger: { filePath: '', recent: () => [], error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    spawn: () => ({ unref: () => {} }),
    platform: 'win32',
  })

  const call = async (method = 'POST', body, headers = sameOriginHeaders) => {
    const handler = route.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = await makeReq({ method: method, url: path, body: body, headers: headers })
    const res = makeRes()
    await handler(req, res)
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }

  return { call, calls, route }
}

test('POST /translate/batch：按 id 回填，空段不翻，单段超长只标记那一段', async () => {
  const env = setupEnv()
  const { res, json } = await env.call('POST', {
    texts: [
      { id: 0, text: '你好' },
      { id: 1, text: '   ' },
      { id: 2, text: 'x'.repeat(5001) },
      { id: 'e', text: 'hello' },
    ],
    source: 'zh',
    target: 'en',
  })

  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.source, 'zh')
  assert.equal(json.target, 'en')
  assert.equal(json.results.length, 4)
  assert.deepEqual(json.results[0], { id: 0, translated: '译:你好', detectedLang: 'zh' })
  assert.deepEqual(json.results[1], { id: 1, translated: '' })
  assert.equal(json.results[2].id, 2)
  assert.equal(json.results[2].translated, '')
  assert.match(json.results[2].error.hint, /单段最多 5000 字/)
  assert.deepEqual(json.results[3], { id: 'e', translated: '译:hello', detectedLang: 'en' })

  // 只有能翻的两段送去引擎，且保持原顺序。
  assert.equal(env.calls.translate.length, 1)
  assert.deepEqual(env.calls.translate[0].input, ['你好', 'hello'])
  assert.equal(env.calls.translate[0].option.source, 'zh')
  assert.equal(env.calls.translate[0].option.target, 'en')
})

test('POST /translate/batch：全是空白时不调引擎，直接回空译文', async () => {
  const env = setupEnv()
  const { res, json } = await env.call('POST', { texts: [{ id: 1, text: '' }, { id: 2, text: '\n\n' }] })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.results.length, 2)
  assert.equal(json.results[0].translated, '')
  assert.equal(env.calls.translate.length, 0)
})

test('POST /translate/batch：格式不对 / 超量都回 400，且不调引擎', async () => {
  const env = setupEnv()

  let result = await env.call('POST', {})
  assert.equal(result.res.statusCode, 400)
  assert.equal(result.json.code, 'bad_request')
  assert.match(result.json.hint, /没有可翻译的文字/)

  result = await env.call('POST', { texts: [] })
  assert.equal(result.res.statusCode, 400)

  result = await env.call('POST', { texts: [{ id: 1 }] })
  assert.equal(result.res.statusCode, 400)
  assert.match(result.json.hint, /翻译分段格式不对/)

  result = await env.call('POST', { texts: [{ id: null, text: '你好' }] })
  assert.equal(result.res.statusCode, 400)

  result = await env.call('POST', { texts: [{ id: 1, text: 123 }] })
  assert.equal(result.res.statusCode, 400)

  result = await env.call('POST', { texts: Array.from({ length: 501 }, (_, i) => ({ id: i, text: 'x' })) })
  assert.equal(result.res.statusCode, 400)
  assert.match(result.json.hint, /最多翻译 500 段/)

  // 每段都没超，但总数超 20 万字。
  result = await env.call('POST', {
    texts: Array.from({ length: 41 }, (_, i) => ({ id: i, text: 'x'.repeat(5000) })),
  })
  assert.equal(result.res.statusCode, 400)
  assert.match(result.json.hint, /最多翻译 200000 字/)

  assert.equal(env.calls.translate.length, 0)
})

test('POST /translate/batch：引擎整批失败回 502，错误码沿用现有风格', async () => {
  const env = setupEnv({
    apiOverrides: {
      translate: async () => {
        throw makeError('service_down', { hint: '本地 AI 没在运行，先启动服务再试。' })
      },
    },
  })
  const { res, json } = await env.call('POST', { texts: [{ id: 1, text: '你好' }] })
  assert.equal(res.statusCode, 502)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'service_down')
  assert.match(json.hint, /先启动服务/)
})

test('POST /translate/batch：引擎少回一条时，只把缺的那段标成可重试', async () => {
  const env = setupEnv({
    apiOverrides: {
      translate: async () => ({
        ok: true,
        texts: ['译:甲'],
        source: 'zh',
        target: 'en',
        engine: 'nllb',
        ms: 2,
      }),
    },
  })
  const { res, json } = await env.call('POST', {
    texts: [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }],
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json.results[0], { id: 'a', translated: '译:甲', detectedLang: 'zh' })
  assert.equal(json.results[1].translated, '')
  assert.equal(json.results[1].error.code, 'upstream_error')
  assert.match(json.results[1].error.hint, /继续翻译/)
})

test('POST /translate/batch：只接受 POST，跨源回 403', async () => {
  const env = setupEnv()

  const notPost = await env.call('GET')
  assert.equal(notPost.res.statusCode, 405)
  assert.match(notPost.json.hint, /仅支持 POST/)

  const crossOrigin = await env.call('POST', { texts: [{ id: 1, text: '你好' }] }, {
    host: '127.0.0.1:10154',
    origin: 'http://evil.example',
  })
  assert.equal(crossOrigin.res.statusCode, 403)
  assert.equal(crossOrigin.json.code, 'bad_request')
})

// ---------------- 后台任务队列路由 ----------------

const taskPath = '/dsh-fish-service/translate/jobs'

function setupTaskEnv({ submit, status, result, cancel } = {}) {
  const calls = { submit: [], status: [], result: [], cancel: [] }
  const api = {
    config: { get: () => ({ enabled: true }) },
    translateJobs: {
      submit: async (texts, option) => {
        calls.submit.push({ texts, option })
        if (submit) return submit(texts, option)
        return {
          ok: true,
          id: 'j1',
          state: 'queued',
          source: (option && option.source) || 'auto',
          target: (option && option.target) || 'en',
          count: texts.length,
        }
      },
      status: async (id) => {
        calls.status.push(id)
        if (status) return status(id)
        return { ok: true, id, state: 'running', progress: null }
      },
      result: async (id) => {
        calls.result.push(id)
        if (result) return result(id)
        return { ok: true, id, state: 'done', texts: ['译:甲'], source: 'zh', target: 'en', engine: 'nllb' }
      },
      cancel: async (id) => {
        calls.cancel.push(id)
        if (cancel) return cancel(id)
        return { ok: true, id, state: 'canceled', cancelRequested: true }
      },
    },
  }

  const route = new Map()
  const ctx = {
    webServer: {
      register: (define) => {
        route.set(define.path, define.handler)
        return () => route.delete(define.path)
      },
    },
  }
  registerRoutes({
    ctx,
    api,
    configStore: { current: {}, save: (c) => c },
    capabilities: { current: () => ({ ok: true, capabilities: {} }), refresh: async () => ({ ok: true, capabilities: {} }), status: () => ({}) },
    cache: { usage: () => ({ dir: '', bytes: 0, mb: 0, files: 0, byKind: {}, ttlHours: 72, maxMb: 2048 }) },
    logger: { filePath: '', recent: () => [], error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    spawn: () => ({ unref: () => {} }),
    platform: 'win32',
  })

  const request = async (method, path, body, headers = sameOriginHeaders, query = '') => {
    const handler = route.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = await makeReq({ method: method, url: `${path}${query}`, body: body, headers: headers })
    const res = makeRes()
    await handler(req, res)
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }

  return { request, calls }
}

test('POST /translate/jobs：提交任务回 job id；旧版服务回 200 not_supported 供面板回退', async () => {
  const env = setupTaskEnv()
  const { res, json } = await env.request('POST', taskPath, {
    texts: ['甲', '乙'],
    source: 'zh',
    target: 'en',
    timeoutMs: 180000,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.id, 'j1')
  assert.equal(json.state, 'queued')
  assert.equal(json.source, 'zh')
  assert.equal(json.target, 'en')
  assert.equal(json.count, 2)
  assert.deepEqual(env.calls.submit[0].texts, ['甲', '乙'])
  assert.equal(env.calls.submit[0].option.source, 'zh')
  assert.equal(env.calls.submit[0].option.target, 'en')

  const legacy = setupTaskEnv({
    submit: () => {
      throw makeError('not_implemented', { hint: '当前本地 AI 版本较旧，已改用直接翻译。' })
    },
  })
  const prevResult = await legacy.request('POST', taskPath, { texts: ['甲'] })
  assert.equal(prevResult.res.statusCode, 200, '旧版服务要让面板能拿到 not_supported 后回退')
  assert.equal(prevResult.json.ok, false)
  assert.equal(prevResult.json.code, 'not_supported')
  assert.match(prevResult.json.hint, /版本较旧/)

  const serviceDown = setupTaskEnv({
    submit: () => {
      throw makeError('service_down', { hint: '本地 AI 没在运行，先启动服务再试。' })
    },
  })
  const attachResult = await serviceDown.request('POST', taskPath, { texts: ['甲'] })
  assert.equal(attachResult.res.statusCode, 502)
  assert.equal(attachResult.json.code, 'service_down')
})

test('POST /translate/jobs：没有文字 / 非字符串 / 超 500 段回 400，不提交任务', async () => {
  const env = setupTaskEnv()

  let result = await env.request('POST', taskPath, {})
  assert.equal(result.res.statusCode, 400)
  assert.match(result.json.hint, /没有可翻译的文字/)

  result = await env.request('POST', taskPath, { texts: ['甲', 123] })
  assert.equal(result.res.statusCode, 400)

  result = await env.request('POST', taskPath, { texts: Array.from({ length: 501 }, () => 'x') })
  assert.equal(result.res.statusCode, 400)
  assert.match(result.json.hint, /最多翻译 500 段/)

  // 跨源被拒。
  result = await env.request('POST', taskPath, { texts: ['甲'] }, { host: '127.0.0.1:10154', origin: 'http://evil.example' })
  assert.equal(result.res.statusCode, 403)

  assert.equal(env.calls.submit.length, 0)
})

test('GET /translate/jobs/status：按 id 查状态；缺 id 回 400；只接受 GET', async () => {
  const env = setupTaskEnv()
  const { res, json } = await env.request('GET', `${taskPath}/status`, undefined, sameOriginHeaders, '?id=j1')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.id, 'j1')
  assert.equal(json.state, 'running')
  assert.deepEqual(env.calls.status, ['j1'])

  const missingId = setupTaskEnv({
    status: (id) => {
      if (!id) throw makeError('bad_request', { hint: '缺少 jobId。' })
      return { ok: true, id, state: 'queued' }
    },
  })
  const empty = await missingId.request('GET', `${taskPath}/status`)
  assert.equal(empty.res.statusCode, 400)
  assert.match(empty.json.hint, /缺少 jobId/)

  const methodErr = await env.request('POST', `${taskPath}/status`, {})
  assert.equal(methodErr.res.statusCode, 405)
})

test('GET /translate/jobs/result：完成回 texts；未完成回 200 not_ready；任务不存在回 502', async () => {
  const env = setupTaskEnv()
  const { res, json } = await env.request('GET', `${taskPath}/result`, undefined, sameOriginHeaders, '?id=j1')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.state, 'done')
  assert.deepEqual(json.texts, ['译:甲'])
  assert.deepEqual(env.calls.result, ['j1'])

  const unfinished = setupTaskEnv({
    result: (id) => ({ ok: false, id, state: 'not_done', code: 'not_ready', hint: '翻译还没完成，请稍后再取。' }),
  })
  const pending = await unfinished.request('GET', `${taskPath}/result`, undefined, sameOriginHeaders, '?id=j1')
  assert.equal(pending.res.statusCode, 200)
  assert.equal(pending.json.ok, false)
  assert.equal(pending.json.code, 'not_ready')

  const lost = setupTaskEnv({
    result: () => {
      throw makeError('bad_request', { hint: '没有这个任务。' })
    },
  })
  const miss = await lost.request('GET', `${taskPath}/result`, undefined, sameOriginHeaders, '?id=missing')
  assert.equal(miss.res.statusCode, 400)
})

test('POST /translate/jobs/cancel：成功/失败都回 200；只接受 POST；跨源回 403', async () => {
  const env = setupTaskEnv()
  const { res, json } = await env.request('POST', `${taskPath}/cancel`, { id: 'j1' })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.state, 'canceled')
  assert.deepEqual(env.calls.cancel, ['j1'])

  const fail = setupTaskEnv({
    cancel: () => {
      throw makeError('canceled', { hint: '任务已经结束了。' })
    },
  })
  const miss = await fail.request('POST', `${taskPath}/cancel`, { id: 'j1' })
  assert.equal(miss.res.statusCode, 200, '取消失败也算停止，面板不弹错')
  assert.equal(miss.json.ok, false)
  assert.equal(miss.json.code, 'canceled')

  const methodErr = await env.request('GET', `${taskPath}/cancel`)
  assert.equal(methodErr.res.statusCode, 405)
  const crossOrigin = await env.request('POST', `${taskPath}/cancel`, { id: 'j1' }, { host: '127.0.0.1:10154', origin: 'http://evil.example' })
  assert.equal(crossOrigin.res.statusCode, 403)

  const submitMethodErr = await env.request('GET', taskPath)
  assert.equal(submitMethodErr.res.statusCode, 405)
})
