// 工具输出 schema 一致性：用工具真实返回跑一遍 DSH 实际使用的 JSON Schema 子集。
// 目的：防止 schema 声明得比真实返回更窄（否则调用即报错，fish_job.result / describe.parsed 就出过这种）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildToolDefinitions } from '../lib/tools/index.js'

// 只断言宿主实际会检查的关键字；没写 type 视为任意 JSON（job.result、describe.parsed 正是如此）。
function validate(shape, value, path = '$') {
  assert.equal(typeof shape, 'object', `${path} 的 schema 缺失`)
  if (shape.type === 'object') {
    assert.equal(typeof value, 'object', `${path} 应为 object，实际是 ${typeof value}`)
    assert.ok(value !== null && !Array.isArray(value), `${path} 应为 object`)
    for (const key of shape.required || []) assert.ok(key in value, `${path} 缺必填字段 ${key}`)
    const prop = shape.properties || {}
    if (shape.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(key in prop, `${path} 多出未声明字段 ${key}`)
    }
    for (const [key, childShape] of Object.entries(prop)) {
      if (key in value) validate(childShape, value[key], `${path}.${key}`)
    }
    return
  }
  if (shape.type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为 array`)
    if (shape.items) value.forEach((item, order) => validate(shape.items, item, `${path}[${order}]`))
    return
  }
  if (shape.type === 'string') assert.equal(typeof value, 'string', `${path} 应为 string`)
  else if (shape.type === 'number') assert.equal(typeof value, 'number', `${path} 应为 number`)
  else if (shape.type === 'integer') assert.ok(Number.isInteger(value), `${path} 应为 integer`)
  else if (shape.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} 应为 boolean`)
}

function makeTool(api) {
  const defs = buildToolDefinitions({ api, logger: null })
  return new Map(defs.map((define) => [define.name, define]))
}

const fakeService = {
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
    items: paths.map((path) => ({ path: path, text: '一只猫', parsed: '{"heads":1}', ms: 3 })),
    ms: 3,
  }),
}

test('每个工具的输出 schema 顶层都是宽松 object', () => {
  const table = makeTool(fakeService)
  assert.equal(table.size, 9)
  for (const define of table.values()) {
    assert.equal(define.output.schema.type, 'object', define.name)
    assert.equal(define.output.schema.additionalProperties, true, define.name)
  }
})

test('fish_job：上游任务结果是数组 / 字符串时也不违反输出 schema', async () => {
  const job = makeTool(fakeService).get('fish_job')

  const arrayResult = await job.execute({ action: 'status', jobId: 'j1' }, {})
  assert.equal(arrayResult.ok, true)
  assert.ok(Array.isArray(arrayResult.result))
  validate(job.output.schema, arrayResult)

  const scalarResult = await job.execute({ action: 'wait', jobId: 'j1' }, {})
  assert.equal(scalarResult.result, '纯文本结果')
  validate(job.output.schema, scalarResult)

  const list = await job.execute({ action: 'list' }, {})
  validate(job.output.schema, list)
})

test('fish_describe_image：parsed 是字符串 / 数组时也不违反输出 schema', async () => {
  const describe = makeTool(fakeService).get('fish_describe_image')

  const textResult = await describe.execute({ paths: ['C:\\a.png'] }, {})
  assert.equal(typeof textResult.items[0].parsed, 'string')
  validate(describe.output.schema, textResult)

  const array = await describe.execute({ paths: ['C:\\a.png'] }, {})
  array.items[0].parsed = [1, 2, 3]
  validate(describe.output.schema, array)
})
