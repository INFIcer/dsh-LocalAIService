// 右栏「双语翻译」客户端纯逻辑：切段 / 缓存 / 状态机 / 面板文案。
//
// 这些是 UI 背后的规则，真机验收见 docs/P2.md。加载方式和 client-load.test.js 一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { detectLanguage } from '../lib/lang.js'

function installReact() {
  return {
    createElement: (...param) => ({ param }),
    useState: (initialValue) => [typeof initialValue === 'function' ? initialValue() : initialValue, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (factoryFn) => factoryFn(),
    useSyncExternalStore: () => null,
    Fragment: 'Fragment',
    version: '18.2.0',
  }
}

function load() {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (define) => { factory = define.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  const exported = factory((displayName) => {
    if (displayName === 'react') return installReact()
    throw new Error(`未预期的 require：${displayName}`)
  })
  return { exported, service: exported.__testing }
}

// vm 里造出来的数组/对象和外面的原型不同，比较前先转成普通结构。
const plain = (value) => JSON.parse(JSON.stringify(value))

// 分段样本：每段都超过 10 字，避免被「短碎片并段」规则并掉。
const segmentText = ['第一段内容刚好十个字', '第二段内容也是十个字', '第三段内容同样十个字']
const threeSegmentOriginal = segmentText.join('\n\n')
const translate = (text) => '译:' + text
const threeSegmentTranslated = segmentText.map(translate).join('\n\n')

function collectText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  const [type, prop, ...child] = node.param
  if (typeof type === 'function') return collectText(type(prop || {}))
  if (type === 'svg') return ''
  return child.map(collectText).join(' ')
}

function findElements(node, type, result = []) {  if (node == null || typeof node !== 'object') return result
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, result)
    return result
  }
  const [currentType, prop, ...child] = node.param
  if (currentType === type) result.push({ prop, child })
  for (const childNode of child) findElements(childNode, type, result)
  return result
}

test('检测语言：与后端 lib/lang.js 同规则', () => {
  const { service } = load()
  for (const text of ['你好', 'hello world', 'こんにちは', '안녕하세요', '123 !!!', '']) {
    assert.equal(service.detectLanguage(text), detectLanguage(text), `文本：${text}`)
  }
  assert.equal(service.detectLanguage('中文 and English'), 'zh')
  assert.equal(service.detectLanguage('日本語です'), 'ja')
  assert.equal(service.detectLanguage(null), null)
})

test('翻译方向：不是第一语言就翻第一，第一语言翻第二，测不出翻第一', () => {
  const { service } = load()
  const config = { primaryLanguage: 'zh', secondaryLanguage: 'en' }
  assert.deepEqual(plain(service.pickTranslationDirection('hello', config)), { source: 'en', target: 'zh', detected: 'en' })
  assert.deepEqual(plain(service.pickTranslationDirection('你好', config)), { source: 'zh', target: 'en', detected: 'zh' })
  assert.deepEqual(plain(service.pickTranslationDirection('123', config)), { source: 'auto', target: 'zh', detected: null })
  // 配置里是认不出的语言代码就回退到中文 / 英文。
  assert.equal(service.pickTranslationDirection('hi', { primaryLanguage: 'xx', secondaryLanguage: '' }).target, 'zh')
  assert.equal(service.translationRuleCopy(config), '自动：非中文 → 中文，中文 → 英文')
  assert.ok(service.translationRuleCopy(config).length <= 22, '规则说明要控制在一行里')
  assert.equal(service.translationDirectionCopy({ source: 'zh', target: 'en' }), '中文 → 英文')
  assert.equal(service.translationDirectionCopy({ source: 'auto', target: 'zh' }), '自动检测 → 中文')
})

test('切段：换行/句末标点都是边界，短碎片并到相邻段，拼回去与原文逐字一致', () => {
  const { service } = load()
  const sampleData = [
    '',
    '   ',
    '你好',
    '第一段内容刚好十个字\n\n第二段内容也是十个字',
    '第一段内容刚好十个字\n第二段内容也是十个字',
    ' 缩进开头\n第二行没有空行',
    '第一句话刚好十个字。第二句话也是十个字！第三句话同样十个字？',
    'He said "hi." Then left.\nNext line.',
    '第一段\r\n\r\n第二段',
    '第一段内容刚好十个字\r\n第二段内容也是十个字',
    '第一段内容刚好十个字\n \n第二段内容也是十个字\n\n\n',
    '行尾空格   \n\n  下一段前面有空格',
    'a'.repeat(2000),
    '长句'.repeat(600),
  ]
  for (const original of sampleData) {
    const segments = service.splitSegment(original)
    const rebuild = service.assembleTranslated(segments, segments.map((segment) => segment.text))
    assert.equal(rebuild, original, `原文：${JSON.stringify(original.slice(0, 40))}`)
  }

  // 单换行必须是边界：两行都够长，不会被并段。
  assert.deepEqual(
    plain(service.splitSegment('第一段内容刚好十个字\n第二段内容也是十个字').map((segment) => segment.text)),
    ['第一段内容刚好十个字', '第二段内容也是十个字'],
  )
  // 句末标点也是边界，标点跟着前一句。
  assert.deepEqual(
    plain(service.splitSegment('第一句话刚好十个字。第二句话也是十个字！').map((segment) => segment.text)),
    ['第一句话刚好十个字。', '第二句话也是十个字！'],
  )
  // 空行照样分开（两段都够长）。
  assert.deepEqual(
    plain(service.splitSegment('第一段内容刚好十个字\n\n第二段内容也是十个字').map((segment) => segment.text)),
    ['第一段内容刚好十个字', '第二段内容也是十个字'],
  )
  // 极短碎片并到相邻段，且不多出换行。
  const mergeAfter = service.splitSegment('短\n这句话内容够长了不用再并')
  assert.equal(mergeAfter.length, 1)
  assert.equal(mergeAfter[0].text, '短\n这句话内容够长了不用再并')
  assert.equal(service.assembleTranslated(mergeAfter, mergeAfter.map((segment) => segment.text)), '短\n这句话内容够长了不用再并')

  // 只有单片超过 800 字才硬切。
  const lengthSegments = service.splitSegment('a'.repeat(2000))
  assert.ok(lengthSegments.length >= 3)
  for (const segment of lengthSegments) assert.ok(segment.text.length <= 800)
  for (const segment of service.splitSegment('长句'.repeat(600))) assert.ok(segment.text.length <= 800)
})

