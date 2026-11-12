// 能力发现：把 /capabilities + /health + /vram 合成契约里的 CapabilityInfo。
//
// 规则（CONTRACT 1.2 / DESIGN 8.2）：
//   - available = 服务可达 && api 主版本兼容 && 服务端有该能力 && ready；
//   - jobs 是 API 组不是模型：只要可达且 jobs.enabled 就算 available；
//   - whisper 归到 asr（engine=whisper）；speaker 只是服务端模型能力，不单独暴露；
//   - 结果缓存 30 秒；507/503 时由调用方主动 invalidate。

import { EventEmitter } from 'node:events'
import { modelMissingHint, timeoutHint } from './errors.js'

export const CAPABILITY_NAMES = Object.freeze([
  'tts', 'asr', 'translate', 'separate', 'vision', 'media', 'download', 'jobs',
])

export const CAPABILITY_TITLES = Object.freeze({
  tts: '文字转语音',
  asr: '语音识别',
  translate: '翻译',
  separate: '人声分离',
  vision: '视觉',
  media: '媒体工具',
  download: '下载',
  jobs: '任务队列',
})

/** 全部不可用的一组能力（服务没通/版本不兼容时用）。 */
export function emptyCapabilities(reason = 'service_down', versions = undefined) {
  const output = {}
  for (const name of CAPABILITY_NAMES) {
    output[name] = {
      available: false,
      ready: false,
      loaded: false,
      reason,
      ...(versions ? { versions } : {}),
    }
  }
  return output
}

const majorVersion = (version) => String(version == null ? '' : version).trim().split('.')[0]

const bool = (value) => value === true || value === 1 || value === '1' || value === 'true'

/**
 * 解析服务端 capabilities。
 * @param {object} raw GET /capabilities 的响应
 * @param {object} health GET /health 的响应（可选，用来补模型/加载状态）
 * @param {object} vram GET /vram 的响应（可选）
 * @param {{config?:object, compatible?:boolean}} opts
 * @returns {Record<string, object>}
 */
export function parseCapabilities(raw, health = null, vram = null, opts = {}) {
  const config = opts.config || {}
  const compatible = opts.compatible !== false
  const rawCapability = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {}
  const serviceVersion = raw?.service?.version
  const apiVersion = raw?.api_version != null ? String(raw.api_version) : ''
  const versions = { service: serviceVersion, api: apiVersion }
  const allowlist = Array.isArray(config.enabledCapabilities) ? config.enabledCapabilities : []

  const vramInfo = vram && typeof vram === 'object'
    ? vram
    : (raw?.vram && typeof raw.vram === 'object' ? raw.vram : null)
  const estimateTable = vramInfo?.estimates && typeof vramInfo.estimates === 'object' ? vramInfo.estimates : {}

  const output = {}

  for (const name of CAPABILITY_NAMES) {
    // jobs 不是模型，单独判定。
    if (name === 'jobs') {
      const on = raw?.jobs?.enabled !== false
      const available = compatible && on
      output.jobs = {
        available: available,
        ready: on,
        loaded: false,
        model: 'SQLite 队列',
        estimateMb: 0,
        versions,
        ...(!compatible ? { reason: 'api_incompatible' } : (on ? {} : { reason: 'not_supported' })),
      }
      continue
    }

    const rawEntry = rawCapability[name] && typeof rawCapability[name] === 'object' ? rawCapability[name] : null
    const healthInfo = name === 'tts'
      ? health
      : (health && typeof health[name] === 'object' ? health[name] : null)

    // 服务端没有这个能力：reason=not_supported（即使 /health 里有同名块也不算）。
    if (!rawEntry) {
      const available = false
      output[name] = {
        available: available,
        ready: false,
        loaded: false,
        reason: 'not_supported',
        versions,
      }
      continue
    }

    const ready = rawEntry.ready !== undefined
      ? bool(rawEntry.ready)
      : (name === 'tts' ? bool(health?.model_ready) : false)
    const loaded = bool(rawEntry.loaded) || bool(healthInfo?.loaded)
    const model = rawEntry.model || healthInfo?.model || undefined
    const estimateMb = Number(rawEntry.estimate_mb ?? healthInfo?.estimate_mb ?? estimateTable[name] ?? 0) || 0
    const disabledByConfig = allowlist.length > 0 && !allowlist.includes(name)

    let available = compatible && ready && !disabledByConfig
    let reason
    if (!compatible) {
      available = false
      reason = 'api_incompatible'
    } else if (disabledByConfig) {
      available = false
      reason = 'not_supported'
    } else if (!ready) {
      available = false
      reason = 'model_missing'
    } else if (!available) {
      reason = 'not_supported'
    }

    output[name] = {
      available,
      ready,
      loaded,
      ...(model ? { model } : {}),
      ...(estimateMb ? { estimateMb } : {}),
      versions,
      ...(reason ? { reason } : {}),
      ...(disabledByConfig ? { disabledByConfig: true } : {}),
    }
  }

  return output
}

