// 右栏「双语翻译」客户端纯逻辑：切段 / 缓存 / 状态机 / 面板文案。
//
// 这些是 UI 背后的规则，真机验收见 docs/P2.md。加载方式和 client-load.test.js 一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { 检测语言 } from '../lib/lang.js'

function 装React() {
  return {
    createElement: (...参数) => ({ 参数 }),
    useState: (初值) => [typeof 初值 === 'function' ? 初值() : 初值, () => {}],
    useEffect: () => {},
    useRef: (值) => ({ current: 值 }),
    useCallback: (函数) => 函数,
    useMemo: (工厂函数) => 工厂函数(),
    useSyncExternalStore: () => null,
    Fragment: 'Fragment',
    version: '18.2.0',
  }
}

function 载入() {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  const 导出 = 工厂((名字) => {
    if (名字 === 'react') return 装React()
    throw new Error(`未预期的 require：${名字}`)
  })
  return { 导出, 测试: 导出.__testing }
}

// vm 里造出来的数组/对象和外面的原型不同，比较前先转成普通结构。
const 直 = (值) => JSON.parse(JSON.stringify(值))

// 分段样本：每段都超过 10 字，避免被「短碎片并段」规则并掉。
const 段文 = ['第一段内容刚好十个字', '第二段内容也是十个字', '第三段内容同样十个字']
const 三段原文 = 段文.join('\n\n')
const 译 = (文本) => '译:' + 文本
const 三段译文 = 段文.map(译).join('\n\n')

function 收文字(节点) {
  if (节点 == null || typeof 节点 === 'boolean') return ''
  if (typeof 节点 === 'string' || typeof 节点 === 'number') return String(节点)
  if (Array.isArray(节点)) return 节点.map(收文字).join(' ')
  const [类型, 属性, ...子] = 节点.参数
  if (typeof 类型 === 'function') return 收文字(类型(属性 || {}))
  if (类型 === 'svg') return ''
  return 子.map(收文字).join(' ')
}

function 找元素(节点, 类型, 结果 = []) {  if (节点 == null || typeof 节点 !== 'object') return 结果
  if (Array.isArray(节点)) {
    for (const 子 of 节点) 找元素(子, 类型, 结果)
    return 结果
  }
  const [当前类型, 属性, ...子] = 节点.参数
  if (当前类型 === 类型) 结果.push({ 属性, 子 })
  for (const 子节点 of 子) 找元素(子节点, 类型, 结果)
  return 结果
}

test('检测语言：与后端 lib/lang.js 同规则', () => {
  const { 测试 } = 载入()
  for (const 文本 of ['你好', 'hello world', 'こんにちは', '안녕하세요', '123 !!!', '']) {
    assert.equal(测试.检测语言(文本), 检测语言(文本), `文本：${文本}`)
  }
  assert.equal(测试.检测语言('中文 and English'), 'zh')
  assert.equal(测试.检测语言('日本語です'), 'ja')
  assert.equal(测试.检测语言(null), null)
})

test('翻译方向：不是第一语言就翻第一，第一语言翻第二，测不出翻第一', () => {
  const { 测试 } = 载入()
  const 配置 = { primaryLanguage: 'zh', secondaryLanguage: 'en' }
  assert.deepEqual(直(测试.选翻译方向('hello', 配置)), { source: 'en', target: 'zh', detected: 'en' })
  assert.deepEqual(直(测试.选翻译方向('你好', 配置)), { source: 'zh', target: 'en', detected: 'zh' })
  assert.deepEqual(直(测试.选翻译方向('123', 配置)), { source: 'auto', target: 'zh', detected: null })
  // 配置里是认不出的语言代码就回退到中文 / 英文。
  assert.equal(测试.选翻译方向('hi', { primaryLanguage: 'xx', secondaryLanguage: '' }).target, 'zh')
  assert.equal(测试.翻译规则文案(配置), '自动：非中文 → 中文，中文 → 英文')
  assert.ok(测试.翻译规则文案(配置).length <= 22, '规则说明要控制在一行里')
  assert.equal(测试.翻译方向文案({ source: 'zh', target: 'en' }), '中文 → 英文')
  assert.equal(测试.翻译方向文案({ source: 'auto', target: 'zh' }), '自动检测 → 中文')
})

