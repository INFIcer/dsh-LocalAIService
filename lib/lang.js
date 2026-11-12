// 翻译语言：可选的界面语言、原文语言检测、目标语言自动规则。
//
// 这里只做纯函数，不读配置、不发请求，方便单测。
// 语言代码与本地服务 /translate 的别名一致（zh/en/ja/ko/yue），
// 其中 zh 对应简体中文、yue 对应粤语。

export const languageNames = Object.freeze({
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  yue: '粤语',
})

/** 设置页下拉用的语言表；顺序固定，第一项是默认值。 */
export const translationLanguages = Object.freeze([
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: 'yue', label: '粤语' },
])

export const languageCodes = Object.freeze(translationLanguages.map((x) => x.value))

export function isLanguageCode(value) {
  return typeof value === 'string' && languageCodes.includes(value)
}

/**
 * 粗粒度检测原文语言。
 *
 * 只看字符种类，不依赖模型：假名 → ja，谚文 → ko，汉字 → zh，
 * 拉丁字母 → en，其余 → null（检测不出来）。日文里汉字多、假名少，
 * 所以假名优先于汉字。
 */
export function detectLanguage(text) {
  const original = String(text ?? '')
  let han = 0
  let kana = 0
  let hangul = 0
  let latin = 0
  for (const chr of original) {
    const code = chr.codePointAt(0)
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) {
      kana += 1
    } else if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) {
      hangul += 1
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      han += 1
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x24f)
    ) {
      latin += 1
    }
  }
  if (kana > 0) return 'ja'
  if (hangul > 0) return 'ko'
  if (han > 0) return 'zh'
  if (latin > 0) return 'en'
  return null
}

/**
 * 目标语言自动规则（没有显式 target 时）：
 * - 原文 ≠ 第一语言 → 第一语言
 * - 原文 = 第一语言 → 第二语言
 * - 检测不出来 → 第一语言
 */
export function chooseTargetLanguage({ text = '', source = '', target = '', primaryLanguage = 'zh', secondaryLanguage = 'en' } = {}) {
  const explicit = String(target ?? '').trim().toLowerCase()
  if (explicit && explicit !== 'auto') return explicit

  const primary = isLanguageCode(primaryLanguage) ? primaryLanguage : 'zh'
  const secondary = isLanguageCode(secondaryLanguage) ? secondaryLanguage : 'en'
  const explicitSource = String(source ?? '').trim().toLowerCase()
  const original = explicitSource && explicitSource !== 'auto' ? explicitSource : detectLanguage(text)
  if (!original) return primary
  return original === primary ? secondary : primary
}

/**
 * 一次算出「发给服务的 source」和「最终 target」。
 * 显式 target 优先；显式 source 优先于检测；检测不出来时 source 用 auto。
 */
export function parseTranslationLanguage({ text = '', source = '', target = '', primaryLanguage = 'zh', secondaryLanguage = 'en' } = {}) {
  const explicitSource = String(source ?? '').trim().toLowerCase()
  const detectTo = detectLanguage(text)
  const original = explicitSource && explicitSource !== 'auto' ? explicitSource : detectTo
  return {
    target: chooseTargetLanguage({ text, source, target, primaryLanguage, secondaryLanguage }),
    source: original || 'auto',
    detected: detectTo,
    explicitTarget: Boolean(String(target ?? '').trim() && String(target).trim().toLowerCase() !== 'auto'),
  }
}
