// fish_tts：文本 → 语音（可批量），产物落 cacheDir，只返回路径与指标。
//
// 结果文字压成一句：界面没有音频附件槽位（见 docs/DSH-CAPABILITIES.md），
// 铺一屏 JSON 只会挤占会话，所以只给一句「生成了什么、文件在哪」。
import { requireInt, requireTexts, makeTool, outputSchema, safe } from './shared.js'
import { makeError } from '../errors.js'

const 语言 = ['auto', 'zh', 'en', 'ja', 'es', 'ar']

/**
 * 把 TTS 结果压成一句中文（失败时给 hint）。
 * @param {object} 值 - fish_tts 的返回值或失败包。
 * @returns {string} 一行文字。
 */
export function 语音摘要(值) {
  if (!值 || 值.ok === false) return String((值 && 值.hint) || '语音生成失败。')
  const 项们 = Array.isArray(值.items) ? 值.items : []
  const 路径们 = 项们.map((项) => String((项 && 项.wavPath) || '')).filter(Boolean)
  if (!路径们.length) return '语音已生成，但服务没有返回文件路径。'
  return `语音已生成（${路径们.length} 段）：${路径们.join('；')}`
}

export function makeTtsTool({ api, logger }) {
  return makeTool({
    name: 'fish_tts',
    description: '把文字转换为语音，可一次合成多条。返回音频文件路径与耗时。首次合成需要加载模型，可能较慢。一次最多 20 条，每条不超过 5000 字。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: '要合成的文本（1~20 条）；单条也传数组。每条不超过 5000 字。',
        },
        voice: { type: 'string', description: '音色名；不填则使用设置里的默认音色。' },
        speed: { type: 'number', description: '语速 0.5~2.0，默认 1.0。' },
        language: { type: 'string', enum: 语言, default: 'auto', description: '语言；auto 表示自动判断。' },
        seed: { type: 'integer', description: '0~4294967295；不传=随机，同一 seed 可复现。' },
      },
      required: ['texts'],
    },
    output: outputSchema({
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            wavPath: { type: 'string' },
            ms: { type: 'number' },
            voice: { type: 'string' },
            seed: { type: 'number' },
            language: { type: 'string' },
            bytes: { type: 'number' },
            cached: { type: 'boolean' },
          },
        },
      },
      ms: { type: 'number' },
    }),
    render: (_args, value) => [{ type: 'text', text: 语音摘要(value) }],
    execute: safe(async (args) => {
      const texts = requireTexts(args.texts, { max: 20 })
      let speed
      if (args.speed !== undefined) {
        speed = Number(args.speed)
        if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
          throw makeError('bad_request', { detail: `speed=${args.speed}`, hint: '请求参数有误：语速须在 0.5~2.0 之间。' })
        }
      }
      const seed = requireInt(args.seed, { field: 'seed', min: 0, max: 4294967295 })
      return api.tts(texts, {
        ...(args.voice ? { voice: String(args.voice) } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(args.language ? { language: args.language } : {}),
        ...(seed !== undefined ? { seed } : {}),
      })
    }, { api, logger, name: 'fish_tts' }),
  })
}
