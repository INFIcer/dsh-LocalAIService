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

test('切段：空行/句子/超长都切开，组装回去和原文一模一样', () => {
  const { 测试 } = 载入()
  const 样本 = [
    '',
    '你好',
    '第一段\n\n第二段',
    '第一段\n \n第二段\n\n\n',
    ' 缩进开头\n第二行没有空行',
    '一句话。第二句！第三句？',
    'He said "hi." Then left.\nNext line.',
    'a'.repeat(2000),
    '长句'.repeat(600),
    '中文'.repeat(1000) + '\n\n' + 'tail',
    '第一段\r\n\r\n第二段',
  ]
  for (const 原文 of 样本) {
    const 段们 = 测试.切段(原文)
    const 重组 = 测试.组装译文(段们, 段们.map((段) => 段.文本))
    assert.equal(重组, 原文, `原文：${JSON.stringify(原文.slice(0, 40))}`)
  }
  const 长段们 = 测试.切段('a'.repeat(2000))
  assert.ok(长段们.length >= 3)
  for (const 段 of 长段们) assert.ok(段.文本.length <= 800)
  assert.deepEqual(
    直(测试.切段('第一段\n\n第二段').map((段) => 段.文本)),
    ['第一段', '第二段'],
  )
})

test('缓存：命中不重翻，改一段只多一条待翻；方向不同不复用；超过上限淘汰最旧', () => {
  const { 测试 } = 载入()
  const 方向 = { source: 'zh', target: 'en' }
  测试.清空翻译缓存()

  const 段们 = 测试.切段('第一段\n\n第二段\n\n第三段')
  let 规划 = 测试.规划翻译(段们, 方向)
  assert.equal(规划.待翻.length, 3)
  for (const 项 of 规划.待翻) 测试.写缓存(方向, 项.文本, `译${项.文本}`)

  规划 = 测试.规划翻译(段们, 方向)
  assert.equal(规划.待翻.length, 0)
  assert.equal(测试.组装译文(段们, 规划.译文表), '译第一段\n\n译第二段\n\n译第三段')

  const 改后 = 测试.切段('第一段\n\n第二段改\n\n第三段')
  规划 = 测试.规划翻译(改后, 方向)
  assert.deepEqual(直(规划.待翻.map((项) => 项.文本)), ['第二段改'])
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

test('状态机：改一边锁另一边；翻译中都不能改；完成后回到都可编辑', () => {
  const { 测试 } = 载入()
  let 状态 = 测试.翻译空状态()
  assert.equal(状态.阶段, '空闲')
  assert.equal(测试.翻译可执行(状态), false)
  assert.equal(测试.翻译按钮文字(状态), '翻译')
  assert.equal(测试.翻译锁定侧(状态), null)

  状态 = 测试.翻译编辑(状态, '上', '你好')
  assert.equal(状态.原文侧, '上')
  assert.equal(状态.阶段, '待翻译')
  assert.equal(测试.翻译锁定侧(状态), '下')
  assert.equal(测试.翻译可执行(状态), true)

  // 锁住的一边写不进去。
  assert.equal(测试.翻译编辑(状态, '下', '偷偷改'), 状态)

  // 翻译中两个框都不能改，按钮显示进度文案。
  const 翻译中 = { ...状态, 阶段: '翻译中' }
  assert.equal(测试.翻译编辑(翻译中, '上', '改'), 翻译中)
  assert.equal(测试.翻译可执行(翻译中), false)
  assert.equal(测试.翻译按钮文字(翻译中), '正在翻译…')

  // 完成后回空闲：两边都能改，改另一边就换方向。
  const 完成 = { ...状态, 阶段: '空闲', 提示: '', 进度: null, 方向: null, 成功: '', 下: 'hello' }
  assert.equal(测试.翻译可执行(完成), true)
  assert.equal(测试.翻译锁定侧(完成), null)
  const 反向 = 测试.翻译编辑(完成, '下', 'hello world')
  assert.equal(反向.原文侧, '下')
  assert.equal(反向.阶段, '待翻译')

  // 取消 / 失败都显示「继续翻译」。
  assert.equal(测试.翻译按钮文字({ ...状态, 阶段: '已取消' }), '继续翻译')
  assert.equal(测试.翻译按钮文字({ ...状态, 阶段: '失败' }), '继续翻译')

  // 清空原文回空闲。
  const 清空 = 测试.翻译编辑(状态, '上', '   ')
  assert.equal(清空.阶段, '空闲')
  assert.equal(清空.原文侧, null)
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

function 假post(记录, 处理) {
  return async (路径, 体) => {
    记录.push({ 路径, 体: 直(体) })
    if (处理) return 处理(体)
    return { ok: true, results: 体.texts.map((项) => ({ id: 项.id, translated: `译:${项.text}` })) }
  }
}

async function 造完成状态(测试, 原文, 记录) {
  const 初始 = 测试.翻译编辑(测试.翻译空状态(), '上', 原文)
  const 计划 = 测试.建翻译计划(初始, 翻译配置)
  const 结果 = await 测试.执行翻译(计划, { post: 假post(记录) })
  assert.equal(结果.失败, '')
  return 测试.翻译成功状态(初始, 计划)
}

test('编辑规则：翻译完成后原文侧保留，改译文不换方向，再翻全部沿用', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, '第一段\n\n第二段\n\n第三段', 记录)
  assert.equal(记录.length, 1)
  assert.equal(完成.原文侧, '上', '翻译成功后不能再把两边都当新输入')
  assert.equal(完成.下, '译:第一段\n\n译:第二段\n\n译:第三段')

  // 用户去改译文里的小错：原文侧和方向都不许动。
  测试.清空翻译缓存()
  const 改译 = 测试.翻译编辑(完成, '下', 完成.下.replace('译:第二段', '译:第二段（手改）'))
  assert.equal(改译.原文侧, '上')
  assert.equal(改译.阶段, '空闲')
  assert.deepEqual(直(改译.方向), 直(完成.方向), '改译文不能把方向翻过来')

  const 计划 = 测试.建翻译计划(改译, 翻译配置)
  assert.equal(计划.侧, '上', '点翻译仍然只把原文侧当原文')
  assert.deepEqual(直(计划.方向), 直(完成.方向))
  assert.equal(计划.待翻.length, 0, '没改过原文，一段都不该重翻')
  const 结果 = await 测试.执行翻译(计划, { post: 假post(记录) })
  assert.equal(结果.已取消, false)
  assert.equal(记录.length, 1, '不该发任何新请求')
})

test('改局部重翻：只发改过的段，未改段沿用 state 里的旧译文', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, '第一段\n\n第二段\n\n第三段', 记录)
  测试.清空翻译缓存()

  const 改后 = 测试.翻译编辑(完成, '上', '第一段\n\n第二段改\n\n第三段')
  assert.equal(改后.原文侧, '上')
  assert.equal(改后.阶段, '待翻译')

  const 计划 = 测试.建翻译计划(改后, 翻译配置)
  assert.deepEqual(直(计划.待翻.map((项) => 项.文本)), ['第二段改'])
  assert.equal(计划.沿用数, 2)
  assert.equal(计划.译文表[0], '译:第一段')
  assert.equal(计划.译文表[2], '译:第三段')

  const 结果 = await 测试.执行翻译(计划, { post: 假post(记录) })
  assert.equal(结果.失败, '')
  assert.equal(记录.length, 2)
  assert.deepEqual(直(记录[1].体.texts.map((项) => 项.text)), ['第二段改'], '只发改过的段')
  assert.equal(记录[1].体.source, 计划.方向.source)
  assert.equal(记录[1].体.target, 计划.方向.target)

  const 成功 = 测试.翻译成功状态(改后, 计划)
  assert.equal(成功.下, '译:第一段\n\n译:第二段改\n\n译:第三段')
  assert.match(成功.成功, /2 段沿用上次/)
  // 开始翻译时也不整段清空：未改段的旧译文先在框里。
  const 开始 = 测试.翻译开始状态(改后, 计划)
  assert.equal(开始.原文侧, '上')
  assert.match(开始.下, /译:第一段/)
  assert.match(开始.下, /译:第三段/)
})

