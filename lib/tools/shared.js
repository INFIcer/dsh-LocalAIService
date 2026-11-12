// 工具层公共件：schema 写法、统一 render、安全包装、轻量参数校验。
//
// DSH 的 defineTool 只接受「参数属性表 + type/enum/default/description」这个子集，
// 不支持 minLength/minItems/minimum 之类的关键字；所以限制写进 description，
// 真正的上限在 execute 里校验（工具层 + fish.service 双重校验）。

import { makeError, toPublicError } from '../errors.js'

/** 统一把结果渲染成文本（JSON），不塞 base64。 */
export function renderJson(value) {
  try {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  } catch {
    return [{ type: 'text', text: String(value) }]
  }
}

/** 宽松输出 schema：字段写清楚，但允许失败包多带诊断字段。 */
export function outputSchema(properties = {}) {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', description: '是否成功' },
      code: { type: 'string', description: '失败时的错误码' },
      hint: { type: 'string', description: '可直接展示给人看的中文提示' },
      ...properties,
    },
  }
}

/** 组装一个 DSH 工具定义（不依赖宿主 defineTool，parameters 已是原始 JSON Schema）。 */
export function makeTool({ name, description, parameters, output, execute, render }) {
  return {
    name,
    description,
    parameters: parameters || { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: output || outputSchema(),
      render: render || ((_args, value) => renderJson(value)),
    },
    execute,
  }
}

/** 失败不抛裸异常：统一转成 {ok:false, code, hint, ...}。 */
export function safe(execute, { api, logger, name }) {
  return async (args, exec) => {
    try {
      return await execute(args || {}, exec)
    } catch (error) {
      try { api?.recordError?.(error, name) } catch { /* 记录失败不影响返回 */ }
      logger?.warn?.(`工具 ${name} 失败：${error?.code || ''} ${error?.message || error}`)
      return toPublicError(error)
    }
  }
}

const isText = (raw) => typeof raw === 'string'

/** 文本数组校验（1~max 条，每条 ≤5000 字）。 */
export function requireTexts(value, { field = 'texts', max = 20 } = {}) {
  const array = isText(value) ? [value] : (Array.isArray(value) ? value : null)
  if (!array) {
    throw makeError('bad_request', { detail: `${field} 必须是字符串数组`, hint: `请求参数有误：「${field}」须为字符串数组。` })
  }
  if (array.length === 0) {
    throw makeError('bad_request', { detail: `${field} 为空`, hint: `请求参数有误：「${field}」不能为空。` })
  }
  if (array.length > max) {
    throw makeError('bad_request', {
      detail: `${field} 一次最多 ${max} 条，收到 ${array.length} 条`,
      hint: `请求参数有误：一次最多 ${max} 条，请分批处理。`,
    })
  }
  for (const item of array) {
    if (!isText(item)) {
      throw makeError('bad_request', { detail: `${field} 里有非字符串`, hint: `请求参数有误：「${field}」中的每一项都必须是字符串。` })
    }
    if (!item.length) {
      throw makeError('bad_request', { detail: `${field} 里有空字符串`, hint: `请求参数有误：「${field}」中不能有空字符串。` })
    }
    if (item.length > 5000) {
      throw makeError('bad_request', {
        detail: `${field} 里有 ${item.length} 字的条目`,
        hint: '请求参数有误：单条文本最多 5000 字，请分段。',
      })
    }
  }
  return array
}

/** 本机文件数组校验（只做类型/数量；存在性与大小由 fish.service 再查）。 */
export function requireFiles(value, { field = 'files', max = 10 } = {}) {
  const array = isText(value) ? [value] : (Array.isArray(value) ? value : null)
  if (!array) {
    throw makeError('bad_request', { detail: `${field} 必须是路径数组`, hint: `请求参数有误：「${field}」须为本机绝对路径数组。` })
  }
  if (array.length === 0) {
    throw makeError('bad_request', { detail: `${field} 为空`, hint: `请求参数有误：「${field}」不能为空。` })
  }
  if (array.length > max) {
    throw makeError('bad_request', {
      detail: `${field} 一次最多 ${max} 个，收到 ${array.length} 个`,
      hint: `请求参数有误：一次最多 ${max} 个文件，请分批处理。`,
    })
  }
  for (const item of array) {
    if (!isText(item) || !item.trim()) {
      throw makeError('bad_request', { detail: `${field} 里有空路径`, hint: `请求参数有误：「${field}」中不能有空路径。` })
    }
  }
  return array
}

/** 一个必填字符串。 */
export function requireString(value, { field = 'value', max = 5000 } = {}) {
  const raw = isText(value) ? value : (value == null ? '' : String(value))
  if (!raw.trim()) {
    throw makeError('bad_request', { detail: `${field} 为空`, hint: `请求参数有误：「${field}」不能为空。` })
  }
  if (raw.length > max) {
    throw makeError('bad_request', { detail: `${field} 超过 ${max} 字`, hint: `请求参数有误：「${field}」过长。` })
  }
  return raw
}

/** 枚举校验。 */
export function requireEnum(value, { field = 'value', allowed = [], fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  if (!allowed.includes(value)) {
    throw makeError('bad_request', {
      detail: `${field}=${value} 不在 ${allowed.join('/')}`,
      hint: `请求参数有误：「${field}」只能取 ${allowed.join(' / ')}。`,
    })
  }
  return value
}

/** 整数范围校验。 */
export function requireInt(value, { field = 'value', min = 0, max = 100, fallback = undefined } = {}) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw makeError('bad_request', { detail: `${field}=${value}`, hint: `请求参数有误：「${field}」须为 ${min}~${max} 之间的整数。` })
  }
  return n
}

/** 布尔（宽松接受 true/false/1/0）。 */
export function requireBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}
