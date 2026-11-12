// 本机 AI 性能指标：把 /admin/system 与 /jobs/stats?limit=1 抓成一个固定形状。
//
// 只做数据整形和抓取，不关心 HTTP 路由；宿主路由 /dsh-fish-service/metrics 调用这里。
// 服务端升级多出字段时忽略，缺字段时给中性默认值，任何异常都不向上抛。
// baseUrl / token 由调用方从现有配置解析后传入，不在这里硬编码。

export const metricsDefaultTimeoutMs = 3000
export const metricsDefaultCacheMs = 1000

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value) => (typeof value === 'string' ? value.trim() : '')

const number = (value, fallback = 0) => {
  const count = Number(value)
  return Number.isFinite(count) ? count : fallback
}

const nonNegative = (value, fallback = 0) => {
  const count = number(value, NaN)
  return Number.isFinite(count) ? Math.max(0, count) : fallback
}

/** 已用 / 总量转整数百分比；总量缺失或为 0 时给 0，不产生 NaN。 */
export function percent(used, totalAmount) {
  const use = number(used, 0)
  const total = number(totalAmount, 0)
  if (!(total > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((use / total) * 100)))
}

/** 按类型的分桶计数：忽略非对象、非数字和 0，键保持服务端原样。 */
function counterTable(value) {
  const result = {}
  if (!isObject(value)) return result
  for (const [key, count] of Object.entries(value)) {
    const counter = Number(count)
    if (Number.isFinite(counter) && counter > 0) result[String(key)] = Math.trunc(counter)
  }
  return result
}

/** /admin/system → gpu / modelsLoaded / service / vision。 */
export function normalizeSystem(raw) {
  const root = isObject(raw) ? raw : {}
  const gpu = isObject(root.gpu) ? root.gpu : {}
  const used = nonNegative(gpu.used_mb, 0)
  const totalAmount = nonNegative(gpu.total_mb, 0)
  const available = gpu.free_mb === undefined || gpu.free_mb === null
    ? Math.max(0, totalAmount - used)
    : nonNegative(gpu.free_mb, Math.max(0, totalAmount - used))
  const service = isObject(root.service) ? root.service : {}
  const visual = isObject(root.vision) ? root.vision : {}
  return {
    gpu: {
      name: text(gpu.name),
      usedMb: used,
      totalMb: totalAmount,
      freeMb: available,
      percent: percent(used, totalAmount),
    },
    modelsLoaded: Array.isArray(root.models_loaded)
      ? root.models_loaded.map(text).filter(Boolean)
      : [],
    service: {
      version: text(service.version),
      uptimeSeconds: nonNegative(service.uptime_seconds, 0),
    },
    vision: {
      loaded: visual.loaded === true,
      ready: visual.ready === true,
    },
  }
}

/** /jobs/stats → queue / scheduler；优先顶层 queued_by_kind，兼容 by_kind.queued 嵌套。 */
export function normalizeTask(raw) {
  const root = isObject(raw) ? raw : {}
  const historyBucket = isObject(root.by_kind) ? root.by_kind : {}
  const queuedSource = isObject(root.queued_by_kind) ? root.queued_by_kind : historyBucket.queued
  const runSource = isObject(root.running_by_kind) ? root.running_by_kind : historyBucket.running
  const schedule = isObject(root.scheduler) ? root.scheduler : {}
  return {
    queue: {
      queued: nonNegative(root.queued, 0),
      running: nonNegative(root.running, 0),
      queuedByKind: counterTable(queuedSource),
      runningByKind: counterTable(runSource),
    },
    scheduler: {
      currentKind: text(schedule.current_kind),
      loadedModel: text(schedule.loaded_model),
    },
  }
}

/** 两侧都失败才算服务离线；只有一侧成功时另一侧用中性默认值。 */
export function mergeMetrics(systemRaw, taskRaw, elapsed) {
  if (!systemRaw && !taskRaw) {
    return { ok: false, code: 'service_down', hint: '本地 AI 未启动' }
  }
  return {
    ok: true,
    ms: nonNegative(elapsed, 0),
    ...normalizeSystem(systemRaw),
    ...normalizeTask(taskRaw),
  }
}

/**
 * 抓一个本机接口：超时用 AbortController，非 2xx、解析失败、网络错误一律返回 null。
 * 用 null 表示「这一侧没拿到」，让 合并指标 能区分单侧失败和两侧全挂。
 */
export async function fetchOneSide(fetchImpl, url, { timeoutMs = metricsDefaultTimeoutMs, token = '' } = {}) {
  if (typeof fetchImpl !== 'function') return null
  const controller = new AbortController()
  let timer = null
  try {
    timer = setTimeout(() => {
      try { controller.abort() } catch {}
    }, Math.max(1, number(timeoutMs, metricsDefaultTimeoutMs)))
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(url, { method: 'GET', headers: headers, signal: controller.signal })
    if (!response || response.ok !== true) return null
    try {
      return await response.json()
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 造一个带 1 秒内存缓存的指标读取器。
 * 轮询间隔 2 秒 > 缓存 1 秒，正常连续轮询最多 1 秒打一次上游；baseUrl 变了缓存自然失效。
 */
export function makeMetricsReader({
  getBaseUrl,
  getToken = () => '',
  fetchImpl = globalThis.fetch,
  timeoutMs = metricsDefaultTimeoutMs,
  cacheMs = metricsDefaultCacheMs,
  now = Date.now,
  logger = null,
} = {}) {
  let cache = null

  const readConfig = () => {
    let base = ''
    let token = ''
    try { base = String(getBaseUrl?.() ?? '').trim() } catch {}
    try { token = String(getToken?.() ?? '').trim() } catch {}
    return { base: base.replace(/\/+$/, ''), token }
  }

  return {
    async read() {
      const { base, token } = readConfig()
      const nowMs = now()
      if (cache && cache.base === base && nowMs - cache.timestamp < cache.ms) return cache.data
      if (!base) {
        const data = { ok: false, code: 'service_down', hint: '本地 AI 未启动' }
        cache = { base, data, timestamp: now(), ms: cacheMs }
        return data
      }
      const begin = now()
      const [system, task] = await Promise.all([
        fetchOneSide(fetchImpl, `${base}/admin/system`, { timeoutMs, token: token }),
        fetchOneSide(fetchImpl, `${base}/jobs/stats?limit=1`, { timeoutMs, token: token }),
      ])
      const data = mergeMetrics(system, task, Math.max(0, now() - begin))
      if (data.ok !== true) logger?.debug?.('[fish-service] 指标抓取失败：本地 AI 可能未启动')
      cache = { base, data, timestamp: now(), ms: cacheMs }
      return data
    },
    clear() {
      cache = null
    },
  }
}
