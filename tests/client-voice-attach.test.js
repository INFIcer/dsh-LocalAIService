// 客户端「语音作为文件附件」纯函数：附件名、内核 conversation 服务解析、挂附件流程。
//
// client.js 是 DSH 浏览器插件（window.__ModuleLoader__），这里用 vm + React 替身载入，
// 只验证挂在 exports.__testing 上的纯函数；内核草稿附件用替身模拟。
import test from 'node:test'
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function 载入客户端() {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    File,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  assert.equal(typeof 工厂, 'function')
  return 工厂(() => ({
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (初值) => [typeof 初值 === 'function' ? 初值() : 初值, () => {}],
    useEffect: () => {},
    useRef: (值) => ({ current: 值 }),
    useCallback: (函数) => 函数,
  }))
}

const 测试 = 载入客户端().__testing

test('语音附件名：日期时间 + 按 MIME 选扩展名', () => {
  const 时刻 = new Date(2026, 10, 10, 23, 5, 9).getTime()
  assert.equal(测试.语音附件名(时刻, 'audio/webm'), '语音-20261110-230509.webm')
  assert.equal(测试.语音附件名(时刻, 'audio/wav'), '语音-20261110-230509.wav')
  assert.equal(测试.语音附件名(时刻, 'audio/ogg;codecs=opus'), '语音-20261110-230509.ogg')
  assert.equal(测试.语音附件名(时刻, 'audio/mp4'), '语音-20261110-230509.m4a')
  assert.equal(测试.语音附件名(时刻, ''), '语音-20261110-230509.webm')
  assert.equal(测试.语音附件名(时刻, undefined), '语音-20261110-230509.webm')
})

test('取会话对话：优先走 session 作用域的 conversation', () => {
  const 对话 = { 标记: 'session' }
  const 上下文 = {
    get: (名) => (名 === 'sessions'
      ? { scope: (id) => (id === 's1' ? { get: (服务) => (服务 === 'conversation' ? 对话 : undefined) } : undefined) }
      : 名 === 'conversation' ? { 标记: 'root' } : undefined),
  }
  assert.equal(测试.取会话对话('s1', 上下文), 对话)
})

test('取会话对话：session 作用域没有时退回根 conversation', () => {
  const 根对话 = { 标记: 'root' }
  const 上下文 = { get: (名) => (名 === 'sessions' ? {} : 名 === 'conversation' ? 根对话 : undefined) }
  assert.equal(测试.取会话对话('s2', 上下文), 根对话)
})

test('取会话对话：服务都没有时返回 null 而不是抛错', () => {
  assert.equal(测试.取会话对话('s3', { get: () => undefined }), null)
  assert.equal(测试.取会话对话('s4', { get: () => { throw new Error('boom') } }), null)
  assert.equal(测试.取会话对话('s5', null), null)
})

test('挂语音附件：createDrafts + addAttachments 成功返回 true', () => {
  const 收到的 = []
  const 对话 = {
    createDrafts: (会话, 文件们) => {
      收到的.push({ 会话, 文件们 })
      return [{ id: 'a1' }, { id: 'a2' }]
    },
  }
  const 上下文 = { get: (名) => (名 === 'conversation' ? 对话 : undefined) }
  const inputActions = {
    addAttachments: (标识们) => {
      收到的.push({ 标识们 })
      return true
    },
  }
  const 成功 = 测试.挂语音附件(inputActions, 's9', { size: 3 }, 'audio/webm', '语音-20261110-230509.webm', 上下文)
  assert.equal(成功, true)
  assert.equal(收到的[0].会话, 's9')
  assert.equal(收到的[0].文件们.length, 1)
  assert.equal(收到的[0].文件们[0].name, '语音-20261110-230509.webm')
  assert.deepEqual(收到的[1].标识们, ['a1', 'a2'])
})

test('挂语音附件：内核没有 conversation 服务时返回 false', () => {
  const inputActions = { addAttachments: () => true }
  assert.equal(测试.挂语音附件(inputActions, 's9', { size: 3 }, 'audio/webm', 'x.webm', { get: () => undefined }), false)
})

test('挂语音附件：addAttachments 被拒时返回 false（调用方退回路径文字）', () => {
  const 对话 = { createDrafts: () => [{ id: 'a1' }] }
  const 上下文 = { get: (名) => (名 === 'conversation' ? 对话 : undefined) }
  assert.equal(测试.挂语音附件({ addAttachments: () => false }, 's9', { size: 3 }, 'audio/webm', 'x.webm', 上下文), false)
})

test('挂语音附件：createDrafts 抛错时吞掉异常返回 false', () => {
  const 对话 = { createDrafts: () => { throw new Error('busy') } }
  const 上下文 = { get: (名) => (名 === 'conversation' ? 对话 : undefined) }
  assert.equal(测试.挂语音附件({ addAttachments: () => true }, 's9', { size: 3 }, 'audio/webm', 'x.webm', 上下文), false)
})

test('挂语音附件：没有 blob / 没有 inputActions 时直接 false', () => {
  assert.equal(测试.挂语音附件({ addAttachments: () => true }, 's9', null, 'audio/webm', 'x.webm', {}), false)
  assert.equal(测试.挂语音附件(null, 's9', { size: 3 }, 'audio/webm', 'x.webm', {}), false)
})
