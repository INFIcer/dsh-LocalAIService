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

import { spawn as 默认spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { toPublicError } from './errors.js'
import { isAbsolutePath, isPathInside } from './fs-util.js'
import { 检测语言 } from './lang.js'
import { 造指标读取器, 指标缓存毫秒, 指标超时毫秒 } from './metrics.js'
import {
  默认最大字数,
  最小分段字数,
  最大分段字数,
  最多段数,
  prepareSpeech,
} from './speech.js'
import {
  最大图片字节,
  最大音频字节,
  最大录音毫秒,
  取图片扩展,
  取图片文件,
  取音频扩展,
  取音频文件,
  解析multipart,
  读数字字段,
} from './upload.js'
import { 默认识图提示, 默认会话识图提示, 规范档位, 识图档位 } from './vision-presets.js'

const 默认前缀 = '/dsh-fish-service'

// 音频扩展名 → Content-Type。只允许这些类型被 /audio 读出去。
const 音频类型 = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
}

const 读体上限 = 2 * 1024 * 1024
const 文本上限 = 512 * 1024
const 上传上限 = 最大音频字节 + 1024 * 1024
const 图片上传上限 = 最大图片字节 + 1024 * 1024

// 与 lib/service-api.js 里的同名常量保持一致（那边没导出，这里本地定义）。
const 最多翻译段数 = 500
const 单段翻译字数 = 5000
const 最多翻译总字数 = 200000

