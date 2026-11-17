// 一键安装：预检、目录校验、命令构造、步骤顺序、取消、回滚、状态文件、
// 模型下载轮询、lite 模式与宿主路由。所有外部依赖（spawn/fetch/端口/时间）都注入，
// 测试不跑 git/pip/torch，也不真的下载模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstaller, compareVersion } from '../lib/installer.js'
import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CATALOG,
  defaultInstallDir,
  selectModelCapabilities,
  validateInstallDir,
} from '../lib/install-manifest.js'
import { registerRoutes } from '../lib/routes.js'
import { makeError } from '../lib/errors.js'
import { basicHandler, makeReq, makeRes, makeStack, makeTempDir } from './helpers.js'

const okResult = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false, aborted: false })
const failResult = (stderr = '', code = 1) => ({ ok: false, code, stdout: '', stderr, timedOut: false, aborted: false })

function writeRepo(root, userFiles = {}) {
  mkdirSync(join(root, 'src', 'localai'), { recursive: true })
  mkdirSync(join(root, 'engine'), { recursive: true })
  mkdirSync(join(root, 'tools'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'start_ai_service.ps1'), '# test')
  writeFileSync(join(root, 'pyproject.toml'), '# test')
  writeFileSync(join(root, 'src', 'localai', '__init__.py'), '')
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
  for (const [name, content] of Object.entries(userFiles)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), content)
  }
}

function writeVenv(root) {
  mkdirSync(join(root, 'engine', '.venv', 'Scripts'), { recursive: true })
  writeFileSync(join(root, 'engine', '.venv', 'Scripts', 'python.exe'), '')
}

/** 假命令执行器：默认把 git clone / venv 需要的最小目录结构真的建出来。 */
function makeRun(root, { onCall = null } = {}) {
  const calls = []
  const run = async (spec) => {
    calls.push(spec)
    if (onCall) {
      const custom = await onCall(spec)
      if (custom) return custom
    }
    const { command, args = [] } = spec
    if (command === 'git' && args[0] === '--version') return okResult('git version 2.51.2.windows.1')
    if (command === 'nvidia-smi') return okResult('NVIDIA GeForce RTX 3070, 8192 MiB, 591.59')
    if (command === 'where' || command === 'which') return failResult()
    if (command === 'py' && args.includes('-c')) return okResult('3.13.9')
    if (command === 'git' && args.includes('clone')) {
      writeRepo(root)
      return okResult()
    }
    if (args.includes('venv')) {
      writeVenv(root)
      return okResult()
    }
    if (args.includes('pip')) return okResult()
    return okResult()
  }
  run.calls = calls
  return run
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => Buffer.from(text),
  }
}

/** 假 fetch：handler 返回 { status, body }；同时记录请求，便于断言顺序。 */
function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const request = {
      url: String(url),
      method: String(options.method || 'GET').toUpperCase(),
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    }
    calls.push(request)
    const output = await handler(request)
    if (output === undefined) return jsonResponse(404, { ok: false })
    const status = output.status === undefined ? 200 : output.status
    return jsonResponse(status, output.body === undefined ? {} : output.body)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const networkOk = (request) => {
  if (request.url.startsWith('https://codeload')
    || request.url.startsWith('https://pypi')
    || request.url.startsWith('https://download.pytorch')) return { status: 200, body: {} }
  return undefined
}

function serviceCaps(version = '2.5.1') {
  return {
    ok: true,
    api_version: '1',
    service: { name: 'localai-service', version },
  }
}

/** 完整安装成功用的 fetch：返回 0 模型 health 200，/admin/models 按下载状态变化。 */
function makeInstallFetch() {
  const state = { downloaded: false, taskPolls: new Map() }
  const fetchImpl = makeFetch(async (request) => {
    const network = networkOk(request)
    if (network) return network
    if (request.url.endsWith('/health')) return { status: 200, body: { ok: true, model_ready: false } }
    if (request.url.endsWith('/capabilities')) return { status: 200, body: serviceCaps() }
    if (request.url.endsWith('/admin/models')) {
      const models = MODEL_CATALOG.map((item) => ({
        capability: item.capability,
        name: item.label,
        present: state.downloaded || item.capability === 'asr',
        size_mb: item.sizeMb,
        missing_files: [],
      }))
      return { status: 200, body: { ok: true, models } }
    }
    if (request.url.endsWith('/admin/models/download')) {
      return { status: 200, body: { ok: true, task_id: `task-${request.body.capability}` } }
    }
    if (request.url.includes('/admin/models/tasks/')) {
      const id = request.url.split('/').pop()
      const count = (state.taskPolls.get(id) || 0) + 1
      state.taskPolls.set(id, count)
      if (count === 1) {
        return { status: 200, body: { ok: true, status: 'running', downloaded_mb: 10, size_mb: 100 } }
      }
      state.downloaded = true
      return { status: 200, body: { ok: true, status: 'done', done: true, downloaded_mb: 100 } }
    }
    return undefined
  })
  fetchImpl.state = state
  return fetchImpl
}