test('切段：换行/句末标点都是边界，短碎片并到相邻段，拼回去与原文逐字一致', () => {
  const { 测试 } = 载入()
  const 样本 = [
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
  for (const 原文 of 样本) {
    const 段们 = 测试.切段(原文)
    const 重组 = 测试.组装译文(段们, 段们.map((段) => 段.文本))
    assert.equal(重组, 原文, `原文：${JSON.stringify(原文.slice(0, 40))}`)
  }

  // 单换行必须是边界：两行都够长，不会被并段。
  assert.deepEqual(
    直(测试.切段('第一段内容刚好十个字\n第二段内容也是十个字').map((段) => 段.文本)),
    ['第一段内容刚好十个字', '第二段内容也是十个字'],
  )
  // 句末标点也是边界，标点跟着前一句。
  assert.deepEqual(
    直(测试.切段('第一句话刚好十个字。第二句话也是十个字！').map((段) => 段.文本)),
    ['第一句话刚好十个字。', '第二句话也是十个字！'],
  )
  // 空行照样分开（两段都够长）。
  assert.deepEqual(
    直(测试.切段('第一段内容刚好十个字\n\n第二段内容也是十个字').map((段) => 段.文本)),
    ['第一段内容刚好十个字', '第二段内容也是十个字'],
  )
  // 极短碎片并到相邻段，且不多出换行。
  const 合并后 = 测试.切段('短\n这句话内容够长了不用再并')
  assert.equal(合并后.length, 1)
  assert.equal(合并后[0].文本, '短\n这句话内容够长了不用再并')
  assert.equal(测试.组装译文(合并后, 合并后.map((段) => 段.文本)), '短\n这句话内容够长了不用再并')

  // 只有单片超过 800 字才硬切。
  const 长段们 = 测试.切段('a'.repeat(2000))
  assert.ok(长段们.length >= 3)
  for (const 段 of 长段们) assert.ok(段.文本.length <= 800)
  for (const 段 of 测试.切段('长句'.repeat(600))) assert.ok(段.文本.length <= 800)
})

test('缓存：命中不重翻，改一段只多一条待翻；方向不同不复用；超过上限淘汰最旧', () => {
  const { 测试 } = 载入()
  const 方向 = { source: 'zh', target: 'en' }
  测试.清空翻译缓存()

  const 段们 = 测试.切段(三段原文)
  let 规划 = 测试.规划翻译(段们, 方向)
  assert.equal(规划.待翻.length, 3)
  for (const 项 of 规划.待翻) 测试.写缓存(方向, 项.文本, `译${项.文本}`)

  规划 = 测试.规划翻译(段们, 方向)
  assert.equal(规划.待翻.length, 0)
  assert.equal(测试.组装译文(段们, 规划.译文表), 段文.map((文本) => '译' + 文本).join('\n\n'))

  const 改后 = 测试.切段(段文[0] + '\n\n' + 段文[1] + '改\n\n' + 段文[2])
  规划 = 测试.规划翻译(改后, 方向)
  assert.deepEqual(直(规划.待翻.map((项) => 项.文本)), [段文[1] + '改'])
  assert.equal(测试.规划翻译(改后, { source: 'zh', target: 'ja' }).待翻.length, 3)

  测试.清空翻译缓存()
  for (let i = 0; i < 2001; i += 1) 测试.写缓存(方向, `段${i}`, `译${i}`)
  assert.equal(测试.读缓存(方向, '段2000'), '译2000')
  assert.equal(测试.读缓存(方向, '段0'), undefined)
})

test('批次：满 20 段或满 8000 字就另起一批', () => {
  const { 测试 } = 载入()
  const 段们 = Array.from({ length: 45 }, (_, i) => ({ 索引: i, 文本: 'x'.repeat(100) }))
  assert.deepEqual(直(测试.规划批次(段们).map((批) => 批.length)), [20, 20, 5])
  const 大字 = Array.from({ length: 3 }, (_, i) => ({ 索引: i, 文本: 'x'.repeat(5000) }))
  assert.deepEqual(直(测试.规划批次(大字).map((批) => 批.length)), [1, 1, 1])
  assert.deepEqual(直(测试.规划批次([])), [])
})

test('状态机：同步 → 修改中 → 翻译中 → 同步，三态全路径', () => {
  const { 测试 } = 载入()
  let 状态 = 测试.翻译空状态()
  assert.equal(状态.阶段, '同步', '空状态是同步态')
  assert.equal(状态.原文侧, null)
  assert.equal(测试.翻译锁定侧(状态), null, '同步态两边都可编辑')
  assert.equal(测试.翻译可执行(状态), false, '同步态没定原文，按钮禁用')
  assert.equal(测试.翻译按钮文字(状态), '翻译')

  // 同步态任一框写入非空内容 → 修改中，这侧是原文，另一侧锁定。
  状态 = 测试.翻译编辑(状态, '上', '你好')
  assert.equal(状态.阶段, '修改中')
  assert.equal(状态.原文侧, '上')
  assert.equal(测试.翻译锁定侧(状态), '下')
  assert.equal(测试.翻译可执行(状态), true)

  // 修改中继续改原文：还是修改中。
  const 再改 = 测试.翻译编辑(状态, '上', '你好呀')
  assert.equal(再改.阶段, '修改中')
  assert.equal(再改.上, '你好呀')

  // 修改中改译文侧：纯函数直接拒绝。
  assert.equal(测试.翻译编辑(状态, '下', '偷偷改'), 状态)

  // 翻译中两侧都不能改，按钮变进度文案。
  const 翻译中状态 = { ...状态, 阶段: '翻译中' }
  assert.equal(测试.翻译编辑(翻译中状态, '上', '改'), 翻译中状态)
  assert.equal(测试.翻译编辑(翻译中状态, '下', '改'), 翻译中状态)
  assert.equal(测试.翻译可执行(翻译中状态), false)
  assert.equal(测试.翻译按钮文字(翻译中状态), '正在翻译…')
  assert.equal(测试.翻译锁定侧(翻译中状态), null, '翻译中两侧都只读，不归「锁定侧」管')

  // 清空原文 → 回同步态，另一侧内容保留。
  const 清空 = 测试.翻译编辑(状态, '上', '   ')
  assert.equal(清空.阶段, '同步')
  assert.equal(清空.原文侧, null)
  assert.equal(测试.翻译可执行(清空), false)

  // 失败 / 取消都停在修改中，按钮显示继续翻译。
  assert.equal(测试.翻译按钮文字({ ...状态, 提示: '服务暂时不可用' }), '继续翻译')
  assert.equal(测试.翻译按钮文字({ ...状态, 提示: '已取消，已翻好的部分保留' }), '继续翻译')
})

test('面板：两个框 + 翻译按钮 + 方向规则一行；空闲时提示先输入', () => {
  const { 导出 } = 载入()
  const 树 = 导出.__testing.翻译面板({ sessionId: 's1' })
  const 文字 = 收文字(树)

  const 框们 = 找元素(树, 'textarea')
  assert.equal(框们.length, 2)
  assert.equal(框们[0].属性.value, '')
  assert.equal(框们[0].属性.disabled, false)
  assert.equal(框们[0].属性.readOnly, false)
  assert.equal(框们[1].属性.disabled, false)

  assert.match(文字, /翻译/)
  assert.match(文字, /可输入/)
  assert.match(文字, /先输入要翻译的文字/)
  assert.match(文字, /自动：非中文 → 中文，中文 → 英文/)

  const 按钮们 = 找元素(树, 'button')
  assert.equal(按钮们.length, 1)
  assert.equal(按钮们[0].属性.disabled, true, '没输入时不能点翻译')
})

// ---------------- 分段映射 / 局部重翻 / 分段操作 ----------------

const 翻译配置 = { primaryLanguage: 'zh', secondaryLanguage: 'en' }

function 找类(节点, 类名, 结果 = []) {
  if (节点 == null || typeof 节点 !== 'object') return 结果
  if (Array.isArray(节点)) {
    for (const 子 of 节点) 找类(子, 类名, 结果)
    return 结果
  }
  const [类型, 属性, ...子] = 节点.参数
  if (属性 && typeof 属性.className === 'string' && 属性.className.split(' ').includes(类名)) 结果.push({ 属性, 子 })
  for (const 子节点 of 子) 找类(子节点, 类名, 结果)
  return 结果
}

// 假网络：任务队列是「提交一批 → 轮询状态 → 按 id 取结果」。
// 记录里只放 post（提交/回退/取消），get 的状态与结果按批次自动回。
function 假网络(记录, 选项 = {}) {
  const 批次 = new Map()
  let 序号 = 0
  const post = async (路径, 体) => {
    记录.push({ 路径, 体: 直(体) })
    if (路径 === '/translate/jobs' && 选项.提交) return 选项.提交(体)
    if (路径 === '/translate/jobs') {
      const id = `任务${(序号 += 1)}`
      批次.set(id, Array.isArray(体.texts) ? 体.texts : [])
      return { ok: true, id, state: 'queued' }
    }
    if (路径 === '/translate/batch') {
      return { ok: true, results: 体.texts.map((项) => ({ id: 项.id, translated: `译:${项.text}` })) }
    }
    if (路径 === '/translate/jobs/cancel') return { ok: true, id: 体.id, state: 'canceled' }
    return { ok: false, code: 'bad_request' }
  }
  const get = async (路径) => {
    if (选项.get) return 选项.get(路径)
    if (路径.startsWith('/translate/jobs/status')) {
      return { ok: true, id: '任务1', state: 选项.状态 || 'done' }
    }
    if (路径.startsWith('/translate/jobs/result')) {
      const id = decodeURIComponent(路径.split('id=')[1] || '')
      const 文本们 = 批次.get(id) || []
      return { ok: true, id, state: 'done', texts: 文本们.map((文本) => `译:${文本}`) }
    }
    return null
  }
  return { post, get }
}

async function 造完成状态(测试, 原文, 记录) {
  const 初始 = 测试.翻译编辑(测试.翻译空状态(), '上', 原文)
  const 计划 = 测试.建翻译计划(初始, 翻译配置)
  const 结果 = await 测试.执行翻译(计划, 假网络(记录))
  assert.equal(结果.失败, '')
  return 测试.翻译成功状态(初始, 计划)
}

test('编辑规则：翻译完成后回同步态，两侧可编辑；谁再编辑谁就是原文', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, 三段原文, 记录)
  assert.equal(记录.length, 1)
  assert.equal(完成.阶段, '同步')
  assert.equal(完成.原文侧, null, '翻译成功后原文侧清空')
  assert.equal(完成.下, 三段译文)
  assert.equal(测试.翻译锁定侧(完成), null, '同步态两侧都可编辑')
  assert.equal(测试.映射有效(完成), true, '同步态分段映射仍然可用')
  assert.equal(测试.翻译可执行(完成), false, '同步态还没定原文，按钮先禁用')
  assert.equal(测试.建翻译计划(完成, 翻译配置), null)

  // 用户去改译文里的小错：被编辑的这侧成为新的原文，另一侧锁成译文输出。
  测试.清空翻译缓存()
  const 改译 = 测试.翻译编辑(完成, '下', 完成.下.replace(译(段文[1]), 译(段文[1]) + '（手改）'))
  assert.equal(改译.阶段, '修改中')
  assert.equal(改译.原文侧, '下', '谁再编辑谁就是新的原文')
  assert.equal(测试.翻译锁定侧(改译), '上')
  assert.equal(测试.映射有效(改译), true, '切换原文侧后映射要跟着翻')
  assert.equal(改译.上, 完成.上, '只改被编辑的那侧，另一侧文本不动')

  // 修改中改译文侧：纯函数直接拒绝。
  assert.equal(测试.翻译编辑(改译, '上', '偷偷改'), 改译)

  // 按新的原文侧重新分段；没改过的段沿用 state 里的旧译文。
  const 计划 = 测试.建翻译计划(改译, 翻译配置)
  assert.ok(计划)
  assert.equal(计划.侧, '下')
  assert.deepEqual(直(计划.待翻.map((项) => 项.文本)), [译(段文[1]) + '（手改）'])
  assert.equal(计划.沿用数, 2)
})

