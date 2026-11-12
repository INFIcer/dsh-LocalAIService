// P2 客户端插件加载冒烟（不跑浏览器，只用 vm + React 替身）：
// 验证 client.js 能求值、apply 能注册各个入口（设置页 + 朗读 + 麦克风 + 本地识图 + 面板 + 自动朗读）。
//
// 真正的交互（录音、播放、插入文字）仍需真机验收，见 docs/P2.md 的手动步骤。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

test('client.js 加载：apply 注册设置页 / 朗读 / 麦克风 / 本地识图 / 面板 / 自动朗读', async () => {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory = null

  const window = {
    __ModuleLoader__: {
      load: (define) => { factory = define.factory },
    },
  }

  const sandbox = {
    window: window,
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  assert.equal(typeof factory, 'function', 'window.__ModuleLoader__.load 应该拿到 factory')

  const exported = factory((displayName) => {
    if (displayName === 'react') return installReact()
    throw new Error(`未预期的 require：${displayName}`)
  })
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual([...exported.inject], ['slots', 'uiConversation', 'sidebarRightTabs'])

  const registers = []
  const interactions = []
  const rightPanelDefine = []
  let release = 0
  const service = {
    inject: (_slot, callback) => { callback(); return () => { release += 1 } },
    register: (config, component) => {
      registers.push({ config, component })
      return () => { release += 1 }
    },
  }
  const rightPanel = {
    register: (define) => {
      rightPanelDefine.push(define)
      return () => { release += 1 }
    },
  }
  const ui = {
    interactions: {
      register: (define, tag) => {
        interactions.push({ define, tag })
        return () => { release += 1 }
      },
    },
  }
  let dispose = null
  const ctx = {
    effect: (install) => { dispose = install() },
    get: (displayName) =>
      displayName === 'slots' ? service : displayName === 'uiConversation' ? ui : displayName === 'sidebarRightTabs' ? rightPanel : undefined,
  }
  exported.apply(ctx)

  assert.deepEqual(registers.map((x) => x.config.name), [
    'settings.section',
    'conversation.chat.assistant-actions',
    'conversation.input.right',
    'conversation.input.right',
    'conversation.input.overlay',
    'conversation.input.left',
    'conversation.input.left',
    'conversation.chat.text-interaction',
    'sidebar.right.pane.tab',
  ])
  assert.deepEqual(registers.map((x) => x.config.id), [
    'fish-service',
    'fish-read',
    'fish-mic',
    'fish-vision',
    'fish-voice',
    'fish-auto-read',
    'fish-metrics',
    undefined,
    undefined,
  ])
  // 本地识图是输入框旁的独立按钮，和麦克风同一排；官方附件栏不再被顶替。
  assert.equal(registers.find((x) => x.config.id === 'fish-vision').config.order, 31)
  assert.equal(registers.find((x) => x.config.id === 'fish-mic').config.order, 32)
  // 状态胶囊是 list 槽：靠 id 区分条目，不需要 priority。
  const statusCapsule = registers.find((x) => x.config.id === 'fish-metrics')
  assert.equal(statusCapsule.config.order, 40)
  assert.equal(statusCapsule.config.priority, undefined)
  assert.equal(registers.some((x) => x.config.name === 'conversation.input.attachments'), false)
  assert.equal(registers.some((x) => x.config.name === 'shell.bottom'), false)
  assert.equal(registers.at(-2).config.key, 'fish-selection')
  // 右栏面板是 keyed 槽，key 必须是 tab 类型的 id。
  assert.equal(registers.at(-1).config.key, 'dsh-fish-service/translate')
  // 面板靠 inject 拿当前会话 id，草稿才能按会话隔离。
  assert.equal(typeof registers.at(-1).config.inject, 'function')
  assert.equal(registers.at(-1).config.inject('session-1').sessionId, 'session-1')

  // 右栏卡片：只注册一个类型，id/kind 都要唯一，guide 里给出一张入口卡。
  assert.equal(rightPanelDefine.length, 1)
  assert.equal(rightPanelDefine[0].id, 'dsh-fish-service/translate')
  assert.equal(rightPanelDefine[0].kind, 'fish-translate')
  assert.equal(rightPanelDefine[0].keepMounted, true)
  assert.equal(rightPanelDefine[0].title(), '双语翻译')
  assert.equal(rightPanelDefine[0].guide.length, 1)
  assert.deepEqual(
    { id: rightPanelDefine[0].guide[0].id, order: rightPanelDefine[0].guide[0].order },
    { id: 'translate', order: 35 },
  )
  assert.equal(rightPanelDefine[0].guide[0].title(), '双语翻译')
  assert.match(rightPanelDefine[0].guide[0].description(), /对着翻/)

  // 框选交互：只对 selection + 有文本的请求 open；其它情况不抢。
  assert.equal(interactions.length, 1)
  assert.equal(interactions[0].define.id, 'fish-selection')
  let open = 0
  const request = (over = {}) => ({ trigger: 'selection', readText: () => '选中文字', open: () => { open += 1 }, ...over })
  interactions[0].define.onInteraction(request())
  assert.equal(open, 1)
  interactions[0].define.onInteraction(request({ trigger: 'context-menu' }))
  interactions[0].define.onInteraction(request({ readText: () => null }))
  interactions[0].define.onInteraction(request({ readText: () => '   ' }))
  assert.equal(open, 1)

  for (const item of registers) assert.equal(typeof item.component, 'function')

  // 再拿最小 props 各渲染一次：能抓出「引用了不存在的变量 / 拼错字段」这类运行时错误。
  const components = Object.fromEntries(registers.map((x) => [x.config.id, x.component]))
  assert.doesNotThrow(() => components['fish-service']())
  assert.doesNotThrow(() => components['fish-read']({ messageId: 'm1', useChat: () => '' }))
  assert.doesNotThrow(() => components['fish-mic']({ sessionId: 's1' }))
  assert.doesNotThrow(() => components['fish-voice']({ sessionId: 's1' }))
  assert.doesNotThrow(() => components['fish-auto-read']())
  // 状态胶囊：服务未加载时也能渲染「连接中」。
  assert.doesNotThrow(() => components['fish-metrics']())
  // 本地识图按钮：独立入口，不依赖草稿附件。
  assert.doesNotThrow(() => components['fish-vision']({ sessionId: 's1' }))
  assert.doesNotThrow(() => components['fish-vision']())
  // 面板空闲时不应该渲染任何东西。
  assert.equal(components['fish-voice']({ sessionId: 's1' }), null)
  // 右栏翻译面板：没有会话 id 也要能渲染。
  assert.doesNotThrow(() => exported.__testing.translationPanel({}))
  assert.doesNotThrow(() => exported.__testing.translationPanel({ sessionId: 's1' }))

  // 上传前按 MIME 定扩展名：服务端只认这几种。
  const { visionExt } = exported.__testing
  assert.equal(visionExt('image/png'), '.png')
  assert.equal(visionExt('image/jpeg'), '.jpg')
  assert.equal(visionExt('image/webp'), '.webp')
  assert.equal(visionExt('image/gif'), '.gif')
  assert.equal(visionExt('image/bmp'), '.bmp')
  assert.equal(visionExt(''), '.jpg')
  assert.equal(visionExt(undefined), '.jpg')

  // ---- 发送前识图：纯函数（入口判断 / 描述拼装 / 待插入队列） ----
  const testingApi = exported.__testing
  const image = (name, type = '') => ({ name: name, type: type, size: 10 })

  // 是图片文件：MIME 优先，扩展名兜底（大小写不敏感）。
  assert.equal(testingApi.isImageFile(image('a.png', 'image/png')), true)
  assert.equal(testingApi.isImageFile(image('a.JPG')), true)
  assert.equal(testingApi.isImageFile(image('a.webp', '')), true)
  assert.equal(testingApi.isImageFile(image('a.pdf', 'application/pdf')), false)
  assert.equal(testingApi.isImageFile(image('a.pdf')), false)
  assert.equal(testingApi.isImageFile(null), false)

  // 识图入口：开关关、服务离线给一句短提示（都不改图片）；正常返回空串。
  assert.equal(testingApi.visionBlockReason({ load: true, online: true, config: {} }), '')
  assert.match(testingApi.visionBlockReason({ load: true, online: true, config: { localDescribe: false } }), /已关闭/)
  assert.match(testingApi.visionBlockReason({ load: true, online: false, config: {} }), /未连接/)
  // 偏好还没载入时先当作可用；真失败时页面自己会提示。
  assert.equal(testingApi.visionBlockReason({ load: false }), '')
  assert.equal(testingApi.visionBlockReason(null), '')
  assert.equal(testingApi.localVisionOn({ localDescribe: false }), false)
  assert.equal(testingApi.localVisionOn({}), true)
  assert.equal(testingApi.localVisionOn(null), true)

  // 拼图片描述：文件名 + 详细描述，每张一段；空描述不插。
  assert.equal(testingApi.composeImageDesc('a.png', ' 一只猫\n坐在窗台 '), '［图片：a.png］\n一只猫\n坐在窗台\n')
  assert.equal(testingApi.composeImageDesc('', '文字'), '［图片：图片］\n文字\n')
  assert.equal(testingApi.composeImageDesc('a.png', '   '), '')
  assert.equal(testingApi.composeImageDesc('a.png', undefined), '')

  // 待插入队列：按会话隔离，取出即删除，失败计入失败数。
  assert.equal(testingApi.enqueuePendingInsert({ sessionId: 's1', text: '甲' }), true)
  assert.equal(testingApi.enqueuePendingInsert({ sessionId: 's2', text: '乙' }), true)
  assert.equal(testingApi.enqueuePendingInsert({ sessionId: 's1', text: '' }), false)
  assert.equal(testingApi.fetchPendingInsert('s1').join(','), '甲')
  assert.equal(testingApi.fetchPendingInsert('s1').length, 0)
  let result = testingApi.consumePendingInsert('s2', (text) => text === '乙')
  assert.equal(result.success, 1)
  assert.equal(result.fail, 0)
  result = testingApi.consumePendingInsert('s2', () => false)
  assert.equal(result.success, 0)
  assert.equal(result.fail, 0)
  assert.equal(testingApi.enqueuePendingInsert({ text: '无会话标记' }), true)
  assert.equal(testingApi.fetchPendingInsert('s3').join(','), '无会话标记')
  assert.equal(testingApi.enqueuePendingInsert({ sessionId: 's4', text: '插入失败' }), true)
  result = testingApi.consumePendingInsert('s4', () => false)
  assert.equal(result.success, 0)
  assert.equal(result.fail, 1)

  // 识图档位：和服务端同一套四档；id 大小写、中文名都收，认不出返回空串交给默认档。
  assert.deepEqual([...testingApi.visionPresets].map((preset) => preset.id), ['brief', 'standard', 'detailed', 'text'])
  assert.deepEqual([...testingApi.visionPresetOption].map((item) => item.value), ['brief', 'standard', 'detailed', 'text'])
  assert.equal(testingApi.normalizeVisionPreset('brief'), 'brief')
  assert.equal(testingApi.normalizeVisionPreset(' Brief '), 'brief')
  assert.equal(testingApi.normalizeVisionPreset('详细'), 'detailed')
  assert.equal(testingApi.normalizeVisionPreset('只看文字'), 'text')
  assert.equal(testingApi.normalizeVisionPreset('特写'), '')
  assert.equal(testingApi.normalizeVisionPreset(null), '')
  // 表情包档已经挪到鱼讯插件，这里不再有。
  assert.equal(testingApi.visionPresets.some((preset) => preset.id === 'sticker'), false)

  // ---- 界面注入开关：纯函数按组件名或配置键判断；旧配置缺字段按开 ----
  const { uiSwitchOn, uiSwitchKey, prefs } = testingApi
  for (const name of ['speechRecognition', 'localVision', 'performanceMonitor', 'autoRead']) {
    assert.equal(uiSwitchOn({}, name), true)
    assert.equal(uiSwitchOn(null, name), true)
    assert.equal(uiSwitchOn({ [uiSwitchKey[name]]: false }, name), false)
    assert.equal(uiSwitchOn({ [uiSwitchKey[name]]: 'false' }, name), false)
    assert.equal(uiSwitchOn({ [uiSwitchKey[name]]: 0 }, name), false)
    assert.equal(uiSwitchOn({ [uiSwitchKey[name]]: true }, name), true)
  }
  assert.equal(uiSwitchOn({ uiMetrics: false }, 'uiMetrics'), false)
  assert.equal(uiSwitchOn({ uiMetrics: '乱写' }, 'uiMetrics'), true)

  // 关掉后对应注入组件返回 null（组件仍挂载，hooks 照常跑，才能即时停掉副作用）。
  for (const [configKey, componentID] of [
    ['uiVoiceInput', 'fish-mic'],
    ['uiVision', 'fish-vision'],
    ['uiMetrics', 'fish-metrics'],
    ['uiAutoRead', 'fish-auto-read'],
  ]) {
    const origConfig = prefs.get().config
    try {
      assert.notEqual(components[componentID]({ sessionId: 's1' }), null)
      prefs.set((prev) => ({ ...prev, config: { ...(prev.config || {}), [configKey]: false } }))
      assert.equal(components[componentID]({ sessionId: 's1' }), null)
    } finally {
      prefs.set((prev) => ({ ...prev, config: origConfig }))
    }
    // 恢复后重新可见。
    assert.notEqual(components[componentID]({ sessionId: 's1' }), null)
  }

  // 录音上限：到点自动停止时 stop() 收尾会略超 300 秒；按上限截断，不能整段丢弃。
  const { clampRecordingDuration } = testingApi
  const normal = clampRecordingDuration(299000)
  assert.equal(normal.ok, true)
  assert.equal(normal.durationMs, 299000)
  assert.equal(normal.capped, false)
  const slightlyOver = clampRecordingDuration(300150)
  assert.equal(slightlyOver.ok, true, '自动停止时略超上限不能判失败')
  assert.equal(slightlyOver.durationMs, 300000, '时长要按上限截断')
  assert.equal(slightlyOver.capped, true)
  assert.equal(clampRecordingDuration(303000).ok, true)
  assert.equal(clampRecordingDuration(310000).ok, false)

  // 卸载：apply 交给 ctx.effect 的清理函数要反注册槽位/交互/右栏，可重复调用。
  assert.equal(typeof dispose, 'function')
  assert.equal(release, 0)
  dispose()
  assert.equal(release, 11)
  dispose()
  assert.equal(release, 11)

  // 两轮 apply（热重载）各自可卸载。
  exported.apply(ctx)
  assert.equal(registers.length, 18)
  dispose()
  assert.equal(release, 22)
})

test('client.js：slots 还没就绪时会重试，而不是直接抛错', async () => {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (define) => { factory = define.factory } } },
    document: undefined,
    console,
    setTimeout: (fn) => { void fn; return 0 },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  const exported = factory(() => installReact())
  let taken = 0
  const ctx = { get: () => { taken += 1; return undefined } }
  assert.doesNotThrow(() => exported.apply(ctx))
  assert.ok(taken > 0, '应该尝试过 ctx.get("slots")')
})

