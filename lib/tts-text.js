// 朗读化：把「写给人看」的文本改成「读出来才对」的文本（对着 TTS 用）。
//
// 本地 TTS 按字面朗读：地址会被念成无意义音节，日期里的短横可能被读成「减」，
// 千分位逗号会打断数字，版本号里的点会被吞掉。这里按固定顺序改写，顺序本身有依赖：
//   1) 邮箱、电话先换成占位符，避免后面的数字/符号规则把地址拆坏；
//   2) 下划线、英文词内连字符、千分位逗号先还原成词边界；
//   3) 日期、时间、温度、百分比、带单位短值、多点数值（版本号）依次转成中文读法；
//   4) 剩余符号逐个换成词，换行并成句号；
//   5) 压缩空白与重复句号，最后还原占位符。
//
// 规则与 dsh-fish-message 的同名模块同源，但两个仓库各自独立维护：这里不引外部依赖，
// 也不做分段（分段由 lib/speech.js 的 splitForSpeech 统一负责，避免两套竞争规则）。
//
// 纯函数：不读配置、不碰网络；同一输入永远得到同一输出。

const digitTable = '零一二三四五六七八九'

/** 逐位读数字（电话、年份、小数部分）；oneDigit=true 时 1 读「幺」，用于电话和纯数字邮箱。 */
function readDigitByDigit(string, oneDigit = false) {
  let out = ''
  for (const text of String(string)) {
    if (text < '0' || text > '9') continue
    out += oneDigit && text === '1' ? '幺' : digitTable[Number(text)]
  }
  return out
}

/** 四位数以内按位读，中间的零合并成一个（1001 → 一千零一）。 */
function fourDigitsToChinese(number) {
  const unit = ['', '十', '百', '千']
  let out = ''
  let pendingPad = false
  for (let i = 0; i < 4; i += 1) {
    const bit = Math.floor(number / 10 ** i) % 10
    if (bit === 0) {
      // 只有已经写出更高位时才需要补零，否则前导零会被吃掉。
      if (out) pendingPad = true
    } else {
      if (pendingPad) {
        out = '零' + out
        pendingPad = false
      }
      out = digitTable[bit] + unit[i] + out
    }
  }
  return out
}

/** 整数转中文读法：分组（万/亿/万亿）拼接，组内不足四位时补零，开头「一十」读「十」。 */
function integerToChinese(number) {
  if (number === 0) return '零'
  if (number < 0) return '负' + integerToChinese(-number)
  // 正常聊天文本到不了「兆」以上，这里兜底到兆而不是抛错。
  const bigUnit = ['', '万', '亿', '万亿', '兆']
  const groups = []
  let rest = number
  while (rest > 0) {
    groups.push(rest % 10000)
    rest = Math.floor(rest / 10000)
  }
  let result = ''
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i]
    if (group === 0) {
      if (result && !result.endsWith('零')) result += '零'
      continue
    }
    // 高位组存在、而本组不足四位（如 10001 的 0001）时补一个零。
    if (result && group < 1000 && !result.endsWith('零')) result += '零'
    result += fourDigitsToChinese(group) + (bigUnit[i] ?? '')
  }
  result = result.replace(/零+$/, '')
  if (result.startsWith('一十')) result = result.slice(1)
  return result
}

/** 数字串转中文：先去掉千分位逗号；小数按「整数部分 + 点 + 逐位读小数」。 */
function numberToChinese(string) {
  const pure = String(string).replace(/,/g, '')
  const dot = pure.indexOf('.')
  if (dot >= 0) {
    return integerToChinese(Number(pure.slice(0, dot))) + '点' + readDigitByDigit(pure.slice(dot + 1))
  }
  return integerToChinese(Number(pure))
}

