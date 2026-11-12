// 宿主 HTTP 路由（给本插件设置页/朗读按钮/语音输入用，不是公共 API）：
//   GET  /dsh-fish-service/health            插件 + 服务联合状态
//   GET  /dsh-fish-service/metrics           显存 / 模型 / 队列 / 版本（1 秒缓存）
//   GET  /dsh-fish-service/state             配置 / capabilities / 最近错误 / 缓存用量
//   POST /dsh-fish-service/save              保存配置
//   POST /dsh-fish-service/test              探测服务连通
//   GET  /dsh-fish-service/logs              最近 200 行日志
//   GET  /dsh-fish-service/voices            音色列表（设置页默认音色下拉用）
//   POST /dsh-fish-service/read              朗读：清洗 + 分段 + TTS（一次全合成，兼容保留）
//   POST /dsh-fish-service/read/plan         朗读分段计划（立即返回，不合成）
//   POST /dsh-fish-service/read/segment      单段合成（走 tts()，自动命中缓存）
//   GET  /dsh-fish-service/cache/stats       TTS 缓存命中统计
//   POST /dsh-fish-service/cache/clear       清空缓存（可指定 kind）
//   POST /dsh-fish-service/cache/cleanup     按 TTL/LRU 清理过期缓存
//   POST /dsh-fish-service/open-folder       在系统文件管理器里打开缓存目录（只限 cacheDir 内）
//   POST /dsh-fish-service/open-webui        用系统默认浏览器打开本地服务的管理界面
//   GET  /dsh-fish-service/audio?path=…      把 cacheDir 里的音频以 audio/* 返回（防穿越）
//   POST /dsh-fish-service/transcribe-upload multipart 录音 → ASR 文本
//   POST /dsh-fish-service/voice-upload      multipart 录音 → 存到 cacheDir/voice（保留语音）
//   POST /dsh-fish-service/describe-upload   multipart 图片 → 本机视觉模型 → 文字
//   POST /dsh-fish-service/translate         划词翻译（单条）
//   POST /dsh-fish-service/translate/batch   分段批量翻译（右栏面板用：按 id 回填，单段出错不连累整批）
//   POST /dsh-fish-service/translate/jobs    提交后台翻译任务（右栏面板用，旧版服务回 not_supported）
//   GET  /dsh-fish-service/translate/jobs/status?id=  查询任务状态
//   GET  /dsh-fish-service/translate/jobs/result?id=  取回任务译文
//   POST /dsh-fish-service/translate/jobs/cancel      取消任务（尽力而为）
//
// 浏览器不接触 token：配置返回永远是脱敏的。

import { spawn as defaultSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { toPublicError } from './errors.js'
import { isAbsolutePath, isPathInside } from './fs-util.js'
import { detectLanguage } from './lang.js'
import { makeMetricsReader, metricsDefaultCacheMs, metricsDefaultTimeoutMs } from './metrics.js'
import {
  defaultMaxChars,
  minSegmentChars,
  maxSegmentChars,
  maxSegments,
  prepareSpeech,
} from './speech.js'
import {
  maxImageBytes,
  maxAudioBytes,
  maxRecordMs,
  imageExt,
  imageFile,
  audioExt,
  audioFile,
  parseMultipart,
  readNumberField,
} from './upload.js'
import { defaultVisionPrompt, defaultSessionVisionPrompt, normalizePreset, visionPreset } from './vision-presets.js'

const defaultPrefix = '/dsh-fish-service'

// 音频扩展名 → Content-Type。只允许这些类型被 /audio 读出去。
const audioType = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
}

const readBodyLimit = 2 * 1024 * 1024
const textLimit = 512 * 1024
const uploadLimit = maxAudioBytes + 1024 * 1024
const imageUploadLimit = maxImageBytes + 1024 * 1024

// 与 lib/service-api.js 里的同名常量保持一致（那边没导出，这里本地定义）。
const maxTranslationSegmentCount = 500
const singleSegmentChars = 5000
const maxTranslationTotalChars = 200000

