// 系统提示段：识图开关、文件提示、段名与顺序、动态读配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  promptSection,
  fileHint,
  fileSectionName,
  fileSectionOrder,
  visionPrompt,
  visionSectionName,
  visionSectionOrder,
} from '../lib/prompt.js'

test('识图提示：图能直接看到就不重复识别，只在拿不到画面时才用本机识图', () => {
  for (const config of [{ localDescribe: true }, {}, undefined, null]) {
    const text = visionPrompt(config)
    assert.match(text, /fish_describe_image/, JSON.stringify(config))
    assert.match(text, /本机/)
    // 用户发进对话的图本来就在上下文里，提示不能再鼓励「优先调用」。
    assert.match(text, /不要再用/)
    assert.match(text, /拿不到画面/)
    assert.equal(text.includes('{{'), false, '提示词里不能出现插值语法')
  }
  assert.equal(visionPrompt({ localDescribe: false }), '')
  // 只有明确 false 才算关：旧配置缺字段仍是开。
  assert.equal(visionPrompt({ localDescribe: undefined }) === '', false)
})

test('文件提示：引导用 present 交付文件，不提内部实现', () => {
  const text = fileHint()
  assert.match(text, /present/)
  assert.match(text, /路径/)
  assert.equal(text.includes('{{'), false)
})

test('提示段：两个段的顺序在工具段之后、交付物段之前，且各段名唯一', () => {
  const segments = promptSection(() => ({ localDescribe: true }))
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map((x) => x.name), [visionSectionName, fileSectionName])
  assert.deepEqual(segments.map((x) => x.order), [visionSectionOrder, fileSectionOrder])
  assert.equal(new Set(segments.map((x) => x.name)).size, 2)
  // 内置顺序：工具段 1000~5000，交付物引用段 9000。夹在中间，不覆盖别人。
  assert.ok(visionSectionOrder > 5000 && fileSectionOrder < 9000)
  assert.ok(visionSectionOrder < fileSectionOrder)
  for (const segment of segments) {
    assert.equal(typeof segment.text(), 'string')
    assert.equal(segment.text().includes('{{'), false)
  }
})

test('提示段：text 每次都重新读配置，改设置立即生效', () => {
  let config = { localDescribe: true }
  const segments = promptSection(() => config)
  const vision = segments.find((x) => x.name === visionSectionName)
  assert.match(vision.text(), /fish_describe_image/)
  config = { localDescribe: false }
  assert.equal(vision.text(), '')
  config = { localDescribe: true }
  assert.match(vision.text(), /fish_describe_image/)
})