/** 邮箱按字母/数字拼读：@ 读 at，域名里的点读 dot；纯数字本地部分用「幺」。 */
function spellEmail(address) {
  const boundary = address.lastIndexOf('@')
  const local = address.slice(0, boundary)
  const domain = address.slice(boundary + 1)
  const digitsOnly = /^[0-9]+$/.test(local)
  const join = (fragment, useOneDigit) => {
    let str = fragment
      .replace(/\./g, ' dot ')
      .replace(/_/g, ' underscore ')
      .replace(/\+/g, ' plus ')
      .replace(/-/g, ' dash ')
    str = str.replace(/[0-9]+/g, (digits) => readDigitByDigit(digits, useOneDigit))
    return str.replace(/\s+/g, ' ').trim()
  }
  return join(local, digitsOnly) + ' at ' + join(domain, false)
}

/** 电话逐位读：分段之间用逗号停顿，+86 读「加八六」。 */
function spellPhone(num) {
  const segments = String(num).trim().split(/[-\s]+/)
  const out = []
  for (const segment of segments) {
    if (!segment) continue
    if (segment.startsWith('+')) {
      const payload = segment.slice(1)
      out.push(payload ? '加' + readDigitByDigit(payload, true) : '加')
    } else {
      out.push(readDigitByDigit(segment, true))
    }
  }
  return out.join('，')
}

/** 分钟/秒固定两位：不足十补「零」（05 → 零五），避免读成「零零五」。 */
function readTwoDigits(twoDigits) {
  const value = Number(twoDigits)
  return value < 10 ? '零' + digitTable[value] : integerToChinese(value)
}

/** 占位符编号：A、B…Z、AA…；只用字母，避免被数字/符号规则二次命中。 */
function serialLetter(seq) {
  let out = ''
  let rest = seq + 1
  while (rest > 0) {
    rest -= 1
    out = String.fromCharCode(65 + (rest % 26)) + out
    rest = Math.floor(rest / 26)
  }
  return out
}

const emailStyle = /(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}(?![A-Za-z0-9\-])/g

