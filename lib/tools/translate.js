// fish_translate：批量翻译（NLLB），返回顺序与输入严格一致。
import { makeTool, outputSchema, requireTexts, safe } from './shared.js'
import { makeError } from '../errors.js'

const 最大总字数 = 200000

export function makeTranslateTool({ api, logger }) {
  return makeTool({
    name: 'fish_translate',
    description: '批量翻译文字（1~200 条，每条不超过 5000 字，总计不超过 20 万字），返回顺序与输入一致。不填 target 时按设置里的第一/第二语言自动选择目标；源语言默认自动判断，文本很短时建议明确指定。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: '要翻译的文本（1~200 条，每条不超过 5000 字，总计不超过 20 万字）。',
        },
        source: { type: 'string', description: '源语言；auto 表示自动判断。' },
        target: { type: 'string', description: '目标语言，如 zh、en、ja、ko、yue；不填则按第一/第二语言自动选择，不能为 auto。' },
      },
      required: ['texts'],
    },
    output: outputSchema({
      texts: { type: 'array', items: { type: 'string' } },
      source: { type: 'string' },
      target: { type: 'string' },
      engine: { type: 'string' },
      ms: { type: 'number' },
      chunks: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const texts = requireTexts(args.texts, { max: 200 })
      const total = texts.reduce((和, x) => 和 + x.length, 0)
      if (total > 最大总字数) {
        throw makeError('bad_request', {
          detail: `总字数 ${total} 超过 ${最大总字数}`,
          hint: '请求参数有误：一次最多 20 万字，请分批处理。',
        })
      }
      const target = args.target == null ? '' : String(args.target).trim()
      if (target.toLowerCase() === 'auto') {
        throw makeError('bad_request', { detail: 'target=auto', hint: '请求参数有误：目标语言不能为 auto。' })
      }
      const source = args.source ? String(args.source) : 'auto'
      return api.translate(texts, { source, ...(target ? { target } : {}) })
    }, { api, logger, name: 'fish_translate' }),
  })
}
