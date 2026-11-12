// P2 朗读文本预处理与分段（纯函数，离线）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultMaxChars,
  maxSegmentChars,
  maxSegments,
  prepareSpeech,
  splitForSpeech,
  stripMarkdown,
} from '../lib/speech.js'

const example = [
  '# 标题一',
  '',
  '这是**加粗**和*斜体*，还有 `行内代码`。',
  '',
  '[链接文字](https://example.com/x) 和 ![图片说明](https://example.com/x.png)',
  '裸链接 https://example.com/y 会被丢掉。',
  '',
  '> 引用一行',
  '',
  '- 列表项 A',
  '- 列表项 B',
  '',
  '| 列1 | 列2 |',
  '| --- | --- |',
  '| 值1 | 值2 |',
  '',
  '---',
  '',
  '```js',
  'const a = 1',
  'const b = 2',
  '```',
  '',
  '[QQ]主人，测试一下。[/QQ]',
  '',
  '&nbsp;&amp; 结束',
].join('\n')

test('stripMarkdown：标题/加粗/斜体/行内代码/列表/引用/表格标记都剥掉', () => {
  const { text } = stripMarkdown(example)
  assert.ok(!text.includes('#'))
  assert.ok(!text.includes('**'))
  assert.ok(!text.includes('`'))
  assert.ok(!text.includes('> '))
  assert.ok(text.includes('标题一'))
  assert.ok(text.includes('还有 巴拉巴拉。'), text)
  assert.ok(text.includes('引用一行'))
  assert.ok(text.includes('列表项 A'))
  assert.ok(text.includes('列表项 B'))
  assert.ok(!text.includes('- 列表项'))
  assert.ok(text.includes('列1，列2'), text)
  assert.ok(text.includes('值1，值2'), text)
  assert.ok(!text.includes('| ---'))
})

test('stripMarkdown：链接只读文字、图片只读 alt、裸 URL 丢掉', () => {
  const { text } = stripMarkdown('[链接文字](https://example.com/x) 与 ![图片说明](https://e/x.png) 以及 https://example.com/y')
  assert.ok(text.includes('链接文字'))
  assert.ok(text.includes('图片说明'))
  assert.ok(!text.includes('example.com'))
  assert.ok(!text.includes(']('))
})

test('stripMarkdown：代码块整块读成一个占位词并统计行数', () => {
  const all = '前面\n\n```python\nprint(1)\nprint(2)\n```\n\n后面'
  const { text, codeBlocks, codeLines } = stripMarkdown(all)
  assert.equal(codeBlocks, 1)
  assert.equal(codeLines, 2)
  assert.ok(!text.includes('print(1)'))
  assert.equal(text.split('巴拉巴拉').length - 1, 1, text)
  assert.ok(text.includes('前面'))
  assert.ok(text.includes('后面'))
})

test('stripMarkdown：未闭合的围栏也整块只念一个占位词', () => {
  const { text, codeBlocks } = stripMarkdown('前\n```\ndeprecated\n')
  assert.equal(codeBlocks, 1)
  assert.equal(text.split('巴拉巴拉').length - 1, 1, text)
  assert.ok(!text.includes('deprecated'))
})

test('stripMarkdown：剥掉 [QQ] 标记但保留块内文字；HTML 实体还原', () => {
  const { text } = stripMarkdown('[QQ]主人，晚安。[/QQ]\n<strong>粗</strong> &amp; &lt;x&gt;')
  assert.ok(!text.includes('[QQ]'))
  assert.ok(!text.includes('[/QQ]'))
  assert.ok(text.includes('主人，晚安。'))
  assert.ok(text.includes('粗'))
  assert.ok(text.includes('& <x>'), text)
  assert.ok(!text.includes('<strong>'))
})

test('stripMarkdown：空输入安全返回空串', () => {
  assert.deepEqual(stripMarkdown(''), { text: '', codeBlocks: 0, codeLines: 0 })
  assert.deepEqual(stripMarkdown(null), { text: '', codeBlocks: 0, codeLines: 0 })
})

test('splitForSpeech：短文本一段，空文本零段', () => {
  assert.deepEqual(splitForSpeech('你好呀。'), { chunks: ['你好呀。'], truncated: false })
  assert.deepEqual(splitForSpeech('   '), { chunks: [], truncated: false })
})

test('splitForSpeech：单段超长按句末标点切分，且不超过 maxChars', () => {
  const sentence = '这是一个用来测试分段的句子，需要足够长一点才能看出效果。'
  const text = sentence.repeat(10) // 约 270 字
  const { chunks, truncated } = splitForSpeech(text, 200)
  assert.equal(truncated, false)
  assert.ok(chunks.length >= 2)
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `片段超长：${chunk.length}`)
  assert.equal(chunks.join(''), text)
})