test('改局部重翻：只发改过的段，未改段沿用 state 里的旧译文', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, 三段原文, 记录)
  测试.清空翻译缓存()

  const 改后 = 测试.翻译编辑(完成, '上', 段文[0] + '\n\n' + 段文[1] + '改\n\n' + 段文[2])
  assert.equal(改后.原文侧, '上')
  assert.equal(改后.阶段, '修改中')

  const 计划 = 测试.建翻译计划(改后, 翻译配置)
  assert.deepEqual(直(计划.待翻.map((项) => 项.文本)), [段文[1] + '改'])
  assert.equal(计划.沿用数, 2)
  assert.equal(计划.译文表[0], 译(段文[0]))
  assert.equal(计划.译文表[2], 译(段文[2]))

  const 结果 = await 测试.执行翻译(计划, 假网络(记录))
  assert.equal(结果.失败, '')
  assert.equal(记录.length, 2)
  assert.deepEqual(直(记录[1].体.texts), [段文[1] + '改'], '只发改过的段')
  assert.equal(记录[1].体.source, 计划.方向.source)
  assert.equal(记录[1].体.target, 计划.方向.target)

  const 成功 = 测试.翻译成功状态(改后, 计划)
  assert.equal(成功.阶段, '同步')
  assert.equal(成功.原文侧, null)
  assert.equal(成功.映射侧, '上')
  assert.equal(成功.下, [译(段文[0]), 译(段文[1] + '改'), 译(段文[2])].join('\n\n'))
  assert.match(成功.成功, /2 段沿用上次/)
  // 开始翻译时也不整段清空：未改段的旧译文先在框里。
  const 开始 = 测试.翻译开始状态(改后, 计划)
  assert.equal(开始.阶段, '翻译中')
  assert.equal(开始.原文侧, '上')
  assert.match(开始.下, /译:第一段内容刚好十个字/)
  assert.match(开始.下, /译:第三段内容同样十个字/)
})

