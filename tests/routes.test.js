// 宿主路由：/health /state /save /test /logs /voices，以及 P2 的
// /read /audio /transcribe-upload /voice-upload：方法限制、同源、错误码、脱敏、防穿越。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerRoutes } from '../lib/routes.js'
import { CacheStore } from '../lib/cache.js'
import { makeError } from '../lib/errors.js'
import { prepareSpeech } from '../lib/speech.js'
import { makeReq, makeRes, makeTempDir, makeStack, basicHandler, sendBuffer } from './helpers.js'

const time = '2026-11-09T12:00:00.000Z'
const capabilityTable = {
  tts: { available: true, ready: true, loaded: false, model: 'IndexTTS-2.5' },
  asr: { available: true, ready: true, loaded: false, model: 'SenseVoiceSmall' },
}

function snapshot(overrides = {}) {
  return {
    ok: true,
    reachable: true,
    compatible: true,
    baseUrl: 'http://127.0.0.1:7880',
    latencyMs: 12,
    checkedAt: time,
    checkedAtMs: Date.parse(time),
    serviceVersion: '2.5.0',
    apiVersion: '1',
    vram: { freeMb: 6973, totalMb: 8192 },
    capabilities: capabilityTable,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  }
}

function setupEnv({ apiOverrides = {}, initialSnapshot = snapshot(), refreshImpl = null, configPatch = {}, cacheStub = null, spawn = null, platform = 'win32' } = {}) {
  const config = {
    baseUrl: 'http://127.0.0.1:7880',
    ttsVoice: 'dafeiyu',
    ttsSpeed: 1,
    autoRead: false,
    autoReadSessions: {},
    recordDeviceId: '',
    token: '***已设置***',
    enabled: true,
    cacheDir: 'C:\\cache',
    cacheTtlHours: 72,
    cacheMaxMb: 2048,
    logLevel: 'info',
    ...configPatch,
  }
  let currentSnapshot = initialSnapshot
  const status = { lastCheckAt: Date.parse(time), latencyMs: 12, consecutiveFailures: 0 }

  const configStore = {
    current: config,
    filePath: 'C:\\Users\\Administrator\\.dsh\\fish-service-config.json',
    overrides: ['ttsVoice'],
    save: (c) => c,
  }

  const capabilities = {
    refresh: async (opts) => {
      if (refreshImpl) return refreshImpl(opts)
      return currentSnapshot
    },
    current: () => currentSnapshot,
    status: () => status,
  }

  const calls = { save: [], voices: 0, logLineCount: [], refresh: 0, spawn: [] }
  const api = {
    config: {
      get: () => ({ ...config }),
      set: async (patch) => {
        calls.save.push(patch)
        if (patch && patch.bad === true) throw makeError('bad_request', { detail: 'bad', hint: '参数不对：bad' })
        return { ok: true, applied: Object.keys(patch || {}), requiresRestart: false, warnings: [] }
      },
    },
    voices: async () => {
      calls.voices += 1
      return [{ name: 'dafeiyu' }, { name: 'default' }]
    },
    recentErrors: () => [{ code: 'service_down', hint: '没有启动' }],
    // 与真实 api 的 1.17 契约一致；用例只覆盖自己关心的字段，其余走这里默认值。
    visionPrefs: () => ({
      localDescribe: config.localDescribe !== false,
      visionSessionReady: config.localDescribe !== false,
      visionSessionPrompt: '',
      visionDefaultPreset: config.visionDefaultPreset || 'detailed',
    }),
    ...apiOverrides,
  }

  const cache = cacheStub || { usage: () => ({ dir: 'C:\\cache', bytes: 1024, mb: 0.1, files: 2, byKind: {}, ttlHours: 72, maxMb: 2048 }) }
  const logger = {
    filePath: 'C:\\Users\\Administrator\\.dsh\\fish-service.log',
    recent: (n) => { calls.logLineCount.push(n); return ['line-1', 'line-2'] },
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }

  const routes = new Map()
  const ctx = {
    webServer: {
      register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) },
    },
  }

  const dispose = registerRoutes({
    ctx,
    api,
    configStore,
    capabilities,
    cache,
    logger,
    version: '0.1.0',
    // 默认不真的启动 explorer；需要时由用例通过 spawn 注入替身。
    spawn: spawn || ((command, param, option) => {
      calls.spawn.push({ command, param, option })
      return { unref: () => {} }
    }),
    platform,
  })

  const call = async (path, { method = 'GET', body, headers = {}, search = '' } = {}) => {
    const handler = routes.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = await makeReq({ method, url: `${path}${search}`, body, headers })
    const res = makeRes()
    await handler(req, res)
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }

  return { routes, api, config, configStore, capabilities, calls, dispose, call }
}

test('注册 26 条约定路由；全部 kind=exact', () => {
  const env = setupEnv()
  assert.deepEqual([...env.routes.keys()].sort(), [
    '/dsh-fish-service/audio',
    '/dsh-fish-service/cache/cleanup',
    '/dsh-fish-service/cache/clear',
    '/dsh-fish-service/cache/stats',
    '/dsh-fish-service/describe-upload',
    '/dsh-fish-service/health',
    '/dsh-fish-service/logs',
    '/dsh-fish-service/metrics',
    '/dsh-fish-service/open-folder',
    '/dsh-fish-service/open-webui',
    '/dsh-fish-service/read',
    '/dsh-fish-service/read/plan',
    '/dsh-fish-service/read/segment',
    '/dsh-fish-service/save',
    '/dsh-fish-service/state',
    '/dsh-fish-service/test',
    '/dsh-fish-service/transcribe-upload',
    '/dsh-fish-service/translate',
    '/dsh-fish-service/translate/batch',
    '/dsh-fish-service/translate/jobs',
    '/dsh-fish-service/translate/jobs/cancel',
    '/dsh-fish-service/translate/jobs/result',
    '/dsh-fish-service/translate/jobs/status',
    '/dsh-fish-service/voice-upload',
    '/dsh-fish-service/voices',
    '/dsh-fish-service/vram-unload',
  ])
  env.dispose()
  assert.equal(env.routes.size, 0)
})

test('GET /health：插件 + 服务联合状态', async () => {
  const env = setupEnv()
  const { res, json } = await env.call('/dsh-fish-service/health')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.pluginOk, true)
  assert.equal(json.serviceDown, false)
  assert.equal(json.enabled, true)
  assert.equal(json.pluginVersion, '0.1.0')
  assert.equal(json.baseUrl, 'http://127.0.0.1:7880')
  assert.equal(json.latencyMs, 12)
  assert.equal(json.serviceVersion, '2.5.0')
  assert.equal(json.apiVersion, '1')
})

test('GET /state：配置 / health / 能力 / 音色 / 缓存 / 错误 / env 覆盖', async () => {
  const env = setupEnv()
  const { res, json } = await env.call('/dsh-fish-service/state')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.plugin.version, '0.1.0')
  assert.equal(json.plugin.configFile, env.configStore.filePath)
  assert.equal(json.plugin.logFile, 'C:\\Users\\Administrator\\.dsh\\fish-service.log')
  assert.equal(json.config.token, '***已设置***')
  assert.deepEqual(json.config.autoReadSessions, {})
  assert.equal(json.config.recordDeviceId, '')
  assert.equal(json.health.ok, true)
  assert.equal(json.health.serviceVersion, '2.5.0')
  assert.equal(json.capabilities.tts.available, true)
  assert.deepEqual(json.voices, ['dafeiyu', 'default'])
  assert.equal(json.voicesDirectory, '')
  assert.equal(json.cache.files, 2)
  // 设置页把「留空=默认」的提示词显示成占位文字，所以默认值要随 state 下发。
  assert.equal(typeof json.visionDefaults.session, 'string')
  assert.ok(json.visionDefaults.session.length > 10)
  assert.equal(typeof json.visionDefaults.presets.detailed, 'string')
  assert.ok(json.visionDefaults.presets.detailed.length > 10)
  assert.deepEqual(Object.keys(json.visionDefaults.presets).sort(), ['brief', 'detailed', 'standard', 'text'])
  assert.equal(json.errors[0].code, 'service_down')
  assert.deepEqual(json.envOverrides, ['ttsVoice'])
  assert.equal(env.calls.voices, 1)
})