test('splitForSpeech：没有标点的超长句按字数硬切', () => {
  const text = '啊'.repeat(500)
  const { chunks } = splitForSpeech(text, 200)
  assert.equal(chunks.length, 3)
  for (const chunk of chunks) assert.ok(chunk.length <= 200)
  assert.equal(chunks.join(''), text)
})

test('splitForSpeech：过短的相邻段会合并，减少 TTS 次数', () => {
  const { chunks } = splitForSpeech('第一段。\n\n第二段。\n\n第三段。', 200)
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0].includes('第一段'))
  assert.ok(chunks[0].includes('第三段'))
})

test('splitForSpeech：maxChars 会被钳到 200~5000', () => {
  const text = '字'.repeat(3000)
  const small = splitForSpeech(text, 1)
  for (const chunk of small.chunks) assert.ok(chunk.length <= 200)
  const big = splitForSpeech(text, 999999)
  assert.equal(big.chunks.length, 1)
  assert.ok(big.chunks[0].length <= maxSegmentChars)
})

test('splitForSpeech：总字数超过 2 万会截断并标记 truncated', () => {
  const text = '啊'.repeat(25000)
  const { chunks, truncated } = splitForSpeech(text, defaultMaxChars)
  assert.equal(truncated, true)
  assert.equal(chunks.length, 10)
  for (const chunk of chunks) assert.ok(chunk.length <= defaultMaxChars)
  assert.equal(chunks.join('').length, 20000)

  // 小分段时：2 万字切成 100 段，最终只保留前 40 段。
  const small = splitForSpeech(text, 200)
  assert.equal(small.truncated, true)
  assert.equal(small.chunks.length, maxSegments)
})

test('prepareSpeech：清洗 + 分段 + 统计代码块', () => {
  const r = prepareSpeech(example, { maxChars: 200 })
  assert.ok(r.chunks.length >= 1)
  assert.ok(r.chars > 0)
  assert.equal(r.codeBlocks, 1)
  assert.equal(r.codeLines, 2)
  assert.equal(r.truncated, false)
  assert.ok(!r.text.includes('const a = 1'))
  assert.ok(r.text.includes('巴拉巴拉'), r.text)
  assert.ok(r.text.includes('主人，测试一下。'))
  for (const chunk of r.chunks) assert.ok(chunk.length <= 200)
})

test('prepareSpeech：只有代码块时没有可朗读内容', () => {
  const r = prepareSpeech('```\ncode\n```')
  assert.equal(r.chunks.length, 0)
  assert.equal(r.text, '')
  assert.equal(r.chars, 0)
  assert.equal(r.codeBlocks, 1)
})

test('分段：换行是边界（两段都够长）', () => {
  const { chunks } = splitForSpeech('第一段内容写长一点，别太短。\n第二段内容也写长一点，单独成段。', 2000)
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].startsWith('第一段'))
  assert.ok(chunks[1].startsWith('第二段'))
})

test('分段：不足 10 字的碎片不单独成段（并到下一段）', () => {
  const { chunks } = splitForSpeech('嗯。今天天气不错，我们出去走走吧。', 2000)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], '嗯。今天天气不错，我们出去走走吧。')
})

test('分段：末尾的碎片并到上一段', () => {
  const { chunks } = splitForSpeech('前面这句写得足够长了可以成为一段。\n好。', 2000)
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0].endsWith('好。'))
})

test('分段：句末标点即分段边界', () => {
  const text = '这是第一句话，写得足够长可以单独成段。这是第二句话，同样足够长能单独成段。'
  const { chunks } = splitForSpeech(text, 2000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], '这是第一句话，写得足够长可以单独成段。')
  assert.equal(chunks[1], '这是第二句话，同样足够长能单独成段。')
})

test('分段：单句超过 maxChars 才按字数硬切', () => {
  const text = '没有标点的一长串文字'.repeat(40) // 480 字，无标点
  const { chunks } = splitForSpeech(text, 200)
  assert.ok(chunks.length >= 2)
  for (const chunk of chunks) assert.ok(chunk.length <= 200)
  assert.equal(chunks.join(''), text)
})

test('朗读化：版本号、小数、百分比、带单位数值都读成中文', () => {
  const spoken = (input) => prepareSpeech(input).text
  assert.equal(spoken('版本 2.5.0 已发布。'), '版本二点五点零已发布。')
  assert.equal(spoken('dsh-context 0.84.0 修好了。'), 'dsh context 零点八四点零修好了。')
  assert.equal(spoken('CPU 占用 87.5%，延迟 69ms。'), 'CPU 占用百分之八十七点五，延迟六十九毫秒。')
  assert.equal(spoken('延迟 69ms，占用 87.5%。'), '延迟六十九毫秒，占用百分之八十七点五。')
})

