// fish_service_status：永远可调的只读诊断工具。
// 服务不可达时仍然返回 baseUrl / 最近错误 / 手动启动提示，方便 Agent 解释“为什么不能用”。
import { makeTool, outputSchema, safe } from './shared.js'

const capabilityLabelZh = {
  tts: '文字转语音',
  asr: '语音识别',
  translate: '翻译',
  separate: '人声分离',
  vision: '视觉关键帧',
  media: '媒体探测',
  download: '下载',
  jobs: '任务队列',
}

function capabilityDigest(caps) {
  const output = {}
  for (const [name, info] of Object.entries(caps || {})) {
    output[name] = {
      available: Boolean(info?.available),
      ready: Boolean(info?.ready),
      loaded: Boolean(info?.loaded),
      ...(info?.model ? { model: info.model } : {}),
      ...(info?.reason ? { reason: info.reason } : {}),
      ...(info?.estimateMb != null ? { estimateMb: info.estimateMb } : {}),
      title: capabilityLabelZh[name] || name,
    }
  }
  return output
}

export function makeStatusTool({ api, logger }) {
  return makeTool({
    name: 'fish_service_status',
    description: '查看本地 AI 的状态：是否在运行、响应快慢、各项能力与音色是否可用及原因，并给出最近一次错误。未启动时也可调用，会说明如何启动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: outputSchema({
      baseUrl: { type: 'string' },
      version: { type: 'string' },
      apiVersion: { type: 'string' },
      latencyMs: { type: 'number' },
      vram: { type: 'object', additionalProperties: true, properties: {} },
      capabilities: { type: 'object', additionalProperties: true, properties: {} },
      voices: { type: 'array', items: { type: 'string' } },
      install: { type: 'object', additionalProperties: true, properties: {} },
      autostart: { type: 'object', additionalProperties: true, properties: {} },
      lastError: { type: 'object', additionalProperties: true, properties: {} },
    }),
    execute: safe(async () => {
      const health = await api.health({ timeoutMs: 3000 })
      let caps = health.capabilities
      if (!caps) {
        try { caps = api.capabilities || {} } catch { caps = {} }
      }
      let voice = []
      try {
        voice = (await api.voices()).map((x) => x.name).filter(Boolean)
      } catch { /* 服务没起时拿不到音色，不影响诊断 */ }

      let install = { ok: false, code: 'not_implemented', hint: '暂不支持安装管理。' }
      try { install = await api.install.status() } catch { /* 保持占位 */ }

      const fail = !health.ok
      // lastError 在 output schema 里必须是对象：服务端偶尔回字符串/null，这里统一归一化。
      const rawErr = health.lastError ?? api.lastError ?? null
      const err =
        rawErr && typeof rawErr === 'object'
          ? rawErr
          : rawErr
            ? { code: 'unknown', detail: String(rawErr) }
            : {}
      return {
        ok: health.ok,
        baseUrl: health.baseUrl || api.config.get().baseUrl,
        version: health.serviceVersion || '',
        apiVersion: health.apiVersion || '',
        latencyMs: health.latencyMs || 0,
        ...(health.vram ? { vram: health.vram } : {}),
        capabilities: capabilityDigest(caps),
        voices: voice,
        install,
        autostart: {
          supported: false,
          enabled: false,
          name: 'LocalAIService-Service',
          note: '暂不支持自动启动检测。',
        },
        lastError: err,
        ...(fail
          ? {
              code: err?.code || 'service_down',
              hint: err?.hint || '本地 AI 服务未启动，请先启动服务。',
            }
          : {}),
      }
    }, { api, logger, name: 'fish_service_status' }),
  })
}
