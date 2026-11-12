// 客户端「按会话自动朗读」纯函数：取值回落、单会话写入、旧配置兼容、非法键与上限。
//
// client.js 是 DSH 浏览器插件（window.__ModuleLoader__），这里用 vm + React 替身载入，
// 直接验证挂在 exports.__testing 上的纯函数，不跑浏览器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
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
  assert.equal(typeof factory, 'function')
  return factory(() => ({
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (initialValue) => [typeof initialValue === 'function' ? initialValue() : initialValue, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }))
}

const {
  readAutoReadSessions,
  writeAutoReadSessions,
  readBackgroundAutoRead,
  shouldAutoRead,
  autoReadSessionLimit,
} = loadClient().__testing

/** vm 里造出来的对象原型不同，比较前先转成当前 realm 的普通对象。 */
const pure = (value) => JSON.parse(JSON.stringify(value))

test('读会话自动朗读：本会话有设置就用，未设置回落全局默认', () => {
  const config = { autoRead: true, autoReadSessions: { 'session-a': false, 'session-b': true } }
  assert.equal(readAutoReadSessions(config, 'session-a'), false)
  assert.equal(readAutoReadSessions(config, 'session-b'), true)
  assert.equal(readAutoReadSessions(config, 'session-c'), true)

  assert.equal(readAutoReadSessions({ autoRead: false, autoReadSessions: { 'session-a': true } }, 'session-a'), true)
  assert.equal(readAutoReadSessions({ autoRead: false }, 'session-a'), false)
  assert.equal(readAutoReadSessions({}, 'session-a'), false)
  // 值按布尔理解，字符串 'true' 也算开启。
  assert.equal(readAutoReadSessions({ autoReadSessions: { 'session-a': 'true' } }, 'session-a'), true)
  assert.equal(readAutoReadSessions({ autoReadSessions: { 'session-a': 'false' } }, 'session-a'), false)
})

test('读会话自动朗读：旧配置没有按会话字段时行为与以前一致', () => {
  assert.equal(readAutoReadSessions({ autoRead: true }, 'session-a'), true)
  assert.equal(readAutoReadSessions({ autoRead: false }, 'session-a'), false)
  // 字段被手工改坏时按全局默认处理，不抛错。
  assert.equal(readAutoReadSessions({ autoRead: true, autoReadSessions: [] }, 'session-a'), true)
})

test('写会话自动朗读：只改当前会话，不影响其它会话与全局默认', () => {
  const orig = { autoRead: true, autoReadSessions: { 'session-a': false, 'session-b': true } }
  const next = writeAutoReadSessions(orig, 'session-a', true)
  assert.deepEqual(pure(next.autoReadSessions), { 'session-a': true, 'session-b': true })
  assert.equal(next.autoRead, true)
  assert.equal(next.autoReadSessions['session-b'], true)
  // 不改原对象。
  assert.deepEqual(orig.autoReadSessions, { 'session-a': false, 'session-b': true })

  // 未设置过的会话：只新增一条，全局默认原样保留。
  const other = writeAutoReadSessions({ autoRead: false }, 'session-c', true)
  assert.deepEqual(pure(other.autoReadSessions), { 'session-c': true })
  assert.equal(other.autoRead, false)
  assert.equal(readAutoReadSessions(other, 'session-c'), true)
  // 其它未设置的会话仍回落全局默认。
  assert.equal(readAutoReadSessions(other, 'session-d'), false)
})

test('写会话自动朗读：非法会话键不写入', () => {
  for (const key of ['', 's1', 'session', null, undefined, 42]) {
    const config = { autoRead: false, autoReadSessions: { 'session-a': true } }
    assert.deepEqual(pure(writeAutoReadSessions(config, key, true)), config)
  }
})

test('写会话自动朗读：最多保留 200 条，超出时淘汰最早的设置、保留本次写入', () => {
  const table = {}
  for (let i = 0; i < autoReadSessionLimit; i += 1) table[`session-${i}`] = true
  const next = writeAutoReadSessions({ autoReadSessions: table }, 'session-new', true)
  assert.equal(Object.keys(next.autoReadSessions).length, autoReadSessionLimit)
  assert.equal(next.autoReadSessions['session-new'], true)
  assert.equal('session-0' in next.autoReadSessions, false)
  assert.equal('session-1' in next.autoReadSessions, true)
})

test('会话切换：按钮状态随会话键重算', () => {
  let config = { autoRead: true, autoReadSessions: {} }
  assert.equal(readAutoReadSessions(config, 'session-a'), true)

  config = writeAutoReadSessions(config, 'session-a', false)
  assert.equal(readAutoReadSessions(config, 'session-a'), false)
  assert.equal(readAutoReadSessions(config, 'session-b'), true) // B 还没单独设置，沿用默认

  config = writeAutoReadSessions(config, 'session-b', false)
  assert.equal(readAutoReadSessions(config, 'session-a'), false)
  assert.equal(readAutoReadSessions(config, 'session-b'), false)
  assert.equal(readAutoReadSessions(config, 'session-c'), true)

  // 切回 A 仍然只反映 A 自己的设置。
  assert.equal(readAutoReadSessions(config, 'session-a'), false)
})

test('读后台自动朗读：默认开，旧配置缺字段按开，只有明确关闭才关', () => {
  assert.equal(readBackgroundAutoRead({}), true)
  assert.equal(readBackgroundAutoRead({ autoReadInBackground: undefined }), true)
  assert.equal(readBackgroundAutoRead(null), true)
  assert.equal(readBackgroundAutoRead({ autoReadInBackground: true }), true)
  for (const value of [false, 'false', 0, '0']) {
    assert.equal(readBackgroundAutoRead({ autoReadInBackground: value }), false)
  }
  // 无法识别的值按开（与配置规范化一致）。
  assert.equal(readBackgroundAutoRead({ autoReadInBackground: '乱写' }), true)
})

test('是否自动朗读：会话开关 × 后台开关 四种组合（前台不受后台设置影响）', () => {
  for (const sessionOn of [true, false]) {
    for (const backgroundOn of [true, false]) {
      const config = { autoRead: sessionOn, autoReadInBackground: backgroundOn }
      // 页面在前台：只看会话开关。
      assert.equal(shouldAutoRead(config, 'session-a', true), sessionOn,
        `前台：会话=${sessionOn} 后台=${backgroundOn}`)
      // 页面在后台：两者都开才朗读。
      assert.equal(shouldAutoRead(config, 'session-a', false), sessionOn && backgroundOn,
        `后台：会话=${sessionOn} 后台=${backgroundOn}`)
    }
  }

  // 按会话单独开启 / 关闭时，仍以后台设置为前提。
  const singleSessionOn = { autoRead: false, autoReadSessions: { 'session-a': true }, autoReadInBackground: true }
  assert.equal(shouldAutoRead(singleSessionOn, 'session-a', false), true)
  assert.equal(shouldAutoRead(singleSessionOn, 'session-b', false), false)

  const singleSessionOff = { autoRead: true, autoReadSessions: { 'session-a': false }, autoReadInBackground: true }
  assert.equal(shouldAutoRead(singleSessionOff, 'session-a', false), false)
  assert.equal(shouldAutoRead(singleSessionOff, 'session-b', false), true)

  // 旧配置（没有后台字段）：后台仍朗读。
  assert.equal(shouldAutoRead({ autoRead: true }, 'session-a', false), true)
  assert.equal(shouldAutoRead({ autoRead: true, autoReadInBackground: false }, 'session-a', false), false)
})