test('缓存：命中不重翻，改一段只多一条待翻；方向不同不复用；超过上限淘汰最旧', () => {
  const { service } = load()
  const direction = { source: 'zh', target: 'en' }
  service.clearTranslationCache()

  const segments = service.splitSegment(threeSegmentOriginal)
  let plan = service.planTranslation(segments, direction)
  assert.equal(plan.pending.length, 3)
  for (const item of plan.pending) service.writeCache(direction, item.text, `译${item.text}`)

  plan = service.planTranslation(segments, direction)
  assert.equal(plan.pending.length, 0)
  assert.equal(service.assembleTranslated(segments, plan.translatedTable), segmentText.map((text) => '译' + text).join('\n\n'))

  const updateAfter = service.splitSegment(segmentText[0] + '\n\n' + segmentText[1] + '改\n\n' + segmentText[2])
  plan = service.planTranslation(updateAfter, direction)
  assert.deepEqual(plain(plan.pending.map((item) => item.text)), [segmentText[1] + '改'])
  assert.equal(service.planTranslation(updateAfter, { source: 'zh', target: 'ja' }).pending.length, 3)

  service.clearTranslationCache()
  for (let i = 0; i < 2001; i += 1) service.writeCache(direction, `段${i}`, `译${i}`)
  assert.equal(service.readCache(direction, '段2000'), '译2000')
  assert.equal(service.readCache(direction, '段0'), undefined)
})

test('批次：满 20 段或满 8000 字就另起一批', () => {
  const { service } = load()
  const segments = Array.from({ length: 45 }, (_, i) => ({ index: i, text: 'x'.repeat(100) }))
  assert.deepEqual(plain(service.planBatchNo(segments).map((batch) => batch.length)), [20, 20, 5])
  const bigChar = Array.from({ length: 3 }, (_, i) => ({ index: i, text: 'x'.repeat(5000) }))
  assert.deepEqual(plain(service.planBatchNo(bigChar).map((batch) => batch.length)), [1, 1, 1])
  assert.deepEqual(plain(service.planBatchNo([])), [])
})

test('状态机：同步 → 修改中 → 翻译中 → 同步，三态全路径', () => {
  const { service } = load()
  let status = service.translationEmptyStatus()
  assert.equal(status.phase, '同步', '空状态是同步态')
  assert.equal(status.originalSide, null)
  assert.equal(service.translationLockedSide(status), null, '同步态两边都可编辑')
  assert.equal(service.translationCanRun(status), false, '同步态没定原文，按钮禁用')
  assert.equal(service.translationButtonLabel(status), '翻译')

  // 同步态任一框写入非空内容 → 修改中，这侧是原文，另一侧锁定。
  status = service.translationEdit(status, 'upper', '你好')
  assert.equal(status.phase, '修改中')
  assert.equal(status.originalSide, 'upper')
  assert.equal(service.translationLockedSide(status), 'lower')
  assert.equal(service.translationCanRun(status), true)

  // 修改中继续改原文：还是修改中。
  const againUpdate = service.translationEdit(status, 'upper', '你好呀')
  assert.equal(againUpdate.phase, '修改中')
  assert.equal(againUpdate.upper, '你好呀')

  // 修改中改译文侧：纯函数直接拒绝。
  assert.equal(service.translationEdit(status, 'lower', '偷偷改'), status)

  // 翻译中两侧都不能改，按钮变进度文案。
  const translatingStatus = { ...status, phase: '翻译中' }
  assert.equal(service.translationEdit(translatingStatus, 'upper', '改'), translatingStatus)
  assert.equal(service.translationEdit(translatingStatus, 'lower', '改'), translatingStatus)
  assert.equal(service.translationCanRun(translatingStatus), false)
  assert.equal(service.translationButtonLabel(translatingStatus), '正在翻译…')
  assert.equal(service.translationLockedSide(translatingStatus), null, '翻译中两侧都只读，不归「锁定侧」管')

  // 清空原文 → 回同步态，另一侧内容保留。
  const clear = service.translationEdit(status, 'upper', '   ')
  assert.equal(clear.phase, '同步')
  assert.equal(clear.originalSide, null)
  assert.equal(service.translationCanRun(clear), false)

  // 失败 / 取消都停在修改中，按钮显示继续翻译。
  assert.equal(service.translationButtonLabel({ ...status, prompt: '服务暂时不可用' }), '继续翻译')
  assert.equal(service.translationButtonLabel({ ...status, prompt: '已取消，已翻好的部分保留' }), '继续翻译')
})

