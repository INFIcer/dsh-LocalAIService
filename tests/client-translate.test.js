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
