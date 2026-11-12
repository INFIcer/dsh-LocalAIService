// 错误分类与文案：把 HTTP 状态码 / fetch 异常翻译成「9 类 + 3 个扩展」。
//
// 原则：
//   - code 给程序判断，hint 给人看；detail 只用于诊断，不直接当 UI 文案；
//   - 失败不抛裸异常给工具层，工具层统一转成结构化返回；
//   - 文案里绝不出现 token。

/** 契约第 3 节的全部错误码。 */
export const ERROR_CODES = Object.freeze([
  'service_not_installed',
  'service_down',
  'model_missing',
  'model_loading',
  'vram_exhausted',
  'busy',
  'timeout',
  'bad_request',
  'upstream_error',
  'api_incompatible',
  'canceled',
  'not_implemented',
  'not_supported',
])

const retryableCodes = new Set(['service_down', 'model_loading', 'busy', 'timeout', 'upstream_error'])

const defaultCopy = {
  service_not_installed: '本地 AI 尚未配置，请到「设置 → 插件 → 本地 AI」填写服务地址。',
  service_down: '本地 AI 未启动，请先启动后重试。',
  model_loading: '模型正在加载，通常需要几十秒，请稍后重试。',
  timeout: '等待超时，模型可能仍在加载。请稍后重试；内容较长时建议分段处理。',
  busy: '当前任务较多，已排队，请稍后查看进度。',
  canceled: '任务已取消。',
  not_supported: '该能力未启用，请到「设置 → 插件 → 本地 AI」中打开后再试。',
}

const byteToGB = (mb) => (Number(mb) / 1024).toFixed(1)
const truncate = (text, longest = 300) => {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > longest ? `${value.slice(0, longest)}…` : value
}

/** 带 code / hint / detail 的错误对象；服务方法内部 throw，工具层负责转包。 */
export class FishServiceError extends Error {
  constructor(code, {
    detail = '',
    hint = '',
    httpStatus = 0,
    capability = '',
    retryable = undefined,
    retryAfterMs = undefined,
    cause = undefined,
  } = {}) {
    const final = ERROR_CODES.includes(code) ? code : 'upstream_error'
    super(detail || hint || final)
    this.name = 'FishServiceError'
    this.code = final
    this.detail = String(detail || '')
    this.hint = hint || defaultCopy[final] || final
    this.httpStatus = Number(httpStatus) || 0
    this.capability = capability || ''
    this.retryable = retryable === undefined ? retryableCodes.has(final) : Boolean(retryable)
    if (retryAfterMs !== undefined) this.retryAfterMs = Number(retryAfterMs)
    if (cause !== undefined) this.cause = cause
  }
}

/** 构造错误的小快捷方式。 */
export function makeError(code, opts = {}) {
  return new FishServiceError(code, opts)
}

/** 显存不足的人话（能拿到 need/free 就带上具体数字）。 */
export function vramHint(needMb, freeMb) {
  if (Number.isFinite(Number(needMb)) && Number.isFinite(Number(freeMb))) {
    return `显存不足（需要约 ${byteToGB(needMb)} GB，当前可用 ${byteToGB(freeMb)} GB）。请关闭占用显存的程序，或卸载暂时不用的模型后重试。`
  }
  return '显存不足。请关闭占用显存的程序，或卸载暂时不用的模型后重试。'
}

/** 缺少模型的人话。具体是哪个模型只写进 detail，界面文案里不出现模型名。 */
export function modelMissingHint(_model, estimateMb) {
  const size = Number(estimateMb) > 0 ? `（约 ${byteToGB(estimateMb)} GB）` : ''
  return `缺少所需模型${size}，请在本地 AI 中下载后重试。`
}

/** 超时的人话（带上本次超时秒数）。 */
export function timeoutHint(timeoutMs) {
  const seconds = Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs) / 1000) : 0
  return seconds > 0
    ? `等待超时（超过 ${seconds} 秒）。模型可能仍在加载，请稍后重试；内容较长时建议分段处理。`
    : '等待超时，模型可能仍在加载。请稍后重试；内容较长时建议分段处理。'
}

/** 命令行/服务端错误体里的 detail 提取（兼容 OpenAI 风格 {error:{message}}）。 */
export function extractErrorBody(body) {
  if (body == null) return { code: '', detail: '', needMb: undefined, freeMb: undefined }
  if (typeof body === 'string') return { code: '', detail: truncate(body), needMb: undefined, freeMb: undefined }
  if (typeof body !== 'object') return { code: '', detail: truncate(body), needMb: undefined, freeMb: undefined }

  let errorCode = ''
  let detailView = ''
  if (body.error && typeof body.error === 'object') {
    errorCode = String(body.error.code || body.error.type || '')
    detailView = String(body.error.message || body.error.detail || '')
  } else if (body.error != null) {
    errorCode = String(body.error)
  }
  detailView = detailView || String(body.detail || body.message || body.msg || '')
  return {
    code: errorCode,
    detail: truncate(detailView),
    needMb: body.need_mb ?? body.needMb,
    freeMb: body.free_mb ?? body.freeMb,
  }
}

/**
 * HTTP 非 2xx → FishServiceError。
 * @param {number} status
 * @param {unknown} body 解析后的响应体（JSON 或文本）
 * @param {{capability?:string, capabilityReady?:boolean, timeoutMs?:number, model?:string, estimateMb?:number}} context
 */