test('分段删除 / 上移 / 下移：只改文本和分段映射，不调用翻译服务', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, 三段原文, 记录)
  const 请求数 = 记录.length

  const 删 = 测试.分段操作(完成, '删除', 1)
  assert.equal(记录.length, 请求数, '删除分段不许发请求')
  assert.equal(删.原文侧, '上', '同步态里动分段：映射锚定的一侧定为原文')
  assert.equal(删.阶段, '修改中')
  assert.equal(删.上, 段文[0] + '\n\n' + 段文[2])
  assert.equal(删.下, [译(段文[0]), 译(段文[2])].join('\n\n'), '其余分段译文保持不动')
  assert.equal(测试.映射有效(删), true)
  assert.equal(测试.取侧片段(删, '上').内容们.length, 2)

  // 删除后点翻译：已有译文全部沿用，仍然不发请求。
  测试.清空翻译缓存()
  const 计划 = 测试.建翻译计划(删, 翻译配置)
  assert.equal(计划.待翻.length, 0)
  const 结果 = await 测试.执行翻译(计划, 假网络(记录))
  assert.equal(结果.请求批次, 0)
  assert.equal(记录.length, 请求数)

  const 上移 = 测试.分段操作(完成, '上移', 1)
  assert.equal(记录.length, 请求数, '移动分段不许发请求')
  assert.equal(上移.上, [段文[1], 段文[0], 段文[2]].join('\n\n'))
  assert.equal(上移.下, [译(段文[1]), 译(段文[0]), 译(段文[2])].join('\n\n'))
  assert.equal(测试.映射有效(上移), true)

  // 移动后点翻译：按原文快照找到原来的译文沿用，也只补缺失段、不发请求。
  测试.清空翻译缓存()
  const 移后计划 = 测试.建翻译计划(上移, 翻译配置)
  assert.equal(移后计划.待翻.length, 0, '移动不改原文快照，旧译文都能沿用')
  const 移后结果 = await 测试.执行翻译(移后计划, 假网络(记录))
  assert.equal(移后结果.请求批次, 0)
  assert.equal(记录.length, 请求数)

  const 下移 = 测试.分段操作(完成, '下移', 0)
  assert.equal(下移.上, [段文[1], 段文[0], 段文[2]].join('\n\n'))
  assert.equal(下移.下, [译(段文[1]), 译(段文[0]), 译(段文[2])].join('\n\n'))
  assert.equal(记录.length, 请求数)

  // 边界与翻译中不动。
  assert.equal(测试.分段操作(完成, '上移', 0), 完成)
  assert.equal(测试.分段操作(完成, '下移', 2), 完成)
  assert.equal(测试.分段操作(完成, '删除', 9), 完成)
  assert.equal(测试.分段操作({ ...完成, 阶段: '翻译中' }, '删除', 0).阶段, '翻译中')

  // 全部删空回到空状态。
  let 空 = 完成
  for (let i = 0; i < 3; i += 1) 空 = 测试.分段操作(空, '删除', 0)
  assert.equal(空.原文侧, null)
  assert.equal(空.阶段, '同步')
})