const phoneStyles = [
  /(?<!\d)(?:\+\s?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/g,
  /(?<!\d)[48]00[-\s]?\d{3}[-\s]?\d{4}(?!\d)/g,
  /(?<!\d)0\d{2,3}[-\s]\d{7,8}(?!\d)/g,
  /(?<!\d)\+\d{1,3}[-\s]\d{4,14}(?!\d)/g,
  /(?<!\d)\+\d{7,15}(?!\d)/g,
]

// 符号按「读出来的词」替换；@ & | 前后补空格，避免和相邻英文粘成一个词。
const symbolTable = {
  '+': '加', '-': '减', '*': '乘', '×': '乘',
  '/': '除以', '÷': '除以', '=': '等于',
  '@': 'at', '#': '井号', '&': 'and', '|': 'or',
  '^': '次方', '~': '波浪号', '<': '小于', '>': '大于',
  '$': '美元', '€': '欧元', '£': '英镑', '¥': '元',
  '±': '正负', '≈': '约等于', '≠': '不等于',
  '≤': '小于等于', '≥': '大于等于',
  '℃': '摄氏度', '°': '度',
  '(': '括号', ')': '括号',
  '[': '方括号', ']': '方括号',
  '{': '花括号', '}': '花括号',
}
const englishSymbol = new Set(['@', '&', '|'])

/**
 * 把一段文本转成适合交给 TTS 朗读的写法。
 * @param {string} text 原始文本（允许空串、null）
 * @returns {string} 可朗读文本；全空白输入返回空串
 */
export function ttsFriendly(text) {
  let str = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // 占位符：地址先整体藏起来，等所有数字/符号规则跑完再放回。
  const placeholder = []
  const store = (replace) => {
    const key = '\u0000' + serialLetter(placeholder.length) + '\u0000'
    placeholder.push([key, replace])
    return key
  }

  // 1. 邮箱、电话
  str = str.replace(emailStyle, (match) => store(spellEmail(match)))
  for (const style of phoneStyles) {
    str = str.replace(style, (match) => store(spellPhone(match)))
  }

  // 2. 词边界：下划线、英文词内连字符、千分位逗号
  str = str.replace(/_/g, ' ')
  str = str.replace(/(?<=[A-Za-z])-(?=[A-Za-z])/g, ' ')
  str = str.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')

  // 3. 日期：先带分隔符的完整日期，再「年月日」，最后只剩年、年月
  str = str.replace(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, (_, year, month, day) =>
    readDigitByDigit(year) + '年' + integerToChinese(Number(month)) + '月' + integerToChinese(Number(day)) + '日')
  str = str.replace(/(?<!\d)(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/g, (_, year, month, day) =>
    readDigitByDigit(year) + '年' + integerToChinese(Number(month)) + '月' + integerToChinese(Number(day)) + '日')
  str = str.replace(/(?<!\d)(\d{4})年(\d{1,2})月/g, (_, year, month) =>
    readDigitByDigit(year) + '年' + integerToChinese(Number(month)) + '月')
  str = str.replace(/(?<!\d)(\d{4})年/g, (_, year) => readDigitByDigit(year) + '年')

  // 4. 时间：9:07 → 九点零七分；带秒时再接「零九秒」
  str = str.replace(/(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/g, (_, hour, minute, second) => {
    const result = integerToChinese(Number(hour)) + '点' + readTwoDigits(minute) + '分'
    return second === undefined ? result : result + readTwoDigits(second) + '秒'
  })

  // 5. 温度 / 角度
  str = str.replace(/(?<![\d.])(\d+(?:\.\d+)?)\s*℃/g, (_, number) => numberToChinese(number) + '摄氏度')
  str = str.replace(/(?<![\d.])(\d+(?:\.\d+)?)\s*°C/g, (_, number) => numberToChinese(number) + '摄氏度')
  str = str.replace(/(?<![\d.])(\d+(?:\.\d+)?)\s*°/g, (_, number) => numberToChinese(number) + '度')

  // 6. 百分比
  str = str.replace(/(?<![\d.])(\d+(?:\.\d+)?)\s*%/g, (_, number) => '百分之' + numberToChinese(number))

  // 7. 带单位短值：69ms → 六十九毫秒、30 秒 → 三十秒。
  //    数字和单位之间常带空格，去掉空格再读，否则 TTS 会在中间停顿。
  str = str.replace(/(?<![\d.])(\d+(?:\.\d+)?)\s*(毫秒|ms|秒钟|秒|分钟|小时)(?![A-Za-z])/gi, (_, number, unit) =>
    numberToChinese(number) + (unit.toLowerCase() === 'ms' ? '毫秒' : unit === '秒钟' ? '秒' : unit))

  // 8. 多点数值（版本号、依赖版本）：2.5.0 → 二点五点零，1.0.213 → 一点零点二一三。
  //    第一段按整数读；后续各段逐位读，避免 213 被读成「二百一十三」。
  //    紧贴在数字前的 v 是版本标记，念出来没有意义，先去掉。
  str = str.replace(/(?<![A-Za-z0-9])[vV](?=\d+(?:\.\d+){2,}(?![\d.]))/g, '')
  str = str.replace(/(?<![\d.])(\d+(?:\.\d+){2,})(?![\d.])/g, (_, number) => {
    const parts = number.split('.')
    return integerToChinese(Number(parts[0])) + parts.slice(1).map((part) => '点' + readDigitByDigit(part)).join('')
  })

  // 9. 小数、剩余整数
  str = str.replace(/(?<![\d.])(\d+\.\d+)(?![\d.])/g, (_, number) => numberToChinese(number))
  str = str.replace(/(?<![\d.])(\d+)(?![\d.])/g, (_, number) => integerToChinese(Number(number)))

  // 10. 剩余符号
  for (const symbol of Object.keys(symbolTable)) {
    if (englishSymbol.has(symbol)) str = str.replaceAll(symbol, ' ' + symbolTable[symbol] + ' ')
    else str = str.replaceAll(symbol, symbolTable[symbol])
  }

  // 11. 换行并句、压缩空白与重复句号
  str = str.replace(/\n+/g, '。')
  str = str.replace(/[ \t\u3000]+/g, ' ')
  str = str.replace(/。+/g, '。')
  str = str.replace(/\s*。\s*/g, '。')
  str = str.replace(/^。+/, '').trim()

  // 12. 还原占位符
  for (const [key, replace] of placeholder) str = str.split(key).join(replace)
  return str
}