function 读体(req, 上限 = 读体上限) {
  return new Promise((resolve) => {
    let 文 = ''
    let 超 = false
    req.on('data', (块) => {
      if (超) return
      文 += 块
      if (文.length > 上限) {
        超 = true
        resolve({})
      }
    })
    req.on('end', () => {
      if (超) return
      try { resolve(JSON.parse(文 || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 读二进制请求体（multipart 用）；超限时返回 { over:true, buffer:空 }。 */
function 读原始体(req, 上限 = 上传上限) {
  return new Promise((resolve) => {
    const 块们 = []
    let 长度 = 0
    let 超 = false
    req.on('data', (块) => {
      if (超) return
      长度 += 块.length
      if (长度 > 上限) {
        超 = true
        块们.length = 0
        return
      }
      块们.push(块)
    })
    req.on('end', () => resolve({ buffer: 超 ? Buffer.alloc(0) : Buffer.concat(块们), bytes: 长度, over: 超 }))
    req.on('error', () => resolve({ buffer: Buffer.alloc(0), bytes: 长度, over: true }))
  })
}

function 查询(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function 回(res, 状态码, 数据) {
  try {
    res.statusCode = 状态码
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end?.(JSON.stringify(数据))
  } catch {
    // 客户端断开就算了。
  }
}

function 回二进制(res, 类型, 数据, 文件名) {
  try {
    res.statusCode = 200
    res.setHeader?.('content-type', 类型)
    res.setHeader?.('content-length', String(数据.length))
    res.setHeader?.('cache-control', 'private, max-age=300')
    res.setHeader?.('content-disposition', `inline; filename="${String(文件名).replace(/["\\]/g, '')}"`)
    res.end?.(数据)
  } catch {
    // 同上。
  }
}

function 要方法(req, res, 方法) {
  const 来 = String(req?.method || 'GET').toUpperCase()
  if (来 === 方法) return true
  回(res, 405, { ok: false, code: 'bad_request', hint: `该操作仅支持 ${方法} 请求。` })
  return false
}

/** 宽松同源检查：没有 Origin（脚本/测试）放行；有就必须和 Host 一致。 */
function 同源(req) {
  const 来源 = req?.headers?.origin
  if (!来源) return true
  try {
    return new URL(来源).host === String(req?.headers?.host || '')
  } catch {
    return false
  }
}

const 数字钳 = (值, 兜底, 最小, 最大) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(最小, Math.min(最大, Math.trunc(n)))
}

const 取字符串枚举 = (值, 允许, 兜底) => {
  const 名 = String(值 == null ? '' : 值).trim().toLowerCase()
  return 允许.includes(名) ? 名 : 兜底
}

/** 有限并发：最多 并发度 个 worker；结果按输入顺序返回（任务自己兜住异常）。 */
async function 有限并发(任务们, 并发度) {
  const 结果 = new Array(任务们.length)
  let 下一个 = 0
  const 工人 = async () => {
    for (;;) {
      const i = 下一个++
      if (i >= 任务们.length) return
      结果[i] = await 任务们[i]()
    }
  }
  const 工人数 = Math.max(1, Math.min(Math.trunc(Number(并发度)) || 1, 任务们.length))
  await Promise.all(Array.from({ length: 工人数 }, () => 工人()))
  return 结果
}

/**
 * 语速：显式给了就必须在 0.5~2.0；没给用配置。
 * @returns {number|undefined|null} null = 越界
 */
function 取语速(值, 配置) {
  if (值 === undefined || 值 === null || 值 === '') {
    const n = Number(配置?.ttsSpeed)
    return Number.isFinite(n) ? n : undefined
  }
  const n = Number(值)
  if (!Number.isFinite(n) || n < 0.5 || n > 2) return null
  return Math.round(n * 100) / 100
}

/** 朗读分段参数（/read 与 /read/plan 共用）：清洗、分段、maxChars、voice。 */
function 取朗读分段(体, 配置) {
  const maxChars = 数字钳(体.maxChars, 配置.readMaxChars || 默认最大字数, 最小分段字数, 最大分段字数)
  const skipCodeBlocks = 体.skipCodeBlocks === undefined
    ? 配置.readSkipCode !== false
    : Boolean(体.skipCodeBlocks)
  const 原文 = typeof 体.text === 'string' ? 体.text : ''
  return {
    maxChars,
    skipCodeBlocks,
    语音: prepareSpeech(原文, { maxChars, skipCodeBlocks }),
    voice: String(体.voice || 配置.ttsVoice || '').trim() || undefined,
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
  prefix = 默认前缀,
  // 打开文件夹 / 打开管理界面用；测试传替身，避免真的弹窗。
  spawn = 默认spawn,
  // 打开管理界面的平台判断；测试可注入，默认当前系统。
  platform = process.platform,
  // /metrics 抓上游用的 fetch 与超时；测试注入替身，避免真的打本机服务。
  fetchImpl = globalThis.fetch,
  metricsTimeoutMs = 指标超时毫秒,
  metricsCacheMs = 指标缓存毫秒,
}) {
  const 路线 = (路径, handler) => {
    const 注册 = ctx.webServer.register({
      kind: 'exact',
      path: 路径,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          logger?.error(`路由 ${路径} 出错：${error?.code || ''} ${error?.message || error}`)
          const 包 = toPublicError(error)
          回(res, 包.code === 'bad_request' ? 400 : 500, 包)
        }
      },
    })
    return 注册
  }

  const 摘 = []

  const 加 = (路径, handler) => {
    const disposer = 路线(路径, handler)
    if (typeof disposer === 'function') 摘.push(disposer)
  }

  /** 缓存目录里的绝对路径 → 浏览器可播放的 URL。 */
  const 音频地址 = (路径) => `${prefix}/audio?path=${encodeURIComponent(String(路径 || ''))}`

  // 指标读取器：baseUrl / token 走现有配置（与 /open-webui 同一来源），不另存一份地址。
  const 读指标 = 造指标读取器({
    getBaseUrl: () => api.config.get()?.baseUrl || configStore?.current?.baseUrl || '',
    getToken: () => api.config.get()?.token || configStore?.current?.token || '',
    fetchImpl,
    timeoutMs: metricsTimeoutMs,
    cacheMs: metricsCacheMs,
    logger,
  })

  // ---------------- 联合健康 ----------------

  加(`${prefix}/health`, async (_req, res) => {
    // 不阻塞：没有快照就先发起一次探测，本轮先返回“未知/离线”。
    if (!capabilities.current()) void capabilities.refresh({ timeoutMs: 2000 })
    const 快照 = capabilities.current()
    const 状态 = capabilities.status()
    回(res, 200, {
      ok: Boolean(快照?.ok),
      pluginOk: true,
      serviceDown: !快照 || !快照.reachable,
      enabled: api.config.get().enabled,
      pluginVersion: version,
      baseUrl: 快照?.baseUrl || api.config.get().baseUrl,
      lastCheckAt: 状态.lastCheckAt || 0,
      latencyMs: 状态.latencyMs || 快照?.latencyMs || 0,
      ...(快照?.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
      ...(快照?.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
      consecutiveFailures: 状态.consecutiveFailures || 0,
      ...(快照?.lastError ? { lastError: 快照.lastError } : {}),
    })
  })

  // ---------------- 性能指标（输入框状态胶囊轮询） ----------------

  加(`${prefix}/metrics`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    // 服务没起来也返回 200 + ok:false，轮询方按离线分支显示，不刷错误。
    回(res, 200, await 读指标.read())
  })

  // ---------------- 设置页状态 ----------------

  加(`${prefix}/state`, async (_req, res) => {
    const 快照 = await capabilities.refresh({ timeoutMs: 2500 })
    let 音色 = []
    let 音色目录 = ''
    try {
      const 列表 = await api.voices()
      音色 = 列表.map((x) => x.name).filter(Boolean)
      音色目录 = typeof 列表.directory === 'string' ? 列表.directory : ''
    } catch { /* 服务没起时忽略 */ }

    回(res, 200, {
      ok: true,
      plugin: {
        version,
        configFile: configStore.filePath,
        logFile: logger?.filePath || '',
        enabled: 快照 ? api.config.get().enabled : false,
        baseUrl: api.config.get().baseUrl,
      },
      config: api.config.get(),
      health: {
        ok: Boolean(快照.ok),
        reachable: Boolean(快照.reachable),
        compatible: Boolean(快照.compatible),
        checkedAt: 快照.checkedAt,
        latencyMs: 快照.latencyMs,
        ...(快照.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
        ...(快照.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
        ...(快照.vram ? { vram: 快照.vram } : {}),
        consecutiveFailures: 快照.consecutiveFailures,
        ...(快照.lastError ? { lastError: 快照.lastError } : {}),
      },
      capabilities: 快照.capabilities,
      voices: 音色,
      voicesDirectory: 音色目录,
      // 设置页把「留空=默认」的提示词直接显示成占位文字，免得到处翻文档。
      visionDefaults: {
        presets: { ...默认识图提示 },
        session: 默认会话识图提示,
      },
      cache: cache.usage(),
      errors: api.recentErrors(20),
      envOverrides: [...(configStore.overrides || [])],
    })
  })

  // ---------------- 保存配置 ----------------

  加(`${prefix}/save`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const 补丁 = 体 && typeof 体.config === 'object'
      ? 体.config
      : (体 && typeof 体.patch === 'object' ? 体.patch : 体)
    try {
      const 结果 = await api.config.set(补丁 || {})
      回(res, 200, { ...结果, config: api.config.get() })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 500, 包)
    }
  })

  // ---------------- 测试连接 ----------------

  加(`${prefix}/test`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const 超时 = Math.max(500, Math.min(10000, Number(体?.timeoutMs) || 3000))
    const 快照 = await capabilities.refresh({ force: true, timeoutMs: 超时 })
    回(res, 200, {
      ok: 快照.ok,
      reachable: 快照.reachable,
      compatible: 快照.compatible,
      baseUrl: 快照.baseUrl,
      latencyMs: 快照.latencyMs,
      checkedAt: 快照.checkedAt,
      ...(快照.serviceVersion ? { serviceVersion: 快照.serviceVersion } : {}),
      ...(快照.apiVersion ? { apiVersion: 快照.apiVersion } : {}),
      ...(快照.ok ? { capabilities: 快照.capabilities } : {}),
      ...(快照.lastError ? { lastError: 快照.lastError } : {}),
      ...(快照.ok ? {} : {
        code: 快照.lastError?.code || 'service_down',
        hint: 快照.lastError?.hint || '未能连接本地 AI，请确认已启动，并检查填写的地址。',
      }),
    })
  })

  // ---------------- 日志 ----------------

  加(`${prefix}/logs`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 原始 = Number(查询(req).get('lines'))
    const 行数 = Number.isFinite(原始) ? Math.max(1, Math.min(1000, Math.trunc(原始))) : 200
    回(res, 200, { ok: true, lines: logger?.recent(行数) || [] })
  })

  // ---------------- 音色 ----------------

  加(`${prefix}/voices`, async (_req, res) => {
    try {
      const 音色 = await api.voices()
      回(res, 200, { ok: true, voices: 音色 })
    } catch (error) {
      回(res, 200, { ok: false, ...toPublicError(error), voices: [] })
    }
  })

  // ---------------- 翻译（框选文字用） ----------------

  加(`${prefix}/translate`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    const 文本 = String(体.text ?? '').trim()
    if (!文本) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可翻译的文字。' })
      return
    }
    try {
      const 结果 = await api.translate(文本, { source: 体.source, target: 体.target })
      回(res, 200, {
        ok: true,
        text: Array.isArray(结果.texts) ? String(结果.texts[0] || '') : '',
        source: 结果.source,
        target: 结果.target,
        ms: 结果.ms,
      })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 502, { ok: false, ...包 })
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
  加(`${prefix}/translate/batch`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    const 段们 = Array.isArray(体.texts) ? 体.texts : []
    if (!段们.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可翻译的文字。' })
      return
    }
    if (段们.length > 最多翻译段数) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `一次最多翻译 ${最多翻译段数} 段，请分段后再试。`,
      })
      return
    }
    const 条们 = []
    for (const 段 of 段们) {
      if (!段 || typeof 段 !== 'object' || 段.id === undefined || 段.id === null || typeof 段.text !== 'string') {
        回(res, 400, { ok: false, code: 'bad_request', hint: '翻译分段格式不对，刷新页面后再试。' })
        return
      }
      条们.push({ id: 段.id, text: 段.text })
    }
    const 总字数 = 条们.reduce((和, 条) => 和 + 条.text.length, 0)
    if (总字数 > 最多翻译总字数) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `一次最多翻译 ${最多翻译总字数} 字，请分段后再试。`,
      })
      return
    }

    const 结果表 = 条们.map((条) => ({ id: 条.id, translated: '' }))
    const 待翻 = []
    条们.forEach((条, 序) => {
      if (!条.text.trim()) return
      if (条.text.length > 单段翻译字数) {
        结果表[序].error = { code: 'bad_request', hint: `这一段太长了，单段最多 ${单段翻译字数} 字。` }
        return
      }
      待翻.push({ 序, 文本: 条.text })
    })

    if (!待翻.length) {
      回(res, 200, { ok: true, source: 'auto', target: '', engine: 'nllb', ms: 0, results: 结果表 })
      return
    }

    let 翻译
    try {
      翻译 = await api.translate(
        待翻.map((项) => 项.文本),
        { source: 体.source, target: 体.target, batchSize: 体.batchSize, timeoutMs: 体.timeoutMs },
      )
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 502, { ok: false, ...包 })
      return
    }

    const 译文们 = Array.isArray(翻译 && 翻译.texts) ? 翻译.texts : []
    待翻.forEach((项, i) => {
      const 译文 = 译文们[i]
      if (typeof 译文 !== 'string') {
        结果表[项.序].error = { code: 'upstream_error', hint: '这一段没翻好，可以点继续翻译重试。' }
        return
      }
      结果表[项.序].translated = 译文
      结果表[项.序].detectedLang = 检测语言(项.文本) || null
    })

    回(res, 200, {
      ok: true,
      source: (翻译 && 翻译.source) || 'auto',
      target: (翻译 && 翻译.target) || '',
      engine: (翻译 && 翻译.engine) || 'nllb',
      ms: 翻译 && 翻译.ms,
      results: 结果表,
    })
  })

  // ---------------- 翻译（右栏面板用：后台任务队列） ----------------

  /**
   * POST /translate/jobs
   * 入参 { texts: [string], source?, target?, timeoutMs? }
   * 出参 { ok, id, state, source, target, count }
   * 旧版服务没有 /jobs/translate：回 HTTP 200 { ok:false, code:'not_supported' }，面板据此回退同步批量。
   */
  加(`${prefix}/translate/jobs`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    const 文本们 = Array.isArray(体.texts) ? 体.texts : []
    if (!文本们.length || 文本们.some((项) => typeof 项 !== 'string')) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可翻译的文字。' })
      return
    }
    if (文本们.length > 最多翻译段数) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: `一次最多翻译 ${最多翻译段数} 段，请分段后再试。`,
      })
      return
    }
    try {
      const 任务 = await api.translateJobs.submit(文本们, { source: 体.source, target: 体.target })
      回(res, 200, {
        ok: true,
        id: 任务.id,
        state: 任务.state,
        source: 任务.source,
        target: 任务.target,
        count: 任务.count,
      })
    } catch (error) {
      if (error?.code === 'not_implemented') {
        回(res, 200, {
          ok: false,
          code: 'not_supported',
          hint: error.hint || '当前本地 AI 版本较旧，已改用直接翻译。',
        })
        return
      }
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 502, { ok: false, ...包 })
    }
  })

  /** GET /translate/jobs/status?id=任务id → { ok, id, state, progress?, error? } */
  加(`${prefix}/translate/jobs/status`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    try {
      回(res, 200, await api.translateJobs.status(查询(req).get('id')))
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 502, { ok: false, ...包 })
    }
  })

  /** GET /translate/jobs/result?id=任务id → { ok, id, state, texts, source, target, engine, ms? } */
  加(`${prefix}/translate/jobs/result`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    try {
      const 结果 = await api.translateJobs.result(查询(req).get('id'))
      if (!结果.ok) {
        回(res, 200, { ok: false, code: 结果.code || 'not_ready', state: 结果.state, hint: 结果.hint })
        return
      }
      回(res, 200, 结果)
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 502, { ok: false, ...包 })
    }
  })

  /** POST /translate/jobs/cancel 入参 { id }；取消失败也回 200，面板只当「已停止」。 */
  加(`${prefix}/translate/jobs/cancel`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    try {
      回(res, 200, await api.translateJobs.cancel(体.id))
    } catch (error) {
      回(res, 200, { ok: false, ...toPublicError(error) })
    }
  })

  // ---------------- 朗读：清洗 + 分段 + TTS ----------------

  加(`${prefix}/read`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    if (!String(体.text || '').trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const 配置 = api.config.get()
    const { 语音, voice, skipCodeBlocks } = 取朗读分段(体, 配置)
    if (!语音.chunks.length) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息在去掉代码块后没有可朗读的内容。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    const speed = 取语速(体.speed, 配置)
    if (speed === null) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '语速须在 0.5~2.0 之间。' })
      return
    }

    const 并发度 = 数字钳(配置.readConcurrency, 2, 1, 4)
    const 开始 = Date.now()

    // fish.service.tts 单次最多 20 条（契约），这里最多 40 段，按 20 条一批。
    const 批们 = []
    for (let 起点 = 0; 起点 < 语音.chunks.length; 起点 += 20) {
      批们.push({ 起点, 批: 语音.chunks.slice(起点, 起点 + 20) })
    }

    /** 合成一批并按全局段序映射；顺序在批内保持（引擎本身串行）。 */
    const 合成一批 = async ({ 起点, 批 }) => {
      const 结果 = await api.tts(批, {
        ...(voice ? { voice } : {}),
        ...(speed ? { speed } : {}),
        timeoutMs: 配置.requestTimeoutMs,
      })
      return (结果.items || []).map((项, i) => {
        const 全局下标 = 起点 + i
        return {
          wavPath: 项.wavPath,
          url: 音频地址(项.wavPath),
          ms: 项.ms,
          voice: 项.voice,
          bytes: 项.bytes,
          chars: 语音.chunks[全局下标] ? 语音.chunks[全局下标].length : 0,
          cached: Boolean(项.cached),
        }
      })
    }

    let 降级 = false
    try {
      const 结果们 = await 有限并发(批们.map((单位) => async () => {
        try {
          return { ok: true, items: await 合成一批(单位) }
        } catch (error) {
          return { ok: false, error }
        }
      }), 并发度)

      // 并发可能把 localai 队列 / 显存顶满：失败的批在所有并发跑完后单独串行重试一次，
      // 结果仍按段序拼接（items 的顺序不受并发影响）。
      const 失败下标 = 结果们.map((x, i) => (x.ok ? -1 : i)).filter((i) => i >= 0)
      if (失败下标.length && 并发度 > 1) {
        降级 = true
        logger?.warn(`朗读并发合成失败 ${失败下标.length} 批，降级为串行重试`)
        for (const i of 失败下标) {
          try {
            结果们[i] = { ok: true, items: await 合成一批(批们[i]) }
          } catch (error) {
            结果们[i] = { ok: false, error }
          }
        }
      }

      const 第一失败 = 结果们.find((x) => !x.ok)
      if (第一失败) throw 第一失败.error

      const items = 结果们.flatMap((x) => x.items)
      if (!items.length) {
        回(res, 200, { ok: false, code: 'upstream_error', hint: '没有生成出音频，请稍后重试。' })
        return
      }
      const cachedChunks = items.filter((x) => x.cached).length
      回(res, 200, {
        ok: true,
        wavPath: items[0].wavPath,
        ms: Date.now() - 开始,
        items,
        chunks: items.length,
        chars: 语音.chars,
        codeBlocks: 语音.codeBlocks,
        codeLines: 语音.codeLines,
        truncated: 语音.truncated,
        voice: items[0].voice,
        ...(speed ? { speed } : {}),
        concurrency: 并发度,
        cachedChunks,
        cacheHits: cachedChunks,
        ...(降级 ? { degraded: true } : {}),
      })
    } catch (error) {
      // 合成失败是「服务没起 / 显存不够 / 缺模型」这类可展示原因；200 + ok:false 让前端直接念 hint。
      const 包 = toPublicError(error)
      if (包.code !== 'bad_request' && 并发度 > 1) {
        包.hint = `${包.hint || '生成语音失败，请稍后重试。'}（本次同时生成 ${并发度} 段；失败的部分已改为逐段重试，若仍失败，可到设置里把「同时生成」调低。）`
        if (包.error && typeof 包.error === 'object') 包.error = { ...包.error, hint: 包.hint }
      }
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    }
  })

  // ---------------- 流式朗读：分段计划（不合成，立即返回） ----------------

  加(`${prefix}/read/plan`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    if (!String(体.text || '').trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有可朗读的文字。' })
      return
    }

    const 配置 = api.config.get()
    const { 语音, voice, skipCodeBlocks, maxChars } = 取朗读分段(体, 配置)
    if (!语音.chunks.length) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: skipCodeBlocks ? '这条消息在去掉代码块后没有可朗读的内容。' : '这条消息没有可朗读的文字。',
      })
      return
    }

    const speed = 取语速(体.speed, 配置)
    if (speed === null) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '语速须在 0.5~2.0 之间。' })
      return
    }

    回(res, 200, {
      ok: true,
      segments: 语音.chunks.map((text, index) => ({ index, text, chars: text.length })),
      chars: 语音.chars,
      codeBlocks: 语音.codeBlocks,
      codeLines: 语音.codeLines,
      truncated: 语音.truncated,
      voice: voice || 配置.ttsVoice || '',
      ...(speed !== undefined ? { speed } : {}),
      maxChars,
    })
  })

  // ---------------- 流式朗读：单段合成（走 tts()，自动命中缓存） ----------------

  加(`${prefix}/read/segment`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req, 文本上限)
    const 原文 = typeof 体.text === 'string' ? 体.text : ''
    if (!原文.trim()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '这一段的文字为空。' })
      return
    }

    // index 必须是非负整数；给了 total 时还要 < total（越界直接拒绝，不合成）。
    const index = Number(体.index)
    if (!Number.isInteger(index) || index < 0 || index > 最多段数 - 1) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: '朗读分段的序号不正确，请从第一段重新开始。',
      })
      return
    }
    let total
    if (体.total !== undefined && 体.total !== null && 体.total !== '') {
      total = Number(体.total)
      if (!Number.isInteger(total) || total < 1 || total > 最多段数) {
        回(res, 400, { ok: false, code: 'bad_request', hint: `朗读分段的总段数不正确，请重新开始朗读。` })
        return
      }
      if (index >= total) {
        回(res, 400, { ok: false, code: 'bad_request', hint: '朗读分段的序号超出范围，请重新开始朗读。' })
        return
      }
    }

    const 配置 = api.config.get()
    const speed = 取语速(体.speed, 配置)
    if (speed === null) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '语速须在 0.5~2.0 之间。' })
      return
    }
    const voice = String(体.voice || 配置.ttsVoice || '').trim() || undefined
    const 开始 = Date.now()

    try {
      const 结果 = await api.tts([原文], {
        ...(voice ? { voice } : {}),
        ...(speed ? { speed } : {}),
        timeoutMs: 配置.requestTimeoutMs,
      })
      const 项 = (结果.items || [])[0]
      if (!项 || !项.wavPath) {
        回(res, 200, { ok: false, code: 'upstream_error', hint: '这段内容没有生成出音频，请重试。' })
        return
      }
      回(res, 200, {
        ok: true,
        index,
        wavPath: 项.wavPath,
        url: 音频地址(项.wavPath),
        // 命中缓存时 tts() 返回 ms:0；这里保留语义，前端可据此显示「复用」。
        ms: 项.ms !== undefined ? 项.ms : Date.now() - 开始,
        cached: Boolean(项.cached),
        bytes: Number(项.bytes) || 0,
        ...(项.voice ? { voice: 项.voice } : {}),
        ...(speed ? { speed } : {}),
        ...(total ? { total } : {}),
      })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    }
  })

  // ---------------- 缓存统计 / 清空 / 清理 ----------------

  加(`${prefix}/cache/stats`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    if (api.cache && typeof api.cache.stats === 'function') {
      回(res, 200, api.cache.stats())
      return
    }
    // 兜底（测试替身 / 老 api）：只有磁盘用量，没有命中率。
    const 用量 = (cache && typeof cache.usage === 'function' ? cache.usage() : {}) || {}
    const tts = (用量.byKind && 用量.byKind.tts) || {}
    回(res, 200, {
      ok: true,
      kind: 'tts',
      files: Number(tts.files) || 0,
      bytes: Number(tts.bytes) || 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    })
  })

  加(`${prefix}/cache/clear`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const kind = 体.kind === undefined || 体.kind === null || 体.kind === ''
      ? ''
      : String(体.kind).trim().toLowerCase()
    const 允许 = ['tts', 'separate', 'vision', 'tmp', 'voice']
    if (kind && !允许.includes(kind)) {
      回(res, 400, {
        ok: false,
        code: 'bad_request',
        hint: '缓存类型无法识别，请重新选择。',
      })
      return
    }
    try {
      const 结果 = api.cache && typeof api.cache.clear === 'function'
        ? api.cache.clear({ kind })
        : {
            ok: true,
            kind: kind || 'all',
            ...((cache && typeof cache.clear === 'function') ? cache.clear(kind) : { files: 0, bytes: 0, kinds: [] }),
          }
      回(res, 200, 结果)
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 500, 包)
    }
  })

  加(`${prefix}/cache/cleanup`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    try {
      const 结果 = api.cache && typeof api.cache.cleanup === 'function'
        ? api.cache.cleanup()
        : { ok: true, ...((cache && typeof cache.cleanup === 'function') ? cache.cleanup() : {}) }
      回(res, 200, 结果)
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 500, 包)
    }
  })

  // ---------------- 在文件管理器里打开缓存目录 ----------------

  加(`${prefix}/open-folder`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 体 = await 读体(req)
    const 原始 = String(体?.path == null ? '' : 体.path).trim()
    if (!原始) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有指定要打开的文件夹。' })
      return
    }
    if (原始.includes('\0') || !isAbsolutePath(原始)) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '请填写本机绝对路径。' })
      return
    }

    // 只允许打开缓存目录、服务音色目录，或它们里面的子目录；两边都先
    // realpath，这样符号链接/短路径也绕不出去。音色目录每次实时从服务取，
    // 不写进配置，避免配置被改成任意路径。
    const 缓存根 = String(api.config.get().cacheDir || cache?.dirPath || '')
    const 允许根 = []
    try { 允许根.push(realpathSync(缓存根)) } catch { /* 缓存目录还没建好时忽略 */ }
    try {
      const 音色 = await api.voices({ force: true })
      const 目录 = typeof 音色?.directory === 'string' ? 音色.directory.trim() : ''
      if (目录 && isAbsolutePath(目录)) 允许根.push(realpathSync(目录))
    } catch (error) {
      logger?.warn(`取音色目录失败：${error?.message || error}`)
    }
    if (!允许根.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '缓存目录还不存在，请先保存设置。' })
      return
    }
    let 目标实际
    try {
      目标实际 = realpathSync(原始)
    } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '文件夹不存在，请检查路径。' })
      return
    }
    const 小写 = process.platform === 'win32'
    const 同路径 = (左, 右) => (小写 ? 左.toLowerCase() : 左) === (小写 ? 右.toLowerCase() : 右)
    if (!允许根.some((根) => 同路径(根, 目标实际) || isPathInside(根, 目标实际))) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '只能打开缓存目录或音色目录。' })
      return
    }
    let 信息
    try { 信息 = statSync(目标实际) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '文件夹不存在，请检查路径。' })
      return
    }
    if (!信息.isDirectory()) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '这个路径不是文件夹。' })
      return
    }
    if (process.platform !== 'win32') {
      回(res, 200, { ok: false, code: 'not_supported', hint: '暂不支持在系统中打开文件夹。' })
      return
    }

    try {
      const 子进程 = spawn('explorer.exe', [目标实际], { detached: true, stdio: 'ignore' })
      // Windows 上 explorer 会在自己的进程里打开窗口，这里不等待、不留句柄。
      if (子进程 && typeof 子进程.unref === 'function') 子进程.unref()
    } catch (error) {
      logger?.warn(`打开缓存目录失败：${error?.message || error}`)
      回(res, 500, { ok: false, code: 'upstream_error', hint: '无法打开文件夹，请手动打开。' })
      return
    }
    回(res, 200, { ok: true, path: 目标实际 })
  })

  // ---------------- 用系统默认浏览器打开本地服务的管理界面 ----------------

  加(`${prefix}/open-webui`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }

    // 先探测服务：离线时不弹浏览器，直接告诉用户先启动。
    let 健康 = null
    try {
      健康 = await capabilities.refresh({ force: true, timeoutMs: 2000 })
    } catch (error) {
      logger?.warn(`打开管理界面前探测服务失败：${error?.message || error}`)
    }
    if (!健康 || !健康.reachable) {
      回(res, 200, { ok: false, code: 'service_down', hint: '本地 AI 未启动，请先启动后再打开管理界面。' })
      return
    }

    // 只接受带 host 的 http(s) 地址；地址来自本机配置，仍按外部输入校验。
    const 原文 = String(api.config.get()?.baseUrl || '').trim()
    let 地址
    try {
      地址 = new URL(原文)
    } catch {
      回(res, 400, { ok: false, code: 'bad_request', hint: '服务地址格式不正确，请先在设置里修改。' })
      return
    }
    if ((地址.protocol !== 'http:' && 地址.protocol !== 'https:') || !地址.host) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '服务地址格式不正确，请先在设置里修改。' })
      return
    }
    // cmd.exe 会重新解析命令行；地址里出现空白或这些字符就有注入风险，
    // 正常地址用不到，直接拒绝。
    if (/[\s&|^<>"']/.test(地址.href)) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '服务地址格式不正确，请先在设置里修改。' })
      return
    }
    if (platform !== 'win32') {
      回(res, 200, { ok: false, code: 'not_supported', hint: '暂不支持在系统中打开浏览器。' })
      return
    }

    const 目标 = `${地址.href.replace(/\/+$/, '')}/ui`
    try {
      // 用 cmd 的 start：交给系统按默认程序打开 http 地址（explorer 不认 URL）。
      // 空字符串占住「窗口标题」，否则带引号的地址会被 start 当成标题。
      const 子进程 = spawn('cmd.exe', ['/c', 'start', '', 目标], { detached: true, stdio: 'ignore' })
      // 与 explorer 一样不等待；异步失败只记日志，避免变成未捕获异常。
      子进程?.on?.('error', (error) => logger?.warn(`打开管理界面失败：${error?.message || error}`))
      if (子进程 && typeof 子进程.unref === 'function') 子进程.unref()
    } catch (error) {
      logger?.warn(`打开管理界面失败：${error?.message || error}`)
      回(res, 500, { ok: false, code: 'upstream_error', hint: '无法打开浏览器，请手动访问管理界面。' })
      return
    }
    回(res, 200, { ok: true })
  })

  // ---------------- 音频回放（只允许 cacheDir 里的文件） ----------------

  加(`${prefix}/audio`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 路径 = String(查询(req).get('path') || '').trim()
    if (!路径) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '缺少音频文件。' })
      return
    }
    const 缓存根 = String(api.config.get().cacheDir || cache?.dirPath || '')
    // 防目录穿越：解析后必须落在 cacheDir 里，且是已知音频扩展名。
    if (!缓存根 || !isPathInside(缓存根, 路径)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '只能播放缓存目录中的音频。' })
      return
    }
    const 类型 = 音频类型[extname(路径).toLowerCase()]
    if (!类型) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '不支持的音频格式。' })
      return
    }
    let 信息
    try { 信息 = statSync(路径) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在，可能已被清理。' })
      return
    }
    if (!信息.isFile()) {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件不存在。' })
      return
    }
    if (信息.size > 128 * 1024 * 1024) {
      回(res, 413, { ok: false, code: 'bad_request', hint: '音频文件过大，已拒绝。' })
      return
    }
    let 数据
    try { 数据 = readFileSync(路径) } catch {
      回(res, 404, { ok: false, code: 'bad_request', hint: '音频文件无法读取。' })
      return
    }
    回二进制(res, 类型, 数据, basename(路径))
  })

  // ---------------- 语音输入：转文字 ----------------

  加(`${prefix}/transcribe-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 原始 = await 读原始体(req, 上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取音频文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '未收到音频文件。' })
      return
    }
    if (文件.data.length > 最大音频字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 时长 = 读数字字段(解析.fields.durationMs, 0)
    if (时长 > 最大录音毫秒) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '录音超过 5 分钟，请分段录制。' })
      return
    }

    const 配置 = api.config.get()
    const 语言 = 取字符串枚举(解析.fields.language, ['auto', 'zh', 'en', 'ja'], 配置.asrLanguage || 'auto')
    const 扩展 = 取音频扩展(文件.contentType, 文件.filename)

    // 诊断与早退：麦克风没采到声音 / 录音太短时，直接给出可操作提示，别把静音丢给识别。
    logger?.info(`语音输入：收到 ${文件.data.length} 字节，类型 ${文件.contentType || '未知'}，扩展 ${扩展}，时长 ${时长 || 0}ms`)
    if (文件.data.length < 1500) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '没有采集到声音，请检查麦克风是否可用后重试。' })
      return
    }
    if (时长 && 时长 < 300) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '录音太短，请多说几秒再停止。' })
      return
    }

    // 临时文件放在 cacheDir/tmp，请求结束就删（不长期保存用户音频）。
    let 临时 = ''
    try {
      临时 = cache.saveBuffer('tmp', 文件.data, { ext: 扩展, name: `${randomUUID()}${扩展}` })
    } catch (error) {
      回(res, 500, { ok: false, code: 'upstream_error', hint: '录音处理失败，请稍后重试。' })
      return
    }

    const 开始 = Date.now()
    let 保留排查 = false
    try {
      const 结果 = await api.asr(临时, { language: 语言, timeoutMs: 配置.asrTimeoutMs })
      const 项 = (结果.items && 结果.items[0]) || {}
      const 识别文本 = String(项.text || '')
      logger?.info(`语音输入：识别结果 ${识别文本.length} 字（${文件.data.length} 字节 / ${时长 || 0}ms），耗时 ${项.elapsedMs ?? '?'}ms，文本「${识别文本.slice(0, 20)}」`)
      // 识别结果异常短（正常一句话至少 3 个字）时保留录音，便于排查麦克风/格式问题。
      if (识别文本.trim().length < 3 && 文件.data.length > 0) {
        保留排查 = true
        logger?.warn(`语音输入：识别结果异常短，已保留录音用于排查：${临时}`)
      }
      回(res, 200, {
        ok: true,
        text: String(项.text || ''),
        ms: Date.now() - 开始,
        ...(项.elapsedMs !== undefined ? { elapsedMs: 项.elapsedMs } : {}),
        ...(项.language ? { language: 项.language } : { language: 语言 }),
        bytes: 文件.data.length,
      })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    } finally {
      if (!保留排查) {
        try { if (临时) rmSync(临时, { force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
      }
    }
  })

  // ---------------- 语音输入：保留语音（存到 cacheDir/voice） ----------------

  加(`${prefix}/voice-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    const 原始 = await 读原始体(req, 上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取音频文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '未收到音频文件。' })
      return
    }
    if (文件.data.length > 最大音频字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `录音过大（超过 ${Math.round(最大音频字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 时长 = 读数字字段(解析.fields.durationMs, 0)
    if (时长 > 最大录音毫秒) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '录音超过 5 分钟，请分段录制。' })
      return
    }
    const 扩展 = 取音频扩展(文件.contentType, 文件.filename)
    const 名称 = `${randomUUID()}${扩展}`
    let 路径 = ''
    try {
      路径 = cache.saveBuffer('voice', 文件.data, { ext: 扩展, name: 名称 })
    } catch (error) {
      回(res, 500, { ok: false, code: 'upstream_error', hint: '音频保存失败，请稍后重试。' })
      return
    }
    回(res, 200, {
      ok: true,
      path: 路径,
      name: 名称,
      bytes: 文件.data.length,
      mime: 文件.contentType,
      ...(时长 ? { durationMs: 时长 } : {}),
    })
  })

  // ---------------- 本地识图：图片 → 文字 ----------------
  // 设置页/会话里「本地识图」按钮用：浏览器把图片上传过来，宿主存成临时文件后
  // 调本机视觉模型，返回一段文字，临时文件随即删掉（不长期保存用户图片）。

  加(`${prefix}/describe-upload`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    if (!同源(req)) {
      回(res, 403, { ok: false, code: 'bad_request', hint: '请求来源不受信任，已拒绝。' })
      return
    }
    if (api.visionPrefs && api.visionPrefs().localDescribe === false) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '本地识图已关闭，可在本地 AI 设置里打开。' })
      return
    }
    const 原始 = await 读原始体(req, 图片上传上限)
    if (原始.over) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `图片过大（超过 ${Math.round(最大图片字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 解析 = 解析multipart(原始.buffer, req?.headers?.['content-type'])
    const 文件 = 取图片文件(解析)
    if (!文件 || !文件.data.length) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '未收到图片。' })
      return
    }
    if (文件.data.length > 最大图片字节) {
      回(res, 413, { ok: false, code: 'bad_request', hint: `图片过大（超过 ${Math.round(最大图片字节 / 1024 / 1024)}MB），已拒绝。` })
      return
    }
    const 扩展 = 取图片扩展(文件.contentType, 文件.filename)
    if (!扩展) {
      回(res, 400, { ok: false, code: 'bad_request', hint: '只支持 JPG / PNG / WebP / GIF / BMP 图片。' })
      return
    }
    const 模式 = 取字符串枚举(解析.fields.mode, ['caption', 'score', 'ocr'], 'caption')
    // 范围：session = 会话识图按钮（固定用会话识图提示词）；tool = 工具识图（按档位）。
    // 档位：显式 preset 优先；ocr 固定「只看文字」档；缺省或非法值用配置默认档。
    const 偏好 = typeof api.visionPrefs === 'function' ? (api.visionPrefs() || {}) : {}
    const 默认档 = 规范档位(偏好.visionDefaultPreset)
    const 范围 = String(解析.fields.scope ?? '').trim().toLowerCase() === 'session' ? 'session' : 'tool'
    const 档位 = 模式 === 'ocr' ? 'text' : 取字符串枚举(解析.fields.preset, 识图档位, 默认档)

    let 临时 = ''
    try {
      临时 = cache.saveBuffer('tmp', 文件.data, { ext: 扩展, name: `${randomUUID()}${扩展}` })
    } catch {
      回(res, 500, { ok: false, code: 'upstream_error', hint: '图片处理失败，请稍后重试。' })
      return
    }

    const 开始 = Date.now()
    try {
      const 结果 = await api.visionDescribe(临时, 范围 === 'session'
        ? { mode: 模式, scope: 'session' }
        : { mode: 模式, preset: 档位 })
      const 项 = (结果.items && 结果.items[0]) || {}
      回(res, 200, {
        ok: true,
        text: String(项.text || ''),
        mode: 模式,
        scope: 范围,
        ...(范围 === 'session' ? {} : { preset: 档位 }),
        ms: Date.now() - 开始,
        bytes: 文件.data.length,
      })
    } catch (error) {
      const 包 = toPublicError(error)
      回(res, 包.code === 'bad_request' ? 400 : 200, 包)
    } finally {
      try { if (临时) rmSync(临时, { force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
    }
  })

  return () => {
    for (const 函数 of 摘.splice(0)) {
      try { 函数() } catch { /* 已卸载 */ }
    }
  }
}

export { 默认前缀 }