test('POST /save：合法保存；GET 405；跨站 403；API 错 → 400', async () => {
  const env = setupEnv()
  const ok = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { ttsVoice: 'default' } },
    headers: { host: '127.0.0.1:10154', origin: 'http://127.0.0.1:10154' },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.deepEqual(ok.json.applied, ['ttsVoice'])
  assert.equal(ok.json.config.token, '***已设置***')
  assert.deepEqual(env.calls.save[0], { ttsVoice: 'default' })

  const device = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { recordDeviceId: 'mic-abc' } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(device.res.statusCode, 200)
  assert.deepEqual(device.json.applied, ['recordDeviceId'])
  assert.deepEqual(env.calls.save.at(-1), { recordDeviceId: 'mic-abc' })

  const wrongMethod = await env.call('/dsh-fish-service/save')
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.json.code, 'bad_request')
  assert.match(wrongMethod.json.hint, /仅支持 POST/)

  const cross = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: {} },
    headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
  })
  assert.equal(cross.res.statusCode, 403)
  assert.match(cross.json.hint, /来源/)

  const bad = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { bad: true } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(bad.res.statusCode, 400)
  assert.equal(bad.json.code, 'bad_request')
  assert.match(bad.json.hint, /参数不对/)
})

test('POST /save：按会话自动朗读随补丁原样传给配置层', async () => {
  const env = setupEnv()
  const session = { 'session-a': true, 'session-b': false }
  const r = await env.call('/dsh-fish-service/save', {
    method: 'POST',
    body: { config: { autoReadSessions: session } },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, true)
  assert.deepEqual(env.calls.save.at(-1), { autoReadSessions: session })
})

test('POST /save：四个界面开关能真正写进配置（不再被白名单丢掉）', async () => {
  const env = setupEnv()
  for (const [field, value] of [['uiVoiceInput', false], ['uiVision', false], ['uiMetrics', false], ['uiAutoRead', false]]) {
    const r = await env.call('/dsh-fish-service/save', {
      method: 'POST',
      body: { config: { [field]: value } },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(r.res.statusCode, 200, field)
    assert.deepEqual(r.json.applied, [field], field)
    assert.deepEqual(env.calls.save.at(-1), { [field]: value }, field)
  }
})


test('POST /test：在线返回能力；离线返回 code/hint', async () => {
  const env = setupEnv()
  const ok = await env.call('/dsh-fish-service/test', {
    method: 'POST', body: { timeoutMs: 3000 }, headers: { host: 'x' },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.reachable, true)
  assert.equal(ok.json.capabilities.tts.available, true)

  const downSnapshot = snapshot({
    ok: false,
    reachable: false,
    compatible: false,
    serviceVersion: '',
    lastError: { code: 'service_down', detail: 'ECONNREFUSED', hint: '本地 AI 服务没在运行。' },
  })
  const env2 = setupEnv({ initialSnapshot: downSnapshot })
  const down = await env2.call('/dsh-fish-service/test', {
    method: 'POST', body: {}, headers: { host: 'x' },
  })
  assert.equal(down.res.statusCode, 200)
  assert.equal(down.json.ok, false)
  assert.equal(down.json.code, 'service_down')
  assert.match(down.json.hint, /服务没在运行/)
})

test('GET /logs：行数钳制 1~1000；POST → 405', async () => {
  const env = setupEnv()
  const r = await env.call('/dsh-fish-service/logs', { search: '?lines=99999' })
  assert.equal(r.res.statusCode, 200)
  assert.deepEqual(r.json.lines, ['line-1', 'line-2'])
  assert.deepEqual(env.calls.logLineCount, [1000])

  const r2 = await env.call('/dsh-fish-service/logs', { search: '?lines=0' })
  assert.equal(r2.res.statusCode, 200)
  assert.deepEqual(env.calls.logLineCount, [1000, 1])

  const wrong = await env.call('/dsh-fish-service/logs', { method: 'POST', body: {} })
  assert.equal(wrong.res.statusCode, 405)
})

test('GET /voices：成功返回列表；失败仍 200 但 ok=false', async () => {
  const env = setupEnv()
  const ok = await env.call('/dsh-fish-service/voices')
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(ok.json.voices.map((x) => x.name), ['dafeiyu', 'default'])

  const env2 = setupEnv({
    apiOverrides: { voices: async () => { throw makeError('service_down', { hint: '服务没在运行' }) } },
  })
  const down = await env2.call('/dsh-fish-service/voices')
  assert.equal(down.res.statusCode, 200)
  assert.equal(down.json.ok, false)
  assert.equal(down.json.code, 'service_down')
  assert.deepEqual(down.json.voices, [])
})

test('GET /state：音色目录从服务透出；服务离线时为空', async () => {
  const hasDir = Object.assign([{ name: 'dafeiyu' }], { directory: 'E:\\LocalAIService\\voices' })
  const env = setupEnv({ apiOverrides: { voices: async () => hasDir } })
  const { json } = await env.call('/dsh-fish-service/state')
  assert.equal(json.voicesDirectory, 'E:\\LocalAIService\\voices')
  assert.deepEqual(json.voices, ['dafeiyu'])

  const down = setupEnv({ apiOverrides: { voices: async () => { throw makeError('service_down', { hint: '服务没在运行' }) } } })
  const r = await down.call('/dsh-fish-service/state')
  assert.equal(r.json.voicesDirectory, '')
  assert.deepEqual(r.json.voices, [])
})

test('POST /translate：选中文字翻译；空文本 400；服务错 502', async () => {
  const env = setupEnv({
    apiOverrides: {
      translate: async (text, opts) => ({
        ok: true, texts: [`译:${text}`], source: opts.source || 'auto', target: opts.target || 'en', engine: 'nllb', ms: 3,
      }),
    },
  })
  const ok = await env.call('/dsh-fish-service/translate', {
    method: 'POST', body: { text: '你好' },
    headers: { host: '127.0.0.1:10154', origin: 'http://127.0.0.1:10154' },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.text, '译:你好')
  assert.equal(ok.json.ms, 3)

  const empty = await env.call('/dsh-fish-service/translate', {
    method: 'POST', body: { text: '  ' },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(empty.res.statusCode, 400)

  const bad = setupEnv({ apiOverrides: { translate: async () => { throw makeError('service_down', { hint: '服务没在运行' }) } } })
  const r = await bad.call('/dsh-fish-service/translate', {
    method: 'POST', body: { text: 'hi' },
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 502)
  assert.equal(r.json.code, 'service_down')
})


test('POST /vram-unload：成功透传卸载结果；方法和来源也校验', async () => {
  const calls = []
  const env = setupEnv({
    apiOverrides: {
      vram: {
        unload: async (opts) => {
          calls.push(opts)
          return { ok: true, released: ['tts', 'separate'], skipped: ['asr'], freeMb: 7100, totalMb: 8192 }
        },
      },
    },
  })
  const ok = await env.call('/dsh-fish-service/vram-unload', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(ok.json, { ok: true, released: ['tts', 'separate'], skipped: ['asr'], freeMb: 7100, totalMb: 8192 })
  // 固定只卸空闲模型：正在跑的任务由服务端跳过，插件不猜。
  assert.deepEqual(calls, [{ all: true, skipBusy: true }])

  const wrongMethod = await env.call('/dsh-fish-service/vram-unload')
  assert.equal(wrongMethod.res.statusCode, 405)

  const crossSite = await env.call('/dsh-fish-service/vram-unload', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
  })
  assert.equal(crossSite.res.statusCode, 403)
  assert.deepEqual(crossSite.json, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
  assert.equal(calls.length, 1)
})

test('POST /vram-unload：服务报错按错误码给 400 / 500', async () => {
  const bad = setupEnv({
    apiOverrides: { vram: { unload: async () => { throw makeError('bad_request', { hint: '模型名无法识别' }) } } },
  })
  const badResult = await bad.call('/dsh-fish-service/vram-unload', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(badResult.res.statusCode, 400)
  assert.equal(badResult.json.code, 'bad_request')
  assert.match(badResult.json.hint, /模型名/)

  const down = setupEnv({
    apiOverrides: { vram: { unload: async () => { throw makeError('service_down', { hint: '本地 AI 没在运行' }) } } },
  })
  const downResult = await down.call('/dsh-fish-service/vram-unload', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(downResult.res.statusCode, 500)
  assert.equal(downResult.json.code, 'service_down')
})

test('路由异常兜底：handler 抛错 → 500 结构化 JSON', async () => {
  const env = setupEnv({
    apiOverrides: { recentErrors: () => { throw new Error('boom') } },
  })
  const r = await env.call('/dsh-fish-service/state')
  assert.equal(r.res.statusCode, 500)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'upstream_error')
})

// ---------------- P2：朗读 / 音频 / 语音上传 ----------------

function buildForm(boundary, segments) {
  const chunk = []
  for (const segment of segments) {
    let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${segment.name}"`
    if (segment.filename) headers += `; filename="${segment.filename}"`
    headers += '\r\n'
    if (segment.type) headers += `Content-Type: ${segment.type}\r\n`
    headers += '\r\n'
    chunk.push(Buffer.from(headers, 'utf8'))
    chunk.push(Buffer.isBuffer(segment.data) ? segment.data : Buffer.from(String(segment.data ?? ''), 'utf8'))
    chunk.push(Buffer.from('\r\n', 'utf8'))
  }
  chunk.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(chunk)
}

function realCache(temp) {
  const cache = new CacheStore({ dir: join(temp.dir, 'cache'), ttlHours: 72, maxMb: 2048 })
  cache.init()
  return cache
}

test('POST /read：清洗 + 分段 + 调 TTS，返回 wav 列表与 URL', async () => {
  const calls = []
  const env = setupEnv({
    apiOverrides: {
      tts: async (texts, opts) => {
        calls.push({ texts, opts })
        return {
          ok: true,
          items: texts.map((text, i) => ({
            wavPath: `C:\\cache\\tts\\x${i}.wav`,
            ms: 12,
            voice: opts.voice || 'dafeiyu',
            seed: 1,
            bytes: 100,
            cached: false,
          })),
          ms: 30,
        }
      },
    },
  })
  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: '# 标题\n\n[QQ]你好呀。[/QQ]\n\n```\ncode\n```\n\n再说一句。', voice: 'default', speed: 1.1 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  // 分段语义：按换行/句末切分，但不足 10 字的碎片会并到相邻段（这段整体不到 10 字/片 → 1 段）。
  assert.equal(json.chunks, 1)
  assert.equal(json.codeBlocks, 1)
  assert.equal(json.voice, 'default')
  assert.equal(json.speed, 1.1)
  assert.ok(json.wavPath)
  assert.equal(json.items.length, 1)
  assert.ok(json.items[0].url.includes('/dsh-fish-service/audio?path='))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].texts, ['标题。你好呀。巴拉巴拉。再说一句。'])
  assert.equal(calls[0].opts.voice, 'default')
  assert.equal(calls[0].opts.speed, 1.1)
})

test('POST /read：空文本 400；语速越界 400；服务错误 200 + ok=false', async () => {
  const env = setupEnv()
  const empty = await env.call('/dsh-fish-service/read', { method: 'POST', headers: { host: 'x' }, body: { text: '   ' } })
  assert.equal(empty.res.statusCode, 400)
  assert.equal(empty.json.ok, false)

  const code = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: '```\ncode\n```' },
  })
  assert.equal(code.res.statusCode, 400)
  assert.match(code.json.hint, /代码块/)

  const speed = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: '你好', speed: 9 },
  })
  assert.equal(speed.res.statusCode, 400)
  assert.match(speed.json.hint, /语速/)

  const err = setupEnv({
    apiOverrides: { tts: async () => { throw makeError('service_down', { hint: '本地 AI 服务没在运行。' }) } },
  })
  const fail = await err.call('/dsh-fish-service/read', { method: 'POST', headers: { host: 'x' }, body: { text: '你好' } })
  assert.equal(fail.res.statusCode, 200)
  assert.equal(fail.json.ok, false)
  assert.equal(fail.json.code, 'service_down')
  assert.match(fail.json.hint, /没在运行/)
})

test('GET /audio：只读 cacheDir 里的音频；穿越 / 缺文件 / 错扩展都有明确状态码', async () => {
  const temp = makeTempDir()
  const outside = makeTempDir()
  try {
    const audio = join(temp.dir, 'a.wav')
    writeFileSync(audio, 'RIFFxxxx', 'utf8')
    writeFileSync(join(temp.dir, 'a.txt'), 'not audio', 'utf8')
    const externalAudio = join(outside.dir, 'evil.wav')
    writeFileSync(externalAudio, 'RIFF', 'utf8')

    const env = setupEnv({ configPatch: { cacheDir: temp.dir } })
    const ok = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(audio)}` })
    assert.equal(ok.res.statusCode, 200)
    assert.equal(ok.res.headers['content-type'], 'audio/wav')
    assert.equal(ok.res.body, 'RIFFxxxx')

    const traverse = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(join(temp.dir, '..', 'x.wav'))}` })
    assert.equal(traverse.res.statusCode, 403)
    assert.match(traverse.json.hint, /缓存目录/)

    const outsideRequest = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(externalAudio)}` })
    assert.equal(outsideRequest.res.statusCode, 403)

    const errExt = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(join(temp.dir, 'a.txt'))}` })
    assert.equal(errExt.res.statusCode, 400)

    const missing = await env.call('/dsh-fish-service/audio', { search: `?path=${encodeURIComponent(join(temp.dir, 'nope.wav'))}` })
    assert.equal(missing.res.statusCode, 404)

    const noArgs = await env.call('/dsh-fish-service/audio')
    assert.equal(noArgs.res.statusCode, 400)

    const errMethod = await env.call('/dsh-fish-service/audio', { method: 'POST', body: {} })
    assert.equal(errMethod.res.statusCode, 405)
  } finally {
    temp.cleanup()
    outside.cleanup()
  }
})

