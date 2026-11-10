// fish_describe_image：单张/多张本机图片理解（Qwen2.5-VL），返回文字描述与耗时。
import { makeTool, outputSchema, requireEnum, requireFiles, safe } from './shared.js'

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
        prompt: { type: 'string', description: '可选提示词；会覆盖默认的图片描述要求。' },
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
            parsed: { type: 'object', additionalProperties: true, properties: {} },
            ms: { type: 'number' },
          },
        },
      },
      ms: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const paths = requireFiles(args.paths, { field: 'paths', max: 10 })
      const mode = requireEnum(args.mode, { field: 'mode', allowed: 模式, fallback: 'caption' })
      const prompt = args.prompt == null ? undefined : String(args.prompt).slice(0, 4000)
      return api.visionDescribe(paths, { mode, ...(prompt ? { prompt } : {}) })
    }, { api, logger, name: 'fish_describe_image' }),
  })
}
