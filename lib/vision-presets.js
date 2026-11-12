// 识图提示词分档：一套固定的内置文案 + 档位/预设的规范化。
//
// 为什么单独一个文件：配置层（默认值/校验）、服务层（visionDescribe）、
// 宿主路由（describe-upload）、工具层（fish_describe_image）都要用同一套档位，
// 放在这里避免各层各写一份、改文案时漏掉。没有依赖，也不会形成循环引用。
//
// 口径：工具识图按档位取提示词；会话识图的按钮用单独一项 visionSessionPrompt，
// 其内置默认与「详细」档完全一致（默认会话识图提示 直接引用它，不另写一份）。

/** 四个档位 id（顺序固定：设置页下拉、工具描述都按这个顺序）。 */
export const visionPreset = Object.freeze(['brief', 'standard', 'detailed', 'text'])

/** 档位的中文名；工具参数也接受这些名字。 */
export const visionPresetLabel = Object.freeze({
  brief: '简短',
  standard: '标准',
  detailed: '详细',
  text: '只看文字',
})

/** 单条提示词长度上限（与契约里 prompt 覆盖的上限一致）。 */
export const visionPromptLimit = 4000

/** 内置默认提示词；配置里某一档为空串时用它。 */
export const defaultVisionPrompt = Object.freeze({
  brief: '请用一两句简洁的中文描述这张图片里有什么：主要对象、场景和正在发生的事。只写描述，不要评分，不要输出 JSON。',
  standard: '请用一段话把这张图片说清楚：主体是什么、在什么场景、正在发生什么事，再补充画面里值得注意的细节。只写描述，不要评价，不要编造，不要输出 JSON。',
  detailed: '请按下面的分条要求描述这张图片，只写看到的内容，不要评价、不要猜测、不要编造：\n'
    + '1. 主体与人物：外貌、服装、表情、动作、数量、位置；\n'
    + '2. 场景与环境：室内还是室外、地点、环境细节；\n'
    + '3. 关键物体与界面元素：画面里重要的物体、按钮、图标、文字框等；\n'
    + '4. 画面文字：逐字照抄图片中的文字并注明位置；没有文字就写「没有文字」；\n'
    + '5. 颜色、光线与构图：主色调、光线方向与明暗、拍摄角度与构图。\n'
    + '用中文回答，不要输出 JSON。',
  text: '请识别并原样输出图片中的文字，保留原有换行；没有文字就写「没有文字」。只输出识别结果，不要评分，不要输出 JSON。',
})

/** 会话识图（输入框旁按钮）的内置提示词：与「详细」工具档一致。 */
export const defaultSessionVisionPrompt = defaultVisionPrompt.detailed

/** 档位 id 或中文名 → 档位 id；认不出返回 null。 */
export function detectPreset(value) {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  if (visionPreset.includes(name)) return name
  for (const preset of visionPreset) {
    if (visionPresetLabel[preset] === value.trim()) return preset
  }
  return null
}

/** 档位 id / 中文名 → 合法档位 id；认不出回退兜底。 */
export function normalizePreset(value, fallback = 'detailed') {
  return detectPreset(value) || fallback
}

/**
 * 把配置里的 visionPresets 规范成四键对象。
 * - 缺字段或非字符串 → 补内置默认（旧配置自动补默认，不报错）；
 * - 空串保留（运行时按内置默认处理，设置页「恢复默认」也靠它）；
 * - 只认四个键，超长截断。
 * @param {unknown} 值 - 配置里的 visionPresets。
 * @returns {Record<string, string>}
 */
export function normalizeVisionPresets(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const output = {}
  for (const preset of visionPreset) {
    const orig = source[preset]
    output[preset] = typeof orig === 'string' ? orig.trim().slice(0, visionPromptLimit) : defaultVisionPrompt[preset]
  }
  return output
}

/**
 * 设置页保存时的提示词补丁：在现有预设上只覆盖四个档位里的字符串值。
 * 其它键、非字符串值忽略；有忽略项时由调用方给用户一句提示。
 * @returns {{value: Record<string, string>, accepted: boolean, ignored: boolean}}
 */
export function mergeVisionPresets(patch, current) {
  const base = normalizeVisionPresets(current)
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null
  if (!source) return { value: base, accepted: false, ignored: true }
  const output = { ...base }
  let accept = 0
  let ignore = 0
  for (const [key, value] of Object.entries(source)) {
    if (!visionPreset.includes(key) || typeof value !== 'string') {
      ignore += 1
      continue
    }
    output[key] = value.trim().slice(0, visionPromptLimit)
    accept += 1
  }
  return { value: output, accepted: accept > 0, ignored: ignore > 0 }
}

/**
 * 取某一档最终要发给服务的提示词：配置里有非空自定义就用它，否则用内置默认。
 * @param {string} 档位 - 档位 id 或中文名。
 * @param {unknown} 预设 - 配置里的 visionPresets。
 */
export function fetchPresetPrompt(presetLevel, presets) {
  const id = normalizePreset(presetLevel)
  const source = presets && typeof presets === 'object' && !Array.isArray(presets) ? presets : {}
  const custom = source[id]
  if (typeof custom === 'string' && custom.trim()) return custom.trim().slice(0, visionPromptLimit)
  return defaultVisionPrompt[id]
}