test('POST /open-folder：只打开 cacheDir 内的目录，spawn 用替身，不弹资源管理器', async () => {
  const temp = makeTempDir()
  const outside = makeTempDir()
  try {
    const childDir = join(temp.dir, 'voice')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(join(temp.dir, 'a.txt'), 'x', 'utf8')

    const env = setupEnv({ configPatch: { cacheDir: temp.dir } })

    // 缓存目录本身：允许，且解析成 realpath 后交给 explorer。
    const root = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(root.res.statusCode, 200)
    assert.equal(root.json.ok, true)
    assert.equal(root.json.path, realpathSync(temp.dir))
    assert.equal(env.calls.spawn.length, 1)
    assert.equal(env.calls.spawn[0].command, 'explorer.exe')
    assert.deepEqual(env.calls.spawn[0].param, [realpathSync(temp.dir)])
    assert.deepEqual(env.calls.spawn[0].option, { detached: true, stdio: 'ignore' })

    // 子目录也能开。
    const child = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: childDir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(child.res.statusCode, 200)
    assert.deepEqual(env.calls.spawn.at(-1).param, [realpathSync(childDir)])

    // 缓存目录之外 / 相对路径 / 空 / 不存在 / 不是目录：一律拒绝，且不 spawn。
    const outsideRequest = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: outside.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(outsideRequest.res.statusCode, 403)
    assert.match(outsideRequest.json.hint, /缓存目录/)

    const traverse = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(temp.dir, '..') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(traverse.res.statusCode, 403)

    const relative = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: 'cache' },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(relative.res.statusCode, 400)
    assert.match(relative.json.hint, /绝对路径/)

    const empty = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: {},
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(empty.res.statusCode, 400)

    const absent = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(temp.dir, 'nope') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(absent.res.statusCode, 404)

    const file = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(temp.dir, 'a.txt') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(file.res.statusCode, 400)
    assert.match(file.json.hint, /不是文件夹/)

    assert.equal(env.calls.spawn.length, 2)

    // 方法和来源校验：GET 405，跨站 403。
    const errMethod = await env.call('/dsh-fish-service/open-folder')
    assert.equal(errMethod.res.statusCode, 405)

    const crossSite = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
    })
    assert.equal(crossSite.res.statusCode, 403)
    assert.equal(env.calls.spawn.length, 2)
  } finally {
    temp.cleanup()
    outside.cleanup()
  }
})

