// 语言检测与翻译目标语言自动规则（纯函数）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  检测语言,
  选目标语言,
  解析翻译语言,
  是语言代码,
  语言代码,
  翻译语言表,
} from '../lib/lang.js'

test('检测语言：汉字→zh、假名→ja、谚文→ko、拉丁→en、其余→null', () => {
  assert.equal(检测语言('你好，世界'), 'zh')
  assert.equal(检测语言('こんにちは'), 'ja')
  assert.equal(检测语言('안녕하세요'), 'ko')
  assert.equal(检测语言('hello world'), 'en')
  assert.equal(检测语言('12345 ！？。'), null)
  assert.equal(检测语言(''), null)
  assert.equal(检测语言(null), null)
  // 日文混汉字：假名优先，判为 ja。
  assert.equal(检测语言('今日はいい天気ですね'), 'ja')
  // 中文夹英文：汉字优先。
  assert.equal(检测语言('用 DSH 很好'), 'zh')
})

test('翻译语言表：覆盖 zh/en/ja/ko/yue，代码服务端可直接用', () => {
  assert.deepEqual(语言代码, ['zh', 'en', 'ja', 'ko', 'yue'])
  assert.deepEqual(翻译语言表.map((x) => x.value), 语言代码)
  for (const 代码 of 语言代码) {
    assert.equal(是语言代码(代码), true)
    assert.ok(翻译语言表.find((x) => x.value === 代码).label)
  }
  assert.equal(是语言代码('fr'), false)
  assert.equal(是语言代码(''), false)
})

test('选目标语言：原文≠第一语言→第一语言；=第一语言→第二语言；检测不出→第一语言', () => {
  const 表 = [
    // [原文, 期望 target]
    ['你好', 'en'],          // zh = 第一语言 → en
    ['hello', 'zh'],         // en ≠ zh → zh
    ['こんにちは', 'zh'],     // ja ≠ zh → zh
    ['안녕하세요', 'zh'],     // ko ≠ zh → zh
    ['12345', 'zh'],         // 检测不出 → 第一语言
    ['', 'zh'],
  ]
  for (const [原文, 期望] of 表) {
    assert.equal(选目标语言({ text: 原文 }), 期望, 原文)
  }

  // 换一组第一/第二语言：英文优先，则英文原文 → 日文。
  assert.equal(选目标语言({ text: 'hello', primaryLanguage: 'en', secondaryLanguage: 'ja' }), 'ja')
  assert.equal(选目标语言({ text: '你好', primaryLanguage: 'en', secondaryLanguage: 'ja' }), 'en')

  // 显式 target 一律优先。
  assert.equal(选目标语言({ text: '你好', target: 'ko' }), 'ko')
  assert.equal(选目标语言({ text: 'hello', target: 'yue' }), 'yue')
})

test('选目标语言：显式 source 优先于检测', () => {
  // 文本看起来是中文，但调用方声明原文是英文 → 英文 ≠ zh → 译成中文。
  assert.equal(选目标语言({ text: '你好', source: 'en' }), 'zh')
  // 声明原文是日文 → 仍是第一语言。
  assert.equal(选目标语言({ text: '你好', source: 'ja' }), 'zh')
})

test('解析翻译语言：返回 target/source/detected/explicitTarget', () => {
  const 中 = 解析翻译语言({ text: '你好' })
  assert.deepEqual(中, { target: 'en', source: 'zh', detected: 'zh', explicitTarget: false })

  const 英 = 解析翻译语言({ text: 'hello' })
  assert.equal(英.target, 'zh')
  assert.equal(英.source, 'en')

  const 检测不出 = 解析翻译语言({ text: '12345' })
  assert.equal(检测不出.target, 'zh')
  assert.equal(检测不出.source, 'auto')
  assert.equal(检测不出.detected, null)

  const 显式 = 解析翻译语言({ text: '你好', target: 'ja', source: 'en' })
  assert.equal(显式.target, 'ja')
  assert.equal(显式.source, 'en')
  assert.equal(显式.explicitTarget, true)

  // 非法配置值回退 zh/en。
  const 回退 = 解析翻译语言({ text: 'hello', primaryLanguage: 'fr', secondaryLanguage: 'de' })
  assert.equal(回退.target, 'zh')
})