test('映射偏移：改段内文字只动这一段，切片段能还原两侧分段', () => {
  const { 测试 } = 载入()
  const 段们 = 测试.切段(三段原文)
  const 拼 = 测试.拼接分段(段们, ['译一', '译二', '译三'], [true, true, true])
  assert.equal(拼.原文文本, 三段原文)
  assert.equal(拼.译文文本, '译一\n\n译二\n\n译三')
  assert.deepEqual(直(拼.分段们.map((项) => [项.原文起, 项.原文止])), [[0, 10], [12, 22], [24, 34]])
  assert.deepEqual(直(拼.分段们.map((项) => [项.译文起, 项.译文止])), [[0, 2], [4, 6], [8, 10]])

  const 状态 = {
    ...测试.翻译空状态(),
    上: 拼.原文文本,
    下: 拼.译文文本,
    原文侧: '上',
    分段们: 拼.分段们,
  }
  const 原文侧片段 = 测试.取侧片段(状态, '上')
  assert.deepEqual(直(原文侧片段.前导们), ['', '\n\n', '\n\n', ''])
  assert.deepEqual(直(原文侧片段.内容们), 段文)
  const 译文侧片段 = 测试.取侧片段(状态, '下')
  assert.deepEqual(直(译文侧片段.内容们), ['译一', '译二', '译三'])

  // 在第二段末尾插一个字：只影响第二段之后（含第二段末尾）的偏移。
  const 新文 = 段文[0] + '\n\n' + 段文[1] + '改\n\n' + 段文[2]
  const 偏移 = 测试.调整分段偏移(拼.分段们, '原文', 拼.原文文本, 新文)
  assert.deepEqual(直(偏移.map((项) => [项.原文起, 项.原文止])), [[0, 10], [12, 23], [25, 35]])
  const 新片段 = 测试.切片段(新文, 偏移, '原文起', '原文止')
  assert.deepEqual(直(新片段.内容们), [段文[0], 段文[1] + '改', 段文[2]])
  // 译文侧没改，偏移一点不动。
  const 译文偏移 = 测试.调整分段偏移(拼.分段们, '译文', 拼.译文文本, 拼.译文文本)
  assert.deepEqual(直(译文偏移.map((项) => [项.译文起, 项.译文止])), [[0, 2], [4, 6], [8, 10]])

  // 没翻译过 / 映射失效时不显示分段。
  const 空 = 测试.翻译空状态()
  assert.equal(测试.取侧片段(空, '上'), null)
  assert.equal(测试.映射有效({ ...状态, 上: '别的文本' }), false)
})

test('中止：失败时保留已翻好的段和未改段的旧译文', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, [段文[0], 段文[1]].join('\n\n'), 记录)
  测试.清空翻译缓存()
  const 改后 = 测试.翻译编辑(完成, '上', [段文[0], 段文[1] + '改'].join('\n\n'))
  const 计划 = 测试.建翻译计划(改后, 翻译配置)
  const 结果 = await 测试.执行翻译(计划, {
    ...假网络(记录, { 提交: () => ({ ok: false, code: 'upstream_error', hint: '服务暂时不可用' }) }),
    等待: async () => {},
  })
  assert.equal(结果.失败, '服务暂时不可用')
  const 中断 = 测试.翻译中断状态(改后, 计划, '失败', 结果.失败)
  assert.equal(中断.阶段, '修改中', '失败回修改中，可直接点继续翻译')
  assert.equal(中断.原文侧, '上')
  assert.equal(中断.提示, '服务暂时不可用')
  assert.match(中断.下, /译:第一段内容刚好十个字/, '没翻成的段沿用旧译文，不整段清空')
})

test('面板：有分段映射才渲染镜像分段层和分段条', () => {
  const { 测试 } = 载入()
  const 段们 = 测试.切段([段文[0], 段文[1]].join('\n\n'))
  const 拼 = 测试.拼接分段(段们, ['译一', '译二'], [true, true])
  const 完成 = {
    ...测试.翻译空状态(),
    上: 拼.原文文本,
    下: 拼.译文文本,
    原文侧: null,
    映射侧: '上',
    阶段: '同步',
    方向: { source: 'zh', target: 'en', detected: 'zh' },
    分段们: 拼.分段们,
    成功: '中文 → 英文 · 已翻译 2 段',
  }
  测试.翻译草稿.set('s2', 完成)
  const 树 = 测试.翻译面板({ sessionId: 's2' })
  const 镜们 = 找类(树, 'fish-tr-mirror')
  assert.equal(镜们.length, 2, '两侧各有一层镜像')
  const 段节点们 = []
  for (const 镜 of 镜们) {
    for (const 节点 of 找元素(镜.子, 'span')) {
      if (节点.属性 && 节点.属性['data-seg'] != null) 段节点们.push(节点)
    }
  }
  assert.equal(段节点们.length, 4)
  assert.deepEqual(直(段节点们.map((节点) => 节点.属性['data-seg'])), [0, 1, 0, 1])
  assert.match(收文字(树), /点一下分段，可上移 \/ 下移 \/ 删除/)
  assert.equal(找类(树, 'fish-tr-segbar').length, 1)

  // 顶部固定操作区：操作行 / 提示 / 规则 / 分段条都在两个输入框上方。
  const 根子们 = 树.参数.slice(2)
  assert.equal(根子们.length, 2, '卡片根只有顶部操作区和输入框两段')
  assert.equal(根子们[0].参数[1].className, 'fish-tr-top')
  const 顶类们 = 根子们[0].参数.slice(2).filter(Boolean).map((项) => 项.参数[1] && 项.参数[1].className)
  assert.ok(顶类们.includes('fish-tr-actions'), '操作行在顶部')
  assert.ok(顶类们.includes('fish-tr-segbar'), '分段工具条在输入框上方')
  assert.ok(顶类们.some((类名) => typeof 类名 === 'string' && 类名.includes('fish-tr-note')), '规则说明在顶部')
  assert.equal(根子们[1].参数[1].className, 'fish-tr-grid')
  const 框们 = 找元素(树, 'textarea')
  assert.equal(框们.length, 2)
  assert.equal(框们[0].属性.readOnly, false, '同步态两侧都可编辑')
  assert.equal(框们[1].属性.readOnly, false)
  assert.equal(找元素(树, 'button').some((项) => 收文字(项.子) === '改这一侧'), false, '同步态没有锁定侧')

  // 还没翻译过：没有分段映射，不渲染镜像层和分段条。
  测试.翻译草稿.delete('s2')
  const 空树 = 测试.翻译面板({ sessionId: 's3' })
  assert.equal(找类(空树, 'fish-tr-mirror').length, 0)
  assert.equal(找类(空树, 'fish-tr-segbar').length, 0)
  assert.match(收文字(空树), /可输入/)
})