test('POST /open-folder：服务音色目录在允许范围，越界仍 403；服务离线时不放行', async () => {
  const cacheStub = makeTempDir()
  const voice = makeTempDir()
  const outside = makeTempDir()
  try {
    mkdirSync(join(voice.dir, '自定义'), { recursive: true })
    const withDir = (dir) => Object.assign([{ name: 'dafeiyu' }], { directory: dir })
    const env = setupEnv({
      configPatch: { cacheDir: cacheStub.dir },
      apiOverrides: { voices: async () => withDir(voice.dir) },
    })

    const voiceRoot = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: voice.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(voiceRoot.res.statusCode, 200)
    assert.deepEqual(env.calls.spawn.at(-1).param, [realpathSync(voice.dir)])

    const child = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: join(voice.dir, '自定义') },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(child.res.statusCode, 200)

    const outOfRange = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: outside.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(outOfRange.res.statusCode, 403)
    assert.match(outOfRange.json.hint, /音色目录/)

    // 服务离线：音色目录取不到 → 不放行；缓存目录照常。
    const offline = setupEnv({
      configPatch: { cacheDir: cacheStub.dir },
      apiOverrides: { voices: async () => { throw makeError('service_down', { hint: '服务没在运行' }) } },
    })
    const offlineVoice = await offline.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: voice.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(offlineVoice.res.statusCode, 403)

    const offlineCache = await offline.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: cacheStub.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(offlineCache.res.statusCode, 200)
  } finally {
    cacheStub.cleanup()
    voice.cleanup()
    outside.cleanup()
  }
})

test('POST /open-folder：spawn 失败给可操作提示；缓存目录还不存在时明确说', async () => {
  const temp = makeTempDir()
  try {
    const env = setupEnv({
      configPatch: { cacheDir: temp.dir },
      spawn: () => { throw new Error('explorer 启动失败') },
    })
    const fail = await env.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(fail.res.statusCode, 500)
    assert.equal(fail.json.ok, false)
    assert.match(fail.json.hint, /手动打开/)

    // cacheDir 指向不存在的目录：提示先保存设置，而不是报“没有权限”。
    const missingRoot = setupEnv({ configPatch: { cacheDir: join(temp.dir, 'missing') } })
    const backPayload = await missingRoot.call('/dsh-fish-service/open-folder', {
      method: 'POST',
      body: { path: temp.dir },
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(backPayload.res.statusCode, 400)
    assert.match(backPayload.json.hint, /缓存目录/)
  } finally {
    temp.cleanup()
  }
})
test('POST /open-webui：在线时用系统默认浏览器打开管理界面，只拼 /ui，不等待子进程', async () => {
  let backref = 0
  const env = setupEnv({
    spawn: (command, param, option) => {
      env.calls.spawn.push({ command, param, option })
      return { unref: () => { backref += 1 } }
    },
  })

  const r = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, true)
  assert.equal(env.calls.spawn.length, 1)
  assert.equal(env.calls.spawn[0].command, 'cmd.exe')
  assert.deepEqual(env.calls.spawn[0].param, ['/c', 'start', '', 'http://127.0.0.1:7880/ui'])
  // detached + ignore：不占宿主的标准输入输出，也不阻塞路由。
  assert.deepEqual(env.calls.spawn[0].option, { detached: true, stdio: 'ignore' })
  assert.equal(backref, 1)

  // baseUrl 末尾有斜杠时不出现 //ui。
  const slash = setupEnv({ configPatch: { baseUrl: 'http://127.0.0.1:7880/' } })
  await slash.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.deepEqual(slash.calls.spawn.at(-1).param, ['/c', 'start', '', 'http://127.0.0.1:7880/ui'])
})

test('POST /open-webui：服务离线不打开浏览器，给可操作提示', async () => {
  const probe = []
  const env = setupEnv({
    refreshImpl: async (opts) => {
      probe.push(opts)
      return { ...snapshot(), ok: false, reachable: false, lastError: { code: 'service_down', hint: '连不上' } }
    },
  })

  const r = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'service_down')
  assert.match(r.json.hint, /未启动/)
  // 用 2 秒超时的强制探测，避免拿旧快照误判在线。
  assert.deepEqual(probe[0], { force: true, timeoutMs: 2000 })
  assert.equal(env.calls.spawn.length, 0)
})

test('POST /open-webui：非法 baseUrl 不打开浏览器；非 Windows 明确说不支持', async () => {
  for (const address of ['不是地址', 'ftp://127.0.0.1:7880', 'http://127.0.0.1:7880/&calc']) {
    const env = setupEnv({ configPatch: { baseUrl: address } })
    const r = await env.call('/dsh-fish-service/open-webui', {
      method: 'POST',
      headers: { host: '127.0.0.1:10154' },
    })
    assert.equal(r.res.statusCode, 400, address)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'bad_request')
    assert.equal(env.calls.spawn.length, 0)
  }

  const nonWindows = setupEnv({ platform: 'linux' })
  const r = await nonWindows.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(r.res.statusCode, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'not_supported')
  assert.match(r.json.hint, /暂不支持/)
  assert.equal(nonWindows.calls.spawn.length, 0)
})

test('POST /open-webui：spawn 失败给可操作提示；方法和来源也校验', async () => {
  const env = setupEnv({
    spawn: () => { throw new Error('cmd 启动失败') },
  })
  const fail = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154' },
  })
  assert.equal(fail.res.statusCode, 500)
  assert.equal(fail.json.code, 'upstream_error')
  assert.match(fail.json.hint, /手动访问/)

  const errMethod = await env.call('/dsh-fish-service/open-webui')
  assert.equal(errMethod.res.statusCode, 405)

  const crossSite = await env.call('/dsh-fish-service/open-webui', {
    method: 'POST',
    headers: { host: '127.0.0.1:10154', origin: 'http://evil.example' },
  })
  assert.equal(crossSite.res.statusCode, 403)
  assert.equal(env.calls.spawn.length, 0)
})


