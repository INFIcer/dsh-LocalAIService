// 朗读用的文本预处理与分段（P2）。
//
// 为什么放在宿主：浏览器里只管播放，Markdown / 代码块 / [QQ] 标记的清洗规则
// 只有一份，且能离线单测。客户端把「消息原文」发过来，宿主返回干净的分段。
//
// 清洗规则（README / docs/P2.md 有同一份说明）：
//   - 代码围栏整体处理：默认删掉；skipCodeBlocks=false 时换成「代码块，共 N 行」（不读代码）；
//   - 行内代码：技术内容（标识符 / 路径 / 表达式 / 提交号）整段丢弃，短值（30 秒、v2.5.0）
//     保留内容交给朗读化；丢弃后留下的空括号、孤立标点、表格竖线、无空格标题一并清掉；
//   - Markdown 链接只读文字（[文字](url) → 文字），裸 URL 丢掉；
//   - 图片 ![alt](url) 只读 alt；
//   - 标题 / 引用 / 列表 / 表格 / 分割线 / HTML 标签 / 加粗斜体删除线标记全部剥掉；
//   - [QQ] / [/QQ] 只是 DSH 出站标记，朗读时剥掉，块内文字保留。
//
// 清洗之后再做朗读化（lib/tts-text.js）：数字、日期、时间、地址、符号改成中文读法。
// 统一入口是 fish.service.tts()（lib/service-api.js）——所有调用方都经过它，各自再做
// 一套会重复改写、读法还会漂移；prepareSpeech 里也做一遍，是为了让 /read/plan 返回的
// 分段就是最终要念的文字。两步都幂等，分段再进 tts() 不会叠加出第二种读法。
//
// 分段规则见 splitForSpeech 与 docs/TTS_CACHE.md。

import { ttsFriendly } from './tts-text.js'

export const defaultMaxChars = 2000
export const minSegmentChars = 200
export const maxSegmentChars = 5000
export const shortestPhrase = 10
export const maxSegments = 40
export const maxTotalChars = 20000

const sentenceEnd = /[。！？!?；;…]/

