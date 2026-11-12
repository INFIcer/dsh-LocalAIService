// fish.service 的实现：按 CONTRACT.md 第 1 节暴露统一门面。
//
// 这里是「服务方法」层，不含 DSH 工具参数校验（那在 lib/tools/），
// 也不含宿主路由（在 lib/routes.js）。所有方法内部抛 FishServiceError，
// 工具层负责转成 {ok:false, code, hint}。

import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import {
  FishServiceError,
  makeError,
  modelMissingHint,
  timeoutHint,
} from './errors.js'
import { emptyCapabilities } from './capabilities.js'
import { normalizeAutoReadSessions, normalizeRecordDeviceId } from './config.js'
import { parseTranslationLanguage } from './lang.js'
import { isSilentSpeech, stripMarkdown } from './speech.js'
import { ttsFriendly } from './tts-text.js'
import { isAbsolutePath, sha16 } from './fs-util.js'
import {
  mergeVisionPresets,
  defaultSessionVisionPrompt,
  fetchPresetPrompt,
  normalizePreset,
  detectPreset,
  visionPromptLimit,
} from './vision-presets.js'

const maxUploadMB = 200
/** 本机已有的媒体文件不是上传，长片（几 GB）也要能处理。 */
const localMediaMaxMB = 20 * 1024
const maxTextChars = 5000
const maxTranslationEntryCount = 500
const maxTranslationTotalChars = 200000
const TTS_Language = ['auto', 'zh', 'en', 'ja', 'es', 'ar']
const ASR_Language = ['auto', 'zh', 'en', 'ja', 'ko', 'yue', 'nospeech']
const ASR_Engine = ['auto', 'sensevoice', 'whisper']
const separateModel = ['htdemucs', 'htdemucs_6s', 'htdemucs_ft']
const separateStem = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']
const taskKind = ['tts', 'asr', 'separate', 'translate', 'download', 'analyze', 'vision']
const taskStatus = ['queued', 'running', 'done', 'failed', 'canceled']
const effortPreset = ['auto', 'low', 'medium', 'high']
const planEr = ['hybrid', 'agent']
const subtitlePreset = ['auto', 'off']
const imageExtName = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const visualMode = ['caption', 'score', 'ocr']
/** 识图范围：tool = 工具识图（按档位）；session = 会话识图（按钮，用单独一项提示词）。 */
const visionRange = ['tool', 'session']

/** 音色数组上挂非枚举的 directory，保持 voices() 返回数组的旧契约。 */
function withDir(list, directory) {
  const result = Array.isArray(list) ? list.slice() : []
  Object.defineProperty(result, 'directory', {
    value: typeof directory === 'string' ? directory : '',
    enumerable: false,
    configurable: true,
  })
  return result
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const decodeHeader = (value) => {
  if (value == null) return undefined
  try { return decodeURIComponent(String(value)) } catch { return String(value) }
}

function interruptibleSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', abort)
      resolve()
    }, Math.max(0, ms))
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal?.addEventListener?.('abort', abort, { once: true })
  })
}

const isText = (value) => typeof value === 'string'

function normalizeTextArray(input, { label = 'texts', max = 20 } = {}) {
  const array = isText(input) ? [input] : (Array.isArray(input) ? input.slice() : null)
  if (!array) {
    throw makeError('bad_request', { detail: `${label} 必须是字符串或字符串数组`, hint: '请求参数有误：文本须为字符串或字符串数组。' })
  }
  if (array.length === 0) {
    throw makeError('bad_request', { detail: `${label} 不能为空`, hint: '请求参数有误：至少需要一条文本。' })
  }
  if (array.length > max) {
    throw makeError('bad_request', {
      detail: `${label} 一次最多 ${max} 条，收到 ${array.length} 条`,
      hint: `请求参数有误：一次最多 ${max} 条，请分批处理。`,
    })
  }
  for (const item of array) {
    if (!isText(item)) {
      throw makeError('bad_request', { detail: `${label} 里有非字符串`, hint: '请求参数有误：文本数组中的每一项都必须是字符串。' })
    }
  }
  return array
}

function normalizeFileArray(input, { label = 'files', max = 10 } = {}) {
  const array = isText(input) ? [input] : (Array.isArray(input) ? input.slice() : null)
  if (!array) {
    throw makeError('bad_request', { detail: `${label} 必须是路径或路径数组`, hint: '请求参数有误：文件须为本机绝对路径。' })
  }
  if (array.length === 0) {
    throw makeError('bad_request', { detail: `${label} 不能为空`, hint: '请求参数有误：至少需要一个文件。' })
  }
  if (array.length > max) {
    throw makeError('bad_request', {
      detail: `${label} 一次最多 ${max} 个，收到 ${array.length} 个`,
      hint: `请求参数有误：一次最多 ${max} 个文件，请分批处理。`,
    })
  }
  return array
}

function checkLocalFile(path, { label = '文件', maxMB = maxUploadMB } = {}) {
  const value = String(path == null ? '' : path)
  if (!value || !isAbsolutePath(value)) {
    throw makeError('bad_request', { detail: `${label} 不是绝对路径：${value}`, hint: `请求参数有误：${label}须为本机绝对路径。` })
  }
  if (!existsSync(value)) {
    throw makeError('bad_request', { detail: `${label} 不存在：${value}`, hint: `请求参数有误：找不到${label}。` })
  }
  let info
  try { info = statSync(value) } catch {
    throw makeError('bad_request', { detail: `${label} 读不到：${value}`, hint: `请求参数有误：${label}无法读取。` })
  }
  if (!info.isFile()) {
    throw makeError('bad_request', { detail: `${label} 不是文件：${value}`, hint: `请求参数有误：${label}必须是文件。` })
  }
  if (info.size > maxMB * 1024 * 1024) {
    throw makeError('bad_request', {
      detail: `${label} ${(info.size / 1024 / 1024).toFixed(1)}MB，超过 ${maxMB}MB`,
      hint: `请求参数有误：${label}超过 ${maxMB}MB，请先裁剪或压缩。`,
    })
  }
  return info
}

const fetchInt = (value, label, min, max, fallback) => {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw makeError('bad_request', {
      detail: `${label}=${value} 不在 ${min}~${max}`,
      hint: `请求参数有误：${label}须为 ${min}~${max} 之间的整数。`,
    })
  }
  return n
}

const fetchEnum = (value, label, allow, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  if (!allow.includes(value)) {
    throw makeError('bad_request', {
      detail: `${label}=${value} 不在 ${allow.join('/')}`,
      hint: `请求参数有误：${label}只能取 ${allow.join(' / ')}。`,
    })
  }
  return value
}

const fetchTimeout = (value, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1000, Math.min(1800000, Math.round(n)))
}

/** 把普通错误包装成 FishServiceError（保留 code/hint/detail）。 */
function toServiceError(error, capability = '') {
  if (error instanceof FishServiceError) return error
  const code = error?.code || 'upstream_error'
  return new FishServiceError(code, {
    detail: error?.detail || error?.message || String(error || ''),
    hint: error?.hint || '',
    capability: error?.capability || capability,
  })
}