test('面板：两个框 + 翻译按钮 + 方向规则一行；空闲时提示先输入', () => {
  const { exported } = load()
  const tree = exported.__testing.translationPanel({ sessionId: 's1' })
  const text = collectText(tree)

  const inputs = findElements(tree, 'textarea')
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0].prop.value, '')
  assert.equal(inputs[0].prop.disabled, false)
  assert.equal(inputs[0].prop.readOnly, false)
  assert.equal(inputs[1].prop.disabled, false)

  assert.match(text, /翻译/)
  assert.match(text, /可输入/)
  assert.match(text, /先输入要翻译的文字/)
  assert.match(text, /自动：非中文 → 中文，中文 → 英文/)

  const buttons = findElements(tree, 'button')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].prop.disabled, true, '没输入时不能点翻译')
})

// ---------------- 分段映射 / 局部重翻 / 分段操作 ----------------

const translationConfig = { primaryLanguage: 'zh', secondaryLanguage: 'en' }

function findClass(node, className, result = []) {
  if (node == null || typeof node !== 'object') return result
  if (Array.isArray(node)) {
    for (const child of node) findClass(child, className, result)
    return result
  }
  const [type, prop, ...child] = node.param
  if (prop && typeof prop.className === 'string' && prop.className.split(' ').includes(className)) result.push({ prop, child })
  for (const childNode of child) findClass(childNode, className, result)
  return result
}

// 假网络：任务队列是「提交一批 → 轮询状态 → 按 id 取结果」。
// 记录里只放 post（提交/回退/取消），get 的状态与结果按批次自动回。
function fakeNetwork(record, option = {}) {
  const batchNo = new Map()
  let seq = 0
  const post = async (path, body) => {
    record.push({ path, body: plain(body) })
    if (path === '/translate/jobs' && option.submit) return option.submit(body)
    if (path === '/translate/jobs') {
      const id = `任务${(seq += 1)}`
      batchNo.set(id, Array.isArray(body.texts) ? body.texts : [])
      return { ok: true, id, state: 'queued' }
    }
    if (path === '/translate/batch') {
      return { ok: true, results: body.texts.map((item) => ({ id: item.id, translated: `译:${item.text}` })) }
    }
    if (path === '/translate/jobs/cancel') return { ok: true, id: body.id, state: 'canceled' }
    return { ok: false, code: 'bad_request' }
  }
  const get = async (path) => {
    if (option.get) return option.get(path)
    if (path.startsWith('/translate/jobs/status')) {
      return { ok: true, id: '任务1', state: option.status || 'done' }
    }
    if (path.startsWith('/translate/jobs/result')) {
      const id = decodeURIComponent(path.split('id=')[1] || '')
      const texts = batchNo.get(id) || []
      return { ok: true, id, state: 'done', texts: texts.map((text) => `译:${text}`) }
    }
    return null
  }
  return { post, get }
}

async function makeDoneState(service, original, record) {
  const initial = service.translationEdit(service.translationEmptyStatus(), 'upper', original)
  const plan = service.buildTranslationPlan(initial, translationConfig)
  const result = await service.runTranslation(plan, fakeNetwork(record))
  assert.equal(result.fail, '')
  return service.translationSuccessStatus(initial, plan)
}

test('编辑规则：翻译完成后回同步态，两侧可编辑；谁再编辑谁就是原文', async () => {
  const { service } = load()
  const record = []
  const done = await makeDoneState(service, threeSegmentOriginal, record)
  assert.equal(record.length, 1)
  assert.equal(done.phase, '同步')
  assert.equal(done.originalSide, null, '翻译成功后原文侧清空')
  assert.equal(done.lower, threeSegmentTranslated)
  assert.equal(service.translationLockedSide(done), null, '同步态两侧都可编辑')
  assert.equal(service.mapValid(done), true, '同步态分段映射仍然可用')
  assert.equal(service.translationCanRun(done), false, '同步态还没定原文，按钮先禁用')
  assert.equal(service.buildTranslationPlan(done, translationConfig), null)

  // 用户去改译文里的小错：被编辑的这侧成为新的原文，另一侧锁成译文输出。
  service.clearTranslationCache()
  const updateTranslate = service.translationEdit(done, 'lower', done.lower.replace(translate(segmentText[1]), translate(segmentText[1]) + '（手改）'))
  assert.equal(updateTranslate.phase, '修改中')
  assert.equal(updateTranslate.originalSide, 'lower', '谁再编辑谁就是新的原文')
  assert.equal(service.translationLockedSide(updateTranslate), 'upper')
  assert.equal(service.mapValid(updateTranslate), true, '切换原文侧后映射要跟着翻')
  assert.equal(updateTranslate.upper, done.upper, '只改被编辑的那侧，另一侧文本不动')

  // 修改中改译文侧：纯函数直接拒绝。
  assert.equal(service.translationEdit(updateTranslate, 'upper', '偷偷改'), updateTranslate)

  // 按新的原文侧重新分段；没改过的段沿用 state 里的旧译文。
  const plan = service.buildTranslationPlan(updateTranslate, translationConfig)
  assert.ok(plan)
  assert.equal(plan.side, 'lower')
  assert.deepEqual(plain(plan.pending.map((item) => item.text)), [translate(segmentText[1]) + '（手改）'])
  assert.equal(plan.reuseCount, 2)
})