/** 能力指纹：只有这些字段变了才发 capability-changed。 */
export function capabilitySignature(caps) {
  const summary = {}
  for (const name of CAPABILITY_NAMES) {
    const x = caps?.[name] || {}
    summary[name] = [Boolean(x.available), Boolean(x.ready), Boolean(x.loaded), x.model || '', x.reason || '']
  }
  return JSON.stringify(summary)
}

/** 失败时 CapabilityInfo 该写哪个 reason。 */
function reasonForError(code) {
  if (code === 'api_incompatible') return 'api_incompatible'
  if (code === 'service_not_installed') return 'service_down'
  return 'service_down'
}

export class CapabilityService {
  constructor({
    client,
    getConfig,
    logger = null,
    ttlMs = 30000,
    now = () => Date.now(),
  } = {}) {
    this.client = client
    this.getConfig = getConfig
    this.logger = logger
    this.ttlMs = ttlMs
    this.now = now
    this.events = new EventEmitter()
    this.snapshot = null
    this.state = {
      consecutiveFailures: 0,
      lastError: null,
      lastCheckAt: 0,
      lastLatencyMs: 0,
      serviceVersion: '',
      apiVersion: '',
      downEmitted: false,
    }
    this.lastErrorEmitAt = new Map()
    this.lastSignature = ''
  }

  invalidate() {
    this.snapshot = null
  }

  /** 安全发事件：没有监听者时不发（尤其 'error'，否则 EventEmitter 会抛）。 */
  emit(name, payload) {
    if (name === 'error' && this.events.listenerCount('error') === 0) return
    try {
      this.events.emit(name, payload)
    } catch (error) {
      this.logger?.warn(`事件 ${name} 的监听器抛错：${error?.message || error}`)
    }
  }