test('朗读按钮：渲染期真的执行 useChat 选择器也不抛错（TDZ 回归）', async () => {
  const sourceCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (define) => { factory = define.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(sandbox)
  vm.runInContext(sourceCode, sandbox)
  const exported = factory(() => installReact())

  // 快照形状照 readButton 里 messageText / messagePosition 的取数路径（轮次 → 节点 → 定稿消息）。
  const snapshot = {
    timeline: { turnOrder: [1] },
    locations: { getTurn: (turn) => (turn === 1 ? ['k1'] : []) },
    nodes: {
      get: (key) => (key === 'k1'
        ? { kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'm1' }, blocks: [{ kind: 'text', text: '你好' }] } } }
        : undefined),
    },
  }
  // 选择器必须真的被调用才能复现：局部变量遮住同名外层函数后自引用，初始化前调用会抛
  // ReferenceError（TDZ），宿主槽位错误边界会把这条注册退役，表现为朗读按钮整块消失。
  const element = exported.__testing.readButton({
    messageId: 'm1',
    sessionId: 'session-1',
    useChat: (selector) => selector(snapshot),
  })
  const children = (element && element.param) || []
  assert.equal(
    children.some((child) => child && Array.isArray(child.param) && child.param[0] === 'button'),
    true,
    '应该渲染出朗读按钮',
  )
})