test('朗读化：行内代码统一读成占位词，表格/标题/列表标记不念', () => {
  const spoken = (input) => prepareSpeech(input).text
  const inline = spoken('\u0060lastBoot.confirmed=true\u0060 不用念，\u00604d35203\u0060 也不用。')
  assert.ok(!inline.includes('lastBoot'), inline)
  assert.ok(!inline.includes('4d35203'), inline)
  assert.equal(inline, '巴拉巴拉不用念，巴拉巴拉也不用。')
  assert.equal(
    spoken('| 名称 | 版本 |\n| --- | --- |\n| 内核 | 2.5.0 |'),
    '名称，版本。内核，二点五点零',
  )
  assert.equal(spoken('## 标题\n- 第一项\n- 第二项\n---\n正文。'), '标题。第一项。第二项。正文。')
})

test('朗读化：反引号内容统一读成巴拉巴拉，保留句子位置', () => {
  const sample = '朗读化自检：版本 2.5.0 已经发布，本地 AI 服务 69ms 响应、8 条表情，用时 1.2 秒；反引号里的 `lastBoot.confirmed=true` 和 `4d35203` 不念。'
  assert.equal(
    prepareSpeech(sample).text,
    '朗读化自检：版本二点五点零已经发布，本地 AI 服务六十九毫秒响应、八条表情，用时一点二秒；反引号里的巴拉巴拉和巴拉巴拉不念。',
  )

  // 单段行内代码：占位词落在句子中间，不留反引号和原文。
  const single = prepareSpeech('先 `lastBoot.confirmed=true` 再看结果。').text
  assert.equal(single, '先巴拉巴拉再看结果。')

  // 句中两段：各出一个占位词，不连成一串。
  const two = prepareSpeech('先 `a` 再 `b` 然后。').text
  assert.equal(two.split('巴拉巴拉').length - 1, 2, two)
  assert.ok(!two.includes('`'), two)

  // 含路径的行内代码：路径整段换成占位词。
  const filePath = prepareSpeech('见 `E:/dsh-fish-service/lib/speech.js` 里的实现。').text
  assert.ok(filePath.includes('巴拉巴拉'), filePath)
  assert.ok(!filePath.includes('speech.js'), filePath)
  assert.ok(!filePath.includes('`'), filePath)
})

test('stripMarkdown：代码块整块只念一个占位词，不按行重复', () => {
  const block = '前\n```\na\nb\nc\n```\n后'
  const { text, codeBlocks } = stripMarkdown(block)
  assert.equal(codeBlocks, 1)
  assert.equal(text.split('巴拉巴拉').length - 1, 1, text)
  assert.ok(!text.includes('\na\n'))

  // 相邻两段行内代码只隔顿号时合并成一个占位词。
  const merged = stripMarkdown('先 `a`、`b` 后。').text
  assert.equal(merged.split('巴拉巴拉').length - 1, 1, merged)
})

test('朗读化：对已朗读化的文本再跑一遍结果不变（幂等）', () => {
  const inputs = [
    '版本 2.5.0 已发布。',
    'dsh-context 0.84.0 修好了。',
    'CPU 占用 87.5%，延迟 69ms。',
    '\u0060lastBoot.confirmed=true\u0060 不用念。',
    '| 名称 | 版本 |\n| --- | --- |\n| 内核 | 2.5.0 |',
    '2026-11-12 9:07 温度 26\u00b0C，电话 13812345678。',
    '开 4 个并发，ratio 是 0.5。',
    '本地 AI 服务 69ms 响应，共 8 条。',
    '甲。。乙；。',
  ]
  for (const input of inputs) {
    const once = prepareSpeech(input).text
    const twice = prepareSpeech(once).text
    assert.equal(twice, once, `不幂等：${input}`)
  }
})

test('朗读化：中文数字两侧不留空格，英文词间空格保留', () => {
  const spoken = (input) => prepareSpeech(input).text
  // 数字和单位读成汉字后两侧的空格去掉，否则念出来会多一个停顿。
  assert.equal(
    spoken('本地 AI 服务 69ms 响应，共 8 条，dsh context 正常。'),
    '本地 AI 服务六十九毫秒响应，共八条，dsh context 正常。',
  )
  // 英文词之间、中英文之间的空格是词边界，不能被一起删掉。
  assert.equal(spoken('本地 AI 服务和 dsh context 都正常。'), '本地 AI 服务和 dsh context 都正常。')
  assert.ok(!/[\u4e00-\u9fff] [\u4e00-\u9fff]/.test(spoken('版本 2.5.0 已发布，共 8 条')))
})

test('朗读化：连续标点收敛成一个，句末优先', () => {
  const spoken = (input) => prepareSpeech(input).text
  assert.equal(spoken('甲。。乙；。'), '甲。乙。')
  assert.equal(spoken('版本 2.5.0 已发布！？。'), '版本二点五点零已发布。')
  assert.equal(spoken('结束：，'), '结束，')
  assert.equal(spoken('先这样；。\n再那样：，\n完了。。'), '先这样。再那样。完了。')
})