test('POST /transcribe-upload：multipart 录音 → ASR 文本；临时文件请求后删除', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const calls = []
    const env = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache'), asrLanguage: 'zh' },
      cacheStub: cache,
      apiOverrides: {
        asr: async (file, opts) => {
          calls.push({ file, opts, exists: existsSync(file) })
          return {
            ok: true,
            items: [{ file: file, text: '你好世界', language: 'zh', engine: 'sensevoice', elapsedMs: 88 }],
            ms: 120,
          }
        },
      },
    })
    // 至少 1500 字节：服务端会把「录音数据过小」当成麦克风没采到声音直接拒绝。
    const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 0x11)])
    const body = buildForm('B1', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: audio },
      { name: 'durationMs', data: '3200' },
    ])
    const { res, json } = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST',
      headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B1' },
      body: body,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(json.ok, true)
    assert.equal(json.text, '你好世界')
    assert.equal(json.language, 'zh')
    assert.equal(json.bytes, audio.length)
    assert.equal(typeof json.ms, 'number')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].exists, true)
    assert.equal(calls[0].opts.language, 'zh')
    assert.equal(calls[0].opts.speaker, undefined)
    assert.equal(readdirSync(join(temp.dir, 'cache', 'tmp')).length, 0)
  } finally {
    temp.cleanup()
  }
})

test('POST /transcribe-upload：缺文件 400；超 5 分钟 400；GET 405', async () => {
  const temp = makeTempDir()
  try {
    const env = setupEnv({ configPatch: { cacheDir: join(temp.dir, 'cache') }, cacheStub: realCache(temp) })
    const empty = buildForm('B2', [{ name: 'language', data: 'zh' }])
    const noFile = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B2' }, body: empty,
    })
    assert.equal(noFile.res.statusCode, 400)
    assert.match(noFile.json.hint, /音频文件/)

    const length = buildForm('B3', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: Buffer.from('xx') },
      { name: 'durationMs', data: '400000' },
    ])
    const timeout = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B3' }, body: length,
    })
    assert.equal(timeout.res.statusCode, 400)
    assert.match(timeout.json.hint, /5 分钟/)

    const errMethod = await env.call('/dsh-fish-service/transcribe-upload')
    assert.equal(errMethod.res.statusCode, 405)
  } finally {
    temp.cleanup()
  }
})

test('POST /voice-upload：保留语音写到 cacheDir/voice；超 5 分钟拒绝', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const env = setupEnv({ configPatch: { cacheDir: join(temp.dir, 'cache') }, cacheStub: cache })
    const audio = Buffer.from([1, 2, 3, 4, 5])
    const body = buildForm('V1', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: audio },
      { name: 'durationMs', data: '3000' },
    ])
    const { res, json } = await env.call('/dsh-fish-service/voice-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=V1' }, body: body,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(json.ok, true)
    assert.equal(json.bytes, audio.length)
    assert.ok(existsSync(json.path))
    assert.ok(json.path.startsWith(join(temp.dir, 'cache', 'voice')))

    const length = buildForm('V2', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: audio },
      { name: 'durationMs', data: '400000' },
    ])
    const timeout = await env.call('/dsh-fish-service/voice-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=V2' }, body: length,
    })
    assert.equal(timeout.res.statusCode, 400)
    assert.match(timeout.json.hint, /5 分钟/)
  } finally {
    temp.cleanup()
  }
})

test('POST /describe-upload：图片上传 → 本机视觉模型 → 文字；临时文件随后删除', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const calls = []
    const env = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache'), localDescribe: true },
      cacheStub: cache,
      apiOverrides: {
        visionDescribe: async (path, opts) => {
          calls.push({ path, opts, exists: existsSync(path) })
          return { ok: true, items: [{ path: path, text: '一只橘猫趴在窗台上。', ms: 640 }], ms: 640 }
        },
      },
    })
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const body = buildForm('D1', [
      { name: 'file', filename: 'cat.png', type: 'image/png', data: image },
      { name: 'mode', data: 'caption' },
    ])
    const { res, json } = await env.call('/dsh-fish-service/describe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=D1' }, body: body,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(json.ok, true)
    assert.equal(json.text, '一只橘猫趴在窗台上。')
    assert.equal(json.mode, 'caption')
    assert.equal(json.scope, 'tool')
    assert.equal(json.preset, 'detailed')
    assert.equal(json.bytes, image.length)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].opts.mode, 'caption')
    assert.equal(calls[0].opts.preset, 'detailed')
    assert.equal(calls[0].exists, true, '调视觉模型时临时文件必须还在')
    assert.equal(existsSync(calls[0].path), false, '请求结束后临时文件要删掉')
  } finally {
    temp.cleanup()
  }
})

test('POST /describe-upload：preset 四档生效，缺省/非法回配置默认档，ocr 强制只看文字', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const presetLevels = []
    const env = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache'), localDescribe: true, visionDefaultPreset: 'standard' },
      cacheStub: cache,
      apiOverrides: {
        visionDescribe: async (path, opts) => {
          presetLevels.push(opts.preset)
          return { ok: true, items: [{ path: path, text: '描述', ms: 1 }], ms: 1 }
        },
      },
    })
    const image = Buffer.from([1, 2, 3])
    const emit = async (boundary, fields) => {
      const body = buildForm(boundary, [{ name: 'file', filename: 'a.png', type: 'image/png', data: image }, ...fields])
      return env.call('/dsh-fish-service/describe-upload', {
        method: 'POST', headers: { host: 'x', 'content-type': `multipart/form-data; boundary=${boundary}` }, body: body,
      })
    }

    const explicit = await emit('P1', [{ name: 'preset', data: 'brief' }])
    assert.equal(explicit.json.preset, 'brief')
    assert.equal(explicit.json.scope, 'tool')

    const defaultValue = await emit('P2', [])
    assert.equal(defaultValue.json.preset, 'standard')

    const invalid = await emit('P3', [{ name: 'preset', data: '特写' }])
    assert.equal(invalid.json.preset, 'standard')

    const OCR = await emit('P4', [{ name: 'mode', data: 'ocr' }, { name: 'preset', data: 'brief' }])
    assert.equal(OCR.json.preset, 'text')

    assert.deepEqual(presetLevels, ['brief', 'standard', 'standard', 'text'])
  } finally {
    temp.cleanup()
  }
})

test('POST /describe-upload：scope=session 走会话识图提示词，不再传工具档位', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const calls = []
    const env = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache'), localDescribe: true },
      cacheStub: cache,
      apiOverrides: {
        visionDescribe: async (path, opts) => {
          calls.push(opts)
          return { ok: true, items: [{ path: path, text: '描述', ms: 1 }], ms: 1 }
        },
      },
    })
    const image = Buffer.from([1, 2, 3])
    const body = buildForm('S1', [
      { name: 'file', filename: 'a.png', type: 'image/png', data: image },
      { name: 'mode', data: 'caption' },
      { name: 'scope', data: 'session' },
      { name: 'preset', data: 'brief' },
    ])
    const { res, json } = await env.call('/dsh-fish-service/describe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=S1' }, body: body,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(json.scope, 'session')
    assert.equal(json.preset, undefined)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].scope, 'session')
    assert.equal(calls[0].preset, undefined)
  } finally {
    temp.cleanup()
  }
})