function makeInstaller(temp, {
  run = null,
  fetchImpl = null,
  fs = nodeFs,
  skipService = false,
  spawnBackgroundImpl = null,
  killTree = null,
  probePort = async () => false,
  now = () => Date.now(),
  sleep = async () => {},
} = {}) {
  const installDir = join(temp.dir, 'localai')
  const home = join(temp.dir, 'home')
  const saved = { config: null }
  const spawned = []
  const killed = []
  const installer = createInstaller({
    homeDir: home,
    fs,
    run: run || makeRun(installDir),
    fetchImpl: fetchImpl || makeFetch(async (request) => networkOk(request) || { status: 404, body: { ok: false } }),
    getConfig: () => ({ baseUrl: 'http://127.0.0.1:7880', installDir: '', installMode: 'unknown', token: '' }),
    saveConfig: async (patch) => { saved.config = { ...(saved.config || {}), ...patch }; return saved.config },
    capabilities: { current: () => null, invalidate: () => {}, refresh: async () => ({}) },
    spawnBackgroundImpl: spawnBackgroundImpl || ((spec) => {
      spawned.push(spec)
      return { pid: 4321 }
    }),
    killTree: killTree || ((pid) => { killed.push(pid) }),
    probePort,
    now,
    sleep,
  })
  return { installer, installDir, home, saved, spawned, killed }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------- 清单与目录 ----------------

test('默认安装目录与模型勾选', () => {
  assert.equal(
    defaultInstallDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x'),
    join('C:\\Users\\x\\AppData\\Local', 'localai-service'),
  )
  assert.deepEqual(selectModelCapabilities().capabilities, [...DEFAULT_MODEL_CAPABILITIES])
  assert.deepEqual(selectModelCapabilities([]).capabilities, [])
  assert.equal(selectModelCapabilities('all').capabilities.length, MODEL_CATALOG.length)
  assert.deepEqual(
    selectModelCapabilities(['speaker', 'tts', 'all']).capabilities.length,
    MODEL_CATALOG.length,
  )
  assert.equal(selectModelCapabilities(['tts', 'nope']).ok, false)
  assert.deepEqual(selectModelCapabilities(['speaker', 'tts']).capabilities, ['tts', 'speaker'])
})

test('安装目录校验：盘符根/系统目录/网络路径/相对路径/junction 都拒绝', () => {
  const temp = makeTempDir()
  try {
    const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: join(temp.dir, 'local') }
    assert.equal(validateInstallDir('C:\\', { env }).ok, false)
    assert.equal(validateInstallDir('C:\\Windows\\localai', { env }).ok, false)
    assert.equal(validateInstallDir('C:\\Program Files\\localai', { env }).ok, false)
    assert.equal(validateInstallDir('\\\\server\\share\\localai', { env }).ok, false)
    assert.equal(validateInstallDir('relative\\dir', { env }).ok, false)
    const good = join(temp.dir, 'install')
    assert.equal(validateInstallDir(good, { env }).ok, true)
    const junctionFs = {
      ...nodeFs,
      existsSync: () => true,
      realpathSync: () => 'D:\\real-target',
    }
    const junction = validateInstallDir(good, { env, fs: junctionFs })
    assert.equal(junction.ok, false)
    assert.match(junction.hint, /junction|链接/)
  } finally {
    temp.cleanup()
  }
})

test('compareVersion 按数字段比较', () => {
  assert.equal(compareVersion('591.59', '580.00'), 1)
  assert.equal(compareVersion('3.13.9', '3.13'), 1)
  assert.equal(compareVersion('3.11', '3.13'), -1)
  assert.equal(compareVersion('2.5.0', '2.5'), 0)
})

