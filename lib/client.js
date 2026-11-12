// 本地 AI 服务的 HTTP 客户端。
//
// ⚠️ 这个文件是**全 DSH 唯一**知道服务地址的地方：其它插件、工具、设置页
// 都通过 fish.service 或 config 拿数据，不自己拼 127.0.0.1:7880。
//
// 职责：
//   - baseUrl / token 注入（token 不进 URL、不进日志）；
//   - 统一超时（AbortController）；
//   - 重试：只有幂等 GET 重试 1 次；POST 一律不重试（避免重复副作用）；
//   - 错误映射：连接失败 / 507 / 503 / 504 / 400 … → 统一 FishServiceError；
//   - multipart 上传与二进制下载。
//
// P1 不实现安装/下载/托管，只做「调用」。

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  FishServiceError,
  isRetryable,
  makeError,
  mapHttpError,
  mapNetworkError,
} from './errors.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const guessMIME = (path) => {
  const ext = extname(String(path || '')).toLowerCase()
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  return 'application/octet-stream'
}

/** 组 multipart：fields 是普通表单字段，files 是 [{field, path}]。 */
export function buildFormData(fields = {}, files = []) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue
    form.append(key, String(value))
  }
  for (const file of files || []) {
    if (!file?.path) continue
    const content = readFileSync(file.path)
    const displayName = file.name || basename(file.path)
    form.append(file.field || 'file', new Blob([content], { type: guessMIME(file.path) }), displayName)
  }
  return form
}

export class LocalAIClient {
  constructor({
    getConfig,
    logger = null,
    fetchImpl = globalThis.fetch,
    retryDelayMs = 300,
  } = {}) {
    this.getConfig = getConfig
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.retryDelayMs = retryDelayMs
  }

  baseUrl() {
    const cfg = this.getConfig?.() || {}
    return String(cfg.baseUrl || '').replace(/\/+$/, '')
  }

  token() {
    return String(this.getConfig?.()?.token || '')
  }

  #headers(extra = {}) {
    const headers = { ...extra }
    const token = this.token()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  /**
   * 发一次请求。
   * @param {string} path 以 / 开头的路径（可带 query）
   * @param {object} opts
   * @param {'GET'|'POST'} [opts.method]
   * @param {object|FormData} [opts.body]
   * @param {object} [opts.headers]
   * @param {number} [opts.timeoutMs]
   * @param {'json'|'buffer'|'text'} [opts.expect]
   * @param {string} [opts.capability]
   * @param {boolean} [opts.capabilityReady]
   * @param {number} [opts.retry] 覆盖自动重试次数（默认 GET=2 次尝试，POST=1 次）
   * @returns {Promise<{data:any, headers:Headers, status:number, ms:number, bytes?:number}>}
   */
  async request(path, opts = {}) {
    const cfg = this.getConfig?.() || {}
    if (cfg.enabled === false) {
      throw makeError('service_not_installed', { detail: '插件已在设置里停用' })
    }
    if (!this.fetchImpl) {
      throw makeError('service_down', { detail: '当前 Node 运行时没有 fetch' })
    }

    const method = String(opts.method || 'GET').toUpperCase()
    const isGet = method === 'GET'
    const expect = opts.expect || 'json'
    const timeoutMs = Math.max(50, Number(opts.timeoutMs) || Number(cfg.requestTimeoutMs) || 180000)
    const attempts = opts.retry !== undefined ? Math.max(1, Number(opts.retry) || 1) : (isGet ? 2 : 1)
    const base = this.baseUrl()
    if (!base) throw makeError('service_not_installed', { detail: '没有配置 baseUrl' })

    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
    let lastError = null

    for (let attemptIndex = 1; attemptIndex <= attempts; attemptIndex += 1) {
      const begin = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => {
        try { controller.abort() } catch { /* 已结束 */ }
      }, timeoutMs)

      let response
      try {
        const requestHeaders = this.#headers(opts.headers)
        const body = opts.body instanceof FormData ? opts.body : (opts.body === undefined ? undefined : JSON.stringify(opts.body))
        if (body !== undefined && !(body instanceof FormData) && !requestHeaders['content-type']) {
          requestHeaders['content-type'] = 'application/json'
        }

        this.logger?.debug(`→ ${method} ${url}（${timeoutMs}ms，第 ${attemptIndex}/${attempts} 次）`)
        response = await this.fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: body,
          signal: controller.signal,
        })
      } catch (error) {
        lastError = mapNetworkError(error, { timeoutMs, baseUrl: base })
        if (attemptIndex < attempts && isRetryable(lastError.code)) {
          this.logger?.warn(`${method} ${path} 失败（${lastError.code}），${this.retryDelayMs}ms 后重试一次`)
          await sleep(this.retryDelayMs)
          continue
        }
        throw lastError
      } finally {
        clearTimeout(timer)
      }

      const elapsed = Date.now() - begin

      if (!response.ok) {
        const errorBody = await this.#readBody(response)
        lastError = mapHttpError(response.status, errorBody, {
          capability: opts.capability,
          capabilityReady: opts.capabilityReady,
          timeoutMs,
          model: opts.model,
          estimateMb: opts.estimateMb,
        })
        if (attemptIndex < attempts && isRetryable(lastError.code) && response.status !== 507) {
          this.logger?.warn(`${method} ${path} → HTTP ${response.status}（${lastError.code}），${this.retryDelayMs}ms 后重试一次`)
          await sleep(this.retryDelayMs)
          continue
        }
        throw lastError
      }

      this.logger?.debug(`← ${method} ${path} HTTP ${response.status}（${elapsed}ms）`)

      if (expect === 'buffer') {
        const data = Buffer.from(await response.arrayBuffer())
        return { data: data, headers: response.headers, status: response.status, ms: elapsed, bytes: data.length }
      }
      if (expect === 'text') {
        const data = await response.text()
        return { data: data, headers: response.headers, status: response.status, ms: elapsed }
      }

      const data = await this.#readBody(response)
      return { data: data, headers: response.headers, status: response.status, ms: elapsed }
    }

    throw lastError || makeError('upstream_error', { detail: '请求没有结果' })
  }

  async #readBody(response) {
    let text = ''
    try {
      text = await response.text()
    } catch {
      return null
    }
    if (!text) return null
    const type = String(response.headers?.get?.('content-type') || '')
    if (!type.includes('json')) return text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  getJson(path, opts = {}) {
    return this.request(path, { ...opts, method: 'GET', expect: 'json' })
  }

  postJson(path, body, opts = {}) {
    return this.request(path, { ...opts, method: 'POST', body, expect: 'json' })
  }

  postBinary(path, body, opts = {}) {
    return this.request(path, { ...opts, method: 'POST', body, expect: 'buffer' })
  }

  postMultipart(path, { fields = {}, files = [], ...opts } = {}) {
    return this.request(path, {
      ...opts,
      method: 'POST',
      body: buildFormData(fields, files),
      expect: opts.expect || 'json',
    })
  }
}

export { FishServiceError }