// 行内代码里哪些内容值得念出来。判断必须「先认可念的、再按技术特征排除」：
// 否则路径里的数字会被数值规则误判成可念内容（如 C:/x86/64）。
const readableInlineCode = [
  /^[vV]?\d+(?:\.\d+)+$/, // 版本号：2.5.0、v1.2.3
  /^\d+(?:\.\d+)?\s*(?:毫秒|ms|秒|分钟|小时|天|周|月|年|元|块|度|℃|%|倍)$/i, // 带单位短值：30 秒、69ms
  /^\d+(?:\.\d+)?%?$/, // 纯数值：0.5、87.5%
]
// 出现这些就是表达式/路径/命令，念出来没有意义。
const technicalInlineCode = /[_/\\=:<>#@&|^~$*+()[\]{}"'`]/
const camelCase = /[a-z][A-Z]/
const acronym = /[A-Z]{2,}/
const technicalKeyword = /^(?:true|false|null|undefined|nan|infinity)$/i

function isReadableInlineCode(content) {
  const value = String(content ?? '').trim()
  if (!value) return false
  if (readableInlineCode.some((pattern) => pattern.test(value))) return true
  if (technicalInlineCode.test(value)) return false
  if (camelCase.test(value) || acronym.test(value)) return false
  if (technicalKeyword.test(value)) return false
  // 纯 ASCII 的标识符：带数字、空格、点或连字符的一律当技术内容；普通英文单词保留。
  if (/^[\x20-\x7e]+$/.test(value)) {
    if (/[0-9\s.'-]/.test(value)) return false
    if (value.length > 24) return false
  }
  return true
}

/** 把 Markdown 文本变成「适合念出来」的纯文本。 */
export function stripMarkdown(input, { skipCodeBlocks = true } = {}) {
  let text = String(input == null ? '' : input)
  let codeBlockCount = 0
  let codeLineCount = 0

  // 统一换行；把行内 <br> 变成空格，避免整行黏在一起。
  text = text.replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, ' ')

  // HTML 注释整体删。
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  // 代码围栏：成对的、以及未闭合到文末的都算一块。
  text = text.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_all, content) => {
    codeBlockCount += 1
    const line = String(content || '').split('\n').filter((x) => x.trim() !== '').length
    codeLineCount += line
    if (skipCodeBlocks) return '\n'
    return `\n（代码块，共 ${line} 行）\n`
  })
  // 四个空格缩进的代码块（没有围栏）也按代码处理。
  text = text.replace(/^(?: {4}|\t).+$/gm, '')

  // 表格：单元格用「，」连起来，分隔行（|---|）丢掉。
  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/gm, '')
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_all, line) => {
    const cell = String(line).split('|').map((x) => x.trim()).filter(Boolean)
    return cell.length ? `${cell.join('，')}\n` : ''
  })

  // 分割线。
  text = text.replace(/^\s*(?:[-*_])(?:\s*[-*_]){2,}\s*$/gm, '')

  // 标题 / 引用 / 列表符号。
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/gm, '')
  // 任务列表的勾选框。
  text = text.replace(/^\s*\[[ xX]\]\s*/gm, '')

  // 图片 → alt；链接 → 文字。
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  // 引用式链接的定义行（[1]: https://…）。
  text = text.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '')

  // 裸 URL 与尖括号自动链接：朗读没有意义，丢掉。
  text = text.replace(/<https?:\/\/[^>]*>/gi, '')
  text = text.replace(/https?:\/\/[^\s<>()（）"']+/gi, '')

  // 行内代码：能念的短值保留内容，标识符/路径/表达式整段丢弃。
  // 丢弃时替换成空格而不是空串，避免前后文字黏成一个词。
  text = text.replace(/`([^`\n]+)`/g, (_all, content) => (isReadableInlineCode(content) ? content.trim() : ' '))

  // 裸提交号（git short hash）：7 位以上、字母数字混合，念不出来，直接丢掉。
  text = text.replace(/(?<![0-9A-Za-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![0-9A-Za-z])/gi, ' ')

  // HTML 标签。
  text = text.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, '')

  // 加粗 / 斜体 / 删除线。
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  // 单个 * 当斜体标记；中文里标记两侧常常直接贴字，所以不要求空白边界。
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  text = text.replace(/(^|[\s（(【「])_([^_\n]+)_(?=$|[\s）)】」。，,！!？?；;：:])/g, '$1$2')

  // [QQ]…[/QQ] 标记剥掉，块内文字保留。
  text = text.replace(/\[\/?qq\]/gi, '')

  // 常见 HTML 实体。
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")

  // 清洗残留标记：行内代码丢弃后会留下空括号、孤立标点，表格可能剩竖线，
  // 标题可能没写空格（##标题），水平线也可能只被拆掉一半。
  text = text
    .replace(/[（(【「『]\s*[）)】」』]/g, '')
    .replace(/`+/g, '')
    .replace(/^\s{0,3}#{1,6}(?=[^\s#])/gm, '')
    .replace(/^\s*[•·]\s*/gm, '')
    .replace(/\|/g, '，')
    .replace(/([，,、；;：:])(?:\s*[，,、；;：:])+/g, '$1')
    .replace(/^\s*[，,、；;：:。]+/gm, '')
    .replace(/\s*(?:-{3,}|\*{3,}|_{3,})\s*/g, ' ')

  // 收尾：压空白、去空行。
  text = text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text: text, codeBlocks: codeBlockCount, codeLines: codeLineCount }
}

/** 把一段（已清洗的）文本切成不超过 maxChars 的片段。
 *
 * 分段语义（与 docs/TTS_CACHE.md 保持一致）：
 *   1. 先按「换行」与「句末标点（。！？!?；;…）」切出基础片段，标点跟着前一句；
 *   2. 不足 `最短短语` 个字的片段不单独成段——优先并到下一片，末尾的并到上一片；
 *   3. 再按 maxChars 打包：能装下就合并，装不下就断开；
 *   4. 单句超长时按字数硬切，尽量在逗号/顿号/空格处断开；
 *   5. 最多 40 段、最多 20000 字（超出截断并标记）。
 */
