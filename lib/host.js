// dsh-fish-service · 宿主入口
//
// 只做装配：
//   配置 → 客户端 → 能力缓存 → 健康轮询 → fish.service → 9 个工具 → 宿主路由。
// 真正的逻辑都在 lib/ 里，宿主层保持薄，方便离线单测。
//
// 生命周期：插件加载不阻塞 DSH；健康轮询在后台跑；
// ctx.effect 的 cleanup 负责停轮询、停缓存清理、摘工具和路由。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, buildConfigSchema } from './config.js'
import { Logger } from './logger.js'
import { CacheStore } from './cache.js'
import { LocalAIClient } from './client.js'
import { CapabilityService } from './capabilities.js'
import { HealthMonitor } from './health.js'
import { createFishServiceApi } from './service-api.js'
import { TOOL_NAMES, registerTools } from './tools/index.js'
import { registerRoutes } from './routes.js'
import { promptSection } from './prompt.js'

const payloadRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const name = 'fish-service'
export const inject = ['tools', 'webServer']

const version = (() => {
  try {
    return String(JSON.parse(readFileSync(join(payloadRoot, 'package.json'), 'utf8')).version || '0.1.0')
  } catch {
    return '0.1.0'
  }
})()

// schemastery 是可选依赖：拿不到时 Config 为 undefined，插件照常加载（配置仍走 json）。
let schemastery = null
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
} catch {
  // 正常的降级路径，不打印错误。
}
export const Config = schemastery ? buildConfigSchema(schemastery) : undefined

export function apply(ctx, pluginConfig = {}) {
  const homeDir = process.env.DSH_HOME || join(homedir(), '.dsh')
  const configStore = new ConfigStore({ homeDir: homeDir })
  let config = configStore.load(pluginConfig || {})
  const logger = new Logger({ filePath: join(homeDir, 'fish-service.log'), level: config.logLevel })
  // 配置里被丢弃的非法项（如手工改坏的按会话自动朗读）只记日志，不让插件起不来。
  for (const warn of configStore.warnings || []) logger.warn(warn)

  const cache = new CacheStore({
    dir: config.cacheDir,
    ttlHours: config.cacheTtlHours,
    maxMb: config.cacheMaxMb,
    logger,
  })
  cache.init()
  try { cache.cleanup() } catch (error) { logger.warn(`启动时缓存清理失败：${error?.message || error}`) }
  const haltCacheTimer = cache.startAutoCleanup()

  const client = new LocalAIClient({ getConfig: () => configStore.current, logger })
  const capabilities = new CapabilityService({
    client,
    getConfig: () => configStore.current,
    logger,
    ttlMs: 30000,
  })
  const monitor = new HealthMonitor({ capabilities, getConfig: () => configStore.current, logger })

  const api = createFishServiceApi({
    ctx,
    configStore,
    client,
    capabilities,
    cache,
    logger,
    version: version,
    onConfigChange: ({ config: nextConfig }) => {
      config = nextConfig
      logger.setLevel(nextConfig.logLevel)
      // 缓存上限/TTL 是 CacheStore 的实例字段；设置页保存后立即生效，不用重启。
      cache.ttlHours = nextConfig.cacheTtlHours
      cache.maxMb = nextConfig.cacheMaxMb
    },
  })

  // 暴露 Cordis 服务：其它插件用 ctx.get('fish.service') 取。
  try {
    ctx.provide?.('fish.service', api)
  } catch (error) {
    logger.error(`ctx.provide('fish.service') 失败：${error?.message || error}`)
  }

  const haltTool = ctx.effect(() => registerTools(ctx, { api, logger }), 'fish-service: 注册 9 个工具')
  const haltRoute = ctx.effect(() => registerRoutes({
    ctx,
    api,
    configStore,
    capabilities,
    cache,
    logger,
    version: version,
  }), 'fish-service: 注册 /dsh-fish-service 路由')

  const haltHealth = ctx.effect(() => {
    monitor.start()
    return () => monitor.stop()
  }, 'fish-service: 后台健康轮询')

  // 给模型的提示（可选服务）：没有 systemPrompt 就跳过，工具与设置页照常。
  // 段文本每次组装提示词时按当前配置求值，所以关闭「本地识图」立即生效。
  try {
    ctx.inject?.(['systemPrompt'], (scope) => {
      for (const segment of promptSection(() => configStore.current)) {
        scope.systemPrompt.section({
          name: segment.name,
          order: segment.order,
          interpolate: false,
          text: () => segment.text(),
        })
      }
    })
  } catch (error) {
    logger.warn(`注册提示词失败：${error?.message || error}`)
  }

  logger.info(`dsh-fish-service v${version} 已加载｜服务地址 ${config.baseUrl}｜缓存 ${config.cacheDir}｜工具 ${TOOL_NAMES.length} 个`)
  if (configStore.overrides?.length) {
    logger.info(`环境变量覆盖：${configStore.overrides.join(', ')}`)
  }
  if (config.enabled === false) {
    logger.warn('插件当前是停用状态（enabled=false）：工具会返回 service_not_installed，设置页仍可用。')
  }

  async function stop() {
    try { monitor.stop() } catch { /* 已停 */ }
    try { haltCacheTimer?.() } catch { /* 已停 */ }
    for (const halt of [haltHealth, haltTool, haltRoute]) {
      try { if (typeof halt === 'function') halt() } catch { /* 已卸载 */ }
    }
    cache.stopAutoCleanup()
    logger.info('dsh-fish-service 已卸载')
  }

  return {
    api,
    client,
    capabilities,
    cache,
    logger,
    configStore,
    health: monitor,
    stop,
  }
}

export { version as version }
