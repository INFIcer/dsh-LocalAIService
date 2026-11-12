// fish_separate：人声分离（Demucs），stems 复制到 cacheDir。
import { makeTool, outputSchema, requireEnum, requireString, safe } from './shared.js'
import { makeError } from '../errors.js'

const modelChoices = ['htdemucs', 'htdemucs_6s', 'htdemucs_ft']
const stem = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']

export function makeSeparateTool({ api, logger }) {
  return makeTool({
    name: 'fish_separate',
    description: '把音频或视频分离为不同音轨（默认人声、鼓、贝斯与其它），产物保存在本机并返回文件路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '本机绝对路径；音频或视频，不超过 200MB。' },
        model: { type: 'string', enum: modelChoices, description: '分离方式；默认已包含人声、鼓、贝斯与其它，需要吉他与钢琴时另选。' },
        stems: {
          type: 'array',
          items: { type: 'string', enum: stem },
          description: '要输出的音轨；默认包含人声、鼓、贝斯与其它。',
        },
      },
      required: ['file'],
    },
    output: outputSchema({
      stems: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      dir: { type: 'string' },
      ms: { type: 'number' },
      released: { type: 'array', items: { type: 'string' } },
    }),
    execute: safe(async (args) => {
      const file = requireString(args.file, { field: 'file', max: 4096 })
      const model = requireEnum(args.model, { field: 'model', allowed: modelChoices, fallback: 'htdemucs' })
      let stems
      if (args.stems !== undefined) {
        if (!Array.isArray(args.stems) || args.stems.length === 0) {
          throw makeError('bad_request', { detail: 'stems 不是非空数组', hint: '请求参数有误：音轨列表不能为空。' })
        }
        for (const stemName of args.stems) {
          if (!stem.includes(stemName)) {
            throw makeError('bad_request', { detail: `未知 stem ${stemName}`, hint: `请求参数有误：音轨只能取 ${stem.join(' / ')}。` })
          }
        }
        stems = args.stems.slice()
      }
      return api.separate(file, { model, ...(stems ? { stems } : {}) })
    }, { api, logger, name: 'fish_separate' }),
  })
}
