// P2 客户端插件加载冒烟（不跑浏览器，只用 vm + React 替身）：
// 验证 client.js 能求值、apply 能注册各个入口（设置页 + 朗读 + 麦克风 + 本地识图 + 面板 + 自动朗读）。
//
// 真正的交互（录音、播放、插入文字）仍需真机验收，见 docs/P2.md 的手动步骤。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

test('client.js 加载：apply 注册设置页 / 朗读 / 麦克风 / 本地识图 / 面板 / 自动朗读', async () => {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null

  const 窗口 = {
    __ModuleLoader__: {
      load: (定义) => { 工厂 = 定义.factory },
    },
  }

  const 沙箱 = {
    window: 窗口,
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  assert.equal(typeof 工厂, 'function', 'window.__ModuleLoader__.load 应该拿到 factory')

  const 导出 = 工厂((名字) => {
    if (名字 === 'react') return 装React()
    throw new Error(`未预期的 require：${名字}`)
  })
  assert.equal(typeof 导出.apply, 'function')
  assert.deepEqual([...导出.inject], ['slots', 'uiConversation'])

  const 注册们 = []
  const 交互们 = []
  const 服务 = {
    inject: (_槽位, 回调) => 回调(),
    register: (配置, 组件) => {
      注册们.push({ 配置, 组件 })
      return () => {}
    },
  }
  const ui = {
    interactions: {
      register: (定义, 标签) => {
        交互们.push({ 定义, 标签 })
        return () => {}
      },
    },
  }
  const ctx = { get: (名字) => (名字 === 'slots' ? 服务 : 名字 === 'uiConversation' ? ui : undefined) }
  导出.apply(ctx)

  assert.deepEqual(注册们.map((x) => x.配置.name), [
    'settings.section',
    'conversation.chat.assistant-actions',
    'conversation.input.right',
    'conversation.input.right',
    'conversation.input.overlay',
    'conversation.input.left',
    'conversation.chat.text-interaction',
  ])
  assert.deepEqual(注册们.map((x) => x.配置.id), [
    'fish-service',
    'fish-read',
    'fish-mic',
    'fish-vision',
    'fish-voice',
    'fish-auto-read',
    undefined,
  ])
  // 本地识图是输入框旁的独立按钮，和麦克风同一排；官方附件栏不再被顶替。
  assert.equal(注册们.find((x) => x.配置.id === 'fish-vision').配置.order, 31)
  assert.equal(注册们.find((x) => x.配置.id === 'fish-mic').配置.order, 32)
  assert.equal(注册们.some((x) => x.配置.name === 'conversation.input.attachments'), false)
  assert.equal(注册们.at(-1).配置.key, 'fish-selection')

  // 框选交互：只对 selection + 有文本的请求 open；其它情况不抢。
  assert.equal(交互们.length, 1)
  assert.equal(交互们[0].定义.id, 'fish-selection')
  let 打开 = 0
  const 请求 = (over = {}) => ({ trigger: 'selection', readText: () => '选中文字', open: () => { 打开 += 1 }, ...over })
  交互们[0].定义.onInteraction(请求())
  assert.equal(打开, 1)
  交互们[0].定义.onInteraction(请求({ trigger: 'context-menu' }))
  交互们[0].定义.onInteraction(请求({ readText: () => null }))
  交互们[0].定义.onInteraction(请求({ readText: () => '   ' }))
  assert.equal(打开, 1)

  for (const 项 of 注册们) assert.equal(typeof 项.组件, 'function')

  // 再拿最小 props 各渲染一次：能抓出「引用了不存在的变量 / 拼错字段」这类运行时错误。
  const 组件们 = Object.fromEntries(注册们.map((x) => [x.配置.id, x.组件]))
  assert.doesNotThrow(() => 组件们['fish-service']())
  assert.doesNotThrow(() => 组件们['fish-read']({ messageId: 'm1', useChat: () => '' }))
  assert.doesNotThrow(() => 组件们['fish-mic']({ sessionId: 's1' }))
  assert.doesNotThrow(() => 组件们['fish-voice']({ sessionId: 's1' }))
  assert.doesNotThrow(() => 组件们['fish-auto-read']())
  // 本地识图按钮：独立入口，不依赖草稿附件。
  assert.doesNotThrow(() => 组件们['fish-vision']({ sessionId: 's1' }))
  assert.doesNotThrow(() => 组件们['fish-vision']())
  // 面板空闲时不应该渲染任何东西。
  assert.equal(组件们['fish-voice']({ sessionId: 's1' }), null)

  // 上传前按 MIME 定扩展名：服务端只认这几种。
  const { 识图扩展 } = 导出.__testing
  assert.equal(识图扩展('image/png'), '.png')
  assert.equal(识图扩展('image/jpeg'), '.jpg')
  assert.equal(识图扩展('image/webp'), '.webp')
  assert.equal(识图扩展('image/gif'), '.gif')
  assert.equal(识图扩展('image/bmp'), '.bmp')
  assert.equal(识图扩展(''), '.jpg')
  assert.equal(识图扩展(undefined), '.jpg')

  // ---- 发送前识图：纯函数（入口判断 / 描述拼装 / 待插入队列） ----
  const 测试 = 导出.__testing
  const 图 = (名, 类型 = '') => ({ name: 名, type: 类型, size: 10 })

  // 是图片文件：MIME 优先，扩展名兜底（大小写不敏感）。
  assert.equal(测试.是图片文件(图('a.png', 'image/png')), true)
  assert.equal(测试.是图片文件(图('a.JPG')), true)
  assert.equal(测试.是图片文件(图('a.webp', '')), true)
  assert.equal(测试.是图片文件(图('a.pdf', 'application/pdf')), false)
  assert.equal(测试.是图片文件(图('a.pdf')), false)
  assert.equal(测试.是图片文件(null), false)

  // 识图入口：开关关、服务离线给一句短提示（都不改图片）；正常返回空串。
  assert.equal(测试.识图阻塞原因({ 载入: true, 在线: true, config: {} }), '')
  assert.match(测试.识图阻塞原因({ 载入: true, 在线: true, config: { localDescribe: false } }), /已关闭/)
  assert.match(测试.识图阻塞原因({ 载入: true, 在线: false, config: {} }), /未连接/)
  // 偏好还没载入时先当作可用；真失败时页面自己会提示。
  assert.equal(测试.识图阻塞原因({ 载入: false }), '')
  assert.equal(测试.识图阻塞原因(null), '')
  assert.equal(测试.本地识图开({ localDescribe: false }), false)
  assert.equal(测试.本地识图开({}), true)
  assert.equal(测试.本地识图开(null), true)

  // 拼图片描述：文件名 + 详细描述，每张一段；空描述不插。
  assert.equal(测试.拼图片描述('a.png', ' 一只猫\n坐在窗台 '), '［图片：a.png］\n一只猫\n坐在窗台\n')
  assert.equal(测试.拼图片描述('', '文字'), '［图片：图片］\n文字\n')
  assert.equal(测试.拼图片描述('a.png', '   '), '')
  assert.equal(测试.拼图片描述('a.png', undefined), '')

  // 待插入队列：按会话隔离，取出即删除，失败计入失败数。
  assert.equal(测试.入队待插入({ sessionId: 's1', text: '甲' }), true)
  assert.equal(测试.入队待插入({ sessionId: 's2', text: '乙' }), true)
  assert.equal(测试.入队待插入({ sessionId: 's1', text: '' }), false)
  assert.equal(测试.取待插入('s1').join(','), '甲')
  assert.equal(测试.取待插入('s1').length, 0)
  let 结果 = 测试.消费待插入('s2', (文本) => 文本 === '乙')
  assert.equal(结果.成功, 1)
  assert.equal(结果.失败, 0)
  结果 = 测试.消费待插入('s2', () => false)
  assert.equal(结果.成功, 0)
  assert.equal(结果.失败, 0)
  assert.equal(测试.入队待插入({ text: '无会话标记' }), true)
  assert.equal(测试.取待插入('s3').join(','), '无会话标记')
  assert.equal(测试.入队待插入({ sessionId: 's4', text: '插入失败' }), true)
  结果 = 测试.消费待插入('s4', () => false)
  assert.equal(结果.成功, 0)
  assert.equal(结果.失败, 1)

  // 识图档位：和服务端同一套四档；id 大小写、中文名都收，认不出返回空串交给默认档。
  assert.deepEqual([...测试.识图档位们].map((档) => 档.id), ['brief', 'standard', 'detailed', 'text'])
  assert.deepEqual([...测试.识图档位选项].map((项) => 项.value), ['brief', 'standard', 'detailed', 'text'])
  assert.equal(测试.规范识图档位('brief'), 'brief')
  assert.equal(测试.规范识图档位(' Brief '), 'brief')
  assert.equal(测试.规范识图档位('详细'), 'detailed')
  assert.equal(测试.规范识图档位('只看文字'), 'text')
  assert.equal(测试.规范识图档位('特写'), '')
  assert.equal(测试.规范识图档位(null), '')
  // 表情包档已经挪到鱼讯插件，这里不再有。
  assert.equal(测试.识图档位们.some((档) => 档.id === 'sticker'), false)
})

test('client.js：slots 还没就绪时会重试，而不是直接抛错', async () => {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout: (函数) => { void 函数; return 0 },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  const 导出 = 工厂(() => 装React())
  let 取了 = 0
  const ctx = { get: () => { 取了 += 1; return undefined } }
  assert.doesNotThrow(() => 导出.apply(ctx))
  assert.ok(取了 > 0, '应该尝试过 ctx.get("slots")')
})
