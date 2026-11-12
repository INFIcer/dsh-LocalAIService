// fish_describe_image：单张/多张本机图片理解（Qwen2.5-VL），返回文字描述与耗时。
import { makeTool, outputSchema, requireEnum, requireFiles, safe } from './shared.js'
import { makeError } from '../errors.js'
import { 识别档位 } from '../vision-presets.js'

const 模式 = ['caption', 'score', 'ocr']

export function makeDescribeImageTool({ api, logger }) {
  return makeTool({
    name: 'fish_describe_image',
    description: '理解本机图片：描述图片里有什么（caption）、给画面评分（score）或识别图中文字（ocr）。一次最多 10 张，返回文字结果与耗时，不返回图片本体。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '本机图片绝对路径，或路径数组（1~10 张，支持 JPG/PNG/WebP/GIF/BMP）。',
        },
        mode: { type: 'string', enum: 模式, description: '理解方式：caption 描述图片内容（默认）、score 画面评分、ocr 识别文字。' },
        detail: {
          type: 'string',
          description: '描述详细程度：brief（简短）、standard（标准）、detailed（详细）、text（只看文字）；也接受中文档位名。不传时用设置里的默认档（默认详细）。',
        },
        prompt: { type: 'string', description: '可选提示词；会覆盖档位提示词。' },
      },
      required: ['paths'],
    },
    output: outputSchema({
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            path: { type: 'string' },
            text: { type: 'string' },
            // 服务端能解析出 JSON 时原样返回，可能是对象、数组或标量。
            parsed: { description: '服务端能解析出 JSON 时原样返回；形态不固定。' },
            ms: { type: 'number' },
          },
        },
      },
      ms: { type: 'number' },
    }),
    execute: safe(async (args) => {
      // localDescribe 是本地识图总开关：关了就不再让 Agent 走识图，而不是只把提示词摘掉。
      const 配置 = api?.config?.get?.() || {}
      if (配置.localDescribe === false) {
        throw makeError('not_supported', {
          detail: 'config.localDescribe=false',
          hint: '本地识图已在「设置 → 插件 → 本地 AI」中关闭，请让用户打开后再试。',
        })
      }
      const paths = requireFiles(args.paths, { field: 'paths', max: 10 })
      const mode = requireEnum(args.mode, { field: 'mode', allowed: 模式, fallback: 'caption' })
      const detail = 识别档位(args.detail)
      const prompt = args.prompt == null ? undefined : String(args.prompt).slice(0, 4000)
      return api.visionDescribe(paths, {
        mode,
        ...(detail ? { preset: detail } : {}),
        ...(prompt ? { prompt } : {}),
      })
    }, { api, logger, name: 'fish_describe_image' }),
  })
}