test('分段删除 / 上移 / 下移：只改文本和分段映射，不调用翻译服务', async () => {
  const { 测试 } = 载入()
  const 记录 = []
  const 完成 = await 造完成状态(测试, '第一段\n\n第二段\n\n第三段', 记录)
  const 请求数 = 记录.length

  const 删 = 测试.分段操作(完成, '删除', 1)
  assert.equal(记录.length, 请求数, '删除分段不许发请求')
  assert.equal(删.原文侧, '上')
  assert.equal(删.阶段, '空闲')
  assert.equal(删.上, '第一段\n\n第三段')
  assert.equal(删.下, '译:第一段\n\n译:第三段', '其余分段译文保持不动')
  assert.equal(测试.映射有效(删), true)
  assert.equal(测试.取侧片段(删, '上').内容们.length, 2)

  // 删除后点翻译：已有译文全部沿用，仍然不发请求。
  测试.清空翻译缓存()
  const 计划 = 测试.建翻译计划(删, 翻译配置)
  assert.equal(计划.待翻.length, 0)
  const 结果 = await 测试.执行翻译(计划, { post: 假post(记录) })
  assert.equal(结果.请求批次, 0)
  assert.equal(记录.length, 请求数)

  const 上移 = 测试.分段操作(完成, '上移', 1)
  assert.equal(记录.length, 请求数, '移动分段不许发请求')
  assert.equal(上移.上, '第二段\n\n第一段\n\n第三段')
  assert.equal(上移.下, '译:第二段\n\n译:第一段\n\n译:第三段')
  assert.equal(测试.映射有效(上移), true)

  // 移动后点翻译：按原文快照找到原来的译文沿用，也只补缺失段、不发请求。
  测试.清空翻译缓存()
  const 移后计划 = 测试.建翻译计划(上移, 翻译配置)
  assert.equal(移后计划.待翻.length, 0, '移动不改原文快照，旧译文都能沿用')
  const 移后结果 = await 测试.执行翻译(移后计划, { post: 假post(记录) })
  assert.equal(移后结果.请求批次, 0)
  assert.equal(记录.length, 请求数)

  const 下移 = 测试.分段操作(完成, '下移', 0)
  assert.equal(下移.上, '第二段\n\n第一段\n\n第三段')
  assert.equal(下移.下, '译:第二段\n\n译:第一段\n\n译:第三段')
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
  assert.equal(空.阶段, '空闲')
})