test('改局部重翻：只发改过的段，未改段沿用 state 里的旧译文', async () => {
  const { service } = load()
  const record = []
  const done = await makeDoneState(service, threeSegmentOriginal, record)
  service.clearTranslationCache()

  const updateAfter = service.translationEdit(done, 'upper', segmentText[0] + '\n\n' + segmentText[1] + '改\n\n' + segmentText[2])
  assert.equal(updateAfter.originalSide, 'upper')
  assert.equal(updateAfter.phase, '修改中')

  const plan = service.buildTranslationPlan(updateAfter, translationConfig)
  assert.deepEqual(plain(plan.pending.map((item) => item.text)), [segmentText[1] + '改'])
  assert.equal(plan.reuseCount, 2)
  assert.equal(plan.translatedTable[0], translate(segmentText[0]))
  assert.equal(plan.translatedTable[2], translate(segmentText[2]))

  const result = await service.runTranslation(plan, fakeNetwork(record))
  assert.equal(result.fail, '')
  assert.equal(record.length, 2)
  assert.deepEqual(plain(record[1].body.texts), [segmentText[1] + '改'], '只发改过的段')
  assert.equal(record[1].body.source, plan.direction.source)
  assert.equal(record[1].body.target, plan.direction.target)

  const success = service.translationSuccessStatus(updateAfter, plan)
  assert.equal(success.phase, '同步')
  assert.equal(success.originalSide, null)
  assert.equal(success.sideMap, 'upper')
  assert.equal(success.lower, [translate(segmentText[0]), translate(segmentText[1] + '改'), translate(segmentText[2])].join('\n\n'))
  assert.match(success.success, /2 段沿用上次/)
  // 开始翻译时也不整段清空：未改段的旧译文先在框里。
  const begin = service.translationBeginStatus(updateAfter, plan)
  assert.equal(begin.phase, '翻译中')
  assert.equal(begin.originalSide, 'upper')
  assert.match(begin.lower, /译:第一段内容刚好十个字/)
  assert.match(begin.lower, /译:第三段内容同样十个字/)
})

test('分段删除 / 上移 / 下移：只改文本和分段映射，不调用翻译服务', async () => {
  const { service } = load()
  const record = []
  const done = await makeDoneState(service, threeSegmentOriginal, record)
  const requestCount = record.length

  const removed = service.pieceAction(done, '删除', 1)
  assert.equal(record.length, requestCount, '删除分段不许发请求')
  assert.equal(removed.originalSide, 'upper', '同步态里动分段：映射锚定的一侧定为原文')
  assert.equal(removed.phase, '修改中')
  assert.equal(removed.upper, segmentText[0] + '\n\n' + segmentText[2])
  assert.equal(removed.lower, [translate(segmentText[0]), translate(segmentText[2])].join('\n\n'), '其余分段译文保持不动')
  assert.equal(service.mapValid(removed), true)
  assert.equal(service.fetchSideFragment(removed, 'upper').contents.length, 2)

  // 删除后点翻译：已有译文全部沿用，仍然不发请求。
  service.clearTranslationCache()
  const plan = service.buildTranslationPlan(removed, translationConfig)
  assert.equal(plan.pending.length, 0)
  const result = await service.runTranslation(plan, fakeNetwork(record))
  assert.equal(result.requestBatchNo, 0)
  assert.equal(record.length, requestCount)

  const moveUp = service.pieceAction(done, '上移', 1)
  assert.equal(record.length, requestCount, '移动分段不许发请求')
  assert.equal(moveUp.upper, [segmentText[1], segmentText[0], segmentText[2]].join('\n\n'))
  assert.equal(moveUp.lower, [translate(segmentText[1]), translate(segmentText[0]), translate(segmentText[2])].join('\n\n'))
  assert.equal(service.mapValid(moveUp), true)

  // 移动后点翻译：按原文快照找到原来的译文沿用，也只补缺失段、不发请求。
  service.clearTranslationCache()
  const afterMovePlan = service.buildTranslationPlan(moveUp, translationConfig)
  assert.equal(afterMovePlan.pending.length, 0, '移动不改原文快照，旧译文都能沿用')
  const afterMoveResult = await service.runTranslation(afterMovePlan, fakeNetwork(record))
  assert.equal(afterMoveResult.requestBatchNo, 0)
  assert.equal(record.length, requestCount)

  const moveDown = service.pieceAction(done, '下移', 0)
  assert.equal(moveDown.upper, [segmentText[1], segmentText[0], segmentText[2]].join('\n\n'))
  assert.equal(moveDown.lower, [translate(segmentText[1]), translate(segmentText[0]), translate(segmentText[2])].join('\n\n'))
  assert.equal(record.length, requestCount)

  // 边界与翻译中不动。
  assert.equal(service.pieceAction(done, '上移', 0), done)
  assert.equal(service.pieceAction(done, '下移', 2), done)
  assert.equal(service.pieceAction(done, '删除', 9), done)
  assert.equal(service.pieceAction({ ...done, phase: '翻译中' }, '删除', 0).phase, '翻译中')

  // 全部删空回到空状态。
  let empty = done
  for (let i = 0; i < 3; i += 1) empty = service.pieceAction(empty, '删除', 0)
  assert.equal(empty.originalSide, null)
  assert.equal(empty.phase, '同步')
})