test('选中状态机：悬停只预览，点击才选中，再点或取消都回到未选', () => {
  const { 测试 } = 载入()
  assert.deepEqual(直(测试.分段空交互()), { 悬停: null, 选中: null })

  const 悬停 = 测试.分段交互(测试.分段空交互(), { 类型: '悬停', 索引: 1 })
  assert.deepEqual(直(悬停), { 悬停: 1, 选中: null }, '悬停不能改变选中')

  const 点击 = 测试.分段交互(悬停, { 类型: '点击', 索引: 1 })
  assert.deepEqual(直(点击), { 悬停: 1, 选中: 1 })

  // 鼠标移开：悬停清掉，选中保留。
  const 移开 = 测试.分段交互(点击, { 类型: '悬停', 索引: null })
  assert.deepEqual(直(移开), { 悬停: null, 选中: 1 })

  // 点另一段切过去，再点同一段取消。
  assert.equal(测试.分段交互(移开, { 类型: '点击', 索引: 2 }).选中, 2)
  assert.equal(测试.分段交互(移开, { 类型: '点击', 索引: 1 }).选中, null)

  // Esc、点空白、取消选择都只清选中。
  assert.equal(测试.分段交互(点击, { 类型: 'Esc' }).选中, null)
  assert.equal(测试.分段交互(点击, { 类型: '框外' }).选中, null)
  assert.equal(测试.分段交互(点击, { 类型: '取消' }).选中, null)
  // 没命中分段（点框内空白）也取消选中。
  assert.equal(测试.分段交互(点击, { 类型: '点击', 索引: null }).选中, null)
})

test('分段工具条：固定显示；没选中给提示，选中后按首尾禁用', () => {
  const { 测试 } = 载入()
  const 空闲 = 测试.分段工具条(3, null)
  assert.equal(收文字(空闲), '点一下分段，可上移 / 下移 / 删除')
  assert.equal(找元素(空闲, 'button').length, 0, '没选中时不出现操作按钮')

  const 找按钮 = (树, 文字) => 找元素(树, 'button').find((项) => 收文字(项.子) === 文字)
  const 中 = 测试.分段工具条(3, 1)
  for (const 文字 of ['上移', '下移', '删除', '取消选择']) assert.ok(找按钮(中, 文字), `缺少按钮：${文字}`)
  assert.equal(找按钮(中, '上移').属性.disabled, false)
  assert.equal(找按钮(中, '下移').属性.disabled, false)

  assert.equal(找按钮(测试.分段工具条(3, 0), '上移').属性.disabled, true, '第一段不能上移')
  assert.equal(找按钮(测试.分段工具条(3, 0), '下移').属性.disabled, false)
  assert.equal(找按钮(测试.分段工具条(3, 2), '下移').属性.disabled, true, '最后一段不能下移')
  assert.equal(找按钮(测试.分段工具条(3, 2), '上移').属性.disabled, false)
  // 段数变少后越界的旧选中视为未选。
  assert.equal(找元素(测试.分段工具条(2, 2), 'button').length, 0)
})

test('改这一侧：只换原文 / 译文角色，文本不动，映射坐标跟着翻', () => {
  const { 测试 } = 载入()
  const 段们 = 测试.切段(三段原文)
  const 拼 = 测试.拼接分段(段们, 三段译文.split('\n\n'), [true, true, true])
  const 改中 = {
    ...测试.翻译空状态(),
    上: 拼.原文文本,
    下: 拼.译文文本,
    阶段: '修改中',
    原文侧: '上',
    映射侧: '上',
    分段们: 拼.分段们,
  }
  const 换 = 测试.切换原文侧(改中)
  assert.equal(换.阶段, '修改中')
  assert.equal(换.原文侧, '下')
  assert.equal(换.上, 改中.上, '切换不动文本')
  assert.equal(换.下, 改中.下)
  assert.equal(测试.翻译锁定侧(换), '上')
  assert.equal(测试.映射有效(换), true)
  assert.deepEqual(直(测试.取侧片段(换, '下').内容们), [译(段文[0]), 译(段文[1]), 译(段文[2])])
  // 再切回去，坐标与原来一致。
  const 回 = 测试.切换原文侧(换)
  assert.deepEqual(
    直(回.分段们.map((项) => [项.原文起, 项.原文止, 项.译文起, 项.译文止])),
    直(拼.分段们.map((项) => [项.原文起, 项.原文止, 项.译文起, 项.译文止])),
  )
  // 翻译中不允许换角色。
  assert.equal(测试.切换原文侧({ ...改中, 阶段: '翻译中' }).原文侧, '上')
})