// ---------------- 预检 ----------------

test('预检：磁盘不足 + 端口被占 + 没有 Python 都是 blocker', async () => {
  const temp = makeTempDir()
  try {
    const run = makeRun(join(temp.dir, 'localai'), {
      onCall: (spec) => {
        if (spec.command === 'nvidia-smi') return failResult('not found')
        if (spec.command === 'git') return failResult()
        if (spec.command === 'py' || spec.command === 'python' || spec.command === 'python3') return failResult()
        return null
      },
    })
    const fetchImpl = makeFetch(async () => ({ status: 503, body: {} }))
    const fs = { ...nodeFs, statfsSync: () => ({ bavail: 1024, bsize: 1024 }) }
    const { installer, installDir } = makeInstaller(temp, {
      run,
      fetchImpl,
      fs,
      probePort: async () => true,
    })
    const result = await installer.preflight({ installDir })
    const codes = result.blockers.map((item) => item.code)
    assert.equal(result.ok, false)
    assert.ok(codes.includes('disk_space'))
    assert.ok(codes.includes('port_busy'))
    assert.ok(codes.includes('python_missing'))
    assert.ok(result.warnings.some((item) => item.code === 'gpu_missing'))
    assert.ok(result.warnings.some((item) => item.code === 'git_missing'))
    assert.ok(result.warnings.some((item) => item.code === 'network_unreachable'))
    assert.equal(result.port.listening, true)
    assert.equal(result.port.owner.kind, 'other')
  } finally {
    temp.cleanup()
  }
})

test('预检：无显卡/无 git/无 ffmpeg 只给 warning，可继续', async () => {
  const temp = makeTempDir()
  try {
    const run = makeRun(join(temp.dir, 'localai'), {
      onCall: (spec) => {
        if (spec.command === 'nvidia-smi') return failResult('not found')
        if (spec.command === 'where') return failResult()
        return null
      },
    })
    const fetchImpl = makeFetch(async (request) => networkOk(request) || { status: 200, body: {} })
    const { installer, installDir } = makeInstaller(temp, { run, fetchImpl, probePort: async () => false })
    const result = await installer.preflight({ installDir })
    assert.equal(result.ok, true)
    assert.equal(result.blockers.length, 0)
    assert.ok(result.warnings.some((item) => item.code === 'gpu_missing'))
    assert.ok(result.warnings.some((item) => item.code === 'ffmpeg_missing'))
    assert.equal(result.python.ok, true)
    assert.equal(result.python.command, 'py')
    assert.equal(result.python.args[0], '-3.13')
    assert.equal(result.git.ok, true)
    assert.ok(result.disk.freeMb > 0)
    assert.ok(result.disk.requiredMb > 7000)
  } finally {
    temp.cleanup()
  }
})