export function mapHttpError(status, body, context = {}) {
  const { code: serviceCode, detail, needMb, freeMb } = extractErrorBody(body)
  const statusCode = Number(status) || 0
  const base = {
    detail: serviceCode ? `${serviceCode}: ${detail}` : detail,
    httpStatus: statusCode,
    capability: context.capability || '',
  }

  if (statusCode === 507 || serviceCode === 'insufficient_vram') {
    return new FishServiceError('vram_exhausted', {
      ...base,
      hint: vramHint(needMb, freeMb),
      retryable: false,
    })
  }

  if (statusCode === 503) {
    if (context.capabilityReady === false) {
      return new FishServiceError('model_missing', {
        ...base,
        detail: [base.detail, context.model].filter(Boolean).join(' | '),
        hint: modelMissingHint(context.model, context.estimateMb),
        retryable: false,
      })
    }
    if (/加载|loading|loading model|正在载入/i.test(detail)) {
      return new FishServiceError('model_loading', { ...base, hint: defaultCopy.model_loading, retryable: true })
    }
    return new FishServiceError('upstream_error', {
      ...base,
      hint: '本地 AI 内部出错，请重试一次；若仍失败，可查看设置页里的日志。',
      retryable: true,
    })
  }

  if (statusCode === 504) {
    return new FishServiceError('timeout', {
      ...base,
      hint: timeoutHint(context.timeoutMs),
      retryable: true,
    })
  }

  if (statusCode === 409) {
    if (serviceCode === 'job_canceled' || serviceCode === 'canceled') {
      return new FishServiceError('canceled', { ...base, retryable: false })
    }
    return new FishServiceError('bad_request', {
      ...base,
      hint: '当前状态不允许该操作，请刷新后重试。',
      retryable: false,
    })
  }

  if (statusCode === 401) {
    return new FishServiceError('bad_request', {
      ...base,
      hint: '服务需要访问令牌，请检查「设置 → 插件 → 本地 AI」中的令牌是否正确。',
      retryable: false,
    })
  }

  if (statusCode === 400 || statusCode === 403 || statusCode === 404 || statusCode === 413 || statusCode === 422) {
    return new FishServiceError('bad_request', {
      ...base,
      hint: '发送的内容有误，请检查后重试。',
      retryable: false,
    })
  }

  if (statusCode === 429) {
    return new FishServiceError('busy', { ...base, retryable: true })
  }

  if (statusCode >= 500) {
    return new FishServiceError('upstream_error', {
      ...base,
      hint: '本地 AI 内部出错，请重试一次；若仍失败，可查看设置页里的日志。',
      retryable: true,
    })
  }

  return new FishServiceError('bad_request', {
    ...base,
    hint: '发送的内容有误，请检查后重试。',
    retryable: false,
  })
}

const connectFailCode = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** fetch 抛出来的异常 → FishServiceError。 */
export function mapNetworkError(error, context = {}) {
  const name = String(error?.name || '')
  const code = String(error?.code || error?.cause?.code || '')
  const original = String(error?.cause?.message || error?.message || error || '')

  if (name === 'AbortError' || code === 'ABORT_ERR' || /aborted/i.test(original)) {
    return new FishServiceError('timeout', {
      detail: `请求被中止：${original}`,
      hint: timeoutHint(context.timeoutMs),
      retryable: true,
      cause: error,
    })
  }

  if (connectFailCode.has(code) || /ECONNREFUSED|fetch failed|connect ECONN|socket hang up/i.test(original)) {
    return new FishServiceError('service_down', {
      detail: `连接失败：${code || original}${context.baseUrl ? `（${context.baseUrl}）` : ''}`,
      hint: defaultCopy.service_down,
      retryable: true,
      cause: error,
    })
  }

  return new FishServiceError('upstream_error', {
    detail: `请求失败：${code || original}`,
    hint: '请求未能完成，请稍后重试；若持续失败，可查看设置页里的日志。',
    retryable: true,
    cause: error,
  })
}

/** 任意异常 → 结构化失败包；工具层直接返回它，不 throw。 */
export function toPublicError(error) {
  if (error instanceof FishServiceError) {
    const payload = {
      ok: false,
      code: error.code,
      hint: error.hint,
      retryable: error.retryable,
    }
    if (error.detail) payload.detail = error.detail
    if (error.capability) payload.capability = error.capability
    if (error.retryAfterMs !== undefined) payload.retryAfterMs = error.retryAfterMs
    // 兼容两种读法：契约用扁平 code/hint；有的调用方习惯 {ok:false,error:{...}}。
    payload.error = { code: error.code, hint: error.hint }
    return payload
  }

  const detailView = truncate(error?.message || error || '未知错误', 300)
  return {
    ok: false,
    code: 'upstream_error',
    hint: '本地 AI 插件出错，请稍后重试。',
    detail: detailView,
    retryable: false,
    error: { code: 'upstream_error', hint: '本地 AI 插件出错，请稍后重试。' },
  }
}

/** 这个 code 值不值得重试（GET 用）。 */
export function isRetryable(code) {
  return retryableCodes.has(code)
}

/** 错误码 → 默认 hint（测试/UI 用）。 */
export function defaultHint(code) {
  return defaultCopy[code] || ''
}
