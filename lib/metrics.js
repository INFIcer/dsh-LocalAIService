// 本机 AI 性能指标：把 /admin/system 与 /jobs/stats?limit=1 抓成一个固定形状。
//
// 只做数据整形和抓取，不关心 HTTP 路由；宿主路由 /dsh-fish-service/metrics 调用这里。
// 服务端升级多出字段时忽略，缺字段时给中性默认值，任何异常都不向上抛。
// baseUrl / token 由调用方从现有配置解析后传入，不在这里硬编码。

export const 指标超时毫秒 = 1500
export const 指标缓存毫秒 = 1000

const 是对象 = (值) => Boolean(值) && typeof 值 === 'object' && !Array.isArray(值)

const 文本 = (值) => (typeof 值 === 'string' ? 值.trim() : '')

const 数字 = (值, 兜底 = 0) => {
  const 数 = Number(值)
  return Number.isFinite(数) ? 数 : 兜底
}

const 非负数 = (值, 兜底 = 0) => {
  const 数 = 数字(值, NaN)
  return Number.isFinite(数) ? Math.max(0, 数) : 兜底
}

/** 已用 / 总量转整数百分比；总量缺失或为 0 时给 0，不产生 NaN。 */
export function 百分比(已用, 总量) {
  const 用 = 数字(已用, 0)
  const 总 = 数字(总量, 0)
  if (!(总 > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((用 / 总) * 100)))
}

/** 按类型的分桶计数：忽略非对象、非数字和 0，键保持服务端原样。 */
function 计数表(值) {
  const 结果 = {}
  if (!是对象(值)) return 结果
  for (const [键, 数] of Object.entries(值)) {
    const 计数 = Number(数)
    if (Number.isFinite(计数) && 计数 > 0) 结果[String(键)] = Math.trunc(计数)
  }
  return 结果
}

/** /admin/system → gpu / modelsLoaded / service / vision。 */
export function 归一化系统(原始) {
  const 根 = 是对象(原始) ? 原始 : {}
  const gpu = 是对象(根.gpu) ? 根.gpu : {}
  const 已用 = 非负数(gpu.used_mb, 0)
  const 总量 = 非负数(gpu.total_mb, 0)
  const 可用 = gpu.free_mb === undefined || gpu.free_mb === null
    ? Math.max(0, 总量 - 已用)
    : 非负数(gpu.free_mb, Math.max(0, 总量 - 已用))
  const 服务 = 是对象(根.service) ? 根.service : {}
  const 视觉 = 是对象(根.vision) ? 根.vision : {}
  return {
    gpu: {
      name: 文本(gpu.name),
      usedMb: 已用,
      totalMb: 总量,
      freeMb: 可用,
      percent: 百分比(已用, 总量),
    },
    modelsLoaded: Array.isArray(根.models_loaded)
      ? 根.models_loaded.map(文本).filter(Boolean)
      : [],
    service: {
      version: 文本(服务.version),
      uptimeSeconds: 非负数(服务.uptime_seconds, 0),
    },
    vision: {
      loaded: 视觉.loaded === true,
      ready: 视觉.ready === true,
    },
  }
}

/** /jobs/stats → queue / scheduler；优先顶层 queued_by_kind，兼容 by_kind.queued 嵌套。 */
export function 归一化任务(原始) {
  const 根 = 是对象(原始) ? 原始 : {}
  const 历史分桶 = 是对象(根.by_kind) ? 根.by_kind : {}
  const 排队源 = 是对象(根.queued_by_kind) ? 根.queued_by_kind : 历史分桶.queued
  const 运行源 = 是对象(根.running_by_kind) ? 根.running_by_kind : 历史分桶.running
  const 调度 = 是对象(根.scheduler) ? 根.scheduler : {}
  return {
    queue: {
      queued: 非负数(根.queued, 0),
      running: 非负数(根.running, 0),
      queuedByKind: 计数表(排队源),
      runningByKind: 计数表(运行源),
    },
    scheduler: {
      currentKind: 文本(调度.current_kind),
      loadedModel: 文本(调度.loaded_model),
    },
  }
}

/** 两侧都失败才算服务离线；只有一侧成功时另一侧用中性默认值。 */
export function 合并指标(系统原始, 任务原始, 耗时) {
  if (!系统原始 && !任务原始) {
    return { ok: false, code: 'service_down', hint: '本地 AI 未启动' }
  }
  return {
    ok: true,
    ms: 非负数(耗时, 0),
    ...归一化系统(系统原始),
    ...归一化任务(任务原始),
  }
}

/**
 * 抓一个本机接口：超时用 AbortController，非 2xx、解析失败、网络错误一律返回 null。
 * 用 null 表示「这一侧没拿到」，让 合并指标 能区分单侧失败和两侧全挂。
 */
export async function 抓一侧(fetchImpl, url, { timeoutMs = 指标超时毫秒, token = '' } = {}) {
  if (typeof fetchImpl !== 'function') return null
  const 控制器 = new AbortController()
  let 定时器 = null
  try {
    定时器 = setTimeout(() => {
      try { 控制器.abort() } catch {}
    }, Math.max(1, 数字(timeoutMs, 指标超时毫秒)))
    const 头 = { accept: 'application/json' }
    if (token) 头.authorization = `Bearer ${token}`
    const 响应 = await fetchImpl(url, { method: 'GET', headers: 头, signal: 控制器.signal })
    if (!响应 || 响应.ok !== true) return null
    try {
      return await 响应.json()
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    if (定时器 !== null) clearTimeout(定时器)
  }
}

/**
 * 造一个带 1 秒内存缓存的指标读取器。
 * 轮询间隔 2 秒 > 缓存 1 秒，正常连续轮询最多 1 秒打一次上游；baseUrl 变了缓存自然失效。
 */
export function 造指标读取器({
  getBaseUrl,
  getToken = () => '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 指标超时毫秒,
  cacheMs = 指标缓存毫秒,
  now = Date.now,
  logger = null,
} = {}) {
  let 缓存 = null

  const 读配置 = () => {
    let 底座 = ''
    let 令牌 = ''
    try { 底座 = String(getBaseUrl?.() ?? '').trim() } catch {}
    try { 令牌 = String(getToken?.() ?? '').trim() } catch {}
    return { 底座: 底座.replace(/\/+$/, ''), 令牌 }
  }

  return {
    async read() {
      const { 底座, 令牌 } = 读配置()
      const 现在 = now()
      if (缓存 && 缓存.底座 === 底座 && 现在 - 缓存.时刻 < 缓存.毫秒) return 缓存.数据
      if (!底座) {
        const 数据 = { ok: false, code: 'service_down', hint: '本地 AI 未启动' }
        缓存 = { 底座, 数据, 时刻: now(), 毫秒: cacheMs }
        return 数据
      }
      const 开始 = now()
      const [系统, 任务] = await Promise.all([
        抓一侧(fetchImpl, `${底座}/admin/system`, { timeoutMs, token: 令牌 }),
        抓一侧(fetchImpl, `${底座}/jobs/stats?limit=1`, { timeoutMs, token: 令牌 }),
      ])
      const 数据 = 合并指标(系统, 任务, Math.max(0, now() - 开始))
      if (数据.ok !== true) logger?.debug?.('[fish-service] 指标抓取失败：本地 AI 可能未启动')
      缓存 = { 底座, 数据, 时刻: now(), 毫秒: cacheMs }
      return 数据
    },
    clear() {
      缓存 = null
    },
  }
}