test('预检：已有安装标记只 warn，并给出 adoptable', async () => {
  const temp = makeTempDir()
  try {
    const installDir = join(temp.dir, 'localai')
    const home = join(temp.dir, 'home')
    mkdirSync(installDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(installDir, '.dsh-fish-service-install.json'), JSON.stringify({
      version: 1, installMode: 'managed', installDir, serviceVersion: '2.5.1', status: 'installed',
    }))
    const run = makeRun(installDir)
    const fetchImpl = makeFetch(async (request) => {
      const network = networkOk(request)
      if (network) return network
      if (request.url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (request.url.endsWith('/capabilities')) return { status: 200, body: serviceCaps() }
      return { status: 404, body: {} }
    })
    const { installer } = makeInstaller(temp, { run, fetchImpl, probePort: async () => true })
    const result = await installer.preflight({ installDir })
    assert.equal(result.ok, true)
    assert.equal(result.existing.found, true)
    assert.equal(result.existing.mode, 'adoptable')
    assert.ok(result.warnings.some((item) => item.code === 'already_installed'))
    assert.ok(result.warnings.some((item) => item.code === 'service_running'))
  } finally {
    temp.cleanup()
  }
})

// ---------------- 安装流程 ----------------

test('安装：lite 模式跳过引擎依赖，步骤顺序正确并写状态文件', async () => {
  const temp = makeTempDir()
  try {
    const fetchImpl = makeInstallFetch()
    const run = makeRun(join(temp.dir, 'localai'))
    const { installer, installDir, home, saved, spawned } = makeInstaller(temp, { run, fetchImpl })
    const started = await installer.start({
      installDir,
      skipEngine: true,
      models: ['tts', 'speaker'],
    })
    assert.equal(started.ok, true)
    assert.equal(started.state, 'running')
    const status = await installer.waitForIdle()
    assert.equal(status.state, 'succeeded', JSON.stringify(status.error))
    assert.equal(status.percent, 100)
    assert.equal(status.steps.some((step) => step.id === 'engine-deps'), false)
    assert.deepEqual(status.steps.map((step) => step.id), [
      'preflight', 'fetch-code', 'venv', 'pip-core', 'start', 'verify', 'save-config', 'models',
    ])
    assert.ok(status.steps.every((step) => step.status === 'done'))
    assert.equal(saved.config.baseUrl, 'http://127.0.0.1:7880')
    assert.equal(saved.config.installMode, 'managed')
    assert.equal(saved.config.installDir, installDir)
    assert.equal(spawned.length, 1)
    assert.deepEqual(spawned[0].args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass'])
    assert.ok(spawned[0].args.includes(join(installDir, 'start_ai_service.ps1')))

    const state = readJson(join(home, 'fish-service-install.json'))
    assert.equal(state.status, 'installed')
    assert.equal(state.installMode, 'managed')
    assert.equal(state.serviceVersion, '2.5.1')
    assert.equal(state.apiVersion, '1')
    assert.equal(state.startedByUs, true)
    assert.ok(state.createdPaths.some((path) => path.endsWith('start_ai_service.ps1')))
    assert.ok(existsSync(join(installDir, '.dsh-fish-service-install.json')))

    // 命令构造：git clone --depth 1；python -m venv；pip install -e；不出现 torch。
    const commands = run.calls.map((call) => [call.command, ...(call.args || [])].join(' '))
    assert.ok(commands.some((line) => line.includes('git -c http.version=HTTP/1.1 clone --depth 1 --branch main https://github.com/INFIcer/LocalAIService.git')))
    assert.ok(commands.some((line) => line.includes('py -3.13 -m venv')))
    assert.ok(commands.some((line) => line.includes('-m pip install --disable-pip-version-check -e')))
    assert.equal(commands.some((line) => line.includes('torch==')), false)

    // 模型按必需 → 推荐串行 POST，name 与服务端契约一致。
    const downloads = fetchImpl.calls.filter((call) => call.url.endsWith('/admin/models/download'))
    assert.deepEqual(downloads.map((call) => call.body), [
      { capability: 'tts', name: '' },
      { capability: 'speaker', name: '' },
    ])
    assert.equal(status.task.models.completed.includes('tts'), true)
    assert.equal(status.task.models.failed.length, 0)
    assert.equal(fetchImpl.calls[fetchImpl.calls.length - 1].url.endsWith('/admin/models'), true)
  } finally {
    temp.cleanup()
  }
})

test('安装：git clone 失败时回退 codeload zip 解压', async () => {
  const temp = makeTempDir()
  try {
    const installDir = join(temp.dir, 'localai')
    const run = makeRun(installDir, {
      onCall: (spec) => {
        if (spec.command === 'git' && (spec.args || []).includes('clone')) return failResult('Recv failure: Connection was reset')
        if (spec.command === 'tar') {
          const index = spec.args.indexOf('-C')
          const extractDir = spec.args[index + 1]
          writeRepo(join(extractDir, 'LocalAIService-main'))
          return okResult()
        }
        return null
      },
    })
    const fetchImpl = makeFetch(async (request) => {
      const network = networkOk(request)
      if (network) return network
      if (request.url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (request.url.endsWith('/capabilities')) return { status: 200, body: serviceCaps() }
      return { status: 404, body: {} }
    })
    const { installer } = makeInstaller(temp, { run, fetchImpl })
    await installer.start({ installDir, skipEngine: true, models: [] })
    const status = await installer.waitForIdle()
    assert.equal(status.state, 'succeeded', JSON.stringify(status.error))
    const commands = run.calls.map((call) => [call.command, ...(call.args || [])].join(' '))
    assert.ok(commands.some((line) => line.includes('tar -xf')))
    assert.equal(existsSync(join(installDir, '.dsh-code.zip')), false)
    assert.equal(existsSync(join(installDir, '.dsh-extract')), false)
    assert.equal(existsSync(join(installDir, 'start_ai_service.ps1')), true)
  } finally {
    temp.cleanup()
  }
})

test('安装：非 lite 模式安装 torch 时固定使用 cu130 索引', async () => {
  const temp = makeTempDir()
  try {
    const fetchImpl = makeInstallFetch()
    const run = makeRun(join(temp.dir, 'localai'))
    const { installer, installDir } = makeInstaller(temp, { run, fetchImpl })
    await installer.start({ installDir, skipEngine: false, models: [] })
    const status = await installer.waitForIdle()
    assert.equal(status.state, 'succeeded', JSON.stringify(status.error))
    assert.ok(status.steps.some((step) => step.id === 'engine-deps'))
    const torch = run.calls.find((call) => (call.args || []).some((arg) => String(arg).startsWith('torch==')))
    assert.ok(torch)
    assert.ok(torch.args.includes('--index-url'))
    assert.ok(torch.args.includes('https://download.pytorch.org/whl/cu130'))
    const engineInstall = run.calls.find((call) => (call.args || []).includes('funasr'))
    assert.ok(engineInstall)
    assert.ok(engineInstall.args.includes('demucs'))
  } finally {
    temp.cleanup()
  }
})

test('取消：终止子进程、回滚本次创建的文件、状态写 canceled', async () => {
  const temp = makeTempDir()
  try {
    let installerRef = null
    const run = makeRun(join(temp.dir, 'localai'), {
      onCall: (spec) => {
        if ((spec.args || []).includes('venv')) {
          return new Promise((resolve) => {
            spec.signal?.addEventListener?.('abort', () => resolve({ ok: false, code: -1, aborted: true, stdout: '', stderr: '' }), { once: true })
          })
        }
        return null
      },
    })
    const { installer, installDir, home } = makeInstaller(temp, {
      run,
      fetchImpl: makeFetch(async (request) => (networkOk(request) || { status: 200, body: {} })),
    })
    installerRef = installer
    await installer.start({ installDir, skipEngine: true, models: [] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const cancel = installer.cancel()
    assert.equal(cancel.canceled, true)
    const status = await installer.waitForIdle()
    assert.equal(status.state, 'canceled')
    assert.equal(status.error.code, 'canceled')
    assert.equal(existsSync(join(installDir, 'start_ai_service.ps1')), false)
    assert.equal(existsSync(join(installDir, '.dsh-fish-service-install.json')), false)
    const state = readJson(join(home, 'fish-service-install.json'))
    assert.equal(state.status, 'canceled')
    assert.equal(state.lastError.code, 'canceled')
    assert.ok(installerRef)
  } finally {
    temp.cleanup()
  }
})

test('失败回滚：只删本次创建的代码，models 用户数据保留', async () => {
  const temp = makeTempDir()
  try {
    const installDir = join(temp.dir, 'localai')
    const run = makeRun(installDir, {
      onCall: (spec) => {
        if (spec.command === 'git' && (spec.args || []).includes('clone')) {
          writeRepo(installDir, { 'models/keep.txt': 'user-data' })
          return okResult()
        }
        if ((spec.args || []).includes('-e')) return failResult('ERROR: No matching distribution found for fastapi')
        return null
      },
    })
    const fetchImpl = makeFetch(async (request) => networkOk(request) || { status: 200, body: {} })
    const { installer, home } = makeInstaller(temp, { run, fetchImpl })
    await installer.start({ installDir, skipEngine: true, models: [] })
    const status = await installer.waitForIdle()
    assert.equal(status.state, 'failed')
    assert.match(status.error.hint, /核心依赖/)
    assert.equal(existsSync(join(installDir, 'start_ai_service.ps1')), false)
    assert.equal(existsSync(join(installDir, 'src')), false)
    assert.equal(existsSync(join(installDir, 'models', 'keep.txt')), true)
    assert.equal(readFileSync(join(installDir, 'models', 'keep.txt'), 'utf8'), 'user-data')
    const state = readJson(join(home, 'fish-service-install.json'))
    assert.equal(state.status, 'failed')
    assert.equal(state.installMode, 'unknown')
    assert.equal(state.lastError.code, 'upstream_error')
    assert.deepEqual(state.createdPaths, [])
  } finally {
    temp.cleanup()
  }
})

test('安装：目录非空且无安装标记时拒绝，不覆盖文件', async () => {
  const temp = makeTempDir()
  try {
    const installDir = join(temp.dir, 'localai')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'user.txt'), 'keep')
    const run = makeRun(installDir)
    const fetchImpl = makeFetch(async (request) => networkOk(request) || { status: 200, body: {} })
    const { installer } = makeInstaller(temp, { run, fetchImpl })
    await assert.rejects(
      () => installer.start({ installDir, skipEngine: true, models: [] }),
      (error) => error.code === 'bad_request' && /不是空/.test(error.hint),
    )
    assert.equal(readFileSync(join(installDir, 'user.txt'), 'utf8'), 'keep')
  } finally {
    temp.cleanup()
  }
})

test('安装：已有安装标记时拒绝重复安装', async () => {
  const temp = makeTempDir()
  try {
    const installDir = join(temp.dir, 'localai')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, '.dsh-fish-service-install.json'), JSON.stringify({
      version: 1, installMode: 'managed', installDir, serviceVersion: '2.5.1', status: 'installed',
    }))
    const run = makeRun(installDir)
    const fetchImpl = makeFetch(async (request) => networkOk(request) || { status: 200, body: {} })
    const { installer } = makeInstaller(temp, { run, fetchImpl })
    await assert.rejects(
      () => installer.start({ installDir, skipEngine: true, models: [] }),
      (error) => error.code === 'bad_request' && /已经安装|安装记录/.test(error.hint),
    )
  } finally {
    temp.cleanup()
  }
})

// ---------------- 模型与接管 ----------------

test('模型下载：串行轮询进度，完成后按 present 复检', async () => {
  const temp = makeTempDir()
  try {
    const fetchImpl = makeInstallFetch()
    const run = makeRun(join(temp.dir, 'localai'))
    const { installer, installDir } = makeInstaller(temp, { run, fetchImpl })
    const seenPercents = []
    await installer.start({ installDir, skipEngine: true, models: ['tts', 'asr', 'speaker'] })
    // 轮询期间抓总进度，确认模型步骤不是 0 → 100 的突变。
    for (let i = 0; i < 2000 && installer.status().task?.state === 'running'; i += 1) {
      seenPercents.push(installer.status().percent)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const status = await installer.waitForIdle()
    assert.equal(status.state, 'succeeded', JSON.stringify(status.error))
    assert.equal(status.task.models.selected.length, 3)
    assert.equal(status.task.models.failed.length, 0)
    assert.equal(fetchImpl.state.taskPolls.get('task-tts') >= 2, true)
    assert.ok(seenPercents.some((percent) => percent > 0 && percent < 100))
    const posts = fetchImpl.calls.filter((call) => call.url.endsWith('/admin/models/download'))
    // asr 在 /admin/models 里已经是 present，不重复 POST。
    assert.deepEqual(posts.map((call) => call.body.capability), ['tts', 'speaker'])
    assert.equal(status.task.models.completed.includes('asr'), true)
  } finally {
    temp.cleanup()
  }
})

test('模型：服务不可达时返回 ok:false，不抛异常', async () => {
  const temp = makeTempDir()
  try {
    const { installer } = makeInstaller(temp, {
      fetchImpl: makeFetch(async () => undefined),
    })
    const result = await installer.models()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'service_down')
  } finally {
    temp.cleanup()
  }
})

test('接管：识别 localai-service 并写 adopted；不是 localai 时拒绝', async () => {
  const temp = makeTempDir()
  try {
    const fetchImpl = makeFetch(async (request) => {
      if (request.url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (request.url.endsWith('/capabilities')) return { status: 200, body: serviceCaps() }
      if (request.url.endsWith('/admin/system')) return { status: 200, body: { ok: true, paths: { home: 'E:\\LocalAIService' } } }
      return { status: 404, body: {} }
    })
    const { installer, saved } = makeInstaller(temp, { fetchImpl })
    const adopt = await installer.adopt()
    assert.equal(adopt.ok, true)
    assert.equal(adopt.installMode, 'adopted')
    assert.equal(adopt.serviceVersion, '2.5.1')
    assert.equal(saved.config.installMode, 'adopted')
    assert.equal(saved.config.baseUrl, 'http://127.0.0.1:7880')

    const wrong = makeFetch(async (request) => {
      if (request.url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (request.url.endsWith('/capabilities')) {
        return { status: 200, body: { ok: true, api_version: '1', service: { name: 'other-service', version: '1.0.0' } } }
      }
      return { status: 404, body: {} }
    })
    const bad = makeInstaller(temp, { fetchImpl: wrong }).installer
    await assert.rejects(() => bad.adopt(), (error) => error.code === 'service_down')
  } finally {
    temp.cleanup()
  }
})

test('日志：返回文件尾部并按 lines 截断', async () => {
  const temp = makeTempDir()
  try {
    const { installer, home, installDir } = makeInstaller(temp)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'fish-service-install.log'), 'line-1\nline-2\nline-3\n')
    const all = installer.logs({ lines: 200 })
    assert.equal(all.ok, true)
    assert.equal(all.file, join(home, 'fish-service-install.log'))
    assert.deepEqual(all.lines, ['line-1', 'line-2', 'line-3'])
    const one = installer.logs({ lines: 1 })
    assert.deepEqual(one.lines, ['line-3'])
    assert.ok(installDir)
  } finally {
    temp.cleanup()
  }
})

test('service-api：install 对象接上真实安装器，fish_service_status 能带出安装状态', async () => {
  const temp = makeTempDir()
  let stack = null
  try {
    stack = await makeStack({
      handler: basicHandler(),
      installerOptions: {
        run: makeRun(join(temp.dir, 'ai')),
        fetchImpl: makeFetch(async (request) => networkOk(request) || { status: 200, body: {} }),
        probePort: async () => false,
      },
    })
    const status = stack.api.install.status()
    assert.equal(status.ok, true)
    assert.equal(status.state, 'idle')
    assert.equal(status.installMode, 'unknown')
    assert.ok(Array.isArray(status.catalog))
    assert.ok(status.defaultModels.includes('tts'))
    assert.ok(status.logFile.endsWith('fish-service-install.log'))

    const preflight = await stack.api.install.preflight({ installDir: join(temp.dir, 'ai') })
    assert.equal(preflight.ok, true, JSON.stringify(preflight.blockers))
    assert.equal(preflight.python.ok, true)
    assert.equal(preflight.git.ok, true)

    const health = await stack.api.health({ timeoutMs: 1000 })
    assert.equal(health.ok, true)
  } finally {
    await stack?.close()
    temp.cleanup()
  }
})

// ---------------- 宿主路由 ----------------

function setupRoutes(installOverrides = {}) {
  const calls = { preflight: [], start: [], logs: [], cancel: 0, status: 0, adopt: 0 }
  const api = {
    config: {
      get: () => ({ enabled: true, baseUrl: 'http://127.0.0.1:7880', cacheDir: 'C:\\cache' }),
      set: async () => ({ ok: true }),
    },
    voices: async () => [],
    recentErrors: () => [],
    install: {
      status: () => { calls.status += 1; return { ok: true, state: 'idle', steps: [] } },
      preflight: async (opts) => { calls.preflight.push(opts); return { ok: true, blockers: [], warnings: [], seen: opts } },
      start: async (opts) => {
        calls.start.push(opts)
        if (opts.models === 'bad') {
          const error = makeError('bad_request', { hint: '预检失败：没有 Python。' })
          error.blockers = [{ code: 'python_missing', hint: '装 Python' }]
          error.warnings = [{ code: 'gpu_missing', hint: '没有显卡' }]
          throw error
        }
        if (opts.installDir === 'busy') throw makeError('busy', { hint: '已有任务' })
        return { ok: true, taskId: 'task-1', state: 'running' }
      },
      cancel: () => { calls.cancel += 1; return { ok: true, canceled: false, state: 'idle' } },
      logs: (opts) => { calls.logs.push(opts); return { ok: true, lines: ['a', 'b'] } },
      adopt: async () => { calls.adopt += 1; return { ok: true, installMode: 'adopted' } },
      ...installOverrides,
    },
  }
  const configStore = { current: api.config.get(), filePath: 'C:\\x\\config.json', overrides: [] }
  const capabilities = { refresh: async () => ({ ok: true, reachable: true }), current: () => null, status: () => ({}) }
  const cache = { usage: () => ({}) }
  const logger = { recent: () => [], info: () => {}, warn: () => {}, error: () => {} }
  const routes = new Map()
  const ctx = { webServer: { register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) } } }
  registerRoutes({ ctx, api, configStore, capabilities, cache, logger, version: '0.6.2', fetchImpl: null, prefix: '/dsh-fish-service' })
  return { routes, calls }
}

