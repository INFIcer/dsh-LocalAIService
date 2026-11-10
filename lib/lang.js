// 翻译语言：可选的界面语言、原文语言检测、目标语言自动规则。
//
// 这里只做纯函数，不读配置、不发请求，方便单测。
// 语言代码与本地服务 /translate 的别名一致（zh/en/ja/ko/yue），
// 其中 zh 对应简体中文、yue 对应粤语。

export const 语言名称 = Object.freeze({
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  yue: '粤语',
})

/** 设置页下拉用的语言表；顺序固定，第一项是默认值。 */
export const 翻译语言表 = Object.freeze([
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: 'yue', label: '粤语' },
])

export const 语言代码 = Object.freeze(翻译语言表.map((x) => x.value))

export function 是语言代码(value) {
  return typeof value === 'string' && 语言代码.includes(value)
}

/**
 * 粗粒度检测原文语言。
 *
 * 只看字符种类，不依赖模型：假名 → ja，谚文 → ko，汉字 → zh，
 * 拉丁字母 → en，其余 → null（检测不出来）。日文里汉字多、假名少，
 * 所以假名优先于汉字。
 */
export function 检测语言(text) {
  const 原文 = String(text ?? '')
  let 汉字 = 0
  let 假名 = 0
  let 谚文 = 0
  let 拉丁 = 0
  for (const 字符 of 原文) {
    const 码 = 字符.codePointAt(0)
    if ((码 >= 0x3040 && 码 <= 0x30ff) || (码 >= 0x31f0 && 码 <= 0x31ff)) {
      假名 += 1
    } else if ((码 >= 0xac00 && 码 <= 0xd7af) || (码 >= 0x1100 && 码 <= 0x11ff)) {
      谚文 += 1
    } else if (
      (码 >= 0x4e00 && 码 <= 0x9fff) ||
      (码 >= 0x3400 && 码 <= 0x4dbf) ||
      (码 >= 0xf900 && 码 <= 0xfaff)
    ) {
      汉字 += 1
    } else if (
      (码 >= 0x41 && 码 <= 0x5a) ||
      (码 >= 0x61 && 码 <= 0x7a) ||
      (码 >= 0xc0 && 码 <= 0x24f)
    ) {
      拉丁 += 1
    }
  }
  if (假名 > 0) return 'ja'
  if (谚文 > 0) return 'ko'
  if (汉字 > 0) return 'zh'
  if (拉丁 > 0) return 'en'
  return null
}

/**
 * 目标语言自动规则（没有显式 target 时）：
 * - 原文 ≠ 第一语言 → 第一语言
 * - 原文 = 第一语言 → 第二语言
 * - 检测不出来 → 第一语言
 */
export function 选目标语言({ text = '', source = '', target = '', primaryLanguage = 'zh', secondaryLanguage = 'en' } = {}) {
  const 显式 = String(target ?? '').trim().toLowerCase()
  if (显式 && 显式 !== 'auto') return 显式

  const 第一 = 是语言代码(primaryLanguage) ? primaryLanguage : 'zh'
  const 第二 = 是语言代码(secondaryLanguage) ? secondaryLanguage : 'en'
  const 显式源 = String(source ?? '').trim().toLowerCase()
  const 原文 = 显式源 && 显式源 !== 'auto' ? 显式源 : 检测语言(text)
  if (!原文) return 第一
  return 原文 === 第一 ? 第二 : 第一
}

/**
 * 一次算出「发给服务的 source」和「最终 target」。
 * 显式 target 优先；显式 source 优先于检测；检测不出来时 source 用 auto。
 */
export function 解析翻译语言({ text = '', source = '', target = '', primaryLanguage = 'zh', secondaryLanguage = 'en' } = {}) {
  const 显式源 = String(source ?? '').trim().toLowerCase()
  const 检测到 = 检测语言(text)
  const 原文 = 显式源 && 显式源 !== 'auto' ? 显式源 : 检测到
  return {
    target: 选目标语言({ text, source, target, primaryLanguage, secondaryLanguage }),
    source: 原文 || 'auto',
    detected: 检测到,
    explicitTarget: Boolean(String(target ?? '').trim() && String(target).trim().toLowerCase() !== 'auto'),
  }
}