test('POST /describe-upload：关闭本地识图要拒绝；非图片、无文件、错方法都有明确提示', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const env = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache'), localDescribe: false },
      cacheStub: cache,
      apiOverrides: {
        visionDescribe: async () => { throw makeError('bad_request', { detail: 'should not run', hint: '不该被调用' }) },
      },
    })
    const image = Buffer.from([1, 2, 3])
    const off = buildForm('D2', [{ name: 'file', filename: 'a.png', type: 'image/png', data: image }])
    const offRes = await env.call('/dsh-fish-service/describe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=D2' }, body: off,
    })
    assert.equal(offRes.res.statusCode, 400)
    assert.match(offRes.json.hint, /本地识图已关闭/)

    const on = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache') },
      cacheStub: cache,
      apiOverrides: { visionDescribe: async () => ({ ok: true, items: [], ms: 1 }) },
    })
    const err = buildForm('D3', [{ name: 'file', filename: 'a.txt', type: 'text/plain', data: image }])
    const errRes = await on.call('/dsh-fish-service/describe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=D3' }, body: err,
    })
    assert.equal(errRes.res.statusCode, 400)
    assert.match(errRes.json.hint, /JPG \/ PNG/)

    const empty = buildForm('D4', [{ name: 'mode', data: 'caption' }])
    const emptyRes = await on.call('/dsh-fish-service/describe-upload', {
      method: 'POST', headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=D4' }, body: empty,
    })
    assert.equal(emptyRes.res.statusCode, 400)
    assert.match(emptyRes.json.hint, /未收到图片/)

    const errMethod = await on.call('/dsh-fish-service/describe-upload')
    assert.equal(errMethod.res.statusCode, 405)
  } finally {
    temp.cleanup()
  }
})

test('POST /read 走真实 fish.service：分段合成写缓存，/audio 能回放', async (t) => {
  const { makeStack, basicHandler, sendBuffer } = await import('./helpers.js')
  const calls = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        calls.push(JSON.parse(rec.body.toString('utf8') || '{}'))
        sendBuffer(res, 200, Buffer.from(`RIFF-${calls.length}`), {
          'content-type': 'audio/wav',
          'x-seed': '7',
          'x-language': 'zh',
        })
      },
    }),
  })
  t.after(() => stack.close())

  const routes = new Map()
  const ctx = { webServer: { register: (define) => { routes.set(define.path, define.handler); return () => routes.delete(define.path) } } }
  const dispose = registerRoutes({
    ctx,
    api: stack.api,
    configStore: stack.store,
    capabilities: stack.capabilities,
    cache: stack.cache,
    logger: stack.logger,
    version: '0.1.0',
  })
  t.after(() => dispose())

  const lengthText = Array.from({ length: 25 }, (_, i) => `这是第${i + 1}句测试内容。`).join('')
  const req = await makeReq({
    method: 'POST',
    url: '/dsh-fish-service/read',
    headers: { host: 'x' },
    body: { text: lengthText, maxChars: 200, speed: 1.2 },
  })
  const res = makeRes()
  await routes.get('/dsh-fish-service/read')(req, res)
  const json = JSON.parse(res.body)
  assert.equal(json.ok, true)
  // 句末标点即分段边界：25 句 → 25 段（每句都 >= 10 字，不会并段）。
  assert.equal(json.chunks, 25)
  assert.equal(json.items.length, 25)
  // 2 批（每批 20 段），fish.service.tts 内部逐条调 /tts → 25 次 HTTP；并发度 2。
  assert.equal(calls.length, 25)
  assert.equal(json.cachedChunks, 0)
  assert.equal(json.cacheHits, 0)
  assert.equal(json.items[0].cached, false)
  assert.equal(json.concurrency, 2)
  for (const body of calls) assert.equal(body.speed, 1.2)
  for (const item of json.items) {
    assert.ok(existsSync(item.wavPath))
    assert.ok(item.wavPath.includes('tts'))
  }

  const playback = await makeReq({
    url: `/dsh-fish-service/audio?path=${encodeURIComponent(json.items[0].wavPath)}`,
    headers: { host: 'x' },
  })
  const reply = makeRes()
  await routes.get('/dsh-fish-service/audio')(playback, reply)
  assert.equal(reply.statusCode, 200)
  assert.equal(reply.headers['content-type'], 'audio/wav')
  // 合成是并发的，第 1 段不一定最先到服务端；只校验回放的是这次合成的音频。
  assert.match(reply.body, /^RIFF-\d+$/)
})

test('POST /read/plan → /read/segment：朗读化只在 tts 入口生效一次（幂等）', async (t) => {
  const { makeStack, basicHandler, sendBuffer } = await import('./helpers.js')
  const calls = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        const body = JSON.parse(rec.body.toString('utf8') || '{}')
        calls.push(body)
        sendBuffer(res, 200, Buffer.from(`RIFF-${calls.length}`), {
          'content-type': 'audio/wav',
          'x-seed': '5',
          'x-language': 'zh',
        })
      },
    }),
  })
  t.after(() => stack.close())

  const routes = new Map()
  const ctx = { webServer: { register: (define) => { routes.set(define.path, define.handler); return () => routes.delete(define.path) } } }
  const dispose = registerRoutes({
    ctx,
    api: stack.api,
    configStore: stack.store,
    capabilities: stack.capabilities,
    cache: stack.cache,
    logger: stack.logger,
    version: '0.1.0',
  })
  t.after(() => dispose())

  const text = '版本 2.5.0 已发布，延迟 69ms。\u0060lastBoot.confirmed=true\u0060 不用念。'
  const planReq = await makeReq({
    method: 'POST',
    url: '/dsh-fish-service/read/plan',
    headers: { host: 'x' },
    body: { text, maxChars: 200 },
  })
  const planRes = makeRes()
  await routes.get('/dsh-fish-service/read/plan')(planReq, planRes)
  const plan = JSON.parse(planRes.body)
  assert.equal(plan.ok, true)
  assert.ok(plan.segments.length >= 1)
  assert.ok(!plan.segments.some((segment) => segment.text.includes('lastBoot')), planRes.body)

  for (const [index, segment] of plan.segments.entries()) {
    const segReq = await makeReq({
      method: 'POST',
      url: '/dsh-fish-service/read/segment',
      headers: { host: 'x' },
      body: { text: segment.text, index, total: plan.segments.length },
    })
    const segRes = makeRes()
    await routes.get('/dsh-fish-service/read/segment')(segReq, segRes)
    assert.equal(JSON.parse(segRes.body).ok, true, segRes.body)
  }

  // 合成收到的文本与分段计划完全一致：计划已朗读化，tts() 再跑一遍不改变结果。
  assert.deepEqual(
    calls.map((body) => body.text).sort(),
    plan.segments.map((segment) => segment.text).sort(),
  )
})

test('POST /read：超过 20 段时按 20 条一批调 TTS（契约上限）', async () => {
  const batchSize = []
  const env = setupEnv({
    apiOverrides: {
      tts: async (texts) => {
        batchSize.push(texts.length)
        return {
          ok: true,
          items: texts.map((_text, i) => ({
            wavPath: `C:\\cache\\tts\\b${i}.wav`, ms: 1, voice: 'x', seed: 1, bytes: 10,
          })),
          ms: 1,
        }
      },
    },
  })
  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: '字'.repeat(20000), maxChars: 200 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 40)
  assert.equal(json.truncated, true)
  assert.deepEqual(batchSize, [20, 20])
})

// ---------------- P2 性能：分段并发 / 流式朗读 / 缓存路由 ----------------

/** 20 个段落、每段 2 句 → maxChars=200 时正好 40 段（每句都够长，不会被合并）。 */
function makeLongSegments(segmentCount = 20) {
  return Array.from({ length: segmentCount }, (_pending, i) => {
    const headers = `第${i}段`
    return `${headers}${'甲'.repeat(114)}。${headers}后${'乙'.repeat(112)}。`
  }).join('\n\n')
}