async function callRoute(routes, path, { method = 'GET', body = undefined, headers = {} } = {}) {
  const res = makeRes()
  const handler = routes.get(path.split('?')[0])
  assert.ok(handler, `缺少路由 ${path}`)
  await handler(await makeReq({ method, url: path, body, headers }), res)
  return { status: res.statusCode, body: res.json() }
}

test('路由：install/status、preflight、start、cancel、logs、adopt 的契约', async () => {
  const { routes, calls } = setupRoutes()
  const status = await callRoute(routes, '/dsh-fish-service/install/status')
  assert.equal(status.status, 200)
  assert.equal(status.body.state, 'idle')

  const preflight = await callRoute(routes, '/dsh-fish-service/install/preflight', {
    method: 'POST',
    body: { installDir: 'C:\\AI\\localai' },
  })
  assert.equal(preflight.status, 200)
  assert.deepEqual(calls.preflight[0], { installDir: 'C:\\AI\\localai' })

  const start = await callRoute(routes, '/dsh-fish-service/install/start', {
    method: 'POST',
    body: { installDir: 'C:\\AI\\localai', skipEngine: true, models: ['tts'] },
  })
  assert.equal(start.status, 200)
  assert.equal(start.body.taskId, 'task-1')
  assert.deepEqual(calls.start[0], { installDir: 'C:\\AI\\localai', skipEngine: true, models: ['tts'] })

  const cancel = await callRoute(routes, '/dsh-fish-service/install/cancel', { method: 'POST' })
  assert.equal(cancel.status, 200)
  assert.equal(calls.cancel, 1)

  const logs = await callRoute(routes, '/dsh-fish-service/install/logs?lines=50')
  assert.equal(logs.status, 200)
  assert.deepEqual(calls.logs[0], { lines: 50 })

  const adopt = await callRoute(routes, '/dsh-fish-service/install/adopt', { method: 'POST' })
  assert.equal(adopt.status, 200)
  assert.equal(adopt.body.installMode, 'adopted')
  assert.equal(calls.adopt, 1)
})