test('分段映射：同步 ↔ 修改中不丢，译文侧编辑被拒', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, 三段原文, 记录)
  assert.equal(测试.映射有效(完成), true)
  assert.equal(测试.取侧片段(完成, '上').内容们.length, 3)

  const 改 = 测试.翻译编辑(完成, '上', 段文[0] + '\n\n' + 段文[1] + '改\n\n' + 段文[2])
  assert.equal(改.阶段, '修改中')
  assert.equal(测试.映射有效(改), true)
  assert.equal(测试.取侧片段(改, '上').内容们.length, 3)
  assert.equal(测试.取侧片段(改, '下').内容们.length, 3)
  assert.equal(测试.翻译编辑(改, '下', '动译文'), 改, '修改中译文侧只读')

  // 换成另一侧当原文，映射仍然有效。
  const 换 = 测试.切换原文侧(改)
  assert.equal(换.原文侧, '下')
  assert.equal(测试.映射有效(换), true)
  assert.equal(测试.取侧片段(换, '下').内容们.length, 3)
})

test('面板：修改中译文侧只读并给「改这一侧」；翻译中两侧只读', () => {
  const { 测试 } = 载入()
  const 改中 = { ...测试.翻译编辑(测试.翻译空状态(), '上', 三段原文), 阶段: '修改中' }
  测试.翻译草稿.set('s4', 改中)
  const 树 = 测试.翻译面板({ sessionId: 's4' })
  const 框们 = 找元素(树, 'textarea')
  assert.equal(框们[0].属性.readOnly, false, '原文侧可编辑')
  assert.equal(框们[1].属性.readOnly, true, '译文侧只读')
  assert.equal(框们[1].属性.disabled, false, '只读但不用 disabled，避免丢焦点')

  const 按钮们 = 找元素(树, 'button')
  assert.ok(按钮们.some((项) => 收文字(项.子) === '改这一侧'), '锁定侧要有「改这一侧」入口')
  const 改侧 = 按钮们.find((项) => 收文字(项.子) === '改这一侧')
  assert.match(改侧.属性.title, /原文/)
  const 翻译按钮 = 按钮们.find((项) => 收文字(项.子).trim() === '翻译')
  assert.ok(翻译按钮, '修改中显示「翻译」按钮')
  assert.equal(翻译按钮.属性.disabled, false)

  // 翻译中：两侧都只读，翻译按钮禁用。
  测试.翻译草稿.set('s5', { ...改中, 阶段: '翻译中' })
  const 跑树 = 测试.翻译面板({ sessionId: 's5' })
  const 跑框们 = 找元素(跑树, 'textarea')
  assert.equal(跑框们[0].属性.readOnly, true)
  assert.equal(跑框们[1].属性.readOnly, true)
  const 跑按钮 = 找元素(跑树, 'button').find((项) => 收文字(项.子).includes('正在翻译'))
  assert.ok(跑按钮)
  assert.equal(跑按钮.属性.disabled, true)
  测试.翻译草稿.delete('s4')
  测试.翻译草稿.delete('s5')
})

// ---------------- 后台任务队列（传输层） ----------------

function 造计划(文本们) {
  return {
    侧: '上',
    另一侧: '下',
    原文: 文本们.join('\n\n'),
    方向: { source: 'zh', target: 'en', detected: 'zh' },
    段们: [],
    译文表: {},
    已译: {},
    待翻: 文本们.map((文本, 索引) => ({ 索引, 文本 })),
    总段数: 文本们.length,
    沿用数: 0,
  }
}

test('任务队列：每批 6 段 / 1500 字，串行提交，按任务 id 取回译文', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 事件 = []
  const 文本们 = Array.from({ length: 13 }, (_, i) => `第${i}段${'字'.repeat(100)}`)
  const 计划 = 造计划(文本们)
  const 网络 = 假网络(记录)
  const 结果 = await 测试.执行翻译(计划, {
    post: async (路径, 体) => {
      事件.push(['post', 路径])
      return 网络.post(路径, 体)
    },
    get: async (路径) => {
      事件.push(['get', 路径])
      return 网络.get(路径)
    },
  })

  assert.equal(结果.完成, 13)
  assert.equal(结果.请求批次, 3, '13 段按 6 段一批切成 6 / 6 / 1')
  assert.equal(结果.失败, '')
  assert.equal(结果.回退, false)
  const 提交们 = 记录.filter((项) => 项.路径 === '/translate/jobs')
  assert.deepEqual(提交们.map((项) => 项.体.texts.length), [6, 6, 1])
  assert.deepEqual(直(提交们[0].体.texts), 文本们.slice(0, 6), '任务接口收字符串数组')
  assert.equal(提交们[0].体.source, 'zh')
  assert.equal(提交们[0].体.target, 'en')

  // 串行：每次提交都发生在上一批取回结果之后，不会叠并发。
  let 提交数 = 0
  let 取回数 = 0
  for (const [类, 路径] of 事件) {
    if (类 === 'post' && 路径 === '/translate/jobs') {
      提交数 += 1
      assert.equal(提交数, 取回数 + 1, '一次只跑一批')
    }
    if (类 === 'get' && 路径.includes('/result')) 取回数 += 1
  }
  assert.equal(计划.已译[12], true)
  assert.equal(计划.译文表[0], '译:' + 文本们[0])
  assert.equal(计划.译文表[12], '译:' + 文本们[12])
})