/** 用真实 stack 注册宿主路由，返回和 routes.test 里一样的 call 接口。 */
function attachRealRoute(stack) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register: (define) => { routes.set(define.path, define.handler); return () => routes.delete(define.path) },
    },
  }
  const dispose = registerRoutes({
    ctx,
    api: stack.api,
    configStore: stack.store,
    capabilities: stack.capabilities,
    cache: stack.cache,
    logger: stack.logger,
    version: '0.1.0',
  })
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const handler = routes.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = await makeReq({ method, url: path, body, headers: { host: 'x', ...headers } })
    const res = makeRes()
    await handler(req, res)
    let json = null
    try { json = res.json() } catch { json = null }
    return { res, json }
  }
  return { routes, dispose, call }
}

/** 按文本→期望段序生成 wavPath，用来验证并发后顺序没串。 */
function segmentOrderMap(bodyText) {
  const expected = prepareSpeech(bodyText, { maxChars: 200 }).chunks
  const seq = new Map(expected.map((text, i) => [text, i]))
  return { expected, seq }
}

test('POST /read：批间有限并发 ≤ readConcurrency，结果按段序拼接', async () => {
  const bodyText = makeLongSegments()
  const { expected, seq } = segmentOrderMap(bodyText)
  assert.equal(expected.length, 40)

  const active = { now: 0, peak: 0 }
  const batchSize = []
  const env = setupEnv({
    configPatch: { readConcurrency: 2 },
    apiOverrides: {
      tts: async (texts) => {
        active.now += 1
        active.peak = Math.max(active.peak, active.now)
        batchSize.push(texts.length)
        await new Promise((r) => setTimeout(r, 25))
        active.now -= 1
        return {
          ok: true,
          items: texts.map((text) => ({
            wavPath: `C:\\cache\\tts\\s${seq.get(text)}.wav`,
            ms: 1, voice: 'dafeiyu', seed: 1, bytes: 10, cached: false,
          })),
          ms: 1,
        }
      },
    },
  })

  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: bodyText, maxChars: 200 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 40)
  assert.equal(json.concurrency, 2)
  assert.equal(json.cachedChunks, 0)
  assert.deepEqual(batchSize.slice().sort((a, b) => a - b), [20, 20])
  assert.equal(active.peak, 2) // 两批确实同时在跑
  assert.ok(active.peak <= 2) // 且不超过配置的并发度
  for (let i = 0; i < 40; i++) {
    assert.equal(json.items[i].wavPath, `C:\\cache\\tts\\s${i}.wav`, `第 ${i} 段顺序错了`)
    assert.equal(json.items[i].chars, expected[i].length)
  }
})

test('POST /read：readConcurrency=1 时完全串行（并发峰值 1）', async () => {
  const bodyText = makeLongSegments()
  const active = { now: 0, peak: 0 }
  const env = setupEnv({
    configPatch: { readConcurrency: 1 },
    apiOverrides: {
      tts: async (texts) => {
        active.now += 1
        active.peak = Math.max(active.peak, active.now)
        await new Promise((r) => setTimeout(r, 10))
        active.now -= 1
        return {
          ok: true,
          items: texts.map((_text, i) => ({ wavPath: `C:\\cache\\tts\\x${i}.wav`, ms: 1, voice: 'x', bytes: 1 })),
          ms: 1,
        }
      },
    },
  })
  const { json } = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: bodyText, maxChars: 200 },
  })
  assert.equal(json.ok, true)
  assert.equal(json.chunks, 40)
  assert.equal(json.concurrency, 1)
  assert.equal(active.peak, 1)
})

test('POST /read：某批失败时降级串行重试该批，成功后标记 degraded 且顺序不变', async () => {
  const bodyText = makeLongSegments()
  const { expected, seq } = segmentOrderMap(bodyText)
  let zeroBatchCount = 0
  const batchSize = []
  const env = setupEnv({
    configPatch: { readConcurrency: 2 },
    apiOverrides: {
      tts: async (texts) => {
        batchSize.push(texts.length)
        if (texts[0] === expected[0]) {
          zeroBatchCount += 1
          if (zeroBatchCount === 1) throw makeError('service_down', { hint: '本地 AI 服务没在运行。' })
        }
        await new Promise((r) => setTimeout(r, 10))
        return {
          ok: true,
          items: texts.map((text) => ({
            wavPath: `C:\\cache\\tts\\s${seq.get(text)}.wav`,
            ms: 1, voice: 'dafeiyu', seed: 1, bytes: 10, cached: false,
          })),
          ms: 1,
        }
      },
    },
  })
  const { json } = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: bodyText, maxChars: 200 },
  })
  assert.equal(json.ok, true)
  assert.equal(json.degraded, true)
  assert.equal(zeroBatchCount, 2) // 第一次并发失败 + 一次串行重试
  assert.equal(batchSize.length, 3) // 两批并发 + 重试失败那批
  for (let i = 0; i < 40; i++) {
    assert.equal(json.items[i].wavPath, `C:\\cache\\tts\\s${i}.wav`)
  }
})

test('POST /read：降级重试仍失败 → 200 + ok:false，hint 带并发/降级提示', async () => {
  const bodyText = makeLongSegments()
  const { expected } = segmentOrderMap(bodyText)
  let zeroBatchCount = 0
  const env = setupEnv({
    configPatch: { readConcurrency: 2 },
    apiOverrides: {
      tts: async (texts) => {
        if (texts[0] === expected[0]) {
          zeroBatchCount += 1
          throw makeError('service_down', { hint: '本地 AI 服务没在运行。' })
        }
        return {
          ok: true,
          items: texts.map((_text, i) => ({ wavPath: `C:\\cache\\tts\\ok${i}.wav`, ms: 1, voice: 'x', bytes: 1 })),
          ms: 1,
        }
      },
    },
  })
  const { res, json } = await env.call('/dsh-fish-service/read', {
    method: 'POST', headers: { host: 'x' }, body: { text: bodyText, maxChars: 200 },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'service_down')
  assert.equal(zeroBatchCount, 2)
  assert.match(json.hint, /同时生成/)
  assert.match(json.hint, /逐段重试/)
})

test('POST /read/plan：立即返回分段计划，不调用 TTS；参数校验齐全', async () => {
  let ttsCall = 0
  const env = setupEnv({
    apiOverrides: {
      tts: async () => {
        ttsCall += 1
        throw new Error('plan 不应调用 TTS')
      },
    },
  })
  const bodyText = makeLongSegments()
  const expected = prepareSpeech(bodyText, { maxChars: 200 })

  const ok = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST',
    headers: { host: 'x' },
    body: { text: bodyText, maxChars: 200, voice: 'default', speed: 1.1 },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.segments.length, 40)
  assert.equal(ok.json.chars, expected.chars)
  assert.equal(ok.json.codeBlocks, 0)
  assert.equal(ok.json.truncated, false)
  assert.equal(ok.json.voice, 'default')
  assert.equal(ok.json.speed, 1.1)
  assert.equal(ok.json.maxChars, 200)
  assert.equal(ok.json.segments[0].index, 0)
  assert.equal(ok.json.segments[39].index, 39)
  assert.equal(ok.json.segments[0].text, expected.chunks[0])
  assert.equal(ok.json.segments[0].chars, expected.chunks[0].length)
  assert.equal(ttsCall, 0)

  // 20000 字 → 40 段截断，且不合成
  const length = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '字'.repeat(20000), maxChars: 200 },
  })
  assert.equal(length.json.ok, true)
  assert.equal(length.json.segments.length, 40)
  assert.equal(length.json.truncated, true)
  assert.equal(ttsCall, 0)

  const empty = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '   ' },
  })
  assert.equal(empty.res.statusCode, 400)
  assert.equal(empty.json.code, 'bad_request')

  const code = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '```\ncode\n```' },
  })
  assert.equal(code.res.statusCode, 400)
  assert.match(code.json.hint, /代码块/)

  const speed = await env.call('/dsh-fish-service/read/plan', {
    method: 'POST', headers: { host: 'x' }, body: { text: '你好', speed: 9 },
  })
  assert.equal(speed.res.statusCode, 400)
  assert.match(speed.json.hint, /语速/)

  const errMethod = await env.call('/dsh-fish-service/read/plan')
  assert.equal(errMethod.res.statusCode, 405)
})

