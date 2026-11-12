// 语言检测与翻译目标语言自动规则（纯函数）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectLanguage,
  chooseTargetLanguage,
  parseTranslationLanguage,
  isLanguageCode,
  languageCodes,
  translationLanguages,
} from '../lib/lang.js'

test('检测语言：汉字→zh、假名→ja、谚文→ko、拉丁→en、其余→null', () => {
  assert.equal(detectLanguage('你好，世界'), 'zh')
  assert.equal(detectLanguage('こんにちは'), 'ja')
  assert.equal(detectLanguage('안녕하세요'), 'ko')
  assert.equal(detectLanguage('hello world'), 'en')
  assert.equal(detectLanguage('12345 ！？。'), null)
  assert.equal(detectLanguage(''), null)
  assert.equal(detectLanguage(null), null)
  // 日文混汉字：假名优先，判为 ja。
  assert.equal(detectLanguage('今日はいい天気ですね'), 'ja')
  // 中文夹英文：汉字优先。
  assert.equal(detectLanguage('用 DSH 很好'), 'zh')
})

test('翻译语言表：覆盖 zh/en/ja/ko/yue，代码服务端可直接用', () => {
  assert.deepEqual(languageCodes, ['zh', 'en', 'ja', 'ko', 'yue'])
  assert.deepEqual(translationLanguages.map((x) => x.value), languageCodes)
  for (const code of languageCodes) {
    assert.equal(isLanguageCode(code), true)
    assert.ok(translationLanguages.find((x) => x.value === code).label)
  }
  assert.equal(isLanguageCode('fr'), false)
  assert.equal(isLanguageCode(''), false)
})

test('选目标语言：原文≠第一语言→第一语言；=第一语言→第二语言；检测不出→第一语言', () => {
  const table = [
    // [原文, 期望 target]
    ['你好', 'en'],          // zh = 第一语言 → en
    ['hello', 'zh'],         // en ≠ zh → zh
    ['こんにちは', 'zh'],     // ja ≠ zh → zh
    ['안녕하세요', 'zh'],     // ko ≠ zh → zh
    ['12345', 'zh'],         // 检测不出 → 第一语言
    ['', 'zh'],
  ]
  for (const [original, expected] of table) {
    assert.equal(chooseTargetLanguage({ text: original }), expected, original)
  }

  // 换一组第一/第二语言：英文优先，则英文原文 → 日文。
  assert.equal(chooseTargetLanguage({ text: 'hello', primaryLanguage: 'en', secondaryLanguage: 'ja' }), 'ja')
  assert.equal(chooseTargetLanguage({ text: '你好', primaryLanguage: 'en', secondaryLanguage: 'ja' }), 'en')

  // 显式 target 一律优先。
  assert.equal(chooseTargetLanguage({ text: '你好', target: 'ko' }), 'ko')
  assert.equal(chooseTargetLanguage({ text: 'hello', target: 'yue' }), 'yue')
})

test('选目标语言：显式 source 优先于检测', () => {
  // 文本看起来是中文，但调用方声明原文是英文 → 英文 ≠ zh → 译成中文。
  assert.equal(chooseTargetLanguage({ text: '你好', source: 'en' }), 'zh')
  // 声明原文是日文 → 仍是第一语言。
  assert.equal(chooseTargetLanguage({ text: '你好', source: 'ja' }), 'zh')
})

test('解析翻译语言：返回 target/source/detected/explicitTarget', () => {
  const middle = parseTranslationLanguage({ text: '你好' })
  assert.deepEqual(middle, { target: 'en', source: 'zh', detected: 'zh', explicitTarget: false })

  const english = parseTranslationLanguage({ text: 'hello' })
  assert.equal(english.target, 'zh')
  assert.equal(english.source, 'en')

  const undetected = parseTranslationLanguage({ text: '12345' })
  assert.equal(undetected.target, 'zh')
  assert.equal(undetected.source, 'auto')
  assert.equal(undetected.detected, null)

  const explicit = parseTranslationLanguage({ text: '你好', target: 'ja', source: 'en' })
  assert.equal(explicit.target, 'ja')
  assert.equal(explicit.source, 'en')
  assert.equal(explicit.explicitTarget, true)

  // 非法配置值回退 zh/en。
  const revert = parseTranslationLanguage({ text: 'hello', primaryLanguage: 'fr', secondaryLanguage: 'de' })
  assert.equal(revert.target, 'zh')
})