test('路由：预检 blocker 回 400 并带 blockers；忙时回 409', async () => {
  const { routes } = setupRoutes()
  const blocked = await callRoute(routes, '/dsh-fish-service/install/start', {
    method: 'POST',
    body: { installDir: 'C:\\AI', models: 'bad' },
  })
  assert.equal(blocked.status, 400)
  assert.equal(blocked.body.code, 'bad_request')
  assert.deepEqual(blocked.body.blockers, [{ code: 'python_missing', hint: '装 Python' }])
  assert.deepEqual(blocked.body.warnings, [{ code: 'gpu_missing', hint: '没有显卡' }])

  const busy = await callRoute(routes, '/dsh-fish-service/install/start', {
    method: 'POST',
    body: { installDir: 'busy' },
  })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.code, 'busy')
})

test('路由：接管不到服务时回 502，并带中文 hint', async () => {
  const { routes } = setupRoutes({
    adopt: async () => { throw makeError('service_down', { hint: '没有找到可接管的本地 AI 服务。' }) },
  })
  const result = await callRoute(routes, '/dsh-fish-service/install/adopt', { method: 'POST' })
  assert.equal(result.status, 502)
  assert.equal(result.body.code, 'service_down')
  assert.match(result.body.hint, /没有找到/)
})

test('路由：install 接口只接受规定的方法和同源请求', async () => {
  const { routes } = setupRoutes()
  const wrongMethod = await callRoute(routes, '/dsh-fish-service/install/start', { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  const crossOrigin = await callRoute(routes, '/dsh-fish-service/install/start', {
    method: 'POST',
    body: {},
    headers: { origin: 'http://evil.example', host: '127.0.0.1:14792' },
  })
  assert.equal(crossOrigin.status, 403)
})