test('任务进度：排队中 / 翻译中；超过 8 秒提示准备模型并带上已用时间', async () => {
  const { 测试 } = 载入()
  let 时钟 = 0
  const 推送 = []
  const 计划 = 造计划(段文)
  const 网络 = 假网络([])
  const 结果 = await 测试.执行翻译(计划, {
    post: 网络.post,
    get: async (路径) => {
      if (路径.includes('/status')) {
        if (时钟 >= 8000) return { ok: true, state: 'done' }
        return { ok: true, state: 时钟 >= 2000 ? 'running' : 'queued' }
      }
      return 网络.get(路径)
    },
    now: undefined,
    现在: () => 时钟,
    等待: async (毫秒) => {
      时钟 += 毫秒
    },
    轮询毫秒: 1000,
    推送: (完成, 信息) => 推送.push([完成, 信息]),
  })

  assert.equal(结果.完成, 3)
  assert.equal(结果.失败, '')
  const 阶段们 = 推送.map((项) => 项[1].阶段)
  assert.ok(阶段们.includes('排队中'), `阶段：${阶段们.join('/')}`)
  assert.ok(阶段们.includes('翻译中'), `阶段：${阶段们.join('/')}`)
  const 冷启动 = 推送.find((项) => 项[1].阶段 === '准备模型')
  assert.ok(冷启动, '超过 8 秒要给冷启动提示')
  assert.equal(冷启动[1].提示, 测试.冷启动提示)
  assert.match(测试.冷启动提示, /正在加载翻译模型，第一次会慢一点（约 40 秒）/)
  assert.ok(冷启动[1].已用 >= 8000)
  assert.equal(冷启动[1].总数, 3)
})

test('任务超时：超过总时长上限就停轮询、尽力取消，已翻好的段保留', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  let 时钟 = 0
  const 计划 = 造计划(段文)
  const 网络 = 假网络(记录)
  const 结果 = await 测试.执行翻译(计划, {
    post: 网络.post,
    get: async (路径) => (路径.includes('/status') ? { ok: true, state: 'queued' } : 网络.get(路径)),
    现在: () => 时钟,
    等待: async (毫秒) => {
      时钟 += 毫秒
    },
    总时长上限: 5000,
    轮询毫秒: 1000,
  })
  assert.match(结果.失败, /等太久/)
  assert.equal(结果.已取消, false)
  assert.deepEqual(记录.map((项) => 项.路径), ['/translate/jobs', '/translate/jobs/cancel'])
})

test('取消：停止轮询并调用任务取消接口，不把半途结果当成功', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 计划 = 造计划(段文)
  const 网络 = 假网络(记录)
  const 运行 = { 已取消: false, 控制器: null, 任务id: null }
  const 结果 = await 测试.执行翻译(计划, {
    post: 网络.post,
    get: async (路径) => {
      if (路径.includes('/status')) {
        运行.已取消 = true
        return { ok: true, state: 'running' }
      }
      return 网络.get(路径)
    },
    运行,
    等待: async () => {},
  })
  assert.equal(结果.已取消, true)
  assert.equal(结果.完成, 0)
  assert.ok(记录.some((项) => 项.路径 === '/translate/jobs/cancel'), '要尽力取消服务端任务')
  assert.equal(记录.filter((项) => 项.路径 === '/translate/jobs/result').length, 0)
})

test('回退：服务不支持任务接口时改走同步批量，超时放宽到 3 分钟', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 计划 = 造计划(段文)
  const 结果 = await 测试.执行翻译(
    计划,
    假网络(记录, { 提交: () => ({ ok: false, code: 'not_supported' }) }),
  )
  assert.equal(结果.回退, true)
  assert.equal(结果.完成, 3)
  assert.equal(结果.失败, '')
  assert.deepEqual(记录.map((项) => 项.路径), ['/translate/jobs', '/translate/batch'])
  assert.equal(记录[1].体.timeoutMs, 180000)
  assert.deepEqual(直(记录[1].体.texts.map((项) => 项.id)), [0, 1, 2])
  assert.equal(记录[1].体.source, 'zh')
  assert.equal(记录[1].体.target, 'en')
  assert.equal(计划.译文表[1], 译(段文[1]))
})

test('任务结果缺段：已翻好的段保留，提示可以继续翻译', async () => {
  const { 测试 } = 载入()
  const 计划 = 造计划(段文)
  const 网络 = 假网络([])
  const 结果 = await 测试.执行翻译(计划, {
    post: 网络.post,
    get: async (路径) => {
      if (路径.includes('/status')) return { ok: true, state: 'done' }
      if (路径.includes('/result')) return { ok: true, state: 'done', texts: [译(段文[0]), 译(段文[1])] }
      return null
    },
  })
  assert.equal(结果.完成, 2)
  assert.match(结果.失败, /继续翻译/)
  assert.equal(计划.已译[0], true)
  assert.equal(计划.已译[1], true)
  assert.equal(计划.已译[2], undefined)
})