test('映射偏移：改段内文字只动这一段，切片段能还原两侧分段', () => {
  const { service } = load()
  const segments = service.splitSegment(threeSegmentOriginal)
  const compose = service.joinSegments(segments, ['译一', '译二', '译三'], [true, true, true])
  assert.equal(compose.originalText, threeSegmentOriginal)
  assert.equal(compose.translatedText, '译一\n\n译二\n\n译三')
  assert.deepEqual(plain(compose.pieces.map((item) => [item.originalStart, item.originalEnd])), [[0, 10], [12, 22], [24, 34]])
  assert.deepEqual(plain(compose.pieces.map((item) => [item.translatedStart, item.translatedEnd])), [[0, 2], [4, 6], [8, 10]])

  const status = {
    ...service.translationEmptyStatus(),
    upper: compose.originalText,
    lower: compose.translatedText,
    originalSide: 'upper',
    pieces: compose.pieces,
  }
  const originalSideFragment = service.fetchSideFragment(status, 'upper')
  assert.deepEqual(plain(originalSideFragment.leadings), ['', '\n\n', '\n\n', ''])
  assert.deepEqual(plain(originalSideFragment.contents), segmentText)
  const translatedSideFragment = service.fetchSideFragment(status, 'lower')
  assert.deepEqual(plain(translatedSideFragment.contents), ['译一', '译二', '译三'])

  // 在第二段末尾插一个字：只影响第二段之后（含第二段末尾）的偏移。
  const nextText = segmentText[0] + '\n\n' + segmentText[1] + '改\n\n' + segmentText[2]
  const offset = service.adjustPieceOffset(compose.pieces, 'original', compose.originalText, nextText)
  assert.deepEqual(plain(offset.map((item) => [item.originalStart, item.originalEnd])), [[0, 10], [12, 23], [25, 35]])
  const nextFragment = service.switchFragment(nextText, offset, 'originalStart', 'originalEnd')
  assert.deepEqual(plain(nextFragment.contents), [segmentText[0], segmentText[1] + '改', segmentText[2]])
  // 译文侧没改，偏移一点不动。
  const translatedOffset = service.adjustPieceOffset(compose.pieces, 'translated', compose.translatedText, compose.translatedText)
  assert.deepEqual(plain(translatedOffset.map((item) => [item.translatedStart, item.translatedEnd])), [[0, 2], [4, 6], [8, 10]])

  // 没翻译过 / 映射失效时不显示分段。
  const empty = service.translationEmptyStatus()
  assert.equal(service.fetchSideFragment(empty, 'upper'), null)
  assert.equal(service.mapValid({ ...status, upper: '别的文本' }), false)
})

test('中止：失败时保留已翻好的段和未改段的旧译文', async () => {
  const { service } = load()
  const record = []
  const done = await makeDoneState(service, [segmentText[0], segmentText[1]].join('\n\n'), record)
  service.clearTranslationCache()
  const updateAfter = service.translationEdit(done, 'upper', [segmentText[0], segmentText[1] + '改'].join('\n\n'))
  const plan = service.buildTranslationPlan(updateAfter, translationConfig)
  const result = await service.runTranslation(plan, {
    ...fakeNetwork(record, { submit: () => ({ ok: false, code: 'upstream_error', hint: '服务暂时不可用' }) }),
    wait: async () => {},
  })
  assert.equal(result.fail, '服务暂时不可用')
  const interrupt = service.translationAbortState(updateAfter, plan, '失败', result.fail)
  assert.equal(interrupt.phase, '修改中', '失败回修改中，可直接点继续翻译')
  assert.equal(interrupt.originalSide, 'upper')
  assert.equal(interrupt.prompt, '服务暂时不可用')
  assert.match(interrupt.lower, /译:第一段内容刚好十个字/, '没翻成的段沿用旧译文，不整段清空')
})

