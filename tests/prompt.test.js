// 系统提示段：识图开关、文件提示、段名与顺序、动态读配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  提示段,
  文件提示,
  文件段名,
  文件段顺序,
  识图提示,
  识图段名,
  识图段顺序,
} from '../lib/prompt.js'

test('识图提示：开启时让模型优先用本机识图，关闭时为空串', () => {
  for (const 配置 of [{ localDescribe: true }, {}, undefined, null]) {
    const 文本 = 识图提示(配置)
    assert.match(文本, /fish_describe_image/, JSON.stringify(配置))
    assert.match(文本, /本机/)
    assert.equal(文本.includes('{{'), false, '提示词里不能出现插值语法')
  }
  assert.equal(识图提示({ localDescribe: false }), '')
  // 只有明确 false 才算关：旧配置缺字段仍是开。
  assert.equal(识图提示({ localDescribe: undefined }) === '', false)
})

test('文件提示：引导用 present 交付文件，不提内部实现', () => {
  const 文本 = 文件提示()
  assert.match(文本, /present/)
  assert.match(文本, /路径/)
  assert.equal(文本.includes('{{'), false)
})

test('提示段：两个段的顺序在工具段之后、交付物段之前，且各段名唯一', () => {
  const 段们 = 提示段(() => ({ localDescribe: true }))
  assert.equal(段们.length, 2)
  assert.deepEqual(段们.map((x) => x.name), [识图段名, 文件段名])
  assert.deepEqual(段们.map((x) => x.order), [识图段顺序, 文件段顺序])
  assert.equal(new Set(段们.map((x) => x.name)).size, 2)
  // 内置顺序：工具段 1000~5000，交付物引用段 9000。夹在中间，不覆盖别人。
  assert.ok(识图段顺序 > 5000 && 文件段顺序 < 9000)
  assert.ok(识图段顺序 < 文件段顺序)
  for (const 段 of 段们) {
    assert.equal(typeof 段.text(), 'string')
    assert.equal(段.text().includes('{{'), false)
  }
})

test('提示段：text 每次都重新读配置，改设置立即生效', () => {
  let 配置 = { localDescribe: true }
  const 段们 = 提示段(() => 配置)
  const 识图 = 段们.find((x) => x.name === 识图段名)
  assert.match(识图.text(), /fish_describe_image/)
  配置 = { localDescribe: false }
  assert.equal(识图.text(), '')
  配置 = { localDescribe: true }
  assert.match(识图.text(), /fish_describe_image/)
})
