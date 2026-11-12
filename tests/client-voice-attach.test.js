// 客户端「语音作为文件附件」纯函数：附件名、内核 conversation 服务解析、挂附件流程。
//
// client.js 是 DSH 浏览器插件（window.__ModuleLoader__），这里用 vm + React 替身载入，
// 只验证挂在 exports.__testing 上的纯函数；内核草稿附件用替身模拟。
import test from 'node:test'
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
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
    File,
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
    useCallback: (fn) => fn,
  }))
}

const service = loadClient().__testing

test('语音附件名：日期时间 + 按 MIME 选扩展名', () => {
  const timestamp = new Date(2026, 10, 10, 23, 5, 9).getTime()
  assert.equal(service.speechAttachmentName(timestamp, 'audio/webm'), '语音-20261110-230509.webm')
  assert.equal(service.speechAttachmentName(timestamp, 'audio/wav'), '语音-20261110-230509.wav')
  assert.equal(service.speechAttachmentName(timestamp, 'audio/ogg;codecs=opus'), '语音-20261110-230509.ogg')
  assert.equal(service.speechAttachmentName(timestamp, 'audio/mp4'), '语音-20261110-230509.m4a')
  assert.equal(service.speechAttachmentName(timestamp, ''), '语音-20261110-230509.webm')
  assert.equal(service.speechAttachmentName(timestamp, undefined), '语音-20261110-230509.webm')
})

test('取会话对话：优先走 session 作用域的 conversation', () => {
  const conversation = { mark: 'session' }
  const context = {
    get: (name) => (name === 'sessions'
      ? { scope: (id) => (id === 's1' ? { get: (service) => (service === 'conversation' ? conversation : undefined) } : undefined) }
      : name === 'conversation' ? { mark: 'root' } : undefined),
  }
  assert.equal(service.fetchSessionConversation('s1', context), conversation)
})

test('取会话对话：session 作用域没有时退回根 conversation', () => {
  const rootConversation = { mark: 'root' }
  const context = { get: (name) => (name === 'sessions' ? {} : name === 'conversation' ? rootConversation : undefined) }
  assert.equal(service.fetchSessionConversation('s2', context), rootConversation)
})

test('取会话对话：服务都没有时返回 null 而不是抛错', () => {
  assert.equal(service.fetchSessionConversation('s3', { get: () => undefined }), null)
  assert.equal(service.fetchSessionConversation('s4', { get: () => { throw new Error('boom') } }), null)
  assert.equal(service.fetchSessionConversation('s5', null), null)
})

test('挂语音附件：createDrafts + addAttachments 成功返回 true', () => {
  const receivedValue = []
  const conversation = {
    createDrafts: (session, files) => {
      receivedValue.push({ session, files })
      return [{ id: 'a1' }, { id: 'a2' }]
    },
  }
  const context = { get: (name) => (name === 'conversation' ? conversation : undefined) }
  const inputActions = {
    addAttachments: (ids) => {
      receivedValue.push({ ids })
      return true
    },
  }
  const success = service.attachSpeechAttachment(inputActions, 's9', { size: 3 }, 'audio/webm', '语音-20261110-230509.webm', context)
  assert.equal(success, true)
  assert.equal(receivedValue[0].session, 's9')
  assert.equal(receivedValue[0].files.length, 1)
  assert.equal(receivedValue[0].files[0].name, '语音-20261110-230509.webm')
  assert.deepEqual(receivedValue[1].ids, ['a1', 'a2'])
})

test('挂语音附件：内核没有 conversation 服务时返回 false', () => {
  const inputActions = { addAttachments: () => true }
  assert.equal(service.attachSpeechAttachment(inputActions, 's9', { size: 3 }, 'audio/webm', 'x.webm', { get: () => undefined }), false)
})

test('挂语音附件：addAttachments 被拒时返回 false（调用方退回路径文字）', () => {
  const conversation = { createDrafts: () => [{ id: 'a1' }] }
  const context = { get: (name) => (name === 'conversation' ? conversation : undefined) }
  assert.equal(service.attachSpeechAttachment({ addAttachments: () => false }, 's9', { size: 3 }, 'audio/webm', 'x.webm', context), false)
})

test('挂语音附件：createDrafts 抛错时吞掉异常返回 false', () => {
  const conversation = { createDrafts: () => { throw new Error('busy') } }
  const context = { get: (name) => (name === 'conversation' ? conversation : undefined) }
  assert.equal(service.attachSpeechAttachment({ addAttachments: () => true }, 's9', { size: 3 }, 'audio/webm', 'x.webm', context), false)
})

test('挂语音附件：没有 blob / 没有 inputActions 时直接 false', () => {
  assert.equal(service.attachSpeechAttachment({ addAttachments: () => true }, 's9', null, 'audio/webm', 'x.webm', {}), false)
  assert.equal(service.attachSpeechAttachment(null, 's9', { size: 3 }, 'audio/webm', 'x.webm', {}), false)
})