test('面板：有分段映射才渲染镜像分段层和分段条', () => {
  const { service } = load()
  const segments = service.splitSegment([segmentText[0], segmentText[1]].join('\n\n'))
  const compose = service.joinSegments(segments, ['译一', '译二'], [true, true])
  const done = {
    ...service.translationEmptyStatus(),
    upper: compose.originalText,
    lower: compose.translatedText,
    originalSide: null,
    sideMap: 'upper',
    phase: '同步',
    direction: { source: 'zh', target: 'en', detected: 'zh' },
    pieces: compose.pieces,
    success: '中文 → 英文 · 已翻译 2 段',
  }
  service.translationDraft.set('s2', done)
  const tree = service.translationPanel({ sessionId: 's2' })
  const mirrors = findClass(tree, 'fish-tr-mirror')
  assert.equal(mirrors.length, 2, '两侧各有一层镜像')
  const segmentNodes = []
  for (const mirror of mirrors) {
    for (const node of findElements(mirror.child, 'span')) {
      if (node.prop && node.prop['data-seg'] != null) segmentNodes.push(node)
    }
  }
  assert.equal(segmentNodes.length, 4)
  assert.deepEqual(plain(segmentNodes.map((node) => node.prop['data-seg'])), [0, 1, 0, 1])
  assert.match(collectText(tree), /点一下分段，可上移 \/ 下移 \/ 删除/)
  assert.equal(findClass(tree, 'fish-tr-segbar').length, 1)

  // 顶部固定操作区：操作行 / 提示 / 规则 / 分段条都在两个输入框上方。
  const rootChilds = tree.param.slice(2)
  assert.equal(rootChilds.length, 2, '卡片根只有顶部操作区和输入框两段')
  assert.equal(rootChilds[0].param[1].className, 'fish-tr-top')
  const topClasses = rootChilds[0].param.slice(2).filter(Boolean).map((item) => item.param[1] && item.param[1].className)
  assert.ok(topClasses.includes('fish-tr-actions'), '操作行在顶部')
  assert.ok(topClasses.includes('fish-tr-segbar'), '分段工具条在输入框上方')
  assert.ok(topClasses.some((className) => typeof className === 'string' && className.includes('fish-tr-note')), '规则说明在顶部')
  assert.equal(rootChilds[1].param[1].className, 'fish-tr-grid')
  const inputs = findElements(tree, 'textarea')
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0].prop.readOnly, false, '同步态两侧都可编辑')
  assert.equal(inputs[1].prop.readOnly, false)
  assert.equal(findElements(tree, 'button').some((item) => collectText(item.child) === '改这一侧'), false, '同步态没有锁定侧')

  // 还没翻译过：没有分段映射，不渲染镜像层和分段条。
  service.translationDraft.delete('s2')
  const emptyTree = service.translationPanel({ sessionId: 's3' })
  assert.equal(findClass(emptyTree, 'fish-tr-mirror').length, 0)
  assert.equal(findClass(emptyTree, 'fish-tr-segbar').length, 0)
  assert.match(collectText(emptyTree), /可输入/)
})

test('选中状态机：悬停只预览，点击才选中，再点或取消都回到未选', () => {
  const { service } = load()
  assert.deepEqual(plain(service.pieceEmptyInteraction()), { hover: null, selected: null })

  const hover = service.pieceInteraction(service.pieceEmptyInteraction(), { type: '悬停', index: 1 })
  assert.deepEqual(plain(hover), { hover: 1, selected: null }, '悬停不能改变选中')

  const click = service.pieceInteraction(hover, { type: '点击', index: 1 })
  assert.deepEqual(plain(click), { hover: 1, selected: 1 })

  // 鼠标移开：悬停清掉，选中保留。
  const moveAway = service.pieceInteraction(click, { type: '悬停', index: null })
  assert.deepEqual(plain(moveAway), { hover: null, selected: 1 })

  // 点另一段切过去，再点同一段取消。
  assert.equal(service.pieceInteraction(moveAway, { type: '点击', index: 2 }).selected, 2)
  assert.equal(service.pieceInteraction(moveAway, { type: '点击', index: 1 }).selected, null)

  // Esc、点空白、取消选择都只清选中。
  assert.equal(service.pieceInteraction(click, { type: 'Esc' }).selected, null)
  assert.equal(service.pieceInteraction(click, { type: '框外' }).selected, null)
  assert.equal(service.pieceInteraction(click, { type: '取消' }).selected, null)
  // 没命中分段（点框内空白）也取消选中。
  assert.equal(service.pieceInteraction(click, { type: '点击', index: null }).selected, null)
})

test('分段工具条：固定显示；没选中给提示，选中后按首尾禁用', () => {
  const { service } = load()
  const idle = service.pieceToolbar(3, null)
  assert.equal(collectText(idle), '点一下分段，可上移 / 下移 / 删除')
  assert.equal(findElements(idle, 'button').length, 0, '没选中时不出现操作按钮')

  const findButton = (tree, text) => findElements(tree, 'button').find((item) => collectText(item.child) === text)
  const middle = service.pieceToolbar(3, 1)
  for (const text of ['上移', '下移', '删除', '取消选择']) assert.ok(findButton(middle, text), `缺少按钮：${text}`)
  assert.equal(findButton(middle, '上移').prop.disabled, false)
  assert.equal(findButton(middle, '下移').prop.disabled, false)

  assert.equal(findButton(service.pieceToolbar(3, 0), '上移').prop.disabled, true, '第一段不能上移')
  assert.equal(findButton(service.pieceToolbar(3, 0), '下移').prop.disabled, false)
  assert.equal(findButton(service.pieceToolbar(3, 2), '下移').prop.disabled, true, '最后一段不能下移')
  assert.equal(findButton(service.pieceToolbar(3, 2), '上移').prop.disabled, false)
  // 段数变少后越界的旧选中视为未选。
  assert.equal(findElements(service.pieceToolbar(2, 2), 'button').length, 0)
})