function readBody(req, limit = readBodyLimit) {
  return new Promise((resolve) => {
    let text = ''
    let exceed = false
    req.on('data', (chunk) => {
      if (exceed) return
      text += chunk
      if (text.length > limit) {
        exceed = true
        resolve({})
      }
    })
    req.on('end', () => {
      if (exceed) return
      try { resolve(JSON.parse(text || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 读二进制请求体（multipart 用）；超限时返回 { over:true, buffer:空 }。 */
function readRawBody(req, limit = uploadLimit) {
  return new Promise((resolve) => {
    const chunks = []
    let len = 0
    let exceed = false
    req.on('data', (chunk) => {
      if (exceed) return
      len += chunk.length
      if (len > limit) {
        exceed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ buffer: exceed ? Buffer.alloc(0) : Buffer.concat(chunks), bytes: len, over: exceed }))
    req.on('error', () => resolve({ buffer: Buffer.alloc(0), bytes: len, over: true }))
  })
}

function query(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function respond(res, statusCode, data) {
  try {
    res.statusCode = statusCode
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端断开就算了。
  }
}

function sendBinary(res, type, data, fileName) {
  try {
    res.statusCode = 200
    res.setHeader?.('content-type', type)
    res.setHeader?.('content-length', String(data.length))
    res.setHeader?.('cache-control', 'private, max-age=300')
    res.setHeader?.('content-disposition', `inline; filename="${String(fileName).replace(/["\\]/g, '')}"`)
    res.end?.(data)
  } catch {
    // 同上。
  }
}

function requestMethod(req, res, method) {
  const reqMethod = String(req?.method || 'GET').toUpperCase()
  if (reqMethod === method) return true
  respond(res, 405, { ok: false, code: 'bad_request', hint: `该操作仅支持 ${method} 请求。` })
  return false
}

/** 宽松同源检查：没有 Origin（脚本/测试）放行；有就必须和 Host 一致。 */
function sameOrigin(req) {
  const origin = req?.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === String(req?.headers?.host || '')
  } catch {
    return false
  }
}

const numberClamp = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

const fetchStrValueEnum = (value, allow, fallback) => {
  const name = String(value == null ? '' : value).trim().toLowerCase()
  return allow.includes(name) ? name : fallback
}

/** 有限并发：最多 并发度 个 worker；结果按输入顺序返回（任务自己兜住异常）。 */
async function limitedConcurrency(tasks, concurrency) {
  const result = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      result[i] = await tasks[i]()
    }
  }
  const workerCount = Math.max(1, Math.min(Math.trunc(Number(concurrency)) || 1, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return result
}

/**
 * 语速：显式给了就必须在 0.5~2.0；没给用配置。
 * @returns {number|undefined|null} null = 越界
 */
function fetchSpeed(value, config) {
  if (value === undefined || value === null || value === '') {
    const n = Number(config?.ttsSpeed)
    return Number.isFinite(n) ? n : undefined
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0.5 || n > 2) return null
  return Math.round(n * 100) / 100
}

/** 朗读分段参数（/read 与 /read/plan 共用）：清洗、分段、maxChars、voice。 */
function fetchReadSegment(body, config) {
  const maxChars = numberClamp(body.maxChars, config.readMaxChars || defaultMaxChars, minSegmentChars, maxSegmentChars)
  const skipCodeBlocks = body.skipCodeBlocks === undefined
    ? config.readSkipCode !== false
    : Boolean(body.skipCodeBlocks)
  const original = typeof body.text === 'string' ? body.text : ''
  return {
    maxChars,
    skipCodeBlocks,
    speech: prepareSpeech(original, { maxChars, skipCodeBlocks }),
    voice: String(body.voice || config.ttsVoice || '').trim() || undefined,
  }
}

export function registerRoutes({
  ctx,
  api,
  configStore,
  capabilities,
  cache,
  logger,
  version = '0.1.0',
  prefix = defaultPrefix,
  // 打开文件夹 / 打开管理界面用；测试传替身，避免真的弹窗。
  spawn = defaultSpawn,
  // 打开管理界面的平台判断；测试可注入，默认当前系统。
  platform = process.platform,
  // /metrics 抓上游用的 fetch 与超时；测试注入替身，避免真的打本机服务。
  fetchImpl = globalThis.fetch,
  metricsTimeoutMs = metricsDefaultTimeoutMs,
  metricsCacheMs = metricsDefaultCacheMs,
}) {
  const route = (path, handler) => {
    const register = ctx.webServer.register({
      kind: 'exact',
      path: path,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          logger?.error(`路由 ${path} 出错：${error?.code || ''} ${error?.message || error}`)
          const payload = toPublicError(error)
          respond(res, payload.code === 'bad_request' ? 400 : 500, payload)
        }
      },
    })
    return register
  }

  const summary = []

  const add = (path, handler) => {
    const disposer = route(path, handler)
    if (typeof disposer === 'function') summary.push(disposer)
  }

  /** 缓存目录里的绝对路径 → 浏览器可播放的 URL。 */
  const audioUrl = (path) => `${prefix}/audio?path=${encodeURIComponent(String(path || ''))}`

  // 指标读取器：baseUrl / token 走现有配置（与 /open-webui 同一来源），不另存一份地址。
  const readMetrics = makeMetricsReader({
    getBaseUrl: () => api.config.get()?.baseUrl || configStore?.current?.baseUrl || '',
    getToken: () => api.config.get()?.token || configStore?.current?.token || '',
    fetchImpl,
    timeoutMs: metricsTimeoutMs,
    cacheMs: metricsCacheMs,
    logger,
  })

  // ---------------- 联合健康 ----------------

  add(`${prefix}/health`, async (_req, res) => {
    // 不阻塞：没有快照就先发起一次探测，本轮先返回“未知/离线”。
    if (!capabilities.current()) void capabilities.refresh({ timeoutMs: 2000 })
    const snapshot = capabilities.current()
    const status = capabilities.status()
    respond(res, 200, {
      ok: Boolean(snapshot?.ok),
      pluginOk: true,
      serviceDown: !snapshot || !snapshot.reachable,
      enabled: api.config.get().enabled,
      pluginVersion: version,
      baseUrl: snapshot?.baseUrl || api.config.get().baseUrl,
      lastCheckAt: status.lastCheckAt || 0,
      latencyMs: status.latencyMs || snapshot?.latencyMs || 0,
      ...(snapshot?.serviceVersion ? { serviceVersion: snapshot.serviceVersion } : {}),
      ...(snapshot?.apiVersion ? { apiVersion: snapshot.apiVersion } : {}),
      consecutiveFailures: status.consecutiveFailures || 0,
      ...(snapshot?.lastError ? { lastError: snapshot.lastError } : {}),
    })
  })

  // ---------------- 性能指标（输入框状态胶囊轮询） ----------------

  add(`${prefix}/metrics`, async (req, res) => {
    if (!requestMethod(req, res, 'GET')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    // 服务没起来也返回 200 + ok:false，轮询方按离线分支显示，不刷错误。
    respond(res, 200, await readMetrics.read())
  })

  // ---------------- 设置页状态 ----------------

  add(`${prefix}/state`, async (_req, res) => {
    const snapshot = await capabilities.refresh({ timeoutMs: 2500 })
    let voice = []
    let voiceDir = ''
    try {
      const list = await api.voices()
      voice = list.map((x) => x.name).filter(Boolean)
      voiceDir = typeof list.directory === 'string' ? list.directory : ''
    } catch { /* 服务没起时忽略 */ }

    respond(res, 200, {
      ok: true,
      plugin: {
        version,
        configFile: configStore.filePath,
        logFile: logger?.filePath || '',
        enabled: snapshot ? api.config.get().enabled : false,
        baseUrl: api.config.get().baseUrl,
      },
      config: api.config.get(),
      health: {
        ok: Boolean(snapshot.ok),
        reachable: Boolean(snapshot.reachable),
        compatible: Boolean(snapshot.compatible),
        checkedAt: snapshot.checkedAt,
        latencyMs: snapshot.latencyMs,
        ...(snapshot.serviceVersion ? { serviceVersion: snapshot.serviceVersion } : {}),
        ...(snapshot.apiVersion ? { apiVersion: snapshot.apiVersion } : {}),
        ...(snapshot.vram ? { vram: snapshot.vram } : {}),
        consecutiveFailures: snapshot.consecutiveFailures,
        ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
      },
      capabilities: snapshot.capabilities,
      voices: voice,
      voicesDirectory: voiceDir,
      // 设置页把「留空=默认」的提示词直接显示成占位文字，免得到处翻文档。
      visionDefaults: {
        presets: { ...defaultVisionPrompt },
        session: defaultSessionVisionPrompt,
      },
      cache: cache.usage(),
      errors: api.recentErrors(20),
      envOverrides: [...(configStore.overrides || [])],
    })
  })

  // ---------------- 保存配置 ----------------

  add(`${prefix}/save`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req)
    const patch = body && typeof body.config === 'object'
      ? body.config
      : (body && typeof body.patch === 'object' ? body.patch : body)
    try {
      const result = await api.config.set(patch || {})
      respond(res, 200, { ...result, config: api.config.get() })
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 500, payload)
    }
  })

  // ---------------- 测试连接 ----------------

  add(`${prefix}/test`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req)
    const timeout = Math.max(500, Math.min(10000, Number(body?.timeoutMs) || 3000))
    const snapshot = await capabilities.refresh({ force: true, timeoutMs: timeout })
    respond(res, 200, {
      ok: snapshot.ok,
      reachable: snapshot.reachable,
      compatible: snapshot.compatible,
      baseUrl: snapshot.baseUrl,
      latencyMs: snapshot.latencyMs,
      checkedAt: snapshot.checkedAt,
      ...(snapshot.serviceVersion ? { serviceVersion: snapshot.serviceVersion } : {}),
      ...(snapshot.apiVersion ? { apiVersion: snapshot.apiVersion } : {}),
      ...(snapshot.ok ? { capabilities: snapshot.capabilities } : {}),
      ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
      ...(snapshot.ok ? {} : {
        code: snapshot.lastError?.code || 'service_down',
        hint: snapshot.lastError?.hint || '未能连接本地 AI，请确认已启动，并检查填写的地址。',
      }),
    })
  })

  // ---------------- 日志 ----------------

  add(`${prefix}/logs`, async (req, res) => {
    if (!requestMethod(req, res, 'GET')) return
    const raw = Number(query(req).get('lines'))
    const lineCount = Number.isFinite(raw) ? Math.max(1, Math.min(1000, Math.trunc(raw))) : 200
    respond(res, 200, { ok: true, lines: logger?.recent(lineCount) || [] })
  })

  // ---------------- 音色 ----------------

  add(`${prefix}/voices`, async (_req, res) => {
    try {
      const voice = await api.voices()
      respond(res, 200, { ok: true, voices: voice })
    } catch (error) {
      respond(res, 200, { ok: false, ...toPublicError(error), voices: [] })
    }
  })

  // ---------------- 翻译（框选文字用） ----------------

  add(`${prefix}/translate`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req, textLimit)
    const text = String(body.text ?? '').trim()
    if (!text) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有可翻译的文字。' })
      return
    }
    try {
      const result = await api.translate(text, { source: body.source, target: body.target })
      respond(res, 200, {
        ok: true,
        text: Array.isArray(result.texts) ? String(result.texts[0] || '') : '',
        source: result.source,
        target: result.target,
        ms: result.ms,
      })
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 502, { ok: false, ...payload })
    }
  })

  // ---------------- 翻译（右栏面板用：分段批量） ----------------

  /**
   * POST /translate/batch
   * 入参 { texts: [{ id, text }], source?, target?, batchSize? }
   * 出参 { ok, source, target, engine, ms, results: [{ id, translated, detectedLang?, error? }] }
   *
   * 面板按段翻译：单段格式/长度不对只标记那一段，整批照样翻；
   * 只有引擎/服务级失败才整批 502（沿用 toPublicError 的中文提示）。
   */
  add(`${prefix}/translate/batch`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req, textLimit)
    const segments = Array.isArray(body.texts) ? body.texts : []
    if (!segments.length) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有可翻译的文字。' })
      return
    }
    if (segments.length > maxTranslationSegmentCount) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `一次最多翻译 ${maxTranslationSegmentCount} 段，请分段后再试。`,
      })
      return
    }
    const entries = []
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object' || segment.id === undefined || segment.id === null || typeof segment.text !== 'string') {
        respond(res, 400, { ok: false, code: 'bad_request', hint: '翻译分段格式不对，刷新页面后再试。' })
        return
      }
      entries.push({ id: segment.id, text: segment.text })
    }
    const totalChars = entries.reduce((and, entry) => and + entry.text.length, 0)
    if (totalChars > maxTranslationTotalChars) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `一次最多翻译 ${maxTranslationTotalChars} 字，请分段后再试。`,
      })
      return
    }

    const resultTable = entries.map((entry) => ({ id: entry.id, translated: '' }))
    const pending = []
    entries.forEach((entry, order) => {
      if (!entry.text.trim()) return
      if (entry.text.length > singleSegmentChars) {
        resultTable[order].error = { code: 'bad_request', hint: `这一段太长了，单段最多 ${singleSegmentChars} 字。` }
        return
      }
      pending.push({ order, text: entry.text })
    })

    if (!pending.length) {
      respond(res, 200, { ok: true, source: 'auto', target: '', engine: 'nllb', ms: 0, results: resultTable })
      return
    }

    let translation
    try {
      translation = await api.translate(
        pending.map((item) => item.text),
        { source: body.source, target: body.target, batchSize: body.batchSize, timeoutMs: body.timeoutMs },
      )
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 502, { ok: false, ...payload })
      return
    }

    const translations = Array.isArray(translation && translation.texts) ? translation.texts : []
    pending.forEach((item, i) => {
      const translated = translations[i]
      if (typeof translated !== 'string') {
        resultTable[item.order].error = { code: 'upstream_error', hint: '这一段没翻好，可以点继续翻译重试。' }
        return
      }
      resultTable[item.order].translated = translated
      resultTable[item.order].detectedLang = detectLanguage(item.text) || null
    })

    respond(res, 200, {
      ok: true,
      source: (translation && translation.source) || 'auto',
      target: (translation && translation.target) || '',
      engine: (translation && translation.engine) || 'nllb',
      ms: translation && translation.ms,
      results: resultTable,
    })
  })

  // ---------------- 翻译（右栏面板用：后台任务队列） ----------------

  /**
   * POST /translate/jobs
   * 入参 { texts: [string], source?, target?, timeoutMs? }
   * 出参 { ok, id, state, source, target, count }
   * 旧版服务没有 /jobs/translate：回 HTTP 200 { ok:false, code:'not_supported' }，面板据此回退同步批量。
   */
  add(`${prefix}/translate/jobs`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req, textLimit)
    const texts = Array.isArray(body.texts) ? body.texts : []
    if (!texts.length || texts.some((item) => typeof item !== 'string')) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有可翻译的文字。' })
      return
    }
    if (texts.length > maxTranslationSegmentCount) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `一次最多翻译 ${maxTranslationSegmentCount} 段，请分段后再试。`,
      })
      return
    }
    try {
      const task = await api.translateJobs.submit(texts, { source: body.source, target: body.target })
      respond(res, 200, {
        ok: true,
        id: task.id,
        state: task.state,
        source: task.source,
        target: task.target,
        count: task.count,
      })
    } catch (error) {
      if (error?.code === 'not_implemented') {
        respond(res, 200, {
          ok: false,
          code: 'not_supported',
          hint: error.hint || '当前本地 AI 版本较旧，已改用直接翻译。',
        })
        return
      }
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 502, { ok: false, ...payload })
    }
  })

  /** GET /translate/jobs/status?id=任务id → { ok, id, state, progress?, error? } */
  add(`${prefix}/translate/jobs/status`, async (req, res) => {
    if (!requestMethod(req, res, 'GET')) return
    try {
      respond(res, 200, await api.translateJobs.status(query(req).get('id')))
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 502, { ok: false, ...payload })
    }
  })

  /** GET /translate/jobs/result?id=任务id → { ok, id, state, texts, source, target, engine, ms? } */
  add(`${prefix}/translate/jobs/result`, async (req, res) => {
    if (!requestMethod(req, res, 'GET')) return
    try {
      const result = await api.translateJobs.result(query(req).get('id'))
      if (!result.ok) {
        respond(res, 200, { ok: false, code: result.code || 'not_ready', state: result.state, hint: result.hint })
        return
      }
      respond(res, 200, result)
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 502, { ok: false, ...payload })
    }
  })

  /** POST /translate/jobs/cancel 入参 { id }；取消失败也回 200，面板只当「已停止」。 */
  add(`${prefix}/translate/jobs/cancel`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req)
    try {
      respond(res, 200, await api.translateJobs.cancel(body.id))
    } catch (error) {
      respond(res, 200, { ok: false, ...toPublicError(error) })
    }
  })

  // ---------------- 朗读：清洗 + 分段 + TTS ----------------

  add(`${prefix}/read`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req, textLimit)
    if (!String(body.text || '').trim()) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const config = api.config.get()
    const { speech, voice, skipCodeBlocks } = fetchReadSegment(body, config)
    if (!speech.chunks.length) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息在去掉代码块后没有可朗读的内容。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    const speed = fetchSpeed(body.speed, config)
    if (speed === null) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '语速须在 0.5~2.0 之间。' })
      return
    }

    const concurrency = numberClamp(config.readConcurrency, 2, 1, 4)
    const begin = Date.now()

    // fish.service.tts 单次最多 20 条（契约），这里最多 40 段，按 20 条一批。
    const batches = []
    for (let startPoint = 0; startPoint < speech.chunks.length; startPoint += 20) {
      batches.push({ startPoint, batch: speech.chunks.slice(startPoint, startPoint + 20) })
    }

    /** 合成一批并按全局段序映射；顺序在批内保持（引擎本身串行）。 */
    const synthesizeOneBatch = async ({ startPoint, batch }) => {
      const result = await api.tts(batch, {
        ...(voice ? { voice } : {}),
        ...(speed ? { speed } : {}),
        timeoutMs: config.requestTimeoutMs,
      })
      return (result.items || []).map((item, i) => {
        const globalSub = startPoint + i
        return {
          wavPath: item.wavPath,
          url: audioUrl(item.wavPath),
          ms: item.ms,
          voice: item.voice,
          bytes: item.bytes,
          chars: speech.chunks[globalSub] ? speech.chunks[globalSub].length : 0,
          cached: Boolean(item.cached),
        }
      })
    }

    let degrade = false
    try {
      const results = await limitedConcurrency(batches.map((unitLabel) => async () => {
        try {
          return { ok: true, items: await synthesizeOneBatch(unitLabel) }
        } catch (error) {
          return { ok: false, error }
        }
      }), concurrency)

      // 并发可能把 localai 队列 / 显存顶满：失败的批在所有并发跑完后单独串行重试一次，
      // 结果仍按段序拼接（items 的顺序不受并发影响）。
      const failSub = results.map((x, i) => (x.ok ? -1 : i)).filter((i) => i >= 0)
      if (failSub.length && concurrency > 1) {
        degrade = true
        logger?.warn(`朗读并发合成失败 ${failSub.length} 批，降级为串行重试`)
        for (const i of failSub) {
          try {
            results[i] = { ok: true, items: await synthesizeOneBatch(batches[i]) }
          } catch (error) {
            results[i] = { ok: false, error }
          }
        }
      }

      const primaryFail = results.find((x) => !x.ok)
      if (primaryFail) throw primaryFail.error

      const items = results.flatMap((x) => x.items)
      if (!items.length) {
        respond(res, 200, { ok: false, code: 'upstream_error', hint: '没有生成出音频，请稍后重试。' })
        return
      }
      const cachedChunks = items.filter((x) => x.cached).length
      respond(res, 200, {
        ok: true,
        wavPath: items[0].wavPath,
        ms: Date.now() - begin,
        items,
        chunks: items.length,
        chars: speech.chars,
        codeBlocks: speech.codeBlocks,
        codeLines: speech.codeLines,
        truncated: speech.truncated,
        voice: items[0].voice,
        ...(speed ? { speed } : {}),
        concurrency: concurrency,
        cachedChunks,
        cacheHits: cachedChunks,
        ...(degrade ? { degraded: true } : {}),
      })
    } catch (error) {
      // 合成失败是「服务没起 / 显存不够 / 缺模型」这类可展示原因；200 + ok:false 让前端直接念 hint。
      const payload = toPublicError(error)
      if (payload.code !== 'bad_request' && concurrency > 1) {
        payload.hint = `${payload.hint || '生成语音失败，请稍后重试。'}（本次同时生成 ${concurrency} 段；失败的部分已改为逐段重试，若仍失败，可到设置里把「同时生成」调低。）`
        if (payload.error && typeof payload.error === 'object') payload.error = { ...payload.error, hint: payload.hint }
      }
      respond(res, payload.code === 'bad_request' ? 400 : 200, payload)
    }
  })

  // ---------------- 流式朗读：分段计划（不合成，立即返回） ----------------

  add(`${prefix}/read/plan`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req, textLimit)
    if (!String(body.text || '').trim()) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const config = api.config.get()
    const { speech, voice, skipCodeBlocks, maxChars } = fetchReadSegment(body, config)
    if (!speech.chunks.length) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息在去掉代码块后没有可朗读的内容。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    const speed = fetchSpeed(body.speed, config)
    if (speed === null) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '语速须在 0.5~2.0 之间。' })
      return
    }

    respond(res, 200, {
      ok: true,
      segments: speech.chunks.map((text, index) => ({ index, text, chars: text.length })),
      chars: speech.chars,
      codeBlocks: speech.codeBlocks,
      codeLines: speech.codeLines,
      truncated: speech.truncated,
      voice: voice || config.ttsVoice || '',
      ...(speed !== undefined ? { speed } : {}),
      maxChars,
    })
  })

  // ---------------- 流式朗读：单段合成（走 tts()，自动命中缓存） ----------------

  add(`${prefix}/read/segment`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req, textLimit)
    const original = typeof body.text === 'string' ? body.text : ''
    if (!original.trim()) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '这一段的文字为空。' })
      return
    }

    // index 必须是非负整数；给了 total 时还要 < total（越界直接拒绝，不合成）。
    const index = Number(body.index)
    if (!Number.isInteger(index) || index < 0 || index > maxSegments - 1) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: '朗读分段的序号不正确，请从第一段重新开始。',
      })
      return
    }
    let total
    if (body.total !== undefined && body.total !== null && body.total !== '') {
      total = Number(body.total)
      if (!Number.isInteger(total) || total < 1 || total > maxSegments) {
        respond(res, 400, { ok: false, code: 'bad_request', hint: `朗读分段的总段数不正确，请重新开始朗读。` })
        return
      }
      if (index >= total) {
        respond(res, 400, { ok: false, code: 'bad_request', hint: '朗读分段的序号超出范围，请重新开始朗读。' })
        return
      }
    }

    const config = api.config.get()
    const speed = fetchSpeed(body.speed, config)
    if (speed === null) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '语速须在 0.5~2.0 之间。' })
      return
    }
    const voice = String(body.voice || config.ttsVoice || '').trim() || undefined
    const begin = Date.now()

    try {
      const result = await api.tts([original], {
        ...(voice ? { voice } : {}),
        ...(speed ? { speed } : {}),
        timeoutMs: config.requestTimeoutMs,
      })
      const item = (result.items || [])[0]
      if (!item || !item.wavPath) {
        respond(res, 200, { ok: false, code: 'upstream_error', hint: '这段内容没有生成出音频，请重试。' })
        return
      }
      respond(res, 200, {
        ok: true,
        index,
        wavPath: item.wavPath,
        url: audioUrl(item.wavPath),
        // 命中缓存时 tts() 返回 ms:0；这里保留语义，前端可据此显示「复用」。
        ms: item.ms !== undefined ? item.ms : Date.now() - begin,
        cached: Boolean(item.cached),
        bytes: Number(item.bytes) || 0,
        ...(item.voice ? { voice: item.voice } : {}),
        ...(speed ? { speed } : {}),
        ...(total ? { total } : {}),
      })
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 200, payload)
    }
  })

  // ---------------- 缓存统计 / 清空 / 清理 ----------------

  add(`${prefix}/cache/stats`, async (req, res) => {
    if (!requestMethod(req, res, 'GET')) return
    if (api.cache && typeof api.cache.stats === 'function') {
      respond(res, 200, api.cache.stats())
      return
    }
    // 兜底（测试替身 / 老 api）：只有磁盘用量，没有命中率。
    const usage = (cache && typeof cache.usage === 'function' ? cache.usage() : {}) || {}
    const tts = (usage.byKind && usage.byKind.tts) || {}
    respond(res, 200, {
      ok: true,
      kind: 'tts',
      files: Number(tts.files) || 0,
      bytes: Number(tts.bytes) || 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    })
  })

  add(`${prefix}/cache/clear`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req)
    const kind = body.kind === undefined || body.kind === null || body.kind === ''
      ? ''
      : String(body.kind).trim().toLowerCase()
    const allow = ['tts', 'separate', 'vision', 'tmp', 'voice']
    if (kind && !allow.includes(kind)) {
      respond(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: '缓存类型无法识别，请重新选择。',
      })
      return
    }
    try {
      const result = api.cache && typeof api.cache.clear === 'function'
        ? api.cache.clear({ kind })
        : {
            ok: true,
            kind: kind || 'all',
            ...((cache && typeof cache.clear === 'function') ? cache.clear(kind) : { files: 0, bytes: 0, kinds: [] }),
          }
      respond(res, 200, result)
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 500, payload)
    }
  })

  add(`${prefix}/cache/cleanup`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    try {
      const result = api.cache && typeof api.cache.cleanup === 'function'
        ? api.cache.cleanup()
        : { ok: true, ...((cache && typeof cache.cleanup === 'function') ? cache.cleanup() : {}) }
      respond(res, 200, result)
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 500, payload)
    }
  })

  // ---------------- 在文件管理器里打开缓存目录 ----------------

  add(`${prefix}/open-folder`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const body = await readBody(req)
    const raw = String(body?.path == null ? '' : body.path).trim()
    if (!raw) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有指定要打开的文件夹。' })
      return
    }
    if (raw.includes('\0') || !isAbsolutePath(raw)) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '请填写本机绝对路径。' })
      return
    }

    // 只允许打开缓存目录、服务音色目录，或它们里面的子目录；两边都先
    // realpath，这样符号链接/短路径也绕不出去。音色目录每次实时从服务取，
    // 不写进配置，避免配置被改成任意路径。
    const cacheRoot = String(api.config.get().cacheDir || cache?.dirPath || '')
    const allowRoot = []
    try { allowRoot.push(realpathSync(cacheRoot)) } catch { /* 缓存目录还没建好时忽略 */ }
    try {
      const voice = await api.voices({ force: true })
      const dir = typeof voice?.directory === 'string' ? voice.directory.trim() : ''
      if (dir && isAbsolutePath(dir)) allowRoot.push(realpathSync(dir))
    } catch (error) {
      logger?.warn(`取音色目录失败：${error?.message || error}`)
    }
    if (!allowRoot.length) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '缓存目录还不存在，请先保存设置。' })
      return
    }
    let targetActual
    try {
      targetActual = realpathSync(raw)
    } catch {
      respond(res, 404, { ok: false, code: 'bad_request', hint: '文件夹不存在，请检查路径。' })
      return
    }
    const lowerCase = process.platform === 'win32'
    const samePath = (left, right) => (lowerCase ? left.toLowerCase() : left) === (lowerCase ? right.toLowerCase() : right)
    if (!allowRoot.some((root) => samePath(root, targetActual) || isPathInside(root, targetActual))) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '只能打开缓存目录或音色目录。' })
      return
    }
    let info
    try { info = statSync(targetActual) } catch {
      respond(res, 404, { ok: false, code: 'bad_request', hint: '文件夹不存在，请检查路径。' })
      return
    }
    if (!info.isDirectory()) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '这个路径不是文件夹。' })
      return
    }
    if (process.platform !== 'win32') {
      respond(res, 200, { ok: false, code: 'not_supported', hint: '暂不支持在系统中打开文件夹。' })
      return
    }

    try {
      const childProcess = spawn('explorer.exe', [targetActual], { detached: true, stdio: 'ignore' })
      // Windows 上 explorer 会在自己的进程里打开窗口，这里不等待、不留句柄。
      if (childProcess && typeof childProcess.unref === 'function') childProcess.unref()
    } catch (error) {
      logger?.warn(`打开缓存目录失败：${error?.message || error}`)
      respond(res, 500, { ok: false, code: 'upstream_error', hint: '无法打开文件夹，请手动打开。' })
      return
    }
    respond(res, 200, { ok: true, path: targetActual })
  })

  // ---------------- 用系统默认浏览器打开本地服务的管理界面 ----------------

  add(`${prefix}/open-webui`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }

    // 先探测服务：离线时不弹浏览器，直接告诉用户先启动。
    let health = null
    try {
      health = await capabilities.refresh({ force: true, timeoutMs: 2000 })
    } catch (error) {
      logger?.warn(`打开管理界面前探测服务失败：${error?.message || error}`)
    }
    if (!health || !health.reachable) {
      respond(res, 200, { ok: false, code: 'service_down', hint: '本地 AI 未启动，请先启动后再打开管理界面。' })
      return
    }

    // 只接受带 host 的 http(s) 地址；地址来自本机配置，仍按外部输入校验。
    const original = String(api.config.get()?.baseUrl || '').trim()
    let address
    try {
      address = new URL(original)
    } catch {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '服务地址格式不正确，请先在设置里修改。' })
      return
    }
    if ((address.protocol !== 'http:' && address.protocol !== 'https:') || !address.host) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '服务地址格式不正确，请先在设置里修改。' })
      return
    }
    // cmd.exe 会重新解析命令行；地址里出现空白或这些字符就有注入风险，
    // 正常地址用不到，直接拒绝。
    if (/[\s&|^<>"']/.test(address.href)) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '服务地址格式不正确，请先在设置里修改。' })
      return
    }
    if (platform !== 'win32') {
      respond(res, 200, { ok: false, code: 'not_supported', hint: '暂不支持在系统中打开浏览器。' })
      return
    }

    const target = `${address.href.replace(/\/+$/, '')}/ui`
    try {
      // 用 cmd 的 start：交给系统按默认程序打开 http 地址（explorer 不认 URL）。
      // 空字符串占住「窗口标题」，否则带引号的地址会被 start 当成标题。
      const childProcess = spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' })
      // 与 explorer 一样不等待；异步失败只记日志，避免变成未捕获异常。
      childProcess?.on?.('error', (error) => logger?.warn(`打开管理界面失败：${error?.message || error}`))
      if (childProcess && typeof childProcess.unref === 'function') childProcess.unref()
    } catch (error) {
      logger?.warn(`打开管理界面失败：${error?.message || error}`)
      respond(res, 500, { ok: false, code: 'upstream_error', hint: '无法打开浏览器，请手动访问管理界面。' })
      return
    }
    respond(res, 200, { ok: true })
  })

  // ---------------- 音频回放（只允许 cacheDir 里的文件） ----------------

  add(`${prefix}/audio`, async (req, res) => {
    if (!requestMethod(req, res, 'GET')) return
    const path = String(query(req).get('path') || '').trim()
    if (!path) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '缺少音频文件。' })
      return
    }
    const cacheRoot = String(api.config.get().cacheDir || cache?.dirPath || '')
    // 防目录穿越：解析后必须落在 cacheDir 里，且是已知音频扩展名。
    if (!cacheRoot || !isPathInside(cacheRoot, path)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '只能播放缓存目录中的音频。' })
      return
    }
    const type = audioType[extname(path).toLowerCase()]
    if (!type) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '不支持的音频格式。' })
      return
    }
    let info
    try { info = statSync(path) } catch {
      respond(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在，可能已被清理。' })
      return
    }
    if (!info.isFile()) {
      respond(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在。' })
      return
    }
    if (info.size > 128 * 1024 * 1024) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: '音频文件过大，已拒绝。' })
      return
    }
    let data
    try { data = readFileSync(path) } catch {
      respond(res, 404, { ok: false, code: 'bad_request', hint: '音频文件无法读取。' })
      return
    }
    sendBinary(res, type, data, basename(path))
  })

  // ---------------- 语音输入：转文字 ----------------

  add(`${prefix}/transcribe-upload`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const raw = await readRawBody(req, uploadLimit)
    if (raw.over) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(maxAudioBytes / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const parse = parseMultipart(raw.buffer, req?.headers?.['content-type'])
    const file = audioFile(parse)
    if (!file || !file.data.length) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '未收到音频文件。' })
      return
    }
    if (file.data.length > maxAudioBytes) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(maxAudioBytes / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const duration = readNumberField(parse.fields.durationMs, 0)
    if (duration > maxRecordMs) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '录音超过 5 分钟，请分段录制。' })
      return
    }

    const config = api.config.get()
    const language = fetchStrValueEnum(parse.fields.language, ['auto', 'zh', 'en', 'ja'], config.asrLanguage || 'auto')
    const ext = audioExt(file.contentType, file.filename)

    // 诊断与早退：麦克风没采到声音 / 录音太短时，直接给出可操作提示，别把静音丢给识别。
    logger?.info(`语音输入：收到 ${file.data.length} 字节，类型 ${file.contentType || '未知'}，扩展 ${ext}，时长 ${duration || 0}ms`)
    if (file.data.length < 1500) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '没有采集到声音，请检查麦克风是否可用后重试。' })
      return
    }
    if (duration && duration < 300) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '录音太短，请多说几秒再停止。' })
      return
    }

    // 临时文件放在 cacheDir/tmp，请求结束就删（不长期保存用户音频）。
    let temp = ''
    try {
      temp = cache.saveBuffer('tmp', file.data, { ext: ext, name: `${randomUUID()}${ext}` })
    } catch (error) {
      respond(res, 500, { ok: false, code: 'upstream_error', hint: '录音处理失败，请稍后重试。' })
      return
    }

    const begin = Date.now()
    let keepDiagnosis = false
    try {
      const result = await api.asr(temp, { language: language, timeoutMs: config.asrTimeoutMs })
      const item = (result.items && result.items[0]) || {}
      const recognizedText = String(item.text || '')
      logger?.info(`语音输入：识别结果 ${recognizedText.length} 字（${file.data.length} 字节 / ${duration || 0}ms），耗时 ${item.elapsedMs ?? '?'}ms，文本「${recognizedText.slice(0, 20)}」`)
      // 识别结果异常短（正常一句话至少 3 个字）时保留录音，便于排查麦克风/格式问题。
      if (recognizedText.trim().length < 3 && file.data.length > 0) {
        keepDiagnosis = true
        logger?.warn(`语音输入：识别结果异常短，已保留录音用于排查：${temp}`)
      }
      respond(res, 200, {
        ok: true,
        text: String(item.text || ''),
        ms: Date.now() - begin,
        ...(item.elapsedMs !== undefined ? { elapsedMs: item.elapsedMs } : {}),
        ...(item.language ? { language: item.language } : { language: language }),
        bytes: file.data.length,
      })
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 200, payload)
    } finally {
      if (!keepDiagnosis) {
        try { if (temp) rmSync(temp, { force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
      }
    }
  })

  // ---------------- 语音输入：保留语音（存到 cacheDir/voice） ----------------

  add(`${prefix}/voice-upload`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const raw = await readRawBody(req, uploadLimit)
    if (raw.over) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(maxAudioBytes / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const parse = parseMultipart(raw.buffer, req?.headers?.['content-type'])
    const file = audioFile(parse)
    if (!file || !file.data.length) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '未收到音频文件。' })
      return
    }
    if (file.data.length > maxAudioBytes) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(maxAudioBytes / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const duration = readNumberField(parse.fields.durationMs, 0)
    if (duration > maxRecordMs) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '录音超过 5 分钟，请分段录制。' })
      return
    }
    const ext = audioExt(file.contentType, file.filename)
    const label = `${randomUUID()}${ext}`
    let path = ''
    try {
      path = cache.saveBuffer('voice', file.data, { ext: ext, name: label })
    } catch (error) {
      respond(res, 500, { ok: false, code: 'upstream_error', hint: '音频保存失败，请稍后重试。' })
      return
    }
    respond(res, 200, {
      ok: true,
      path: path,
      name: label,
      bytes: file.data.length,
      mime: file.contentType,
      ...(duration ? { durationMs: duration } : {}),
    })
  })

  // ---------------- 本地识图：图片 → 文字 ----------------
  // 设置页/会话里「本地识图」按钮用：浏览器把图片上传过来，宿主存成临时文件后
  // 调本机视觉模型，返回一段文字，临时文件随即删掉（不长期保存用户图片）。

  add(`${prefix}/describe-upload`, async (req, res) => {
    if (!requestMethod(req, res, 'POST')) return
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    if (api.visionPrefs && api.visionPrefs().localDescribe === false) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '本地识图已关闭，可在本地 AI 设置里打开。' })
      return
    }
    const raw = await readRawBody(req, imageUploadLimit)
    if (raw.over) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: `图片过大（超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const parse = parseMultipart(raw.buffer, req?.headers?.['content-type'])
    const file = imageFile(parse)
    if (!file || !file.data.length) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '未收到图片。' })
      return
    }
    if (file.data.length > maxImageBytes) {
      respond(res, 413, { ok: false, code: 'bad_request', hint: `图片过大（超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const ext = imageExt(file.contentType, file.filename)
    if (!ext) {
      respond(res, 400, { ok: false, code: 'bad_request', hint: '只支持 JPG / PNG / WebP / GIF / BMP 图片。' })
      return
    }
    const mode = fetchStrValueEnum(parse.fields.mode, ['caption', 'score', 'ocr'], 'caption')
    // 范围：session = 会话识图按钮（固定用会话识图提示词）；tool = 工具识图（按档位）。
    // 档位：显式 preset 优先；ocr 固定「只看文字」档；缺省或非法值用配置默认档。
    const prefs = typeof api.visionPrefs === 'function' ? (api.visionPrefs() || {}) : {}
    const defaultPreset = normalizePreset(prefs.visionDefaultPreset)
    const range = String(parse.fields.scope ?? '').trim().toLowerCase() === 'session' ? 'session' : 'tool'
    const presetLevel = mode === 'ocr' ? 'text' : fetchStrValueEnum(parse.fields.preset, visionPreset, defaultPreset)

    let temp = ''
    try {
      temp = cache.saveBuffer('tmp', file.data, { ext: ext, name: `${randomUUID()}${ext}` })
    } catch {
      respond(res, 500, { ok: false, code: 'upstream_error', hint: '图片处理失败，请稍后重试。' })
      return
    }

    const begin = Date.now()
    try {
      const result = await api.visionDescribe(temp, range === 'session'
        ? { mode: mode, scope: 'session' }
        : { mode: mode, preset: presetLevel })
      const item = (result.items && result.items[0]) || {}
      respond(res, 200, {
        ok: true,
        text: String(item.text || ''),
        mode: mode,
        scope: range,
        ...(range === 'session' ? {} : { preset: presetLevel }),
        ms: Date.now() - begin,
        bytes: file.data.length,
      })
    } catch (error) {
      const payload = toPublicError(error)
      respond(res, payload.code === 'bad_request' ? 400 : 200, payload)
    } finally {
      try { if (temp) rmSync(temp, { force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
    }
  })

  return () => {
    for (const fn of summary.splice(0)) {
      try { fn() } catch { /* 已卸载 */ }
    }
  }
}

export { defaultPrefix }