test('POST /read/segment：只合成一段，返回 index/wavPath/url/ms/cached/bytes；参数校验', async () => {
  const calls = []
  const env = setupEnv({
    apiOverrides: {
      tts: async (texts, opts) => {
        calls.push({ texts, opts })
        return {
          ok: true,
          items: [{ wavPath: 'C:\\cache\\tts\\one.wav', ms: 0, voice: 'default', bytes: 123, cached: true }],
          ms: 1,
        }
      },
    },
  })
  const ok = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST',
    headers: { host: 'x' },
    body: { index: 1, total: 3, text: '第二段文字。', voice: 'default', speed: 1.2 },
  })
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.index, 1)
  assert.equal(ok.json.wavPath, 'C:\\cache\\tts\\one.wav')
  assert.ok(ok.json.url.includes('/dsh-fish-service/audio?path='))
  assert.equal(ok.json.ms, 0)
  assert.equal(ok.json.cached, true)
  assert.equal(ok.json.bytes, 123)
  assert.equal(ok.json.total, 3)
  assert.equal(ok.json.voice, 'default')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].texts, ['第二段文字。'])
  assert.equal(calls[0].opts.voice, 'default')
  assert.equal(calls[0].opts.speed, 1.2)

  const negative = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: -1, text: 'x' },
  })
  assert.equal(negative.res.statusCode, 400)
  assert.match(negative.json.hint, /序号/)

  const outOfRange = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 3, total: 3, text: 'x' },
  })
  assert.equal(outOfRange.res.statusCode, 400)
  assert.match(outOfRange.json.hint, /序号/)

  const exceedTotalSegment = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 0, total: 41, text: 'x' },
  })
  assert.equal(exceedTotalSegment.res.statusCode, 400)
  assert.match(exceedTotalSegment.json.hint, /总段数/)

  const emptyText = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 0, total: 1, text: '   ' },
  })
  assert.equal(emptyText.res.statusCode, 400)

  const speed = await env.call('/dsh-fish-service/read/segment', {
    method: 'POST', headers: { host: 'x' }, body: { index: 0, text: 'x', speed: 9 },
  })
  assert.equal(speed.res.statusCode, 400)
  assert.match(speed.json.hint, /语速/)

  const errMethod = await env.call('/dsh-fish-service/read/segment')
  assert.equal(errMethod.res.statusCode, 405)
  assert.equal(calls.length, 1) // 非法参数一个都没合成
})

test('流式朗读走真实 fish.service：plan 不合成；segment 命中缓存；缓存统计/清空/清理', async (t) => {
  const sent = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        sent.push(JSON.parse(rec.body.toString('utf8') || '{}'))
        sendBuffer(res, 200, Buffer.from(`RIFF-${sent.length}`), {
          'content-type': 'audio/wav',
          'x-seed': '7',
          'x-language': 'zh',
        })
      },
    }),
  })
  t.after(() => stack.close())
  const { call, dispose } = attachRealRoute(stack)
  t.after(() => dispose())

  const bodyText = `第一段${'甲'.repeat(130)}。\n\n第二段${'乙'.repeat(130)}。`
  const plan = await call('/dsh-fish-service/read/plan', {
    method: 'POST',
    body: { text: bodyText, maxChars: 200, voice: 'dafeiyu', speed: 1 },
  })
  assert.equal(plan.json.ok, true)
  assert.equal(plan.json.segments.length, 2)
  assert.equal(plan.json.voice, 'dafeiyu')
  assert.equal(plan.json.speed, 1)
  assert.equal(sent.length, 0) // plan 不合成

  const primary = await call('/dsh-fish-service/read/segment', {
    method: 'POST',
    body: { index: 0, total: 2, text: plan.json.segments[0].text, voice: plan.json.voice, speed: plan.json.speed },
  })
  assert.equal(primary.json.ok, true)
  assert.equal(primary.json.index, 0)
  assert.equal(primary.json.cached, false)
  assert.ok(existsSync(primary.json.wavPath))
  assert.ok(primary.json.url.includes('/dsh-fish-service/audio?path='))
  assert.equal(sent.length, 1)

  const replay = await call('/dsh-fish-service/read/segment', {
    method: 'POST',
    body: { index: 0, total: 2, text: plan.json.segments[0].text, voice: plan.json.voice, speed: plan.json.speed },
  })
  assert.equal(replay.json.ok, true)
  assert.equal(replay.json.cached, true)
  assert.equal(replay.json.ms, 0)
  assert.equal(replay.json.wavPath, primary.json.wavPath)
  assert.equal(sent.length, 1) // 第二次没有发 HTTP

  const stats = await call('/dsh-fish-service/cache/stats')
  assert.equal(stats.json.ok, true)
  assert.equal(stats.json.kind, 'tts')
  assert.equal(stats.json.hits, 1)
  assert.equal(stats.json.misses, 1)
  assert.equal(stats.json.hitRate, 0.5)
  assert.equal(stats.json.files, 1)

  const clear = await call('/dsh-fish-service/cache/clear', { method: 'POST', body: { kind: 'tts' } })
  assert.equal(clear.json.ok, true)
  assert.equal(clear.json.kind, 'tts')
  assert.equal(clear.json.files, 1)
  const clearAfterStats = await call('/dsh-fish-service/cache/stats')
  assert.equal(clearAfterStats.json.files, 0)
  assert.equal(clearAfterStats.json.hits, 1) // 历史命中计数不因清缓存而重置

  const cleanup = await call('/dsh-fish-service/cache/cleanup', { method: 'POST', body: {} })
  assert.equal(cleanup.json.ok, true)
  assert.equal(typeof cleanup.json.expired, 'number')
  assert.equal(typeof cleanup.json.lru, 'number')

  const errKind = await call('/dsh-fish-service/cache/clear', { method: 'POST', body: { kind: 'nope' } })
  assert.equal(errKind.res.statusCode, 400)
  assert.equal(errKind.json.code, 'bad_request')

  const errMethod = await call('/dsh-fish-service/cache/clear')
  assert.equal(errMethod.res.statusCode, 405)
})

test('POST /transcribe-upload：录音数据过小 / 太短 时给可操作提示', async () => {
  const temp = makeTempDir()
  try {
    const cache = realCache(temp)
    const env = setupEnv({
      configPatch: { cacheDir: join(temp.dir, 'cache') },
      cacheStub: cache,
      apiOverrides: { asr: async () => { throw new Error('不该被调用') } },
    })

    const smallAudio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    const bodySmall = buildForm('B2', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: smallAudio },
      { name: 'durationMs', data: '3200' },
    ])
    const small = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST',
      headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B2' },
      body: bodySmall,
    })
    assert.equal(small.res.statusCode, 400)
    assert.match(small.json.hint, /没有采集到声音/)

    const normalAudio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 0x11)])
    const bodyShort = buildForm('B3', [
      { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: normalAudio },
      { name: 'durationMs', data: '120' },
    ])
    const short = await env.call('/dsh-fish-service/transcribe-upload', {
      method: 'POST',
      headers: { host: 'x', 'content-type': 'multipart/form-data; boundary=B3' },
      body: bodyShort,
    })
    assert.equal(short.res.statusCode, 400)
    assert.match(short.json.hint, /录音太短/)
  } finally {
    temp.cleanup()
  }
})