test('改这一侧：只换原文 / 译文角色，文本不动，映射坐标跟着翻', () => {
  const { service } = load()
  const segments = service.splitSegment(threeSegmentOriginal)
  const compose = service.joinSegments(segments, threeSegmentTranslated.split('\n\n'), [true, true, true])
  const updating = {
    ...service.translationEmptyStatus(),
    upper: compose.originalText,
    lower: compose.translatedText,
    phase: '修改中',
    originalSide: 'upper',
    sideMap: 'upper',
    pieces: compose.pieces,
  }
  const swap = service.switchSwapOriginalSide(updating)
  assert.equal(swap.phase, '修改中')
  assert.equal(swap.originalSide, 'lower')
  assert.equal(swap.upper, updating.upper, '切换不动文本')
  assert.equal(swap.lower, updating.lower)
  assert.equal(service.translationLockedSide(swap), 'upper')
  assert.equal(service.mapValid(swap), true)
  assert.deepEqual(plain(service.fetchSideFragment(swap, 'lower').contents), [translate(segmentText[0]), translate(segmentText[1]), translate(segmentText[2])])
  // 再切回去，坐标与原来一致。
  const respond = service.switchSwapOriginalSide(swap)
  assert.deepEqual(
    plain(respond.pieces.map((item) => [item.originalStart, item.originalEnd, item.translatedStart, item.translatedEnd])),
    plain(compose.pieces.map((item) => [item.originalStart, item.originalEnd, item.translatedStart, item.translatedEnd])),
  )
  // 翻译中不允许换角色。
  assert.equal(service.switchSwapOriginalSide({ ...updating, phase: '翻译中' }).originalSide, 'upper')
})

test('分段映射：同步 ↔ 修改中不丢，译文侧编辑被拒', async () => {
  const { service } = load()
  const record = []
  const done = await makeDoneState(service, threeSegmentOriginal, record)
  assert.equal(service.mapValid(done), true)
  assert.equal(service.fetchSideFragment(done, 'upper').contents.length, 3)

  const update = service.translationEdit(done, 'upper', segmentText[0] + '\n\n' + segmentText[1] + '改\n\n' + segmentText[2])
  assert.equal(update.phase, '修改中')
  assert.equal(service.mapValid(update), true)
  assert.equal(service.fetchSideFragment(update, 'upper').contents.length, 3)
  assert.equal(service.fetchSideFragment(update, 'lower').contents.length, 3)
  assert.equal(service.translationEdit(update, 'lower', '动译文'), update, '修改中译文侧只读')

  // 换成另一侧当原文，映射仍然有效。
  const swap = service.switchSwapOriginalSide(update)
  assert.equal(swap.originalSide, 'lower')
  assert.equal(service.mapValid(swap), true)
  assert.equal(service.fetchSideFragment(swap, 'lower').contents.length, 3)
})

test('面板：修改中译文侧只读并给「改这一侧」；翻译中两侧只读', () => {
  const { service } = load()
  const updating = { ...service.translationEdit(service.translationEmptyStatus(), 'upper', threeSegmentOriginal), phase: '修改中' }
  service.translationDraft.set('s4', updating)
  const tree = service.translationPanel({ sessionId: 's4' })
  const inputs = findElements(tree, 'textarea')
  assert.equal(inputs[0].prop.readOnly, false, '原文侧可编辑')
  assert.equal(inputs[1].prop.readOnly, true, '译文侧只读')
  assert.equal(inputs[1].prop.disabled, false, '只读但不用 disabled，避免丢焦点')

  const buttons = findElements(tree, 'button')
  assert.ok(buttons.some((item) => collectText(item.child) === '改这一侧'), '锁定侧要有「改这一侧」入口')
  const updateSide = buttons.find((item) => collectText(item.child) === '改这一侧')
  assert.match(updateSide.prop.title, /原文/)
  const translationButton = buttons.find((item) => collectText(item.child).trim() === '翻译')
  assert.ok(translationButton, '修改中显示「翻译」按钮')
  assert.equal(translationButton.prop.disabled, false)

  // 翻译中：两侧都只读，翻译按钮禁用。
  service.translationDraft.set('s5', { ...updating, phase: '翻译中' })
  const executeTree = service.translationPanel({ sessionId: 's5' })
  const executeInputs = findElements(executeTree, 'textarea')
  assert.equal(executeInputs[0].prop.readOnly, true)
  assert.equal(executeInputs[1].prop.readOnly, true)
  const executeButton = findElements(executeTree, 'button').find((item) => collectText(item.child).includes('正在翻译'))
  assert.ok(executeButton)
  assert.equal(executeButton.prop.disabled, true)
  service.translationDraft.delete('s4')
  service.translationDraft.delete('s5')
})

// ---------------- 后台任务队列（传输层） ----------------

function makePlan(texts) {
  return {
    side: 'upper',
    otherOneSide: 'lower',
    original: texts.join('\n\n'),
    direction: { source: 'zh', target: 'en', detected: 'zh' },
    segments: [],
    translatedTable: {},
    translated: {},
    pending: texts.map((text, index) => ({ index, text })),
    totalSegmentCount: texts.length,
    reuseCount: 0,
  }
}

test('任务队列：每批 6 段 / 1500 字，串行提交，按任务 id 取回译文', async () => {
  const { service } = load()
  const record = []
  const event = []
  const texts = Array.from({ length: 13 }, (_, i) => `第${i}段${'字'.repeat(100)}`)
  const plan = makePlan(texts)
  const network = fakeNetwork(record)
  const result = await service.runTranslation(plan, {
    post: async (path, body) => {
      event.push(['post', path])
      return network.post(path, body)
    },
    get: async (path) => {
      event.push(['get', path])
      return network.get(path)
    },
  })

  assert.equal(result.done, 13)
  assert.equal(result.requestBatchNo, 3, '13 段按 6 段一批切成 6 / 6 / 1')
  assert.equal(result.fail, '')
  assert.equal(result.revert, false)
  const submits = record.filter((item) => item.path === '/translate/jobs')
  assert.deepEqual(submits.map((item) => item.body.texts.length), [6, 6, 1])
  assert.deepEqual(plain(submits[0].body.texts), texts.slice(0, 6), '任务接口收字符串数组')
  assert.equal(submits[0].body.source, 'zh')
  assert.equal(submits[0].body.target, 'en')

  // 串行：每次提交都发生在上一批取回结果之后，不会叠并发。
  let submitCount = 0
  let fetchedCount = 0
  for (const [category, path] of event) {
    if (category === 'post' && path === '/translate/jobs') {
      submitCount += 1
      assert.equal(submitCount, fetchedCount + 1, '一次只跑一批')
    }
    if (category === 'get' && path.includes('/result')) fetchedCount += 1
  }
  assert.equal(plan.translated[12], true)
  assert.equal(plan.translatedTable[0], '译:' + texts[0])
  assert.equal(plan.translatedTable[12], '译:' + texts[12])
})

