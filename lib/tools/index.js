// 9 个 Agent 工具的统一注册。
//
// 工具**始终注册**（即使服务没装/没起）：Agent 需要能诊断“为什么不能用”；
// 具体失败由 execute 返回结构化 {ok:false, code, hint}，不抛裸异常。

import { makeTtsTool } from './tts.js'
import { makeAsrTool } from './asr.js'
import { makeTranslateTool } from './translate.js'
import { makeSeparateTool } from './separate.js'
import { makeVisionTool } from './vision.js'
import { makeDescribeImageTool } from './describe.js'
import { makeMediaProbeTool } from './media.js'
import { makeJobTool } from './job.js'
import { makeStatusTool } from './status.js'

export const TOOL_NAMES = Object.freeze([
  'fish_tts',
  'fish_asr',
  'fish_translate',
  'fish_separate',
  'fish_vision_frames',
  'fish_describe_image',
  'fish_media_probe',
  'fish_job',
  'fish_service_status',
])

/** 造 9 个工具定义（不注册，方便单测）。 */
export function buildToolDefinitions({ api, logger }) {
  return [
    makeTtsTool({ api, logger }),
    makeAsrTool({ api, logger }),
    makeTranslateTool({ api, logger }),
    makeSeparateTool({ api, logger }),
    makeVisionTool({ api, logger }),
    makeDescribeImageTool({ api, logger }),
    makeMediaProbeTool({ api, logger }),
    makeJobTool({ api, logger }),
    makeStatusTool({ api, logger }),
  ]
}

/**
 * 注册到宿主；返回 disposer（调用一次摘掉全部）。
 * 宿主 API 不存在时安静跳过，插件仍可用 fish.service。
 */
export function registerTools(ctx, { api, logger }) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn('宿主没有 ctx.tools，跳过 9 个工具注册（fish.service 仍然可用）')
    return () => {}
  }
  const summary = []
  for (const define of buildToolDefinitions({ api, logger })) {
    try {
      const disposer = ctx.tools.register(define)
      if (typeof disposer === 'function') summary.push(disposer)
    } catch (error) {
      logger?.error(`工具 ${define.name} 注册失败：${error?.message || error}`)
    }
  }
  return () => {
    for (const fn of summary.splice(0)) {
      try { fn() } catch { /* 已卸载 */ }
    }
  }
}
