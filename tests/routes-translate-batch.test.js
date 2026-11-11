// 分段批量翻译路由：按 id 回填、空段不翻、单段失败不连累整批、方法/同源/错误码。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../lib/routes.js'
import { makeError } from '../lib/errors.js'
import { makeReq, makeRes } from './helpers.js'

const 路径 = '/dsh-fish-service/translate/batch'
const 同源头 = { host: '127.0.0.1:10154', origin: 'http://127.0.0.1:10154' }

function 搭环境({ apiOverrides = {} } = {}) {
  const 配置 = {
    baseUrl: 'http://127.0.0.1:7880',
    enabled: true,
    cacheDir: 'C:\\cache',
    cacheTtlHours: 72,
    cacheMaxMb: 2048,
    logLevel: 'info',
    primaryLanguage: 'zh',
    secondaryLanguage: 'en',
  }
  const 调用 = { translate: [] }
  const api = {
    config: { get: () => ({ ...配置 }), set: async () => ({ ok: true }) },
    translate: async (输入, 选项) => {
      调用.translate.push({ 输入, 选项 })
      const 文本们 = Array.isArray(输入) ? 输入 : [输入]
      return {
        ok: true,
        texts: 文本们.map((文本) => `译:${文本}`),
        source: (选项 && 选项.source) || 'auto',
        target: (选项 && 选项.target) || 'zh',
        engine: 'nllb',
        ms: 4,
      }
    },
    ...apiOverrides,
  }

  const 路由 = new Map()
  const ctx = {
    webServer: {
      register: (定义) => {
        路由.set(定义.path, 定义.handler)
        return () => 路由.delete(定义.path)
      },
    },
  }
  registerRoutes({
    ctx,
    api,
    configStore: { current: 配置, save: (c) => c },
    capabilities: { current: () => ({ ok: true, capabilities: {} }), refresh: async () => ({ ok: true, capabilities: {} }), status: () => ({}) },
    cache: { usage: () => ({ dir: '', bytes: 0, mb: 0, files: 0, byKind: {}, ttlHours: 72, maxMb: 2048 }) },
    logger: { filePath: '', recent: () => [], error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    spawn: () => ({ unref: () => {} }),
    platform: 'win32',
  })

  const call = async (方法 = 'POST', 体, 头 = 同源头) => {
    const handler = 路由.get(路径)
    assert.ok(handler, `没有注册 ${路径}`)
    const req = await makeReq({ method: 方法, url: 路径, body: 体, headers: 头 })
    const res = makeRes()
    await handler(req, res)
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }

  return { call, 调用, 路由 }
}

test('POST /translate/batch：按 id 回填，空段不翻，单段超长只标记那一段', async () => {
  const env = 搭环境()
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
  assert.equal(env.调用.translate.length, 1)
  assert.deepEqual(env.调用.translate[0].输入, ['你好', 'hello'])
  assert.equal(env.调用.translate[0].选项.source, 'zh')
  assert.equal(env.调用.translate[0].选项.target, 'en')
})

test('POST /translate/batch：全是空白时不调引擎，直接回空译文', async () => {
  const env = 搭环境()
  const { res, json } = await env.call('POST', { texts: [{ id: 1, text: '' }, { id: 2, text: '\n\n' }] })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.results.length, 2)
  assert.equal(json.results[0].translated, '')
  assert.equal(env.调用.translate.length, 0)
})

test('POST /translate/batch：格式不对 / 超量都回 400，且不调引擎', async () => {
  const env = 搭环境()

  let 结果 = await env.call('POST', {})
  assert.equal(结果.res.statusCode, 400)
  assert.equal(结果.json.code, 'bad_request')
  assert.match(结果.json.hint, /没有可翻译的文字/)

  结果 = await env.call('POST', { texts: [] })
  assert.equal(结果.res.statusCode, 400)

  结果 = await env.call('POST', { texts: [{ id: 1 }] })
  assert.equal(结果.res.statusCode, 400)
  assert.match(结果.json.hint, /翻译分段格式不对/)

  结果 = await env.call('POST', { texts: [{ id: null, text: '你好' }] })
  assert.equal(结果.res.statusCode, 400)

  结果 = await env.call('POST', { texts: [{ id: 1, text: 123 }] })
  assert.equal(结果.res.statusCode, 400)

  结果 = await env.call('POST', { texts: Array.from({ length: 501 }, (_, i) => ({ id: i, text: 'x' })) })
  assert.equal(结果.res.statusCode, 400)
  assert.match(结果.json.hint, /最多翻译 500 段/)

  // 每段都没超，但总数超 20 万字。
  结果 = await env.call('POST', {
    texts: Array.from({ length: 41 }, (_, i) => ({ id: i, text: 'x'.repeat(5000) })),
  })
  assert.equal(结果.res.statusCode, 400)
  assert.match(结果.json.hint, /最多翻译 200000 字/)

  assert.equal(env.调用.translate.length, 0)
})

test('POST /translate/batch：引擎整批失败回 502，错误码沿用现有风格', async () => {
  const env = 搭环境({
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
  const env = 搭环境({
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
  const env = 搭环境()

  const 不是POST = await env.call('GET')
  assert.equal(不是POST.res.statusCode, 405)
  assert.match(不是POST.json.hint, /仅支持 POST/)

  const 跨源 = await env.call('POST', { texts: [{ id: 1, text: '你好' }] }, {
    host: '127.0.0.1:10154',
    origin: 'http://evil.example',
  })
  assert.equal(跨源.res.statusCode, 403)
  assert.equal(跨源.json.code, 'bad_request')
})