test('映射偏移：改段内文字只动这一段，切片段能还原两侧分段', () => {
  const { 测试 } = 载入()
  const 段们 = 测试.切段('第一段\n\n第二段\n\n第三段')
  const 拼 = 测试.拼接分段(段们, ['译一', '译二', '译三'], [true, true, true])
  assert.equal(拼.原文文本, '第一段\n\n第二段\n\n第三段')
  assert.equal(拼.译文文本, '译一\n\n译二\n\n译三')
  assert.deepEqual(直(拼.分段们.map((项) => [项.原文起, 项.原文止])), [[0, 3], [5, 8], [10, 13]])
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
  assert.deepEqual(直(原文侧片段.内容们), ['第一段', '第二段', '第三段'])
  const 译文侧片段 = 测试.取侧片段(状态, '下')
  assert.deepEqual(直(译文侧片段.内容们), ['译一', '译二', '译三'])

  // 在第二段末尾插一个字：只影响第二段之后（含第二段末尾）的偏移。
  const 新文 = '第一段\n\n第二段改\n\n第三段'
  const 偏移 = 测试.调整分段偏移(拼.分段们, '原文', 拼.原文文本, 新文)
  assert.deepEqual(直(偏移.map((项) => [项.原文起, 项.原文止])), [[0, 3], [5, 9], [11, 14]])
  const 新片段 = 测试.切片段(新文, 偏移, '原文起', '原文止')
  assert.deepEqual(直(新片段.内容们), ['第一段', '第二段改', '第三段'])
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
  const 完成 = await 造完成状态(测试, '第一段\n\n第二段', 记录)
  测试.清空翻译缓存()
  const 改后 = 测试.翻译编辑(完成, '上', '第一段\n\n第二段改')
  const 计划 = 测试.建翻译计划(改后, 翻译配置)
  const 结果 = await 测试.执行翻译(计划, {
    post: 假post(记录, () => ({ ok: false, code: 'upstream_error', hint: '服务暂时不可用' })),
  })
  assert.equal(结果.失败, '服务暂时不可用')
  const 中断 = 测试.翻译中断状态(改后, 计划, '失败', 结果.失败)
  assert.equal(中断.阶段, '失败')
  assert.equal(中断.提示, '服务暂时不可用')
  assert.match(中断.下, /译:第一段/, '没翻成的段沿用旧译文，不整段清空')
})

test('面板：有分段映射才渲染镜像分段层和分段条', () => {
  const { 测试 } = 载入()
  const 段们 = 测试.切段('第一段\n\n第二段')
  const 拼 = 测试.拼接分段(段们, ['译一', '译二'], [true, true])
  const 完成 = {
    ...测试.翻译空状态(),
    上: 拼.原文文本,
    下: 拼.译文文本,
    原文侧: '上',
    阶段: '空闲',
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
  assert.match(收文字(树), /共 2 段，悬浮分段可单独处理/)
  assert.equal(找类(树, 'fish-tr-segbar').length, 1)
  assert.equal(找元素(树, 'textarea').length, 2)

  // 还没翻译过：没有分段映射，不渲染镜像层和分段条。
  测试.翻译草稿.delete('s2')
  const 空树 = 测试.翻译面板({ sessionId: 's3' })
  assert.equal(找类(空树, 'fish-tr-mirror').length, 0)
  assert.equal(找类(空树, 'fish-tr-segbar').length, 0)
  assert.match(收文字(空树), /可输入/)
})
