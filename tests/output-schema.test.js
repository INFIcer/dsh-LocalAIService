// 工具输出 schema 一致性：用工具真实返回跑一遍 DSH 实际使用的 JSON Schema 子集。
// 目的：防止 schema 声明得比真实返回更窄（否则调用即报错，fish_job.result / describe.parsed 就出过这种）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildToolDefinitions } from '../lib/tools/index.js'

// 只断言宿主实际会检查的关键字；没写 type 视为任意 JSON（job.result、describe.parsed 正是如此）。
function 校验(结构, 值, 路径 = '$') {
  assert.equal(typeof 结构, 'object', `${路径} 的 schema 缺失`)
  if (结构.type === 'object') {
    assert.equal(typeof 值, 'object', `${路径} 应为 object，实际是 ${typeof 值}`)
    assert.ok(值 !== null && !Array.isArray(值), `${路径} 应为 object`)
    for (const 键 of 结构.required || []) assert.ok(键 in 值, `${路径} 缺必填字段 ${键}`)
    const 属性 = 结构.properties || {}
    if (结构.additionalProperties === false) {
      for (const 键 of Object.keys(值)) assert.ok(键 in 属性, `${路径} 多出未声明字段 ${键}`)
    }
    for (const [键, 子结构] of Object.entries(属性)) {
      if (键 in 值) 校验(子结构, 值[键], `${路径}.${键}`)
    }
    return
  }
  if (结构.type === 'array') {
    assert.ok(Array.isArray(值), `${路径} 应为 array`)
    if (结构.items) 值.forEach((项, 序) => 校验(结构.items, 项, `${路径}[${序}]`))
    return
  }
  if (结构.type === 'string') assert.equal(typeof 值, 'string', `${路径} 应为 string`)
  else if (结构.type === 'number') assert.equal(typeof 值, 'number', `${路径} 应为 number`)
  else if (结构.type === 'integer') assert.ok(Number.isInteger(值), `${路径} 应为 integer`)
  else if (结构.type === 'boolean') assert.equal(typeof 值, 'boolean', `${路径} 应为 boolean`)
}

function 造工具(api) {
  const defs = buildToolDefinitions({ api, logger: null })
  return new Map(defs.map((定义) => [定义.name, 定义]))
}

const 假服务 = {
  config: { get: () => ({}) },
  recordError() {},
  jobs: {
    status: async (id) => ({ ok: true, id, kind: 'tts', state: 'done', result: [{ path: 'C:\\cache\\a.wav' }] }),
    wait: async (id) => ({ ok: true, id, state: 'done', result: '纯文本结果' }),
    cancel: async (id) => ({ ok: true, id, state: 'canceled' }),
    list: async () => ({ ok: true, total: 1, jobs: [{ id: 'j1', kind: 'tts', state: 'done' }] }),
  },
  visionDescribe: async (paths) => ({
    ok: true,
    items: paths.map((路径) => ({ path: 路径, text: '一只猫', parsed: '{"heads":1}', ms: 3 })),
    ms: 3,
  }),
}

test('每个工具的输出 schema 顶层都是宽松 object', () => {
  const 表 = 造工具(假服务)
  assert.equal(表.size, 9)
  for (const 定义 of 表.values()) {
    assert.equal(定义.output.schema.type, 'object', 定义.name)
    assert.equal(定义.output.schema.additionalProperties, true, 定义.name)
  }
})

test('fish_job：上游任务结果是数组 / 字符串时也不违反输出 schema', async () => {
  const job = 造工具(假服务).get('fish_job')

  const 数组结果 = await job.execute({ action: 'status', jobId: 'j1' }, {})
  assert.equal(数组结果.ok, true)
  assert.ok(Array.isArray(数组结果.result))
  校验(job.output.schema, 数组结果)

  const 标量结果 = await job.execute({ action: 'wait', jobId: 'j1' }, {})
  assert.equal(标量结果.result, '纯文本结果')
  校验(job.output.schema, 标量结果)

  const 列表 = await job.execute({ action: 'list' }, {})
  校验(job.output.schema, 列表)
})

test('fish_describe_image：parsed 是字符串 / 数组时也不违反输出 schema', async () => {
  const describe = 造工具(假服务).get('fish_describe_image')

  const 字符串 = await describe.execute({ paths: ['C:\\a.png'] }, {})
  assert.equal(typeof 字符串.items[0].parsed, 'string')
  校验(describe.output.schema, 字符串)

  const 数组 = await describe.execute({ paths: ['C:\\a.png'] }, {})
  数组.items[0].parsed = [1, 2, 3]
  校验(describe.output.schema, 数组)
})