test('任务进度：排队中 / 翻译中；超过 8 秒提示准备模型并带上已用时间', async () => {
  const { service } = load()
  let clock = 0
  const push = []
  const plan = makePlan(segmentText)
  const network = fakeNetwork([])
  const result = await service.runTranslation(plan, {
    post: network.post,
    get: async (path) => {
      if (path.includes('/status')) {
        if (clock >= 8000) return { ok: true, state: 'done' }
        return { ok: true, state: clock >= 2000 ? 'running' : 'queued' }
      }
      return network.get(path)
    },
    now: undefined,
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    pollMs: 1000,
    push: (done, info) => push.push([done, info]),
  })

  assert.equal(result.done, 3)
  assert.equal(result.fail, '')
  const phases = push.map((item) => item[1].phase)
  assert.ok(phases.includes('排队中'), `阶段：${phases.join('/')}`)
  assert.ok(phases.includes('翻译中'), `阶段：${phases.join('/')}`)
  const coldStart = push.find((item) => item[1].phase === '准备模型')
  assert.ok(coldStart, '超过 8 秒要给冷启动提示')
  assert.equal(coldStart[1].prompt, service.coldStartPrompt)
  assert.match(service.coldStartPrompt, /正在加载翻译模型，第一次会慢一点（约 40 秒）/)
  assert.ok(coldStart[1].used >= 8000)
  assert.equal(coldStart[1].totalCount, 3)
})

test('任务超时：超过总时长上限就停轮询、尽力取消，已翻好的段保留', async () => {
  const { service } = load()
  const record = []
  let clock = 0
  const plan = makePlan(segmentText)
  const network = fakeNetwork(record)
  const result = await service.runTranslation(plan, {
    post: network.post,
    get: async (path) => (path.includes('/status') ? { ok: true, state: 'queued' } : network.get(path)),
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    totalDurationLimit: 5000,
    pollMs: 1000,
  })
  assert.match(result.fail, /等太久/)
  assert.equal(result.canceled, false)
  assert.deepEqual(record.map((item) => item.path), ['/translate/jobs', '/translate/jobs/cancel'])
})

test('取消：停止轮询并调用任务取消接口，不把半途结果当成功', async () => {
  const { service } = load()
  const record = []
  const plan = makePlan(segmentText)
  const network = fakeNetwork(record)
  const run = { canceled: false, controller: null, taskId: null }
  const result = await service.runTranslation(plan, {
    post: network.post,
    get: async (path) => {
      if (path.includes('/status')) {
        run.canceled = true
        return { ok: true, state: 'running' }
      }
      return network.get(path)
    },
    run,
    wait: async () => {},
  })
  assert.equal(result.canceled, true)
  assert.equal(result.done, 0)
  assert.ok(record.some((item) => item.path === '/translate/jobs/cancel'), '要尽力取消服务端任务')
  assert.equal(record.filter((item) => item.path === '/translate/jobs/result').length, 0)
})

test('回退：服务不支持任务接口时改走同步批量，超时放宽到 3 分钟', async () => {
  const { service } = load()
  const record = []
  const plan = makePlan(segmentText)
  const result = await service.runTranslation(
    plan,
    fakeNetwork(record, { submit: () => ({ ok: false, code: 'not_supported' }) }),
  )
  assert.equal(result.revert, true)
  assert.equal(result.done, 3)
  assert.equal(result.fail, '')
  assert.deepEqual(record.map((item) => item.path), ['/translate/jobs', '/translate/batch'])
  assert.equal(record[1].body.timeoutMs, 180000)
  assert.deepEqual(plain(record[1].body.texts.map((item) => item.id)), [0, 1, 2])
  assert.equal(record[1].body.source, 'zh')
  assert.equal(record[1].body.target, 'en')
  assert.equal(plan.translatedTable[1], translate(segmentText[1]))
})

test('任务结果缺段：已翻好的段保留，提示可以继续翻译', async () => {
  const { service } = load()
  const plan = makePlan(segmentText)
  const network = fakeNetwork([])
  const result = await service.runTranslation(plan, {
    post: network.post,
    get: async (path) => {
      if (path.includes('/status')) return { ok: true, state: 'done' }
      if (path.includes('/result')) return { ok: true, state: 'done', texts: [translate(segmentText[0]), translate(segmentText[1])] }
      return null
    },
  })
  assert.equal(result.done, 2)
  assert.match(result.fail, /继续翻译/)
  assert.equal(plan.translated[0], true)
  assert.equal(plan.translated[1], true)
  assert.equal(plan.translated[2], undefined)
})
