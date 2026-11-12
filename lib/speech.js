// 朗读用的文本预处理与分段（P2）。
//
// 为什么放在宿主：浏览器里只管播放，Markdown / 代码块 / [QQ] 标记的清洗规则
// 只有一份，且能离线单测。客户端把「消息原文」发过来，宿主返回干净的分段。
//
// 清洗规则（README / docs/P2.md 有同一份说明）：
//   - 代码围栏整体处理：默认删掉；`skipCodeBlocks=false` 时换成「代码块，共 N 行」（不读代码）；
//   - 行内代码去掉反引号，保留内容；
//   - Markdown 链接只读文字（`[文字](url)` → `文字`），裸 URL 丢掉；
//   - 图片 `![alt](url)` 只读 alt；
//   - 标题 / 引用 / 列表 / 表格 / 分割线 / HTML 标签 / 加粗斜体删除线标记全部剥掉；
//   - `[QQ]` / `[/QQ]` 只是 DSH 出站标记，朗读时剥掉，块内文字保留。
//
// 分段规则（2026-11 调整）：以「换行」和「句末标点（。！？!?；;…）」为边界切段；
// 不足 10 字的碎片不单独成段（并到下一段，末尾的并到上一段）；
// 只有单句超过 maxChars 时才按字数硬切（优先在逗号/顿号/空格处断）。
// 最多 40 段、最多 20000 字（超出截断并标记）。

export const defaultMaxChars = 2000
export const minSegmentChars = 200
export const maxSegmentChars = 5000
export const shortestPhrase = 10
export const maxSegments = 40
export const maxTotalChars = 20000

const sentenceEnd = /[。！？!?；;…]/

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

  // 行内代码：去掉反引号，保留内容。
  text = text.replace(/`([^`\n]+)`/g, '$1')

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
  const piece = splitForSpeech(sanitize.text, maxChars)
  return {
    text: sanitize.text,
    chunks: piece.chunks,
    chars: sanitize.text.length,
    codeBlocks: sanitize.codeBlocks,
    codeLines: sanitize.codeLines,
    truncated: piece.truncated,
  }
}
