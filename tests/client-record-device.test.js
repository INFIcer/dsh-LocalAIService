// 客户端「语音输入设备」纯函数：录音约束、设备不可用回退、虚拟设备提示。
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
  buildRecordingConstraint,
  openMic,
  deviceUnavailableError,
  isVirtualDeviceName,
  virtualDevicePrompt,
} = loadClient().__testing

/** vm 里造出来的对象原型不同，比较前先转成当前 realm 的普通对象。 */
const pure = (value) => JSON.parse(JSON.stringify(value))

function makeDeviceError(name) {
  const error = new Error(name)
  error.name = name
  return error
}

test('构建录音约束：空设备标识 → 系统默认约束，不带 deviceId', () => {
  const expected = { audio: { echoCancellation: true, noiseSuppression: true } }
  assert.deepEqual(pure(buildRecordingConstraint('')), expected)
  assert.deepEqual(pure(buildRecordingConstraint('   ')), expected)
  assert.deepEqual(pure(buildRecordingConstraint(undefined)), expected)
  assert.deepEqual(pure(buildRecordingConstraint(null)), expected)
  assert.deepEqual(pure(buildRecordingConstraint(42)), expected)
  assert.equal(buildRecordingConstraint('').audio.deviceId, undefined)
})

test('构建录音约束：非空设备标识 → 精确指定 deviceId', () => {
  assert.deepEqual(pure(buildRecordingConstraint('mic-abc')), {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      deviceId: { exact: 'mic-abc' },
    },
  })
  // 前后空白去掉，不改设备标识内部的字符。
  assert.deepEqual(pure(buildRecordingConstraint('  mic abc  ').audio.deviceId), { exact: 'mic abc' })
})

test('回退逻辑：所选设备报 OverconstrainedError → 改用系统默认', async () => {
  const stream = { id: 'default-stream' }
  const call = []
  const result = await openMic('gone-device', async (constraint) => {
    call.push(constraint)
    if (call.length === 1) throw makeDeviceError('OverconstrainedError')
    return stream
  })
  assert.equal(result.stream, stream)
  assert.equal(result.fellBack, true)
  assert.equal(call.length, 2)
  assert.deepEqual(call[0], buildRecordingConstraint('gone-device'))
  assert.deepEqual(call[1], buildRecordingConstraint(''))
  assert.equal(call[1].audio.deviceId, undefined)
})

test('回退逻辑：设备被拔掉 / 改名（NotFoundError）同样回退', async () => {
  const call = []
  const result = await openMic('old-device', async (constraint) => {
    call.push(constraint)
    if (call.length === 1) throw makeDeviceError('NotFoundError')
    return { id: 'ok' }
  })
  assert.equal(result.fellBack, true)
  assert.equal(call.length, 2)
  assert.equal(deviceUnavailableError(makeDeviceError('DevicesNotFoundError')), true)
})

test('回退逻辑：未指定设备或其它错误不回退，直接抛给调用方', async () => {
  let count = 0
  await assert.rejects(
    openMic('', async () => { count += 1; throw makeDeviceError('NotFoundError') }),
    (error) => error.name === 'NotFoundError',
  )
  assert.equal(count, 1)

  count = 0
  await assert.rejects(
    openMic('mic-1', async () => { count += 1; throw makeDeviceError('NotAllowedError') }),
    (error) => error.name === 'NotAllowedError',
  )
  assert.equal(count, 1)
})

test('回退逻辑：回退后仍失败，返回第二次的错误', async () => {
  const call = []
  await assert.rejects(
    openMic('gone-device', async (constraint) => {
      call.push(constraint)
      if (call.length === 1) throw makeDeviceError('OverconstrainedError')
      throw makeDeviceError('NotReadableError')
    }),
    (error) => error.name === 'NotReadableError',
  )
  assert.equal(call.length, 2)
})

test('虚拟设备识别：包含 stream / virtual / cable / voicemeeter 等关键词', () => {
  for (const label of [
    'PicoStreamingMicrophone',
    'Virtual Audio Cable',
    'CABLE Output (VB-Audio Virtual Cable)',
    'VoiceMeeter VAIO',
    'Stereo Mix (Realtek)',
    '立体声混音',
    'Loopback Audio',
  ]) {
    assert.equal(isVirtualDeviceName(label), true, label)
    assert.match(virtualDevicePrompt(label), /虚拟设备/)
  }
  for (const label of ['', 'Microphone (Realtek(R) Audio)', 'Headset Microphone', null, 42]) {
    assert.equal(isVirtualDeviceName(label), false, String(label))
    assert.equal(virtualDevicePrompt(label), '')
  }
})

test('虚拟设备提示文案固定，便于直接展示给用户', () => {
  assert.equal(virtualDevicePrompt('PicoStreamingMicrophone'), '当前输入设备可能是虚拟设备，请在设置里改选真实麦克风。')
})