export function createFishServiceApi({
  ctx = null,
  configStore,
  client,
  capabilities: capabilityService,
  cache,
  logger = null,
  version = '0.1.0',
  onConfigChange = null,
} = {}) {
  const fetchConfig = () => configStore.current
  const event = capabilityService.events
  const recentError = []
  let recentErrorEntry = null
  const errorThrottle = new Map()
  let voiceCache = null

  // ---------------- TTS 缓存统计 ----------------
  //
  // 只在服务层内存里计数，**不扫盘**：
  //   - hits：findByKey 直接命中的段数；misses：真正发起 /tts 的段数；
  //   - files/bytes：本进程写入或命中过的不同 wav（用 Map 去重，同一文件只算一次）。
  // 进程重启后计数归零；files/bytes 也不代表磁盘上的全部历史产物（那是 /state 的缓存用量）。
  const ttsCache = {
    hits: 0,
    misses: 0,
    files: new Map(), // wavPath → bytes
  }

  function rememberCacheFile(path, byteCount) {
    if (!path) return
    const size = Number(byteCount) || 0
    // 命中老文件时也要记进去；同一路径重复命中不能重复累计。
    if (!ttsCache.files.has(path) || ttsCache.files.get(path) !== size) ttsCache.files.set(path, size)
  }

  /** 清掉内存账本里已经不存在的文件（清理/清空之后调用，按账本逐个 existsSync，不扫目录）。 */
  function syncCacheLedger() {
    for (const path of [...ttsCache.files.keys()]) {
      try { if (!existsSync(path)) ttsCache.files.delete(path) } catch { /* 读不到就当不存在 */ }
    }
  }

  function cacheStats() {
    let bytes = 0
    for (const size of ttsCache.files.values()) bytes += size
    const totalCount = ttsCache.hits + ttsCache.misses
    return {
      ok: true,
      kind: 'tts',
      files: ttsCache.files.size,
      bytes,
      hits: ttsCache.hits,
      misses: ttsCache.misses,
      // 0~1 的小数（不是百分比），UI 自己乘 100。
      hitRate: totalCount > 0 ? Math.round((ttsCache.hits / totalCount) * 10000) / 10000 : 0,
    }
  }

  function rememberError(error, capability = '') {
    const err = toServiceError(error, capability)
    recentErrorEntry = {
      code: err.code,
      hint: err.hint,
      detail: err.detail,
      capability: err.capability || capability,
      at: new Date().toISOString(),
    }
    recentError.push(recentErrorEntry)
    if (recentError.length > 20) recentError.shift()

    const now = Date.now()
    const lastTime = errorThrottle.get(err.code) || 0
    if (now - lastTime >= 5000) {
      errorThrottle.set(err.code, now)
      // EventEmitter 的 'error' 事件没有监听者时会抛异常；事件是尽力而为，不能影响主流程。
      if ((event.listenerCount?.('error') || 0) > 0) {
        event.emit('error', {
          code: err.code,
          capability: err.capability || capability || undefined,
          detail: err.detail,
          at: recentErrorEntry.at,
        })
      }
    }
    logger?.warn(`${err.code}: ${err.detail || err.hint}`)
    return err
  }

  function fail(code, opts = {}) {
    // 只抛；记录交给外面的 guard()，避免同一条错误记两遍。
    throw makeError(code, opts)
  }

  function assertEnabled() {
    if (fetchConfig()?.enabled === false) {
      fail('service_not_installed', {
        detail: 'enabled=false',
        hint: '本地 AI 已停用，请到「设置 → 插件 → 本地 AI」打开总开关。',
      })
    }
  }

  /** 门禁 + 错误记录。 */
  async function requestCapability(name) {
    assertEnabled()
    const result = await capabilityService.require(name)
    if (!result.ok) {
      rememberError(result.error, name)
      throw result.error
    }
    return result.info
  }

  /** 统一包一层：失败时失效能力缓存（507/503 后不要继续显示旧的 ready）。 */
  async function guard(capability, fn) {
    try {
      return await fn()
    } catch (error) {
      const err = toServiceError(error, capability)
      if (['vram_exhausted', 'service_down', 'model_missing', 'upstream_error', 'timeout'].includes(err.code)) {
        capabilityService.invalidate()
      }
      rememberError(err, capability)
      throw err
    }
  }

  // ---------------- TTS ----------------

  async function tts(input, opts = {}) {
    return guard('tts', async () => {
      assertEnabled()
      const config = fetchConfig()
      const textS = normalizeTextArray(input, { label: 'texts', max: 20 })
      // 朗读化只在这里做一次：/read、/read/segment、fish_tts 工具、别的插件调 service.tts
      // 都走这个入口。各调用方自己再改写一遍会重复叠加、读法还会漂移。
      // 先清洗 Markdown（代码块与行内代码统一读成「巴拉巴拉」），再转中文读法；
      // 两步都幂等，prepareSpeech 已经改写过的分段再进来结果不变。
      const spoken = textS.map((text) => {
        const cleaned = ttsFriendly(stripMarkdown(text).text)
        return isSilentSpeech(cleaned) ? '' : cleaned
      })
      // 长度按改写后的文本算：数字读成汉字、单位翻译都会变长，按原文长度放行会超上游上限。
      for (const [index, text] of spoken.entries()) {
        if (text.length === 0) {
          fail('bad_request', {
            detail: `第 ${index + 1} 条朗读化后为空`,
            hint: '请求参数有误：文本去掉 Markdown 标记和代码后没有可朗读的内容。',
          })
        }
        if (text.length > maxTextChars) {
          fail('bad_request', {
            detail: `第 ${index + 1} 条朗读化后 ${text.length} 字，超过 ${maxTextChars}`,
            hint: `请求参数有误：单条文本朗读化后最多 ${maxTextChars} 字（数字与单位会读成汉字，比原文长），请分段。`,
          })
        }
      }

      const voice = String(opts.voice || config.ttsVoice || 'dafeiyu')
      const speed = opts.speed === undefined ? undefined : Number(opts.speed)
      if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) {
        fail('bad_request', { detail: `speed=${opts.speed}`, hint: '请求参数有误：语速须在 0.5~2.0 之间。' })
      }
      const language = fetchEnum(opts.language, 'language', TTS_Language, 'auto')
      const seed = opts.seed === undefined || opts.seed === null
        ? undefined
        : fetchInt(opts.seed, 'seed', 0, 4294967295, undefined)
      const timeoutMs = fetchTimeout(opts.timeoutMs, config.requestTimeoutMs)

      await requestCapability('tts')

      const items = []
      const begin = Date.now()
      for (const text of spoken) {
        const body = { text, voice }
        if (speed !== undefined) body.speed = speed
        if (language && language !== 'auto') body.language = language
        if (seed !== undefined) body.seed = seed
        if (opts.emotion) body.emotion = String(opts.emotion)

        const cacheTag = body.seed !== undefined ? body.seed : 'auto'
        // key 只由「文本 + 音色 + 语速 + 情绪 + seed」组成，不含 ms / 时间：
        // 同一组参数重复朗读会稳定命中；换音色/语速/情绪会重新合成。
        const key = sha16(JSON.stringify([body.text, body.voice, body.speed, body.emotion, cacheTag]))

        // 无论有没有 seed 都查缓存：自动朗读 / 普通调用不传 seed，也必须复用上一次的音频。
        const existing = cache.findByKey('tts', key)
        if (existing && existsSync(existing)) {
          let bytes = 0
          try { bytes = statSync(existing).size } catch { bytes = 0 }
          ttsCache.hits += 1
          rememberCacheFile(existing, bytes)
          items.push({
            wavPath: existing,
            ms: 0,
            voice,
            ...(body.seed !== undefined ? { seed: body.seed } : {}),
            ...(language && language !== 'auto' ? { language } : {}),
            bytes,
            cached: true,
          })
          continue
        }

        ttsCache.misses += 1
        const response = await client.postBinary('/tts', body, {
          timeoutMs,
          capability: 'tts',
          capabilityReady: true,
        })
        const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data)
        const headersSeed = response.headers?.get?.('x-seed')
        const actualSeed = headersSeed !== null && headersSeed !== undefined && headersSeed !== '' ? Number(headersSeed) : undefined
        const actualLanguage = decodeHeader(response.headers?.get?.('x-language'))
        const path = cache.saveBuffer('tts', buffer, { ext: '.wav', key, ts: Date.now() })
        rememberCacheFile(path, buffer.length)
        items.push({
          wavPath: path,
          ms: response.ms,
          voice,
          seed: Number.isInteger(actualSeed) ? actualSeed : (body.seed ?? 0),
          ...(actualLanguage ? { language: actualLanguage } : (language && language !== 'auto' ? { language } : {})),
          bytes: buffer.length,
          cached: false,
          ...(opts.returnBuffer ? { buffer: buffer } : {}),
        })
      }

      return { ok: true, items, ms: Date.now() - begin }
    })
  }

  // ---------------- ASR ----------------

  function mapPiece(segments) {
    if (!Array.isArray(segments)) return undefined
    const normalize = segments.map((x) => ({
      start: Number(x?.start) || 0,
      end: Number(x?.end) || 0,
      text: String(x?.text || ''),
    }))
    if (normalize.length <= 200) return normalize
    return [...normalize.slice(0, 100), ...normalize.slice(-100)]
  }

  async function asr(input, opts = {}) {
    return guard('asr', async () => {
      assertEnabled()
      const config = fetchConfig()
      const fileS = normalizeFileArray(input, { label: 'files', max: 10 })
      for (const file of fileS) checkLocalFile(file, { label: '音频文件' })

      const language = fetchEnum(opts.language, 'language', ASR_Language, 'auto')
      const engine = fetchEnum(opts.engine, 'engine', ASR_Engine, 'auto')
      const timestamps = opts.timestamps === true
      const timeoutMs = fetchTimeout(opts.timeoutMs, config.asrTimeoutMs)

      await requestCapability('asr')

      const items = []
      const begin = Date.now()
      for (const file of fileS) {
        const fields = {
          ...(language && language !== 'auto' ? { language } : {}),
          ...(engine && engine !== 'auto' ? { engine } : {}),
          ...(timestamps ? { timestamps: '1' } : {}),
        }
        const path = timestamps ? '/asr/segments' : '/asr'
        const response = await client.postMultipart(path, {
          fields,
          files: [{ field: 'file', path: file }],
          timeoutMs,
          capability: 'asr',
          capabilityReady: true,
        })
        const responseBody = response.data || {}
        if (responseBody.ok === false) {
          fail('upstream_error', {
            detail: String(responseBody.detail || responseBody.error || 'asr failed'),
            hint: '转写未能完成，请稍后重试。',
            capability: 'asr',
          })
        }

        const piece = mapPiece(responseBody.segments)
        const accumulate = {
          file: file,
          text: String(responseBody.text || ''),
          ...(responseBody.language ? { language: String(responseBody.language) } : {}),
          ...(responseBody.engine ? { engine: String(responseBody.engine) } : {}),
          ...(responseBody.emotion ? { emotion: String(responseBody.emotion) } : {}),
          ...(Array.isArray(responseBody.events) && responseBody.events.length > 0
            ? { events: responseBody.events.map((x) => String(x)) }
            : {}),
          ...(responseBody.duration != null ? { durationMs: Math.round(Number(responseBody.duration) * 1000) } : {}),
          ...(responseBody.elapsed_ms != null ? { elapsedMs: Number(responseBody.elapsed_ms) } : {}),
          ...(piece ? { segments: piece } : {}),
          ...(Array.isArray(responseBody.segments) && responseBody.segments.length > 200 ? { truncated: true } : {}),
        }
        items.push(accumulate)
      }

      return { ok: true, items, ms: Date.now() - begin }
    })
  }

  // ---------------- 翻译 ----------------

  async function translate(input, opts = {}) {
    return guard('translate', async () => {
      assertEnabled()
      const config = fetchConfig()
      const textS = normalizeTextArray(input, { label: 'texts', max: maxTranslationEntryCount })
      const explicitTarget = String(opts.target || '').trim()
      if (explicitTarget.toLowerCase() === 'auto') {
        fail('bad_request', { detail: 'target 不能为 auto', hint: '请求参数有误：目标语言不能为 auto。' })
      }
      // 没有显式 target 时按第一/第二语言自动选择；source 也由同一次检测给出。
      const language = parseTranslationLanguage({
        text: textS.find((x) => x.length > 0) || '',
        source: opts.source,
        target: explicitTarget,
        primaryLanguage: config.primaryLanguage,
        secondaryLanguage: config.secondaryLanguage,
      })
      const target = language.target
      const source = language.source
      let totalChars = 0
      for (const text of textS) {
        totalChars += text.length
        if (text.length > maxTextChars) {
          fail('bad_request', { detail: `单条文本 ${text.length} 字`, hint: `请求参数有误：单条文本最多 ${maxTextChars} 字。` })
        }
      }
      if (totalChars > maxTranslationTotalChars) {
        fail('bad_request', {
          detail: `总字数 ${totalChars}，超过 ${maxTranslationTotalChars}`,
          hint: `请求参数有误：一次最多 ${maxTranslationTotalChars} 字，请分批处理。`,
        })
      }
      const timeoutMs = fetchTimeout(opts.timeoutMs, 60000)
      const batchSize = opts.batchSize === undefined ? 8 : fetchInt(opts.batchSize, 'batchSize', 1, 16, 8)

      await requestCapability('translate')
      const begin = Date.now()

      // 契约：空字符串原样返回，不发给服务端；顺序必须和输入严格一致。
      const nonEmpty = []
      const nonEmptyIndex = []
      textS.forEach((text, sub) => {
        if (text.length > 0) {
          nonEmpty.push(text)
          nonEmptyIndex.push(sub)
        }
      })
      if (nonEmpty.length === 0) {
        return {
          ok: true,
          texts: textS.map(() => ''),
          source,
          target,
          engine: 'nllb',
          ms: Date.now() - begin,
        }
      }

      if (textS.length === 1) {
        const response = await client.postJson('/translate', {
          text: nonEmpty[0],
          source,
          target,
          batch_size: batchSize,
        }, { timeoutMs, capability: 'translate', capabilityReady: true })
        const responseBody = response.data || {}
        return {
          ok: true,
          texts: [String(responseBody.text ?? '')],
          source: String(responseBody.source || source),
          target: String(responseBody.target || target),
          engine: 'nllb',
          ms: Date.now() - begin,
          ...(responseBody.chunks != null ? { chunks: Number(responseBody.chunks) } : {}),
        }
      }

      const response = await client.postJson('/translate/batch', {
        texts: nonEmpty,
        source,
        target,
        batch_size: batchSize,
      }, { timeoutMs, capability: 'translate', capabilityReady: true })
      const responseBody = response.data || {}
      const serverResult = Array.isArray(responseBody.texts) ? responseBody.texts.map((x) => String(x ?? '')) : []
      const result = textS.map(() => '')
      nonEmptyIndex.forEach((origSub, seq) => {
        result[origSub] = serverResult[seq] ?? ''
      })
      return {
        ok: true,
        texts: result,
        source: String(responseBody.source || source),
        target: String(responseBody.target || target),
        engine: 'nllb',
        ms: Date.now() - begin,
        ...(responseBody.chunks != null ? { chunks: Number(responseBody.chunks) } : {}),
      }
    })
  }

  /**
   * 右栏面板的「后台翻译任务」：提交 → 轮询 → 取结果，避免同步接口被 60 秒超时掐断。
   * 上游契约：POST /jobs/translate、GET /jobs/{id}、GET /jobs/{id}/result、
   * POST /jobs/{id}/cancel（旧版服务没有 /jobs/translate，提交时抛 not_supported 供上层回退）。
   */
  const translateJobs = {
    async submit(input, opts = {}) {
      return guard('translate', async () => {
        assertEnabled()
        const config = fetchConfig()
        const textS = normalizeTextArray(input, { label: 'texts', max: maxTranslationEntryCount })
        const explicitTarget = String(opts.target || '').trim()
        if (explicitTarget.toLowerCase() === 'auto') {
          fail('bad_request', { detail: 'target 不能为 auto', hint: '请求参数有误：目标语言不能为 auto。' })
        }
        const language = parseTranslationLanguage({
          text: textS.find((x) => x.length > 0) || '',
          source: opts.source,
          target: explicitTarget,
          primaryLanguage: config.primaryLanguage,
          secondaryLanguage: config.secondaryLanguage,
        })
        const source = language.source
        const target = language.target
        let totalChars = 0
        for (const text of textS) {
          totalChars += text.length
          if (text.length > maxTextChars) {
            fail('bad_request', { detail: `单条文本 ${text.length} 字`, hint: `请求参数有误：单条文本最多 ${maxTextChars} 字。` })
          }
        }
        if (totalChars > maxTranslationTotalChars) {
          fail('bad_request', {
            detail: `总字数 ${totalChars}，超过 ${maxTranslationTotalChars}`,
            hint: `请求参数有误：一次最多 ${maxTranslationTotalChars} 字，请分批处理。`,
          })
        }
        await requestCapability('translate')
        try {
          const response = await client.postJson('/jobs/translate', { texts: textS, source, target }, {
            timeoutMs: fetchTimeout(opts.timeoutMs, 30000),
            capability: 'translate',
            capabilityReady: true,
          })
          const responseBody = response.data || {}
          if (!responseBody.id) {
            fail('upstream_error', { detail: '服务没有返回任务 id', hint: '提交翻译任务失败，请稍后重试。' })
          }
          return {
            ok: true,
            id: String(responseBody.id),
            state: String(responseBody.state || 'queued'),
            source,
            target,
            count: textS.length,
          }
        } catch (error) {
          const err = toServiceError(error, 'translate')
          // 旧版服务没有任务接口：交给上层回退到 /translate/batch。
          if (err.httpStatus === 404 || err.httpStatus === 405) {
            fail('not_implemented', {
              detail: `服务不支持后台翻译任务（HTTP ${err.httpStatus}）`,
              hint: '当前本地 AI 版本较旧，已改用直接翻译。',
            })
          }
          throw err
        }
      })
    },

    async status(id, opts = {}) {
      return guard('translate', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        const response = await client.getJson(`/jobs/${encodeURIComponent(taskId)}`, {
          timeoutMs: fetchTimeout(opts.timeoutMs, 15000),
          capability: 'jobs',
          capabilityReady: true,
        })
        const record = mapTask(taskId, response.data)
        return {
          ok: true,
          id: record.id,
          state: record.state,
          ...(record.progress ? { progress: record.progress } : {}),
          ...(record.error ? { error: record.error } : {}),
        }
      })
    },

    async result(id, opts = {}) {
      return guard('translate', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        try {
          const response = await client.getJson(`/jobs/${encodeURIComponent(taskId)}/result`, {
            timeoutMs: fetchTimeout(opts.timeoutMs, 30000),
            capability: 'jobs',
            capabilityReady: true,
          })
          const responseBody = response.data || {}
          const inner = responseBody.result && typeof responseBody.result === 'object' ? responseBody.result : {}
          return {
            ok: true,
            id: String(responseBody.id || taskId),
            state: String(responseBody.state || 'done'),
            texts: Array.isArray(inner.texts) ? inner.texts.map((x) => String(x ?? '')) : [],
            source: inner.source ? String(inner.source) : '',
            target: inner.target ? String(inner.target) : '',
            engine: inner.engine ? String(inner.engine) : 'nllb',
            ...(inner.elapsed_ms != null ? { ms: Number(inner.elapsed_ms) } : {}),
          }
        } catch (error) {
          const err = toServiceError(error, 'translate')
          if (err.httpStatus === 409) {
            return { ok: false, id: taskId, state: 'not_done', code: 'not_ready', hint: '翻译还没完成，请稍后再取。' }
          }
          throw err
        }
      })
    },

    /** 取消只尽力而为：任务已终态/服务不支持都当成功，不阻塞面板停止。 */
    async cancel(id) {
      return guard('translate', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        try {
          return await jobs.cancel(taskId)
        } catch (error) {
          const err = toServiceError(error, 'translate')
          if (err.code === 'canceled') return { ok: true, id: taskId, state: 'canceled', cancelRequested: false }
          return { ok: false, id: taskId, code: err.code, hint: err.hint }
        }
      })
    },
  }

  // ---------------- 人声分离 ----------------

  async function separate(file, opts = {}) {
    return guard('separate', async () => {
      assertEnabled()
      const config = fetchConfig()
      checkLocalFile(file, { label: '音频/视频文件', maxMB: localMediaMaxMB })
      const model = fetchEnum(opts.model, 'model', separateModel, 'htdemucs')
      const stems = Array.isArray(opts.stems) && opts.stems.length ? opts.stems.map(String) : ['vocals', 'drums', 'bass', 'other']
      for (const stem of stems) {
        if (!separateStem.includes(stem)) {
          fail('bad_request', { detail: `未知 stem：${stem}`, hint: `请求参数有误：音轨只能是 ${separateStem.join(' / ')}。` })
        }
      }
      const timeoutMs = fetchTimeout(opts.timeoutMs, config.asrTimeoutMs)
      await requestCapability('separate')

      const begin = Date.now()
      const response = await client.postMultipart('/separate', {
        fields: { model, stems: stems.join(',') },
        files: [{ field: 'file', path: file }],
        timeoutMs,
        capability: 'separate',
        capabilityReady: true,
      })
      const responseBody = response.data || {}
      if (!responseBody.stems || typeof responseBody.stems !== 'object') {
        fail('upstream_error', { detail: '服务未返回分离结果', hint: '分离未返回结果，请稍后重试。', capability: 'separate' })
      }

      const dir = cache.makeJobDir('separate')
      const result = {}
      for (const [stem, info] of Object.entries(responseBody.stems)) {
        const source = String(info?.path || '')
        if (!source || !existsSync(source)) continue
        const ext = extname(source) || '.wav'
        const target = cache.copyIn('separate', source, {
          subdir: dir.split(/[\\/]/).pop(),
          name: `${stem}${ext}`,
        })
        if (!target) continue
        result[stem] = {
          path: target,
          ...(info?.duration != null ? { duration: Number(info.duration) } : {}),
        }
      }
      if (!Object.keys(result).length) {
        fail('upstream_error', { detail: '没有可复制的 stem', hint: '分离已完成，但未能读取音轨文件，请重试。', capability: 'separate' })
      }

      const release = Array.isArray(responseBody.released_models) ? responseBody.released_models : (Array.isArray(responseBody.released) ? responseBody.released : [])
      return {
        ok: true,
        stems: result,
        dir: dir,
        ms: Date.now() - begin,
        ...(release.length ? { released: release.map(String) } : {}),
      }
    })
  }

  // ---------------- 视觉关键帧 ----------------

  async function visionFrames(input, opts = {}) {
    return guard('vision', async () => {
      assertEnabled()
      const config = fetchConfig()
      const origin = input && typeof input === 'object' ? input : { videoPath: input }
      if (origin.url) {
        fail('not_implemented', {
          detail: 'url 输入需要下载能力，暂未支持',
          hint: '暂不支持直接分析网络视频，请先将视频保存到本机，再传入文件路径。',
        })
      }
      if (!origin.videoPath && !origin.jobId) {
        fail('bad_request', { detail: '缺少 videoPath / jobId', hint: '请提供本机视频的路径。' })
      }
      if (origin.videoPath) checkLocalFile(origin.videoPath, { label: '视频文件', maxMB: localMediaMaxMB })

      const targetFrames = fetchInt(opts.targetFrames ?? 3, 'targetFrames', 1, 10, 3)
      const effort = fetchEnum(opts.effort, 'effort', effortPreset, 'auto')
      const planner = fetchEnum(opts.planner, 'planner', planEr, 'hybrid')
      const subtitles = fetchEnum(opts.subtitles, 'subtitles', subtitlePreset, 'auto')
      const timeoutMs = fetchTimeout(opts.timeoutMs, config.visionTimeoutMs)

      await requestCapability('vision')
      const begin = Date.now()
      const body = {
        target_frames: targetFrames,
        effort,
        planner,
        subtitles,
        ...(origin.videoPath ? { video_path: origin.videoPath } : { job_id: origin.jobId }),
      }
      const response = await client.postJson('/vision/frames', body, {
        timeoutMs,
        capability: 'vision',
        capabilityReady: true,
      })
      const responseBody = response.data || {}
      const dir = cache.makeJobDir('vision')
      const childDir = dir.split(/[\\/]/).pop()
      const frames = []
      for (const [seq, frame] of (Array.isArray(responseBody.frames) ? responseBody.frames : []).slice(0, 10).entries()) {
        const source = String(frame?.path || '')
        if (!source || !existsSync(source)) continue
        const ext = extname(source) || '.jpg'
        const target = cache.copyIn('vision', source, { subdir: childDir, name: `frame_${String(seq + 1).padStart(4, '0')}${ext}` })
        if (!target) continue
        frames.push({
          time: Number(frame.time) || 0,
          path: target,
          ...(frame.score != null ? { score: Number(frame.score) } : {}),
          ...(frame.kind ? { kind: String(frame.kind) } : {}),
          ...(frame.ocr_text ? { ocrText: String(frame.ocr_text) } : {}),
          ...(frame.summary ? { summary: String(frame.summary).slice(0, 300) } : {}),
          ...(frame.why ? { why: String(frame.why) } : {}),
          ...(frame.confidence ? { confidence: String(frame.confidence) } : {}),
        })
      }

      return {
        ok: true,
        frames,
        ...(responseBody.duration != null ? { duration: Number(responseBody.duration) } : {}),
        ...(responseBody.subtitles_from ? { subtitlesFrom: String(responseBody.subtitles_from) } : {}),
        ...(responseBody.stats && typeof responseBody.stats === 'object'
          ? {
              stats: {
                ...(responseBody.stats.candidates != null ? { candidates: Number(responseBody.stats.candidates) } : {}),
                ...(responseBody.stats.vlm_calls != null ? { vlmCalls: Number(responseBody.stats.vlm_calls) } : {}),
                ...(responseBody.stats.elapsed_ms != null ? { elapsedMs: Number(responseBody.stats.elapsed_ms) } : {}),
                ...(responseBody.stats.degraded != null ? { degraded: Boolean(responseBody.stats.degraded) } : {}),
                ...(responseBody.stats.degraded_reason ? { degradedReason: String(responseBody.stats.degraded_reason) } : {}),
              },
            }
          : {}),
        ms: Date.now() - begin,
      }
    })
  }

  // ---------------- 单图理解 ----------------

  async function visionDescribe(input, opts = {}) {
    return guard('vision', async () => {
      assertEnabled()
      const config = fetchConfig()
      const fileS = normalizeFileArray(input, { label: '图片', max: 10 })
      for (const file of fileS) {
        checkLocalFile(file, { label: '图片', maxMB: maxUploadMB })
        if (!imageExtName.includes(extname(file).toLowerCase())) {
          fail('bad_request', {
            detail: `不是图片：${file}`,
            hint: '请求参数有误：图片只支持 JPG / PNG / WebP / GIF / BMP。',
          })
        }
      }
      const mode = fetchEnum(opts.mode, 'mode', visualMode, 'caption')
      const scope = fetchEnum(opts.scope, 'scope', visionRange, 'tool')
      const customPrompt = typeof opts.prompt === 'string' ? opts.prompt.trim().slice(0, visionPromptLimit) : ''
      // 提示词优先级：显式 prompt > 显式 preset（工具档）> 配置里的默认档。
      // scope=session（会话识图按钮）时用单独的 visionSessionPrompt，内置默认与详细档一致。
      // mode 仍兼容旧调用：ocr 固定用「只看文字」档，score 保持服务端默认评分提示（不传 prompt）。
      const defaultPreset = normalizePreset(config.visionDefaultPreset)
      const preset = normalizePreset(opts.preset, defaultPreset)
      const sessionPrompt = typeof config.visionSessionPrompt === 'string' && config.visionSessionPrompt.trim()
        ? config.visionSessionPrompt.trim().slice(0, visionPromptLimit)
        : defaultSessionVisionPrompt
      const prompt = customPrompt || (mode === 'score'
        ? ''
        : mode === 'ocr'
          ? fetchPresetPrompt('text', config.visionPresets)
          : scope === 'session'
            ? sessionPrompt
            : fetchPresetPrompt(preset, config.visionPresets))
      const timeoutMs = fetchTimeout(opts.timeoutMs, config.visionTimeoutMs)

      await requestCapability('vision')
      const begin = Date.now()
      const items = []
      for (const file of fileS) {
        const singleBegin = Date.now()
        const response = await client.postMultipart('/vision/describe', {
          fields: prompt ? { prompt } : {},
          files: [{ field: 'file', path: file }],
          timeoutMs,
          capability: 'vision',
          capabilityReady: true,
        })
        const responseBody = response.data || {}
        const text = String(responseBody.text || '')
        if (!text) {
          fail('upstream_error', {
            detail: `服务没有返回图片描述：${file}`,
            hint: '本地 AI 没有返回图片描述，可以换一张图或稍后重试。',
          })
        }
        items.push({
          path: file,
          text,
          ...(responseBody.parsed !== undefined && responseBody.parsed !== null ? { parsed: responseBody.parsed } : {}),
          ms: Number.isFinite(Number(responseBody.elapsed_ms)) ? Number(responseBody.elapsed_ms) : Date.now() - singleBegin,
        })
      }
      return { ok: true, items, ms: Date.now() - begin }
    })
  }

  // ---------------- 媒体探测 ----------------

  async function mediaProbe(input, opts = {}) {
    return guard('media', async () => {
      assertEnabled()
      const config = fetchConfig()
      const fileS = normalizeFileArray(input, { label: 'files', max: 10 })
      for (const file of fileS) checkLocalFile(file, { label: '媒体文件', maxMB: localMediaMaxMB })
      const timeoutMs = fetchTimeout(opts.timeoutMs, 30000)
      await requestCapability('media')

      const items = []
      const begin = Date.now()
      for (const file of fileS) {
        const response = await client.postMultipart('/media/probe', {
          files: [{ field: 'file', path: file }],
          timeoutMs,
          capability: 'media',
          capabilityReady: true,
        })
        const responseBody = response.data || {}
        items.push({
          file: file,
          ...(responseBody.duration != null ? { duration: Number(responseBody.duration) } : {}),
          ...(responseBody.format ? { format: String(responseBody.format) } : {}),
          ...(responseBody.audio && typeof responseBody.audio === 'object'
            ? {
                audio: {
                  ...(responseBody.audio.codec ? { codec: String(responseBody.audio.codec) } : {}),
                  ...(responseBody.audio.sample_rate != null ? { sampleRate: Number(responseBody.audio.sample_rate) } : {}),
                  ...(responseBody.audio.channels != null ? { channels: Number(responseBody.audio.channels) } : {}),
                },
              }
            : {}),
          ...(responseBody.video && typeof responseBody.video === 'object'
            ? {
                video: {
                  ...(responseBody.video.codec ? { codec: String(responseBody.video.codec) } : {}),
                  ...(responseBody.video.width != null ? { width: Number(responseBody.video.width) } : {}),
                  ...(responseBody.video.height != null ? { height: Number(responseBody.video.height) } : {}),
                  ...(responseBody.video.fps != null ? { fps: Number(responseBody.video.fps) } : {}),
                },
              }
            : {}),
        })
      }
      return { ok: true, items, ms: Date.now() - begin }
    })
  }

  // ---------------- 任务队列 ----------------

  function mapTask(id, responseBody) {
    const err = responseBody?.error
    return {
      ok: true,
      id: String(responseBody?.id || id || ''),
      kind: String(responseBody?.kind || ''),
      ...(responseBody?.action ? { action: String(responseBody.action) } : {}),
      state: String(responseBody?.state || 'unknown'),
      ...(responseBody?.priority != null ? { priority: Number(responseBody.priority) } : {}),
      ...(responseBody?.created_at ? { createdAt: String(responseBody.created_at) } : {}),
      ...(responseBody?.started_at ? { startedAt: String(responseBody.started_at) } : {}),
      ...(responseBody?.finished_at ? { finishedAt: String(responseBody.finished_at) } : {}),
      ...(responseBody?.attempts != null ? { attempts: Number(responseBody.attempts) } : {}),
      ...(err != null ? { error: typeof err === 'string' ? err : JSON.stringify(err) } : {}),
      ...(responseBody?.result != null ? { result: responseBody.result } : {}),
      ...(responseBody?.meta?.progress && typeof responseBody.meta.progress === 'object' ? { progress: responseBody.meta.progress } : {}),
    }
  }

  function checkTaskId(id) {
    const value = String(id == null ? '' : id).trim()
    if (!value) fail('bad_request', { detail: '缺少 jobId', hint: '请求参数有误：请提供任务 id。' })
    return value
  }

  const jobs = {
    async enqueue(kind, payload = {}, opts = {}) {
      return guard('jobs', async () => {
        assertEnabled()
        if (!taskKind.includes(kind)) {
          fail('bad_request', { detail: `未知任务类型 ${kind}`, hint: `请求参数有误：任务类型只能是 ${taskKind.join(' / ')}。` })
        }
        if (opts.files && Array.isArray(opts.files) && opts.files.length) {
          fail('not_implemented', {
            detail: 'files 需要先上传到服务端，暂未支持',
            hint: '暂不支持带文件提交任务，请直接使用对应的工具处理。',
          })
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          fail('bad_request', { detail: 'payload 必须是对象', hint: '请求参数有误：任务数据须为 JSON 对象。' })
        }
        const response = await client.postJson('/jobs', {
          kind,
          payload,
          ...(opts.priority != null ? { priority: Number(opts.priority) } : {}),
        }, {
          timeoutMs: fetchTimeout(opts.timeoutMs, 30000),
          capability: 'jobs',
          capabilityReady: true,
        })
        const responseBody = response.data || {}
        if (!responseBody.id) fail('upstream_error', { detail: '服务没有返回任务 id', hint: '提交任务失败，请稍后重试。' })
        return { ok: true, id: String(responseBody.id), state: String(responseBody.state || 'queued') }
      })
    },

    async status(id, opts = {}) {
      return guard('jobs', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        const response = await client.getJson(`/jobs/${encodeURIComponent(taskId)}`, {
          timeoutMs: fetchTimeout(opts.timeoutMs, 15000),
          capability: 'jobs',
          capabilityReady: true,
        })
        return mapTask(taskId, response.data)
      })
    },

    /** 取任务结果：只有 done 才有；未完成时上游 409 → 返回 not_ready。 */
    async result(id, opts = {}) {
      return guard('jobs', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        try {
          const response = await client.getJson(`/jobs/${encodeURIComponent(taskId)}/result`, {
            timeoutMs: fetchTimeout(opts.timeoutMs, 30000),
            capability: 'jobs',
            capabilityReady: true,
          })
          const responseBody = response.data || {}
          return {
            ok: true,
            id: String(responseBody.id || taskId),
            state: String(responseBody.state || 'done'),
            ...(responseBody.result != null ? { result: responseBody.result } : {}),
          }
        } catch (error) {
          const err = toServiceError(error, 'jobs')
          if (err.httpStatus === 409) {
            return { ok: false, id: taskId, state: 'not_done', code: 'not_ready', hint: '任务还没完成，请稍后再取结果。' }
          }
          throw err
        }
      })
    },

    async wait(id, opts = {}) {
      return guard('jobs', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        const totalTimeout = fetchTimeout(opts.timeoutMs, 600000)
        const poll = Math.max(200, Number(opts.pollMs) || 1000)
        const deadline = Date.now() + totalTimeout
        const signal = opts.signal
        try {
          for (;;) {
            if (signal?.aborted) {
              const err = new Error('aborted')
              err.name = 'AbortError'
              throw err
            }
            const record = await jobs.status(taskId, { timeoutMs: 15000 })
            if (['done', 'failed', 'canceled'].includes(record.state)) return record
            if (Date.now() >= deadline) {
              fail('timeout', {
                detail: `等待任务 ${taskId} 超过 ${totalTimeout}ms`,
                hint: timeoutHint(totalTimeout),
              })
            }
            await interruptibleSleep(Math.min(poll, Math.max(0, deadline - Date.now())), signal)
          }
        } catch (error) {
          if (error?.name === 'AbortError') {
            try { await jobs.cancel(taskId) } catch { /* 取消失败也不掩盖取消 */ }
            fail('canceled', { detail: '等待被取消', hint: '任务已取消。' })
          }
          throw error
        }
      })
    },

    async cancel(id) {
      return guard('jobs', async () => {
        assertEnabled()
        const taskId = checkTaskId(id)
        try {
          const response = await client.postJson(`/jobs/${encodeURIComponent(taskId)}/cancel`, {}, {
            timeoutMs: 15000,
            capability: 'jobs',
            capabilityReady: true,
          })
          const responseBody = response.data || {}
          return {
            ok: true,
            id: String(responseBody.id || taskId),
            state: String(responseBody.state || 'canceled'),
            ...(responseBody.cancel_requested != null ? { cancelRequested: Boolean(responseBody.cancel_requested) } : {}),
          }
        } catch (error) {
          const err = toServiceError(error, 'jobs')
          if (err.code === 'canceled') {
            return { ok: true, id: taskId, state: 'canceled', cancelRequested: false }
          }
          throw err
        }
      })
    },

    async list(filter = {}) {
      return guard('jobs', async () => {
        assertEnabled()
        const param = new URLSearchParams()
        if (filter.kind) param.set('kind', String(filter.kind))
        if (filter.state) param.set('state', String(filter.state))
        if (filter.limit != null) param.set('limit', String(fetchInt(filter.limit, 'limit', 1, 100, 20)))
        if (filter.offset != null) param.set('offset', String(Math.max(0, Number(filter.offset) || 0)))
        const query = param.toString()
        const response = await client.getJson(`/jobs${query ? `?${query}` : ''}`, {
          timeoutMs: 15000,
          capability: 'jobs',
          capabilityReady: true,
        })
        const responseBody = response.data || {}
        return {
          ok: true,
          total: Number(responseBody.total) || 0,
          jobs: (Array.isArray(responseBody.jobs) ? responseBody.jobs : []).map((x) => mapTask(x.id, x)),
        }
      })
    },
  }

  // ---------------- 音色 ----------------

  async function voices(opts = {}) {
    return guard('voices', async () => {
      assertEnabled()
      const now = Date.now()
      if (!opts.force && voiceCache && now - voiceCache.at < 30000) {
        return withDir(voiceCache.list, voiceCache.directory)
      }
      const response = await client.getJson('/voices', {
        timeoutMs: fetchTimeout(opts.timeoutMs, 15000),
        capability: 'voices',
        capabilityReady: true,
      })
      const responseBody = response.data || {}
      const list = (Array.isArray(responseBody.voices) ? responseBody.voices : []).map((x) => ({
        name: String(x?.name || ''),
        ...(x?.filename ? { filename: String(x.filename) } : {}),
        ...(x?.format ? { format: String(x.format) } : {}),
        ...(x?.duration != null ? { duration: Number(x.duration) } : {}),
      })).filter((x) => x.name)
      const directory = typeof responseBody.directory === 'string' ? responseBody.directory : ''
      voiceCache = { at: now, list, directory }
      return withDir(list, directory)
    })
  }

  // ---------------- 配置 ----------------

  const writableField = [
    'baseUrl', 'apiVersion', 'token', 'enabled', 'ttsVoice', 'ttsSpeed',
    'autoRead', 'autoReadSessions', 'autoReadInBackground', 'readMaxChars', 'readConcurrency',
    'recordMime', 'recordDeviceId', 'rememberVoiceChoice', 'asrLanguage',
    'primaryLanguage', 'secondaryLanguage',
    'requestTimeoutMs', 'asrTimeoutMs', 'visionTimeoutMs', 'localDescribe',
    'uiVoiceInput', 'uiVision', 'uiMetrics', 'uiAutoRead',
    'visionPresets', 'visionDefaultPreset', 'visionSessionPrompt',
    'cacheDir', 'cacheTtlHours', 'cacheMaxMb', 'healthIntervalMs',
    'enabledCapabilities', 'logLevel',
  ]

  function validateConfigPatch(patch, current) {
    const apply = {}
    const applied = []
    const warnings = []
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}

    const numberField = [
      ['requestTimeoutMs', 1000, 1800000],
      ['asrTimeoutMs', 1000, 1800000],
      ['visionTimeoutMs', 1000, 1800000],
      ['healthIntervalMs', 5000, 120000],
      ['cacheTtlHours', 1, 720],
      ['cacheMaxMb', 256, 10240],
    ]
    // 提示文案里只出现用户看得懂的名字，不暴露配置键。
    const fieldLabelZh = {
      baseUrl: '服务地址',
      apiVersion: '服务版本',
      token: '访问令牌',
      enabled: '总开关',
      ttsVoice: '默认音色',
      ttsSpeed: '语速',
      autoRead: '新会话默认自动朗读',
      autoReadSessions: '按会话的自动朗读设置',
      autoReadInBackground: '后台也自动朗读',
      readMaxChars: '单次最大字数',
      readConcurrency: '同时合成',
      recordMime: '录音格式',
      recordDeviceId: '输入设备',
      rememberVoiceChoice: '记住上次选择',
      asrLanguage: '识别语言',
      primaryLanguage: '第一语言',
      secondaryLanguage: '第二语言',
      requestTimeoutMs: '请求超时',
      asrTimeoutMs: '语音识别超时',
      visionTimeoutMs: '视觉分析超时',
      localDescribe: '本地识图',
      uiVoiceInput: '语音识别按钮',
      uiVision: '本地识图按钮',
      uiMetrics: '性能监控',
      uiAutoRead: '自动朗读',
      visionPresets: '工具识图提示词',
      visionDefaultPreset: '工具识图默认档',
      visionSessionPrompt: '会话识图提示词',
      cacheDir: '缓存目录',
      cacheTtlHours: '缓存保留时长',
      cacheMaxMb: '缓存上限',
      healthIntervalMs: '状态检查间隔',
      enabledCapabilities: '启用的能力',
      logLevel: '日志级别',
    }

    for (const field of writableField) {
      if (source[field] === undefined) continue
      const value = source[field]

      if (field === 'baseUrl') {
        const address = String(value || '').trim().replace(/\/+$/, '')
        try {
          const u = new URL(address)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('协议')
          apply[field] = address
          applied.push(field)
        } catch {
          warnings.push('服务地址格式不正确，已忽略这项修改。')
        }
      } else if (field === 'apiVersion') {
        const version = String(value || '').trim()
        if (/^\d+(\.\d+)?$/.test(version)) { apply[field] = version; applied.push(field) }
        else warnings.push('服务版本须为数字，已忽略这项修改。')
      } else if (field === 'token') {
        if (value === '***已设置***') continue
        const token = String(value ?? '')
        if (token.length > 512) warnings.push('访问令牌超过 512 字，已忽略。')
        else { apply[field] = token; applied.push(field) }
      } else if (field === 'enabled') {
        apply[field] = value === true || value === 'true' || value === 1 || value === '1'
        applied.push(field)
      } else if (field === 'ttsVoice') {
        const voice = String(value || '').trim()
        if (!voice) warnings.push('默认音色不能为空，已忽略这项修改。')
        else { apply[field] = voice.slice(0, 80); applied.push(field) }
      } else if (field === 'ttsSpeed') {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0.5 || n > 2) warnings.push('语速须在 0.5~2.0 之间，已忽略这项修改。')
        else { apply[field] = Math.round(n * 100) / 100; applied.push(field) }
      } else if (field === 'readMaxChars') {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 200 || n > 5000) warnings.push('单次最大字数须在 200~5000 之间，已忽略这项修改。')
        else { apply[field] = Math.round(n); applied.push(field) }
      } else if (field === 'readConcurrency') {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 4) warnings.push('同时合成须为 1~4 的整数，已忽略这项修改。')
        else { apply[field] = n; applied.push(field) }
      } else if (field === 'autoReadSessions') {
        const normalize = normalizeAutoReadSessions(value)
        warnings.push(...normalize.warnings)
        // 格式不对就整项忽略，避免把已有的按会话设置清空。
        if (normalize.valid) {
          apply[field] = normalize.value
          applied.push(field)
        }
      } else if (field === 'autoRead' || field === 'autoReadInBackground'
        || field === 'rememberVoiceChoice'
        || field === 'localDescribe'
        || field === 'uiVoiceInput' || field === 'uiVision'
        || field === 'uiMetrics' || field === 'uiAutoRead') {
        apply[field] = value === true || value === 'true' || value === 1 || value === '1'
        applied.push(field)
      } else if (field === 'visionDefaultPreset') {
        const presetLevel = detectPreset(value)
        if (presetLevel) {
          apply[field] = presetLevel
          applied.push(field)
        } else {
          // 非法档位回退默认，不让设置页卡在未知值上。
          apply[field] = 'detailed'
          applied.push(field)
          warnings.push(`${fieldLabelZh[field]}无法识别，已恢复默认。`)
        }
      } else if (field === 'visionSessionPrompt') {
        const prompt = typeof value === 'string' ? value.trim() : ''
        if (typeof value !== 'string') {
          warnings.push('会话识图提示词格式不正确，已忽略这项修改。')
        } else {
          apply[field] = prompt.slice(0, visionPromptLimit)
          applied.push(field)
          if (prompt.length > visionPromptLimit) warnings.push(`会话识图提示词超过 ${visionPromptLimit} 字，已截断。`)
        }
      } else if (field === 'visionPresets') {
        const merge = mergeVisionPresets(value, current.visionPresets)
        if (merge.ignored) warnings.push('识图提示词里有无法识别的档位或内容，已忽略。')
        if (merge.accepted) {
          for (const [preset, prompt] of Object.entries(merge.value)) {
            const origValue = value && typeof value === 'object' ? value[preset] : undefined
            if (typeof origValue === 'string' && origValue.trim().length > visionPromptLimit) {
              warnings.push('识图提示词超过 4000 字，已截断。')
              break
            }
          }
          apply[field] = merge.value
          applied.push(field)
        }
      } else if (field === 'recordMime') {
        const format = String(value || '').trim().toLowerCase()
        if (!['auto', 'webm', 'wav'].includes(format)) warnings.push('录音格式只能是自动、体积较小或体积较大，已忽略这项修改。')
        else { apply[field] = format; applied.push(field) }
      } else if (field === 'recordDeviceId') {
        const normalize = normalizeRecordDeviceId(value)
        warnings.push(...normalize.warnings)
        // 非法值整项忽略，避免把已选好的设备清掉；空串是合法值（跟随系统默认）。
        if (normalize.valid) {
          apply[field] = normalize.value
          applied.push(field)
        }
      } else if (field === 'asrLanguage') {
        const language = String(value || '').trim().toLowerCase()
        if (!['auto', 'zh', 'en', 'ja'].includes(language)) warnings.push('识别语言只能是自动、中文、英文或日文，已忽略这项修改。')
        else { apply[field] = language; applied.push(field) }
      } else if (field === 'primaryLanguage' || field === 'secondaryLanguage') {
        const language = String(value || '').trim().toLowerCase()
        if (!['zh', 'en', 'ja', 'ko', 'yue'].includes(language)) {
          warnings.push(`${fieldLabelZh[field]}只能是中文、英文、日文、韩文或粤语，已忽略这项修改。`)
        } else { apply[field] = language; applied.push(field) }
      } else if (field === 'cacheDir') {
        const dir = String(value || '').trim()
        if (!dir) warnings.push('缓存目录不能为空，已忽略这项修改。')
        else { apply[field] = dir; applied.push(field) }
      } else if (field === 'enabledCapabilities') {
        const list = Array.isArray(value) ? value.map(String) : String(value || '').split(',')
        const legal = list.map((x) => x.trim().toLowerCase()).filter((x) => ['tts', 'asr', 'translate', 'separate', 'vision', 'media', 'download', 'jobs'].includes(x))
        if (legal.length !== list.filter((x) => String(x).trim()).length) warnings.push('启用的能力中有无法识别的项，已忽略。')
        apply[field] = [...new Set(legal)]
        applied.push(field)
      } else if (field === 'logLevel') {
        const level = String(value || '').toLowerCase()
        if (['debug', 'info', 'warn', 'error'].includes(level)) { apply[field] = level; applied.push(field) }
        else warnings.push('日志级别无法识别，已忽略这项修改。')
      } else if (numberField.some(([name]) => name === field)) {
        const [, min, max] = numberField.find(([name]) => name === field)
        const n = Number(value)
        if (!Number.isFinite(n) || n < min || n > max) warnings.push(`${fieldLabelZh[field] || '该设置'}须在 ${min}~${max} 之间，已忽略这项修改。`)
        else { apply[field] = Math.round(n); applied.push(field) }
      }
    }

    // 环境变量钉住的字段：保存成功但实际不生效，提前告诉设置页。
    if (configStore.overrides?.length) {
      for (const field of applied) {
        if (configStore.overrides.includes(field)) warnings.push(`${fieldLabelZh[field] || '该设置'}已由系统统一指定，在设置页修改不会生效。`)
      }
    }
    return { patch: apply, applied, warnings, current: current }
  }

  const config = {
    get() {
      const c = fetchConfig()
      return {
        ...c,
        token: c.token ? '***已设置***' : '',
        envOverrides: [...(configStore.overrides || [])],
        configFile: configStore.filePath,
      }
    },

    async set(patch) {
      return guard('config', async () => {
        const current = fetchConfig()
        const { patch: clean, applied, warnings } = validateConfigPatch(patch, current)
        if (!applied.length) return { ok: true, applied: [], requiresRestart: false, warnings }
        const merge = { ...current, ...clean }
        const save = configStore.save(merge)
        if (!save) {
          fail('upstream_error', {
            detail: `写不进配置文件：${configStore.filePath}`,
            hint: '保存失败：无法写入配置文件，请检查文件权限或磁盘空间。',
          })
        }
        // 文件里原有的非法项（例如被手工改坏的按会话设置）也要给用户一个提示。
        for (const warn of configStore.warnings || []) {
          if (!warnings.includes(warn)) warnings.push(warn)
        }
        logger?.setLevel?.(save.logLevel)
        if (applied.includes('baseUrl') || applied.includes('apiVersion')) capabilityService.invalidate()
        if (applied.includes('cacheDir')) {
          cache.setDir(save.cacheDir)
          cache.init()
        }
        try { onConfigChange?.({ config: save, patch: clean }) } catch (error) {
          logger?.warn(`配置变更回调失败：${error?.message || error}`)
        }
        logger?.info(`设置已保存：${applied.join(', ')}`)
        return { ok: true, applied, requiresRestart: false, warnings }
      })
    },
  }

  // ---------------- 缓存运维（供设置页与宿主路由） ----------------

  const cacheType = ['tts', 'separate', 'vision', 'tmp', 'voice']

  const cacheOps = {
    /** TTS 命中统计；命中/未命中是进程内存计数，不扫盘。 */
    stats() {
      return cacheStats()
    },

    /** 清空缓存：kind 省略 = 生成产物（tts/separate/vision/tmp），保留用户录音 voice。 */
    clear(opts = {}) {
      const kind = String(opts?.kind || '').trim().toLowerCase()
      if (kind && !cacheType.includes(kind)) {
        fail('bad_request', {
          detail: `未知缓存类型 ${kind}`,
          hint: `请求参数有误：缓存类型只能取 ${cacheType.join(' / ')}，或留空以清空全部产物。`,
        })
      }
      const result = typeof cache.clear === 'function' ? cache.clear(kind) : { files: 0, bytes: 0, kinds: [] }
      // 文件被删了，内存账本也跟着对一遍；命中/未命中是历史计数，清缓存不重置。
      syncCacheLedger()
      logger?.info(`缓存已清空：${(result.kinds || []).join('/') || kind || 'all'}，${result.files || 0} 个文件，${((result.bytes || 0) / 1024 / 1024).toFixed(1)} MB`)
      return {
        ok: true,
        kind: kind || 'all',
        files: result.files || 0,
        bytes: result.bytes || 0,
        kinds: result.kinds || [],
      }
    },

    /** 先删过期（TTL），再按 LRU 删到上限；返回清理结果。 */
    cleanup(opts = {}) {
      const result = typeof cache.cleanup === 'function'
        ? cache.cleanup(opts)
        : { expired: 0, lru: 0, bytesFreed: 0, scanned: 0 }
      syncCacheLedger()
      return {
        ok: true,
        expired: Number(result.expired) || 0,
        lru: Number(result.lru) || 0,
        bytesFreed: Number(result.bytesFreed) || 0,
        scanned: Number(result.scanned) || 0,
      }
    },
  }

  // ---------------- 事件 ----------------

  const events = {
    on(name, fn) {
      event.on(name, fn)
      return () => event.off(name, fn)
    },
    off(name, fn) {
      event.off(name, fn)
    },
    once(name, fn) {
      event.once(name, fn)
      return () => event.off(name, fn)
    },
  }

  // ---------------- ensureReady ----------------

  async function ensureReady(capability, opts = {}) {
    const begin = Date.now()
    const result = await capabilityService.require(capability, {
      force: opts.force === true,
      timeoutMs: fetchTimeout(opts.timeoutMs, 2000),
    })
    if (!result.ok) {
      const err = toServiceError(result.error, capability)
      rememberError(err, capability)
      return {
        ok: false,
        capability,
        ready: false,
        loaded: false,
        willLoadOnFirstUse: false,
        waitedMs: Date.now() - begin,
        code: err.code,
        hint: err.hint,
      }
    }

    const info = result.info
    let loaded = Boolean(info.loaded)
    let warmupError = null
    if (opts.preload === true) {
      if (capability === 'tts' && !loaded) {
        try {
          await tts('嗯', { voice: fetchConfig().ttsVoice, timeoutMs: fetchTimeout(opts.timeoutMs, fetchConfig().requestTimeoutMs) })
          loaded = true
        } catch (error) {
          warmupError = toServiceError(error, 'tts')
        }
      } else if (capability !== 'tts') {
        // 其它能力没有“加载模型”的独立接口，只能等第一次真实请求。
      }
    }

    if (warmupError) {
      rememberError(warmupError, capability)
      return {
        ok: false,
        capability,
        ready: true,
        loaded: false,
        willLoadOnFirstUse: true,
        waitedMs: Date.now() - begin,
        code: warmupError.code,
        hint: warmupError.hint,
      }
    }

    return {
      ok: true,
      capability,
      ready: true,
      loaded,
      willLoadOnFirstUse: !loaded,
      waitedMs: Date.now() - begin,
    }
  }

  // ---------------- 安装（P1 只占位） ----------------

  const notImplemented = async (feature) => {
    throw rememberError(makeError('not_implemented', {
      detail: feature,
      hint: `暂不支持${feature}。`,
    }))
  }

  const install = {
    async status() {
      const config = fetchConfig()
      return {
        ok: false,
        code: 'not_implemented',
        hint: '暂不支持安装管理。',
        installMode: config.installMode || 'unknown',
        installDir: config.installDir || '',
        serviceVersion: capabilityService.current()?.serviceVersion || null,
      }
    },
    preflight: () => notImplemented('安装预检'),
    start: () => notImplemented('安装服务'),
    cancel: () => notImplemented('取消安装'),
    adopt: async () => {
      // 接管只读探测：不改目录、不重启服务。
      const snapshot = await capabilityService.refresh({ force: true, timeoutMs: 3000 })
      if (!snapshot.reachable) {
        fail('service_down', { hint: '接管失败：本地 AI 服务不可达，请确认服务已启动。', detail: snapshot.lastError?.detail || '' })
      }
      return { ok: true, installMode: 'adopted', ...(snapshot.serviceVersion ? { serviceVersion: snapshot.serviceVersion } : {}) }
    },
    uninstall: () => notImplemented('卸载服务'),
    models: () => notImplemented('模型管理'),
    logs: () => notImplemented('安装日志'),
  }

  // ---------------- 组装 ----------------

  const api = {
    apiVersion: '1.0',
    pluginVersion: version,
    /** 契约 1.1：capabilities 是最近一次探测的能力表（同步读，不触发网络）。 */
    get capabilities() {
      return capabilityService.current()?.capabilities || emptyCapabilities('service_down')
    },
    /** 内部：强制/缓存式探测一次并返回能力表（工具与路由用）。 */
    capabilitiesAsync: (opts = {}) => capabilityService.list(opts),
    health: (opts = {}) => capabilityService.health(opts),
    ensureReady,
    tts,
    asr,
    translate,
    translateJobs,
    separate,
    visionFrames,
    visionDescribe,
    /**
     * 契约 1.17：识图偏好。只读本地配置，不探服务、不联网；
     * 供鱼讯插件做「继承 / 开 / 关」三态，缺字段按开启处理。
     * visionSessionPrompt 是会话识图实际会用的提示词（留空已换成内置默认），
     * 鱼讯插件可直接展示或复核，不需要自己维护一份。
     */
    visionPrefs() {
      const c = fetchConfig()
      const localDescribe = c.localDescribe !== false
      const sessionPrompt = typeof c.visionSessionPrompt === 'string' && c.visionSessionPrompt.trim()
        ? c.visionSessionPrompt.trim().slice(0, visionPromptLimit)
        : defaultSessionVisionPrompt
      return {
        localDescribe,
        visionSessionReady: localDescribe,
        visionSessionPrompt: localDescribe ? sessionPrompt : '',
        // 工具识图的默认档位；/describe-upload 没带 preset 时用它，缺省按 detailed。
        visionDefaultPreset: normalizePreset(c.visionDefaultPreset) || 'detailed',
      }
    },
    mediaProbe,
    jobs,
    voices,
    config,
    /** 缓存统计 / 清空 / 清理（设置页与宿主路由用；不对外承诺稳定）。 */
    cache: cacheOps,
    events,
    install,
    /** 内部：最近一次错误 / 最近错误列表（工具与路由用）。 */
    get lastError() { return recentErrorEntry },
    recentErrors(n = 20) { return recentError.slice(-Math.max(1, Number(n) || 20)) },
    /** 内部：工具层失败时把错误记进来（不对外承诺）。 */
    recordError(error, capability = '') { return rememberError(error, capability) },
  }

  return api
}