export function splitForSpeech(input, maxChars = defaultMaxChars) {
  const limit = Math.max(minSegmentChars, Math.min(maxSegmentChars, Math.trunc(Number(maxChars) || defaultMaxChars)))
  const original = String(input == null ? '' : input).replace(/\r\n?/g, '\n').trim()
  if (!original) return { chunks: [], truncated: false }

  let text = original
  let truncate = false
  if (text.length > maxTotalChars) {
    text = text.slice(0, maxTotalChars)
    // 尽量退到句末，别把一句话砍一半。
    const back = Math.max(text.lastIndexOf('。'), text.lastIndexOf('！'), text.lastIndexOf('？'), text.lastIndexOf('\n'))
    if (back > maxTotalChars * 0.8) text = text.slice(0, back + 1)
    truncate = true
  }

  // 1) 基础片段：换行与句末标点都是边界。
  //    换行处如果没有句末标点，补一个「。」，否则 TTS 会把两行黏成一句、不换气。
  const rawSlice = []
  const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  for (const [lineSub, line] of lines.entries()) {
    let segment = line
    // 行尾是逗号/顿号/冒号/分号之类，统一收成句号；
    // 行尾什么都没有、且不是最后一行 → 补一个「。」（换行处不补的话 TTS 会黏成一句、不换气）。
    if (lineSub < lines.length - 1) {
      const last = segment[segment.length - 1]
      if (/[，,、：:；;]/.test(last)) segment = segment.slice(0, -1) + '。'
      else if (!sentenceEnd.test(last)) segment = segment + '。'
    }
    let startPoint = 0
    for (let i = 0; i < segment.length; i++) {
      if (sentenceEnd.test(segment[i])) {
        const slice = segment.slice(startPoint, i + 1).trim()
        if (slice) rawSlice.push(slice)
        startPoint = i + 1
      }
    }
    if (startPoint < segment.length) {
      const tail = segment.slice(startPoint).trim()
      if (tail) rawSlice.push(tail)
    }
  }
  if (!rawSlice.length) return { chunks: [], truncated: truncate }

  // 2) 太短的片段不单独成段：不足 最短短语 的并到下一片（末尾的并到上一片）。
  const slice = []
  let i = 0
  while (i < rawSlice.length) {
    let current = rawSlice[i]
    i += 1
    while (current.length < shortestPhrase && i < rawSlice.length) {
      current += rawSlice[i]
      i += 1
    }
    slice.push(current)
  }
  if (slice.length >= 2 && slice[slice.length - 1].length < shortestPhrase) {
    const last = slice.pop()
    slice[slice.length - 1] = slice[slice.length - 1] + last
  }

  // 3) 句/换行级片段直接成段（不再为了压字数把多句黏成 2000 字长段）；
  //    4) 只有单片超过 maxChars 时才按字数硬切，并尽量在逗号/顿号/空格处断开。
  const fragment = []
  for (const chunk of slice) {
    if (chunk.length <= limit) {
      fragment.push(chunk)
      continue
    }
    let rest = chunk
    while (rest.length > limit) {
      let cutPoint = limit
      const comma = Math.max(
        rest.lastIndexOf('，', limit),
        rest.lastIndexOf(',', limit),
        rest.lastIndexOf('、', limit),
        rest.lastIndexOf(' ', limit),
      )
      if (comma > limit * 0.6) cutPoint = comma + 1
      fragment.push(rest.slice(0, cutPoint).trim())
      rest = rest.slice(cutPoint)
    }
    if (rest.trim()) fragment.push(rest.trim())
  }

  // 5) 收尾：除最后一段外，任何片段都不短于 最短短语（打包边界可能产生短尾）。
  const merge = []
  for (const chunk of fragment.filter(Boolean)) {
    const upper = merge[merge.length - 1]
    if (upper !== undefined && upper.length < shortestPhrase && (upper.length + chunk.length) <= limit) {
      merge[merge.length - 1] = upper + chunk
    } else {
      merge.push(chunk)
    }
  }
  if (merge.length >= 2 && merge[merge.length - 1].length < shortestPhrase) {
    const last = merge.pop()
    merge[merge.length - 1] = merge[merge.length - 1] + last
  }

  // 兜底：合并短尾或补句号后，极少数情况会超过 上限（例如 200 字整 + 「。」）。
  // 这类情形成年切片，保证任何一段都不超 maxChars。
  const fix = []
  for (const chunk of merge) {
    if (chunk.length <= limit) { fix.push(chunk); continue }
    let rest = chunk
    while (rest.length > limit) { fix.push(rest.slice(0, limit)); rest = rest.slice(limit) }
    if (rest) fix.push(rest)
  }

  const output = fix.filter((x) => x.trim() !== '')
  if (output.length > maxSegments) {
    return { chunks: output.slice(0, maxSegments), truncated: true }
  }
  return { chunks: output, truncated: truncate }
}

/**
 * 预处理 + 分段，一步到位。
 * @returns {{text:string, chunks:string[], chars:number, codeBlocks:number, codeLines:number, truncated:boolean}}
 */
export function prepareSpeech(input, { maxChars = defaultMaxChars, skipCodeBlocks = true } = {}) {
  const sanitize = stripMarkdown(input, { skipCodeBlocks })
  // 朗读化在清洗之后、分段之前：清洗去掉结构性标记，朗读化改写数字/符号/地址，
  // 分段必须按最终的朗读文本切，否则长度计算与断句都会对不上。
  const readable = ttsFriendly(sanitize.text)
  const piece = splitForSpeech(readable, maxChars)
  return {
    text: readable,
    chunks: piece.chunks,
    chars: readable.length,
    codeBlocks: sanitize.codeBlocks,
    codeLines: sanitize.codeLines,
    truncated: piece.truncated,
  }
}