  #emitErrorOnce(error) {
    const nowMs = this.now()
    const lastTime = this.lastErrorEmitAt.get(error.code) || 0
    if (nowMs - lastTime < 30000) return
    this.lastErrorEmitAt.set(error.code, nowMs)
    this.emit('error', {
      code: error.code,
      detail: error.detail || '',
      at: new Date(nowMs).toISOString(),
    })
  }

  #snapshotFromFailure(error) {
    const config = this.getConfig?.() || {}
    const reason = reasonForError(error.code)
    const versions = {
      service: this.state.serviceVersion || undefined,
      api: this.state.apiVersion || undefined,
    }
    return {
      ok: false,
      reachable: error.code !== 'service_down' && error.code !== 'service_not_installed' && error.code !== 'timeout',
      compatible: error.code !== 'api_incompatible',
      baseUrl: config.baseUrl || '',
      latencyMs: 0,
      checkedAt: new Date(this.state.lastCheckAt || this.now()).toISOString(),
      checkedAtMs: this.state.lastCheckAt || this.now(),
      serviceVersion: this.state.serviceVersion || '',
      apiVersion: this.state.apiVersion || '',
      vram: null,
      capabilities: emptyCapabilities(reason, versions),
      consecutiveFailures: this.state.consecutiveFailures,
      lastError: { code: error.code, detail: error.detail || '', hint: error.hint || '' },
      fromCache: false,
    }
  }

  /**
   * 探测一次（默认读 30 秒缓存）。
   * @param {{force?:boolean, timeoutMs?:number}} opts
   */
  async refresh({ force = false, timeoutMs = 2000 } = {}) {
    const config = this.getConfig?.() || {}
    if (config.enabled === false) {
      const err = Object.assign(new Error('插件已停用'), { code: 'service_not_installed', detail: '插件已在设置里停用', hint: '' })
      return this.#snapshotFromFailure(err)
    }

    const nowMs = this.now()
    if (!force && this.snapshot && nowMs - this.snapshot.checkedAtMs < this.ttlMs) {
      return { ...this.snapshot, fromCache: true }
    }

    const option = { timeoutMs: Math.max(500, Number(timeoutMs) || 2000), retry: 1 }
    const [healthInfo, capability, vramInfo] = await Promise.allSettled([
      this.client.getJson('/health', option),
      this.client.getJson('/capabilities', option),
      this.client.getJson('/vram', option),
    ])

    if (capability.status !== 'fulfilled') {
      const reason = this.#pickError(capability.reason, healthInfo)
      this.state.consecutiveFailures += 1
      this.state.lastError = { code: reason.code, detail: reason.detail || '', hint: reason.hint || '' }
      this.state.lastCheckAt = nowMs
      this.state.lastLatencyMs = 0
      this.#emitErrorOnce(reason)
      if (this.state.consecutiveFailures >= 2 && !this.state.downEmitted) {
        this.state.downEmitted = true
        this.emit('service-down', { reason: reason.code, at: new Date(nowMs).toISOString() })
      }
      const snapshot = this.#snapshotFromFailure(reason)
      snapshot.checkedAt = new Date(nowMs).toISOString()
      snapshot.checkedAtMs = nowMs
      snapshot.latencyMs = 0
      return snapshot
    }

    const rawEntry = capability.value.data || {}
    const healthData = healthInfo.status === 'fulfilled' ? (healthInfo.value.data || {}) : null
    const vramData = vramInfo.status === 'fulfilled' ? (vramInfo.value.data || null) : null

    if (rawEntry.ok === false) {
      const err = Object.assign(new Error('服务拒绝能力发现'), {
        code: 'upstream_error',
        detail: String(rawEntry.detail || rawEntry.error || ''),
        hint: '本地 AI 暂时不可用，请稍后重试。',
      })
      this.state.consecutiveFailures += 1
      this.state.lastError = { code: err.code, detail: err.detail, hint: err.hint }
      this.#emitErrorOnce(err)
      return this.#snapshotFromFailure(err)
    }

    const apiVersion = rawEntry.api_version != null ? String(rawEntry.api_version) : ''
    const expected = String(config.apiVersion || '1')
    const compatible = majorVersion(apiVersion || expected) === majorVersion(expected)
    const serviceVersion = String(rawEntry.service?.version || '')

    const caps = parseCapabilities(rawEntry, healthData, vramData, { config: config, compatible })
    const vram = vramData && (vramData.total_mb || vramData.free_mb)
      ? {
          freeMb: Number(vramData.free_mb) || 0,
          totalMb: Number(vramData.total_mb) || 0,
          marginMb: Number(vramData.margin_mb) || undefined,
        }
      : (rawEntry.vram ? {
          freeMb: Number(rawEntry.vram.free_mb) || 0,
          totalMb: Number(rawEntry.vram.total_mb) || 0,
          marginMb: Number(rawEntry.vram.margin_mb) || undefined,
        } : null)

    const delay = Math.max(0, Number(capability.value.ms) || 0)
    const snapshot = {
      ok: compatible,
      reachable: true,
      compatible,
      baseUrl: config.baseUrl || '',
      latencyMs: delay,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
      serviceVersion,
      apiVersion: apiVersion,
      vram,
      capabilities: caps,
      consecutiveFailures: 0,
      lastError: compatible ? null : {
        code: 'api_incompatible',
        detail: `服务 api_version=${apiVersion || '?'}，插件支持 ${expected}.x`,
        hint: '本地 AI 版本不兼容，请更新插件或本地 AI 后重试。',
      },
      fromCache: false,
    }

    if (this.state.consecutiveFailures > 0) {
      this.emit('service-up', { serviceVersion, at: snapshot.checkedAt })
    }
    this.state.consecutiveFailures = 0
    this.state.lastError = snapshot.lastError ? { ...snapshot.lastError } : null
    this.state.lastCheckAt = nowMs
    this.state.lastLatencyMs = delay
    this.state.serviceVersion = serviceVersion
    this.state.apiVersion = apiVersion
    this.state.downEmitted = false

    const fingerprint = capabilitySignature(caps)
    if (this.lastSignature && fingerprint !== this.lastSignature) {
      this.emit('capability-changed', { at: snapshot.checkedAt, capabilities: caps })
    }
    this.lastSignature = fingerprint
    this.snapshot = snapshot
    return snapshot
  }

  #pickError(error, healthResult) {
    if (error instanceof Error && error.code) return error
    if (healthResult?.status === 'rejected' && healthResult.reason?.code) return healthResult.reason
    if (error && typeof error === 'object') return error
    return Object.assign(new Error('能力发现失败'), {
      code: 'service_down',
      detail: String(error || ''),
      hint: '本地 AI 未启动，请先启动后重试。',
    })
  }

  /** 给服务方法用的门禁：返回 {ok:true, info, snapshot} 或 {ok:false, error}。 */
  async require(name, { force = false, timeoutMs = 2000 } = {}) {
    const config = this.getConfig?.() || {}
    if (config.enabled === false) {
      return {
        ok: false,
        error: Object.assign(new Error('插件已停用'), {
          code: 'service_not_installed',
          hint: '本地 AI 插件已停用，请在「设置 → 插件 → 本地 AI」中打开总开关。',
          detail: 'enabled=false',
        }),
      }
    }
    if (!CAPABILITY_NAMES.includes(name)) {
      return {
        ok: false,
        error: Object.assign(new Error(`未知能力 ${name}`), {
          code: 'upstream_error',
          hint: '当前版本不支持这项能力。',
          detail: `unsupported capability: ${name}`,
        }),
      }
    }

    const snapshot = await this.refresh({ force, timeoutMs })
    if (!snapshot.reachable) {
      return {
        ok: false,
        error: Object.assign(new Error('服务不可达'), {
          code: 'service_down',
          hint: '本地 AI 未启动，请先启动后重试。',
          detail: snapshot.lastError?.detail || '',
        }),
      }
    }
    if (!snapshot.compatible) {
      return {
        ok: false,
        error: Object.assign(new Error('服务契约版本不匹配'), {
          code: 'api_incompatible',
          hint: snapshot.lastError?.hint || '本地 AI 版本不兼容，请更新插件或本地 AI 后重试。',
          detail: snapshot.lastError?.detail || '',
        }),
      }
    }

    const info = snapshot.capabilities?.[name]
    if (!info) {
      return {
        ok: false,
        error: Object.assign(new Error('服务不支持该能力'), {
          code: 'upstream_error',
          hint: '本地 AI 未提供这项能力，请检查本地 AI 的设置。',
          detail: `unsupported capability: ${name}`,
        }),
      }
    }
    if (!info.available) {
      if (info.reason === 'model_missing') {
        return {
          ok: false,
          error: Object.assign(new Error('模型缺失'), {
            code: 'model_missing',
            hint: modelMissingHint(info.model, info.estimateMb),
            detail: `${name} ready=false${info.model ? ` (${info.model})` : ''}`,
            capability: name,
          }),
        }
      }
      if (info.reason === 'not_supported') {
        return {
          ok: false,
          error: Object.assign(new Error('能力不可用'), {
            code: 'upstream_error',
            hint: '本地 AI 未启用这项能力，请在本地 AI 中启用后重试。',
            detail: `capability ${name} not supported`,
            capability: name,
          }),
        }
      }
      return {
        ok: false,
        error: Object.assign(new Error('能力不可用'), {
          code: 'service_down',
          hint: '本地 AI 暂时不可用，请稍后重试。',
          detail: `${name}: ${info.reason || 'unavailable'}`,
          capability: name,
        }),
      }
    }

    return { ok: true, info: info, snapshot: snapshot }
  }

  /** 当前快照（不触发探测）。 */
  current() {
    return this.snapshot
  }

  /** 健康检查结果（CONTRACT 1.3）。 */
  async health({ timeoutMs = 2000 } = {}) {
    const snapshot = await this.refresh({ force: true, timeoutMs })
    return {
      ok: snapshot.ok,
      baseUrl: snapshot.baseUrl,
      latencyMs: snapshot.latencyMs,
      checkedAt: snapshot.checkedAt,
      ...(snapshot.serviceVersion ? { serviceVersion: snapshot.serviceVersion } : {}),
      ...(snapshot.apiVersion ? { apiVersion: snapshot.apiVersion } : {}),
      ...(snapshot.vram ? { vram: snapshot.vram } : {}),
      ...(snapshot.ok ? { capabilities: snapshot.capabilities } : {}),
      consecutiveFailures: snapshot.consecutiveFailures,
      ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
    }
  }

  /** 能力表（默认读缓存）。 */
  async list({ force = false, timeoutMs = 2000 } = {}) {
    const snapshot = await this.refresh({ force, timeoutMs })
    return snapshot.capabilities
  }

  /** 后台健康检查的当前状态。 */
  status() {
    return {
      consecutiveFailures: this.state.consecutiveFailures,
      lastError: this.state.lastError,
      lastCheckAt: this.state.lastCheckAt,
      latencyMs: this.state.lastLatencyMs,
      serviceVersion: this.state.serviceVersion,
      apiVersion: this.state.apiVersion,
    }
  }
}

export { timeoutHint }
