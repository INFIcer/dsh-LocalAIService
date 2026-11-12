// 给模型的提示段（systemPrompt）：只做两件小事，不接管其它提示。
//
// DSH 的 ctx.systemPrompt.section() 在每次组装提示词时求值 text（可以是函数），
// 求值结果为空串的段会被删掉——所以「本地识图」关掉就等于这段提示不存在，
// 不需要重新注册。interpolate 关掉，文本里的花括号不会被当成变量。

/** 识图提示的段名（同一作用域内不能重名）。 */
export const visionSectionName = 'fish-service:vision'
/** 文件提示的段名。 */
export const fileSectionName = 'fish-service:files'

// 顺序值：DSH 内置段在 -1000~10200 之间；这两段排在工具说明（3100）之后、
// 交付物说明（9000）之前，语气上属于「本地工具怎么用」。
export const visionSectionOrder = 8500
export const fileSectionOrder = 8600

/**
 * 识图提示：开启「本地识图」时让模型优先走本机视觉模型。
 * @param {object|null} 配置 - 当前配置（缺字段按开启处理）。
 * @returns {string} 提示文本；关闭时为空串（该段会被删掉）。
 */
export function visionPrompt(config) {
  if (config && config.localDescribe === false) return ''
  return '需要看图时优先调用 fish_describe_image 在本机识别，把返回的文字当结果用；'
    + '只有它不可用（模型未就绪等）时，才自己看图。'
}

/**
 * 文件提示：语音等产物要让用户拿到文件本身时，用 present 展示成文件卡片。
 * @returns {string} 提示文本。
 */
export function fileHint() {
  return '生成语音或其它文件后，如果用户要的是文件本身（想听、想下载），'
    + '用 present 把路径展示成文件卡片，不要只在回复里写路径。'
}

/**
 * 供宿主注册用：段定义列表（text 每次都重新取配置，改设置立即生效）。
 * @param {() => object} 取配置 - 返回当前配置的函数。
 */
export function promptSection(fetchConfig = () => ({})) {
  return [
    { name: visionSectionName, order: visionSectionOrder, text: () => visionPrompt(fetchConfig() || {}) },
    { name: fileSectionName, order: fileSectionOrder, text: () => fileHint() },
  ]
}
