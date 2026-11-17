// 服务端一键部署（P3 插件侧安装流程）。
//
// 顺序与直觉不同：先启动服务（0 模型），再调服务的 /admin/models/download 下模型。
// 这样进度、互斥与校验都由服务端负责，插件不自己实现下载器。
//
// 依赖全部可注入（fs/spawn/fetch/now/probePort），单测不需要真的跑 git/pip/torch；
// 真实运行时用默认实现。安装任务是进程内单例：同一时刻只允许一个。
//
// 关键取舍：
//   - 只用 7880，不偷偷换端口；端口被别的程序占用时明确要求用户处理；
//   - 模型下载失败不算安装失败（服务仍可用），但状态里如实列出未完成项；
//   - 取消/失败只删本次创建的路径，models/voices/data/outputs/logs/config.json 永远保留。

import * as nodeFs from 'node:fs'
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir, release as osRelease } from 'node:os'
import { dirname, join } from 'node:path'
import net from 'node:net'
import { makeError } from './errors.js'
import {
  CODELOAD_URL,
  DEFAULT_MODEL_CAPABILITIES,
  DEFAULT_PORT,
  DISK_CODE_MB,
  DISK_MARGIN_RATIO,
  DISK_VENV_MB,
  ENGINE_PACKAGES,
  INSTALL_STEPS,
  MIN_DRIVER,
  MIN_SERVICE_VERSION,
  MIN_WINDOWS_BUILD,
  MODEL_CATALOG,
  PRESERVED_NAMES,
  PYTHON_MAX,
  PYTHON_MIN,
  REPO_BRANCH,
  REPO_URL,
  SERVICE_BASE_URL,
  TORCH_INDEX_URL,
  TORCH_SPEC,
  defaultInstallDir,
  driveRootFor,
  globalStatePath,
  installLogPath,
  markerPath,
  selectModelCapabilities,
  selectedModelsMb,
  sortModelCatalog,
  validateInstallDir as installerModValidate,
} from './install-manifest.js'
import { formatCommand, killProcessTree, runProcess, spawnBackground } from './install-process.js'

const HEALTH_TIMEOUT_MS = 120000
const HEALTH_POLL_MS = 2000
const MODEL_POLL_MS = 1000
const MODEL_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_TAIL_DEFAULT = 200
const OUTPUT_TAIL = 600

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const isIso = () => new Date().toISOString()
const mbToGb = (mb) => (Number(mb) / 1024).toFixed(1)

function versionParts(value) {
  const match = String(value == null ? '' : value).match(/\d+(?:\.\d+)*/)
  if (!match) return []
  return match[0].split('.').map((part) => Number(part) || 0)
}

/** 数字点分版本比较；缺的段按 0 处理（591.59 > 580）。 */
export function compareVersion(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

const majorOf = (version) => String(version == null ? '' : version).split('.')[0]

function tailText(text, limit = OUTPUT_TAIL) {
  const value = String(text == null ? '' : text).replace(/\r/g, '').trim()
  if (!value) return ''
  const lines = value.split('\n').filter(Boolean)
  return lines.slice(-4).join(' / ').slice(-limit)
}

function samePath(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function normalizeUrl(value) {
  const text = String(value == null ? '' : value).trim().replace(/\/+$/, '')
  if (!text) return ''
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : ''
  } catch {
    return ''
  }
}

/** 服务端 /admin/models 的某项是否对应目录里的某个模型（capability + name 双重匹配）。 */
function matchesModelItem(model, item) {
  if (String(item?.capability || '').toLowerCase() !== model.capability) return false
  const expected = String(model.name || '').toLowerCase()
  if (!expected) return true
  const actual = String(item?.name || '').toLowerCase()
  return actual === expected || actual.endsWith(`-${expected}`) || actual.includes(expected)
}

function isModelPresent(model, items) {
  return Array.isArray(items) && items.some((item) => matchesModelItem(model, item) && item.present)
}

function defaultProbePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (listening) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已关闭 */ }
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, '127.0.0.1')
    } catch {
      finish(false)
    }
  })
}

/** 后台服务启动器的默认实现（真实 spawn，可被测试替换）。 */
function defaultSpawnBackground(spec, deps) {
  return spawnBackground(spec, { spawnImpl: deps.spawnImpl })
}

export class Installer {
  constructor({
    getConfig = () => ({}),
    saveConfig = async (patch) => patch,
    capabilities = null,
    logger = null,
    fs = nodeFs,
    fetchImpl = globalThis.fetch,
    spawnImpl = nodeSpawn,
    spawnSyncImpl = nodeSpawnSync,
    run = null,
    spawnBackgroundImpl = null,
    killTree = null,
    probePort = null,
    systemVersion = null,
    now = () => Date.now(),
    sleep = sleepDefault,
    platform = process.platform,
    env = process.env,
    homeDir = null,
    random = () => randomUUID(),
  } = {}) {
    this.getConfig = getConfig
    this.saveConfig = saveConfig
    this.capabilities = capabilities
    this.logger = logger
    this.fs = fs === nodeFs ? fs : { ...nodeFs, ...fs }
    this.fetchImpl = fetchImpl
    this.spawnImpl = spawnImpl
    this.spawnSyncImpl = spawnSyncImpl
    this.killTree = killTree || ((pid) => killProcessTree(pid, { platform, spawnSyncImpl }))
    this.run = run || ((spec) => runProcess(spec, { spawnImpl, killTree: this.killTree }))
    this.spawnBackgroundImpl = spawnBackgroundImpl
      || ((spec) => defaultSpawnBackground(spec, { spawnImpl }))
    this.probePort = probePort || defaultProbePort
    this.systemVersion = systemVersion || (() => {
      try { return osRelease() || '' } catch { return '' }
    })
    this.now = now
    this.sleep = sleep
    this.platform = platform
    this.env = env
    this.homeDir = homeDir || env.DSH_HOME || join(homedir(), '.dsh')
    this.random = random
    this.logFile = installLogPath(this.homeDir)

    this.task = null
    this.taskPromise = null
    this.abort = null
    this.pending = false
    this.servicePid = null
    this.venvPython = ''
    this.serviceVersion = ''
    this.logTail = []
    this.logBroken = false
  }

  // ---------------- 状态文件与日志 ----------------

  #readJson(file, fallback = null) {
    try {
      if (!this.fs.existsSync(file)) return fallback
      return JSON.parse(this.fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  #writeJson(file, value) {
    const text = JSON.stringify(value, null, 2)
    try {
      this.fs.mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${this.now()}.tmp`
      this.fs.writeFileSync(temp, text, 'utf8')
      this.fs.renameSync(temp, file)
      return true
    } catch {
      try {
        this.fs.writeFileSync(file, text, 'utf8')
        return true
      } catch {
        return false
      }
    }
  }

  #appendLog(text) {
    const value = String(text == null ? '' : text).replace(/\r/g, '')
    for (const line of value.split('\n')) {
      if (!line) continue
      const stamped = `[${new Date(this.now()).toISOString()}] ${line}`
      this.logTail.push(stamped)
      if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200)
      try {
        if (!this.logBroken) {
          this.fs.mkdirSync(dirname(this.logFile), { recursive: true })
          if (!this.logRotated) {
            this.logRotated = true
            try {
              const size = this.fs.existsSync(this.logFile) ? this.fs.statSync(this.logFile).size : 0
              if (size > LOG_MAX_BYTES) this.fs.renameSync(this.logFile, `${this.logFile}.1`)
            } catch { /* 滚动失败继续追加 */ }
          }
          this.fs.appendFileSync(this.logFile, `${stamped}\n`, 'utf8')
        }
      } catch {
        // 日志写不进去不能影响安装；下一次不再重试，避免每条都抛。
        this.logBroken = true
      }
    }
  }

  // ---------------- 状态查询 ----------------

  status() {
    const config = this.getConfig() || {}
    const stateFile = globalStatePath(this.homeDir)
    const lastState = this.#readJson(stateFile, null)
    const snapshot = this.capabilities?.current?.() || null
    const installDir = this.task?.installDir
      || String(config.installDir || '').trim()
      || defaultInstallDir(this.env, this.homeDir)
    const task = this.task
    return {
      ok: true,
      installMode: config.installMode || 'unknown',
      installDir,
      defaultInstallDir: defaultInstallDir(this.env, this.homeDir),
      state: task?.state || lastState?.status || 'idle',
      phase: task?.phase || '',
      percent: task?.percent ?? 0,
      message: task?.message || '',
      startedAt: task?.startedAt || null,
      finishedAt: task?.finishedAt || null,
      error: task?.error || lastState?.lastError || null,
      // 状态轮询要能直接显示最后几行日志，不必再单独请求 /install/logs。
      logTail: this.logTail.slice(-20),
      steps: task ? task.steps.map((step) => ({ ...step })) : [],
      task: task ? this.#taskSnapshot(task) : null,
      lastState,
      service: {
        baseUrl: config.baseUrl || SERVICE_BASE_URL,
        reachable: Boolean(snapshot?.reachable),
        serviceVersion: snapshot?.serviceVersion || '',
        apiVersion: snapshot?.apiVersion || '',
      },
      catalog: MODEL_CATALOG,
      defaultModels: [...DEFAULT_MODEL_CAPABILITIES],
      logFile: this.logFile,
      stateFile,
    }
  }

  #taskSnapshot(task) {
    return {
      taskId: task.taskId,
      state: task.state,
      phase: task.phase,
      percent: task.percent,
      message: task.message,
      detail: task.detail || '',
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      error: task.error,
      steps: task.steps.map((step) => ({ ...step })),
      options: { ...task.options },
      installDir: task.installDir,
      models: task.models ? JSON.parse(JSON.stringify(task.models)) : null,
      logFile: this.logFile,
    }
  }

  /** 读安装器日志尾部；文件不存在就返回内存里的步骤日志。 */
  logs({ lines = LOG_TAIL_DEFAULT } = {}) {
    const count = Math.max(1, Math.min(1000, Math.trunc(Number(lines)) || LOG_TAIL_DEFAULT))
    let output = []
    try {
      if (this.fs.existsSync(this.logFile)) {
        const size = Number(this.fs.statSync(this.logFile).size) || 0
        const maxBytes = 2 * 1024 * 1024
        if (size <= maxBytes) {
          output = this.fs.readFileSync(this.logFile, 'utf8').split(/\r?\n/)
        } else {
          const fd = this.fs.openSync(this.logFile, 'r')
          try {
            const buffer = Buffer.alloc(maxBytes)
            const read = this.fs.readSync(fd, buffer, 0, maxBytes, size - maxBytes)
            output = buffer.subarray(0, read).toString('utf8').split(/\r?\n/)
            output.shift() // 从中间开始的第一行不完整
          } finally {
            this.fs.closeSync(fd)
          }
        }
      }
    } catch {
      output = []
    }
    const cleaned = output.map((line) => String(line)).filter(Boolean)
    return {
      ok: true,
      file: this.logFile,
      lines: cleaned.slice(-count),
      task: this.task
        ? { taskId: this.task.taskId, state: this.task.state, phase: this.task.phase, message: this.task.message }
        : null,
    }
  }

  // ---------------- 预检 ----------------

  async #probeCommand(command, args, timeoutMs = 5000) {
    try {
      const result = await this.run({ command, args, timeoutMs, signal: null, onLine: null })
      return {
        ok: Boolean(result?.ok),
        code: Number(result?.code ?? -1),
        stdout: String(result?.stdout || ''),
        stderr: String(result?.stderr || ''),
        timedOut: Boolean(result?.timedOut),
      }
    } catch (error) {
      return { ok: false, code: -1, stdout: '', stderr: String(error?.message || error), timedOut: false }
    }
  }

  async #probeGpu() {
    const result = await this.#probeCommand(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
      8000,
    )
    if (!result.ok) return { ok: false, error: tailText(result.stderr) || `nvidia-smi 退出码 ${result.code}` }
    const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || ''
    if (!line) return { ok: false, error: 'nvidia-smi 没有输出' }
    const parts = line.split(',').map((item) => item.trim())
    const totalMb = Number(String(parts[1] || '').replace(/[^\d]/g, '')) || 0
    const driver = parts[2] || ''
    return {
      ok: true,
      name: parts[0] || '',
      totalMb,
      driver,
      driverOk: compareVersion(driver, MIN_DRIVER) >= 0,
      driverRequired: MIN_DRIVER,
    }
  }

  async #probePython() {
    const candidates = [
      { command: 'py', args: ['-3.13'], label: 'py -3.13' },
      { command: 'py', args: ['-3.12'], label: 'py -3.12' },
      { command: 'py', args: ['-3.11'], label: 'py -3.11' },
      { command: 'python', args: [], label: 'python' },
      { command: 'python3', args: [], label: 'python3' },
    ]
    const rejected = []
    for (const candidate of candidates) {
      const result = await this.#probeCommand(
        candidate.command,
        [...candidate.args, '-c', 'import sys;print(sys.version.split()[0])'],
        5000,
      )
      if (!result.ok) continue
      const version = (result.stdout.trim().split(/\s+/)[0] || '')
      if (!version) continue
      // 只比较主次版本：3.13.9 落在 3.11~3.13 区间内，不能拿完整版本号直接比 3.13。
      const parts = versionParts(version)
      const inRange = parts.length >= 2
        && compareVersion(`${parts[0]}.${parts[1]}`, PYTHON_MIN) >= 0
        && compareVersion(`${parts[0]}.${parts[1]}`, PYTHON_MAX) <= 0
      if (inRange) {
        return {
          ok: true,
          command: candidate.command,
          args: [...candidate.args],
          label: candidate.label,
          version,
          rejected,
          detail: '',
        }
      }
      rejected.push({ label: candidate.label, version })
    }
    return {
      ok: false,
      command: '',
      args: [],
      label: '',
      version: '',
      rejected,
      detail: rejected.map((item) => `${item.label}=${item.version}`).join('; '),
    }
  }

  async #probeNetwork() {
    const targets = [
      { name: 'github', url: CODELOAD_URL },
      { name: 'pypi', url: 'https://pypi.org/simple/' },
      { name: 'pytorch', url: TORCH_INDEX_URL },
    ]
    const checked = await Promise.all(targets.map(async (target) => {
      if (!this.fetchImpl) return { name: target.name, ok: false, status: 0, error: '当前运行时没有 fetch' }
      const controller = new AbortController()
      const timer = setTimeout(() => { try { controller.abort() } catch { /* 已结束 */ } }, 5000)
      timer.unref?.()
      try {
        const response = await this.fetchImpl(target.url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: controller.signal,
        })
        const status = Number(response?.status) || 0
        return { name: target.name, ok: status > 0 && status < 500, status, error: '' }
      } catch (error) {
        return { name: target.name, ok: false, status: 0, error: String(error?.message || error) }
      } finally {
        clearTimeout(timer)
      }
    }))
    return { ok: checked.every((item) => item.ok), checked }
  }

  async #probeFfmpeg() {
    const fromEnv = String(this.env.LOCALAI_FFMPEG || '').trim()
    if (fromEnv && this.fs.existsSync(fromEnv)) return { ok: true, path: fromEnv, source: 'env' }
    const result = await this.#probeCommand(this.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], 5000)
    const path = result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || ''
    if (result.ok && path) return { ok: true, path, source: 'path' }
    return { ok: false, path: '', source: '' }
  }

  async #fetchJson(url, timeoutMs, options = {}) {
    if (!this.fetchImpl) return null
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 已结束 */ } }, Math.max(100, timeoutMs))
    timer.unref?.()
    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal })
      const status = Number(response?.status) || 0
      let data = null
      try {
        const text = typeof response?.text === 'function' ? await response.text() : ''
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      return { ok: response?.ok !== false && status > 0 && status < 400, status, data }
    } catch (error) {
      return { ok: false, status: 0, data: null, error }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 探测一个 baseUrl 是否是 localai-service（只看 HTTP，不写任何东西）。 */
  async #probeServiceUrl(baseUrl) {
    const health = await this.#fetchJson(`${baseUrl}/health`, 2000)
    if (!health || health.status !== 200) {
      return { found: false, baseUrl, reachable: false, reason: health ? `HTTP ${health.status || '无响应'}` : '无响应' }
    }
    const caps = await this.#fetchJson(`${baseUrl}/capabilities`, 5000)
    const data = caps?.data || {}
    const serviceName = String(data?.service?.name || '')
    const serviceVersion = String(data?.service?.version || '')
    const apiVersion = data?.api_version != null ? String(data.api_version) : ''
    if (caps?.status !== 200) {
      return { found: false, baseUrl, reachable: true, reason: '能力接口不可用' }
    }
    if (serviceName && serviceName !== 'localai-service') {
      return { found: false, baseUrl, reachable: true, other: true, serviceName, reason: `不是 localai-service（${serviceName}）` }
    }
    if (apiVersion && majorOf(apiVersion) !== '1') {
      return { found: false, baseUrl, reachable: true, incompatible: true, serviceName, serviceVersion, apiVersion, reason: `api_version=${apiVersion}` }
    }
    return {
      found: true,
      baseUrl,
      reachable: true,
      serviceName: serviceName || 'localai-service',
      serviceVersion,
      apiVersion,
    }
  }

  /**
   * 预检：只读检查（唯一副作用是建/删一个写权限探针文件）。
   * @param {{installDir?:string, skipEngine?:boolean, models?:string[]}} options
   */
  async preflight(options = {}) {
    const config = this.getConfig() || {}
    const requested = String(options.installDir || '').trim()
      || String(config.installDir || '').trim()
      || defaultInstallDir(this.env, this.homeDir)
    const skipEngine = options.skipEngine === true
    const capabilitySelection = selectModelCapabilities(options.models)
    const capabilities = capabilitySelection.ok ? capabilitySelection.capabilities : []
    const modelsMb = selectedModelsMb(capabilities)
    const requiredMb = Math.ceil(
      (DISK_CODE_MB + (skipEngine ? 0 : DISK_VENV_MB) + modelsMb) * (1 + DISK_MARGIN_RATIO),
    )

    const blockers = []
    const warnings = []
    const dirCheck = validateInstallDirSafe(requested, this)
    const installDir = dirCheck.path || String(requested)

    const systemVersion = String(this.systemVersion() || '')
    const arch = process.arch === 'x64' ? 'x64' : process.arch
    const os = this.platform === 'win32' ? `Windows-10-${systemVersion || 'unknown'}` : this.platform
    if (this.platform !== 'win32') {
      blockers.push({ code: 'not_supported', hint: '一键安装目前只支持 Windows 10/11 x64。' })
    } else {
      if (arch !== 'x64') {
        blockers.push({ code: 'arch_unsupported', hint: `当前系统架构是 ${arch}，安装器只支持 x64。` })
      }
      const build = Number(systemVersion.split('.')[2]) || 0
      if (systemVersion && build > 0 && build < MIN_WINDOWS_BUILD) {
        blockers.push({
          code: 'windows_too_old',
          hint: `Windows 版本过旧（${systemVersion}），需要 10.0.${MIN_WINDOWS_BUILD} 或更高。请先更新系统。`,
        })
      } else if (!systemVersion) {
        warnings.push({ code: 'windows_version_unknown', hint: '无法读取 Windows 版本号，跳过版本检查。' })
      }
    }
    if (!dirCheck.ok) {
      blockers.push({ code: dirCheck.code || 'invalid_install_dir', hint: dirCheck.hint })
    }

    // 磁盘空间：按「代码 + venv + 所选模型 + 10%」估算。
    let disk = null
    if (installDir) {
      const drive = driveRootFor(installDir)
      try {
        if (!drive) throw new Error('不是本机盘符路径')
        if (typeof this.fs.statfsSync !== 'function') throw new Error('当前 Node 不支持 statfs')
        const info = this.fs.statfsSync(drive)
        const freeMb = Math.floor((Number(info.bavail) * Number(info.bsize)) / (1024 * 1024))
        disk = { drive, freeMb, requiredMb, modelsMb, venvMb: skipEngine ? 0 : DISK_VENV_MB, skipEngine }
        if (freeMb < requiredMb) {
          blockers.push({
            code: 'disk_space',
            hint: `安装目录所在 ${drive} 盘剩余 ${mbToGb(freeMb)}GB，至少需要 ${mbToGb(requiredMb)}GB（代码 50MB + 虚拟环境 ${skipEngine ? '0' : '7GB'} + 模型 ${mbToGb(modelsMb)}GB + 10% 余量）。请清理磁盘或换一个分区。`,
            detail: `free=${freeMb}MB required=${requiredMb}MB`,
          })
        }
      } catch (error) {
        warnings.push({
          code: 'disk_unreadable',
          hint: `无法读取安装目录的磁盘剩余空间（${String(error?.message || error)}），请自行确认至少有 ${mbToGb(requiredMb)}GB。`,
        })
      }
    }

    // GPU：没有 NVIDIA 时允许 lite；只比较驱动，不装驱动。
    const gpuProbe = await this.#probeGpu()
    const gpu = gpuProbe.ok
      ? {
          name: gpuProbe.name,
          totalMb: gpuProbe.totalMb,
          driver: gpuProbe.driver,
          ok: true,
          driverOk: gpuProbe.driverOk,
          driverRequired: MIN_DRIVER,
        }
      : null
    if (!gpu) {
      warnings.push({
        code: 'gpu_missing',
        hint: `未检测到可用的 NVIDIA 显卡（${gpuProbe.error || 'nvidia-smi 不可用'}）。可以安装 lite 模式（仅翻译/下载/媒体），TTS/ASR/视觉/人声分离不可用。`,
      })
    } else if (!gpu.driverOk) {
      warnings.push({
        code: 'driver_old',
        hint: `显卡驱动 ${gpu.driver} 低于建议版本 ${MIN_DRIVER}。请到 https://www.nvidia.com/Download/index.aspx 手动更新驱动（安装器不会自动安装驱动）。`,
      })
    }

    // 端口 7880：被 localai 占用可接管；被别的程序占用是 blocker。
    const port = { port: DEFAULT_PORT, listening: false, owner: null }
    let portListening = false
    try {
      portListening = Boolean(await this.probePort(DEFAULT_PORT, 800))
    } catch (error) {
      warnings.push({ code: 'port_probe_failed', hint: `无法检查 7880 端口（${String(error?.message || error)}）。` })
    }
    port.listening = portListening
    let liveService = null
    if (portListening) {
      liveService = await this.#probeServiceUrl(SERVICE_BASE_URL)
      if (liveService.found) {
        port.owner = { kind: 'localai', ...liveService }
        warnings.push({
          code: 'service_running',
          hint: `7880 上已经有本地 AI 服务在运行（版本 ${liveService.serviceVersion || '未知'}），无需重复安装；可以在设置页点「接管已有服务」。`,
        })
      } else {
        port.owner = { kind: 'other', reason: liveService.reason || '' }
        blockers.push({
          code: 'port_busy',
          hint: '7880 端口被其它程序占用。安装器固定使用 7880；请关闭该程序，或先接管已有的本地 AI 服务。',
        })
      }
    } else {
      const configured = normalizeUrl(config.baseUrl)
      if (configured && configured !== SERVICE_BASE_URL) {
        const probe = await this.#probeServiceUrl(configured)
        if (probe.found) {
          liveService = probe
          warnings.push({
            code: 'service_running_elsewhere',
            hint: `检测到已配置的 ${configured} 上有本地 AI 服务在运行（版本 ${probe.serviceVersion || '未知'}）。如需统一管理，请使用「接管已有服务」。`,
          })
        }
      }
    }

    // 已有安装标记：全局状态 + 目录内标记，互相校验。
    const globalState = this.#readJson(globalStatePath(this.homeDir), null)
    const localMarker = dirCheck.ok ? this.#readJson(markerPath(installDir), null) : null
    const existingFound = Boolean(globalState || localMarker)
    const existingDirs = [globalState?.installDir, localMarker?.installDir].filter(Boolean)
    const consistent = existingDirs.every((dir) => samePath(dir, installDir))
    if (globalState && localMarker && !consistent) {
      warnings.push({
        code: 'install_state_mismatch',
        hint: `全局安装记录（${globalState.installDir || '未知'}）与目录内标记（${localMarker.installDir || '未知'}）不一致，安装器不会覆盖任何一方，请手动确认。`,
      })
    }
    if (existingFound && consistent) {
      const version = globalState?.serviceVersion || localMarker?.serviceVersion || ''
      warnings.push({
        code: 'already_installed',
        hint: `${installDir} 已有本插件的安装记录${version ? `（服务版本 ${version}）` : ''}。重装前请先删除标记文件：${dirCheck.ok ? markerPath(installDir) : '安装目录下的 .dsh-fish-service-install.json'}。`,
      })
    }
    const existing = {
      found: existingFound,
      consistent: existingDirs.length ? consistent : true,
      installDir: globalState?.installDir || localMarker?.installDir || '',
      serviceVersion: globalState?.serviceVersion || localMarker?.serviceVersion || '',
      status: globalState?.status || localMarker?.status || '',
      global: globalState,
      marker: localMarker,
      live: liveService?.found ? liveService : null,
      mode: liveService?.found ? 'adoptable' : (existingFound ? 'installed' : 'not_installed'),
    }

    // git：没有也能装（回退 zip），只给 warning。
    const gitProbe = await this.#probeCommand('git', ['--version'], 5000)
    const git = gitProbe.ok
      ? { ok: true, version: gitProbe.stdout.trim(), path: 'git' }
      : { ok: false, version: '', path: '' }
    if (!git.ok) {
      warnings.push({
        code: 'git_missing',
        hint: '未找到 git，将改用 zip 下载服务端代码；如果下载也失败，请安装 Git for Windows（https://git-scm.com/download/win）后重试。',
      })
    }

    // Python：只认 3.11~3.13；都没有是 blocker（uv 引导尚未实现）。
    const python = await this.#probePython()
    if (!python.ok) {
      const rejected = python.rejected.length
        ? `（已找到：${python.detail}，版本不在 3.11~3.13）`
        : ''
      blockers.push({
        code: 'python_missing',
        hint: `没有找到可用的 Python 3.11~3.13${rejected}。请安装 Python 3.13（安装时勾选 Add python.exe to PATH，https://www.python.org/downloads/）后重试；uv 自动引导将在后续版本支持。`,
        detail: python.detail,
      })
    }

    const network = await this.#probeNetwork()
    if (!network.ok) {
      const failed = network.checked.filter((item) => !item.ok).map((item) => item.name).join('、')
      warnings.push({
        code: 'network_unreachable',
        hint: `网络检查失败（${failed} 不可达）。首次安装需要联网下载代码与依赖；请检查代理/防火墙，或稍后用离线包安装。`,
      })
    }

    const ffmpegProbe = await this.#probeFfmpeg()
    if (!ffmpegProbe.ok) {
      warnings.push({
        code: 'ffmpeg_missing',
        hint: '未找到 ffmpeg：视频关键帧/媒体工具会不可用。可以安装 ffmpeg 并加入 PATH，或把 LOCALAI_FFMPEG 指向 ffmpeg.exe。',
      })
    }

    // 写权限：在目标目录建临时文件再删；失败 blocker（不删除任何已有文件）。
    if (dirCheck.ok) {
      const existedBefore = this.fs.existsSync(installDir)
      try {
        this.fs.mkdirSync(installDir, { recursive: true })
        const probe = join(installDir, `.dsh-write-${process.pid}-${this.now()}.tmp`)
        this.fs.writeFileSync(probe, 'ok', 'utf8')
        this.fs.rmSync(probe, { force: true })
        if (!existedBefore) {
          try {
            if (!this.fs.readdirSync(installDir).length) this.fs.rmdirSync(installDir)
          } catch { /* 删不掉就留着空目录 */ }
        }
      } catch (error) {
        blockers.push({
          code: 'dir_not_writable',
          hint: `安装目录不可写（${String(error?.message || error)}）。请换一个当前用户有权限的目录，例如 %LOCALAPPDATA%\\localai-service。`,
        })
      }
    }

    return {
      ok: blockers.length === 0,
      checkedAt: isIso(),
      os,
      osVersion: systemVersion,
      arch,
      installDir,
      dir: { ok: dirCheck.ok, path: installDir, hint: dirCheck.hint || '' },
      disk,
      gpu,
      port,
      existing,
      python,
      git,
      network,
      ffmpeg: { ok: ffmpegProbe.ok, path: ffmpegProbe.path, source: ffmpegProbe.source || '' },
      blockers,
      warnings,
      requiredMb,
      modelsMb,
      skipEngine,
      models: capabilities,
    }
  }

  // ---------------- 安装任务 ----------------

  async start(options = {}) {
    if (this.pending || this.task?.state === 'running') {
      throw makeError('busy', {
        detail: 'install_task_running',
        hint: '已经有一个安装任务在运行，请等待完成或先取消。',
      })
    }
    this.pending = true
    try {
      if (this.platform !== 'win32') {
        throw makeError('not_supported', { hint: '一键安装目前只支持 Windows x64。' })
      }
      const config = this.getConfig() || {}
      const requested = String(options.installDir || '').trim()
        || String(config.installDir || '').trim()
        || defaultInstallDir(this.env, this.homeDir)
      const dirCheck = validateInstallDirSafe(requested, this)
      if (!dirCheck.ok) {
        throw makeError('bad_request', { detail: dirCheck.code, hint: dirCheck.hint })
      }
      const installDir = dirCheck.path
      const selection = selectModelCapabilities(options.models)
      if (!selection.ok) {
        throw makeError('bad_request', { detail: selection.unknown.join(','), hint: selection.hint })
      }
      const skipEngine = options.skipEngine === true

      // 预检放在任务开始之前：blocker 时连目录都不建。
      const pre = await this.preflight({
        installDir,
        skipEngine,
        models: selection.capabilities,
      })
      if (!pre.ok) {
        const error = makeError('bad_request', {
          detail: pre.blockers.map((item) => item.code).join(','),
          hint: pre.blockers[0]?.hint || '预检未通过。',
        })
        error.blockers = pre.blockers
        error.warnings = pre.warnings
        throw error
      }
      if (pre.existing?.found) {
        throw makeError('bad_request', {
          detail: 'already_installed',
          hint: pre.existing.status === 'installing'
            ? `${installDir} 里有一次未完成的安装记录。请先删除 ${markerPath(installDir)} 并清空该目录后重试。`
            : `${installDir} 已经安装过。要重新安装，请先删除 ${markerPath(installDir)} 并清空代码目录；models/voices/data 会保留。`,
        })
      }
      if (pre.port?.owner?.kind === 'localai') {
        throw makeError('bad_request', {
          detail: 'service_running',
          hint: '7880 上已经有本地 AI 服务在运行，请使用「接管已有服务」，不要重复安装。',
        })
      }

      // 目录非空且没有安装标记：绝不覆盖。
      let entries = []
      try {
        if (this.fs.existsSync(installDir)) entries = this.fs.readdirSync(installDir)
      } catch (error) {
        throw makeError('bad_request', {
          detail: String(error?.message || error),
          hint: `无法读取安装目录 ${installDir}，请检查权限。`,
        })
      }
      if (entries.length) {
        throw makeError('bad_request', {
          detail: 'directory_not_empty',
          hint: `目录 ${installDir} 不是空的，而且没有本插件的安装记录。安装器不会覆盖已有文件，请换一个空目录。`,
        })
      }

      const createdRoot = !this.fs.existsSync(installDir)
      try {
        this.fs.mkdirSync(installDir, { recursive: true })
      } catch (error) {
        throw makeError('bad_request', {
          detail: String(error?.message || error),
          hint: `无法创建安装目录 ${installDir}，请检查权限。`,
        })
      }

      const steps = INSTALL_STEPS
        .filter((step) => {
          if (step.id === 'engine-deps' && skipEngine) return false
          if (step.id === 'models' && !selection.capabilities.length) return false
          return true
        })
        .map((step) => ({
          id: step.id,
          title: step.title,
          estimate: step.estimate,
          weight: step.weight,
          status: 'pending',
          percent: 0,
          message: '',
          detail: '',
          startedAt: null,
          finishedAt: null,
        }))

      this.task = {
        taskId: this.random().replace(/-/g, '').slice(0, 12),
        state: 'running',
        phase: 'preflight',
        percent: 0,
        message: '准备安装',
        detail: '',
        startedAt: isIso(),
        finishedAt: null,
        error: null,
        installDir,
        createdRoot,
        createdPaths: [],
        startedByUs: false,
        steps,
        options: {
          installDir,
          skipEngine,
          models: [...selection.capabilities],
        },
        models: null,
      }
      this.serviceVersion = ''
      this.venvPython = ''
      this.#appendLog(`开始安装：目录=${installDir}，lite=${skipEngine}，模型=[${selection.capabilities.join(',')}]`)
      const task = this.task
      const context = {
        installDir,
        skipEngine,
        selected: selection,
        preflight: pre,
        createdRoot,
      }
      this.taskPromise = this.#runTask(task, context)
      return { ok: true, taskId: task.taskId, state: 'running', steps: task.steps.map((s) => ({ ...s })) }
    } finally {
      this.pending = false
    }
  }

  #stepById(id) {
    return this.task?.steps.find((step) => step.id === id) || null
  }

  #totalWeight() {
    return (this.task?.steps || []).reduce((sum, step) => sum + (Number(step.weight) || 0), 0) || 1
  }

  #refreshPercent() {
    const task = this.task
    if (!task) return
    const total = this.#totalWeight()
    let done = 0
    let running = 0
    for (const step of task.steps) {
      if (step.status === 'done' || step.status === 'skipped') done += step.weight
      else if (step.status === 'running') running += step.weight * (Math.max(0, Math.min(100, step.percent)) / 100)
    }
    task.percent = Math.max(0, Math.min(100, Math.round(((done + running) / total) * 100)))
  }

  #beginStep(id, message, detail = '') {
    const step = this.#stepById(id)
    if (!step) return
    step.status = 'running'
    step.startedAt = isIso()
    step.message = message
    step.detail = detail
    step.percent = 0
    this.task.phase = id
    this.task.message = message
    this.task.detail = detail
    this.#refreshPercent()
    this.#appendLog(`步骤 ${id}：${message}`)
  }

  #progressStep(id, percent, message) {
    const step = this.#stepById(id)
    if (!step) return
    step.percent = Math.max(0, Math.min(100, Math.round(percent)))
    if (message) {
      step.message = message
      this.task.message = message
    }
    this.#refreshPercent()
  }

  #endStep(id, status, message = '') {
    const step = this.#stepById(id)
    if (!step) return
    step.status = status
    if (status === 'done') step.percent = 100
    if (message) {
      step.message = message
      this.task.message = message
    }
    step.finishedAt = isIso()
    this.#refreshPercent()
  }

  #ensureNotCanceled() {
    if (this.abort?.signal?.aborted) {
      throw makeError('canceled', { detail: 'install_canceled', hint: '安装已取消。' })
    }
  }

  async #runCommand(spec, { hint = '', stepId = '' } = {}) {
    this.#ensureNotCanceled()
    this.#appendLog(`$ ${formatCommand(spec.command, spec.args || [])}`)
    const result = await this.run({
      ...spec,
      signal: this.abort?.signal || null,
      onLine: (stream, line) => {
        this.#appendLog(`${stream === 'err' ? '!' : ' '} ${line}`)
      },
    })
    if (result?.aborted || this.abort?.signal?.aborted) {
      throw makeError('canceled', { detail: 'install_canceled', hint: '安装已取消。' })
    }
    if (!result?.ok) {
      const detail = tailText(result?.stderr) || tailText(result?.stdout) || `exit ${result?.code}`
      throw makeError('upstream_error', {
        detail: `${stepId ? `${stepId}: ` : ''}${detail}`,
        hint: hint || '命令执行失败，请查看安装日志。',
      })
    }
    return result
  }

  async #runTask(task, context) {
    this.abort = new AbortController()
    try {
      this.#beginStep('preflight', '环境检查通过')
      const warningCount = context.preflight.warnings?.length || 0
      this.#endStep('preflight', 'done', warningCount
        ? `环境检查通过（${warningCount} 条提醒，不影响安装）`
        : '环境检查通过')

      await this.#fetchCode(task, context)
      await this.#createVenv(task, context)
      await this.#installCore(task, context)
      if (!context.skipEngine) await this.#installEngine(task, context)
      await this.#startService(task, context)
      await this.#verifyService(task, context)
      await this.#saveConfig(task, context)
      if (context.selected.capabilities.length) {
        try {
          await this.#downloadModels(task, context)
        } catch (error) {
          if (error?.code === 'canceled' || this.abort?.signal?.aborted) throw error
          this.#endStep('models', 'failed', error?.hint || '模型下载失败，服务仍可运行，但对应能力不可用。')
          task.models = {
            ...(task.models || { selected: [...context.selected.capabilities] }),
            completed: task.models?.completed || [],
            failed: task.models?.failed || [],
            error: { code: error?.code || 'upstream_error', hint: error?.hint || '模型下载失败。', detail: String(error?.detail || '') },
          }
          this.#appendLog(`模型步骤失败：${error?.detail || error?.message || error}`)
        }
      } else {
        task.models = { selected: [], completed: [], failed: [], skipped: true }
      }

      const missing = task.models?.failed?.length || 0
      task.state = 'succeeded'
      task.phase = 'done'
      task.percent = 100
      task.message = missing
        ? `安装完成，但有 ${missing} 项模型未下载；服务已可启动，对应能力暂不可用。`
        : '安装完成：服务已启动，插件已切换到该服务。'
      task.finishedAt = isIso()
      this.#writeState(task, 'installed')
      this.#appendLog(task.message)
    } catch (error) {
      const canceled = this.abort?.signal?.aborted || error?.code === 'canceled' || error?.name === 'AbortError'
      task.state = canceled ? 'canceled' : 'failed'
      task.error = {
        code: canceled ? 'canceled' : (error?.code || 'upstream_error'),
        hint: canceled ? '安装已取消，已清理本次创建的文件。' : (error?.hint || '安装失败，请查看安装日志。'),
        detail: String(error?.detail || error?.message || ''),
      }
      task.message = task.error.hint
      const running = task.steps.find((step) => step.status === 'running')
      if (running) {
        running.status = 'failed'
        running.message = task.error.hint
        running.finishedAt = isIso()
      }
      task.phase = 'rollback'
      this.#appendLog(`安装${canceled ? '已取消' : '失败'}：${task.error.code} ${task.error.detail}`)
      await this.#rollback(task)
      task.phase = 'failed'
      task.finishedAt = isIso()
      this.#writeState(task, canceled ? 'canceled' : 'failed')
      task.percent = task.percent || 0
    } finally {
      this.abort = null
      if (task.state !== 'succeeded') this.servicePid = null
    }
  }

  // ---------------- 各步骤 ----------------

  async #fetchCode(task, context) {
    const dir = context.installDir
    this.#beginStep('fetch-code', '下载服务端代码', REPO_URL)
    const before = new Set()
    try {
      for (const name of this.fs.readdirSync(dir)) before.add(name)
    } catch { /* 目录刚建，读不到就当空 */ }

    let cloned = false
    if (context.preflight.git?.ok) {
      const clone = await this.run({
        command: 'git',
        // 部分网络下 git 的 HTTP/2 会被重置；HTTP/1.1 实测更稳，不影响功能。
        args: ['-c', 'http.version=HTTP/1.1', 'clone', '--depth', '1', '--branch', REPO_BRANCH, REPO_URL, dir],
        cwd: dirname(dir),
        timeoutMs: 300000,
        signal: this.abort?.signal || null,
        onLine: (stream, line) => this.#appendLog(`${stream === 'err' ? '!' : ' '} ${line}`),
      })
      if (clone?.aborted || this.abort?.signal?.aborted) {
        throw makeError('canceled', { detail: 'install_canceled', hint: '安装已取消。' })
      }
      cloned = Boolean(clone?.ok) && this.fs.existsSync(join(dir, 'start_ai_service.ps1'))
      if (!cloned) {
        this.#appendLog(`git clone 失败（exit ${clone?.code}）：${tailText(clone?.stderr) || '无输出'}，改用 zip 下载`)
      }
    } else {
      this.#appendLog('git 不可用，改用 zip 下载')
    }

    if (!cloned) {
      this.#cleanNewEntries(dir, before)
      await this.#downloadZip(dir)
    }

    if (!this.fs.existsSync(join(dir, 'start_ai_service.ps1')) || !this.fs.existsSync(join(dir, 'pyproject.toml'))) {
      throw makeError('upstream_error', {
        detail: 'code_incomplete',
        hint: '服务端代码下载不完整（缺少 start_ai_service.ps1 或 pyproject.toml）。请检查网络/代理后重试。',
      })
    }

    this.#recordCreatedPaths(task, dir, before)
    this.#endStep('fetch-code', 'done', '服务端代码已就绪')
  }

  #cleanNewEntries(dir, before) {
    let entries = []
    try { entries = this.fs.readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (before.has(name) || PRESERVED_NAMES.includes(name)) continue
      try { this.fs.rmSync(join(dir, name), { recursive: true, force: true }) } catch { /* 尽力清理 */ }
    }
  }

  #recordCreatedPaths(task, dir, before) {
    let entries = []
    try { entries = this.fs.readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (before.has(name) || PRESERVED_NAMES.includes(name)) continue
      const full = join(dir, name)
      if (!task.createdPaths.some((item) => samePath(item, full))) task.createdPaths.push(full)
    }
  }

  async #downloadZip(dir) {
    this.#appendLog(`下载备用代码包：${CODELOAD_URL}`)
    if (!this.fetchImpl) {
      throw makeError('upstream_error', {
        detail: 'fetch_unavailable',
        hint: '当前运行时没有 fetch，无法下载服务端代码。请安装 Git 后重试。',
      })
    }
    const response = await this.fetchImpl(CODELOAD_URL, {
      redirect: 'follow',
      signal: this.abort?.signal || null,
    })
    if (!response || response.ok === false) {
      throw makeError('upstream_error', {
        detail: `HTTP ${response?.status || 0}`,
        hint: '下载服务端代码失败（git 与备用 zip 都不可用）。请检查网络/代理，或安装 Git for Windows 后重试。',
      })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) {
      throw makeError('upstream_error', {
        detail: 'empty_zip',
        hint: '下载到的代码包是空的，请检查网络后重试。',
      })
    }
    const zipPath = join(dir, '.dsh-code.zip')
    const extractDir = join(dir, '.dsh-extract')
    this.fs.writeFileSync(zipPath, buffer)
    this.fs.mkdirSync(extractDir, { recursive: true })
    this.#appendLog(`代码包 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，正在解压`)
    const tar = await this.run({
      command: 'tar',
      args: ['-xf', zipPath, '-C', extractDir],
      timeoutMs: 120000,
      signal: this.abort?.signal || null,
      onLine: (stream, line) => this.#appendLog(`${stream === 'err' ? '!' : ' '} ${line}`),
    })
    if (!tar?.ok) {
      const quote = (value) => String(value).replace(/'/g, "''")
      const command = `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(extractDir)}' -Force`
      const powershell = await this.#runCommand({
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        timeoutMs: 120000,
      }, {
        hint: '解压服务端代码失败。请安装 Git for Windows 后重试，或手动解压代码包。',
      })
      if (!powershell?.ok) {
        throw makeError('upstream_error', {
          detail: 'unzip_failed',
          hint: '解压服务端代码失败（tar 与 PowerShell 都不可用）。请安装 Git for Windows 后重试。',
        })
      }
    }
    // codeload zip 有一个顶层目录；把它里面的内容搬到安装目录。
    let entries = []
    try { entries = this.fs.readdirSync(extractDir) } catch { entries = [] }
    let source = extractDir
    if (entries.length === 1) {
      const only = join(extractDir, entries[0])
      try {
        if (this.fs.statSync(only).isDirectory()) source = only
      } catch { /* 不是目录就按原样搬 */ }
    }
    for (const name of this.fs.readdirSync(source)) {
      const from = join(source, name)
      const to = join(dir, name)
      if (this.fs.existsSync(to)) {
        this.fs.rmSync(to, { recursive: true, force: true })
      }
      this.fs.renameSync(from, to)
    }
    try { this.fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
    try { this.fs.rmSync(zipPath, { force: true }) } catch { /* 尽力清理 */ }
  }

  async #createVenv(task, context) {
    this.#beginStep('venv', '创建虚拟环境', 'python -m venv engine\\.venv')
    const venvDir = join(context.installDir, 'engine', '.venv')
    await this.#runCommand({
      command: context.preflight.python.command,
      args: [...(context.preflight.python.args || []), '-m', 'venv', venvDir],
      cwd: context.installDir,
      timeoutMs: 300000,
    }, {
      stepId: 'venv',
      hint: `创建虚拟环境失败。请确认 Python ${context.preflight.python.version} 可用，并换一个不含特殊字符的目录后重试。`,
    })
    const pythonExe = join(venvDir, 'Scripts', 'python.exe')
    if (!this.fs.existsSync(pythonExe)) {
      throw makeError('upstream_error', {
        detail: 'venv_python_missing',
        hint: `虚拟环境没有生成 ${pythonExe}。请检查 Python 安装是否完整（需要 venv 模块）。`,
      })
    }
    this.venvPython = pythonExe
    if (!task.createdPaths.some((item) => samePath(item, venvDir))) task.createdPaths.push(venvDir)
    this.#endStep('venv', 'done', '虚拟环境已创建')
  }

  async #installCore(task, context) {
    this.#beginStep('pip-core', '安装核心依赖', 'pip install -e <installDir>')
    await this.#runCommand({
      command: this.venvPython,
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', '-U', 'pip', 'setuptools', 'wheel'],
      cwd: context.installDir,
      timeoutMs: 900000,
    }, {
      stepId: 'pip-core',
      hint: '升级 pip/setuptools 失败。请检查网络、代理或 PyPI 镜像设置，然后重试。',
    })
    this.#progressStep('pip-core', 10, '正在安装核心依赖（几百 MB）…')
    await this.#runCommand({
      command: this.venvPython,
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', '-e', context.installDir],
      cwd: context.installDir,
      timeoutMs: 1800000,
    }, {
      stepId: 'pip-core',
      hint: `安装核心依赖失败。请检查网络与 PyPI 镜像；详细输出见 ${this.logFile}。`,
    })
    this.#endStep('pip-core', 'done', '核心依赖已安装')
  }

  async #installEngine(task, context) {
    this.#beginStep('engine-deps', '安装引擎依赖（torch 等）', `torch 使用 ${TORCH_INDEX_URL}`)
    await this.#runCommand({
      command: this.venvPython,
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', TORCH_SPEC, '--index-url', TORCH_INDEX_URL],
      cwd: context.installDir,
      timeoutMs: 3600000,
    }, {
      stepId: 'engine-deps',
      hint: '安装 torch 失败（约 6.5GB）。请检查网络与磁盘；也可以改用 lite 模式跳过引擎依赖。',
    })
    this.#progressStep('engine-deps', 70, 'torch 已安装，正在安装其余引擎依赖…')
    await this.#runCommand({
      command: this.venvPython,
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', ...ENGINE_PACKAGES],
      cwd: context.installDir,
      timeoutMs: 3600000,
    }, {
      stepId: 'engine-deps',
      hint: '安装引擎依赖失败。可以稍后重试，或勾选 lite 模式跳过（TTS/ASR/视觉/分离将不可用）。',
    })
    this.#endStep('engine-deps', 'done', '引擎依赖已安装')
  }

  async #startService(task, context) {
    this.#beginStep('start', '启动服务（0 模型）', 'GET /health → HTTP 200')
    const script = join(context.installDir, 'start_ai_service.ps1')
    if (!this.fs.existsSync(script)) {
      throw makeError('upstream_error', {
        detail: 'start_script_missing',
        hint: `安装目录缺少启动脚本 ${script}，代码可能不完整，请重试。`,
      })
    }
    let child
    try {
      child = this.spawnBackgroundImpl({
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        cwd: context.installDir,
        env: { ...this.env },
      })
    } catch (error) {
      throw makeError('upstream_error', {
        detail: String(error?.message || error),
        hint: '启动服务失败：无法创建 PowerShell 进程。请检查系统权限后重试。',
      })
    }
    this.servicePid = Number(child?.pid) || 0
    task.startedByUs = Boolean(this.servicePid)
    this.#appendLog(`后台启动服务（pid ${this.servicePid || '未知'}）`)

    const started = this.now()
    let lastStatus = 0
    let healthy = false
    for (;;) {
      this.#ensureNotCanceled()
      const health = await this.#fetchJson(`${SERVICE_BASE_URL}/health`, 2000)
      if (health?.status === 200) {
        healthy = true
        break
      }
      lastStatus = health?.status || 0
      const elapsed = this.now() - started
      if (elapsed >= HEALTH_TIMEOUT_MS) break
      this.#progressStep('start', Math.min(95, Math.round((elapsed / HEALTH_TIMEOUT_MS) * 100)),
        `等待服务就绪（${lastStatus ? `HTTP ${lastStatus}` : '端口未响应'}）…`)
      await this.sleep(HEALTH_POLL_MS)
    }
    if (!healthy) {
      throw makeError('upstream_error', {
        detail: `health_timeout last_status=${lastStatus}`,
        hint: `服务在 120 秒内没有返回 HTTP 200。请查看 ${join(context.installDir, 'logs', 'service.err.log')} 与 ${this.logFile}；常见原因是 7880 被占用、路径含特殊字符或依赖未装完。`,
      })
    }
    this.#endStep('start', 'done', '服务已启动（HTTP 200）')
  }

  async #verifyService(task, context) {
    this.#beginStep('verify', '校验服务能力', 'GET /capabilities → api_version=1')
    const response = await this.#fetchJson(`${SERVICE_BASE_URL}/capabilities`, 5000)
    if (!response || response.status !== 200 || !response.data) {
      throw makeError('upstream_error', {
        detail: `capabilities HTTP ${response?.status || 0}`,
        hint: '服务启动了，但能力接口不可用。请查看服务日志，确认使用的是 localai-service 2.5.x。',
      })
    }
    const apiVersion = response.data.api_version != null ? String(response.data.api_version) : ''
    if (majorOf(apiVersion) !== '1') {
      throw makeError('api_incompatible', {
        detail: `api_version=${apiVersion || '?'}`,
        hint: `服务返回的 api_version=${apiVersion || '?'}，插件只支持 1.x。请更新插件或服务端后重试。`,
      })
    }
    this.serviceVersion = String(response.data?.service?.version || '')
    this.#endStep('verify', 'done', `服务版本 ${this.serviceVersion || '未知'}，契约 api_version=1`)
  }

  async #saveConfig(task, context) {
    this.#beginStep('save-config', '保存插件设置', `baseUrl=${SERVICE_BASE_URL}`)
    try {
      await this.saveConfig({
        baseUrl: SERVICE_BASE_URL,
        installMode: 'managed',
        installDir: context.installDir,
      })
    } catch (error) {
      throw makeError('upstream_error', {
        detail: String(error?.message || error),
        hint: '服务已启动，但保存插件配置失败。请检查配置文件权限，然后到设置页手动填写服务地址。',
      })
    }
    try { this.capabilities?.invalidate?.() } catch { /* 缓存失效失败不影响 */ }
    try {
      await this.capabilities?.refresh?.({ force: true, timeoutMs: 3000 })
    } catch { /* 刷新失败下一次轮询会自己重试 */ }
    this.#endStep('save-config', 'done', '插件已切换到新服务')
  }

  // ---------------- 模型下载 ----------------

  async #serviceRequest(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    if (!this.fetchImpl) return { ok: false, status: 0, data: null, error: new Error('fetch 不可用') }
    const headers = {}
    const token = String(this.getConfig()?.token || '')
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 已结束 */ } }, Math.max(100, timeoutMs))
    timer.unref?.()
    try {
      const response = await this.fetchImpl(`${SERVICE_BASE_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const status = Number(response?.status) || 0
      let data = null
      try {
        const text = typeof response?.text === 'function' ? await response.text() : ''
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      return { ok: response?.ok !== false && status > 0 && status < 400, status, data }
    } catch (error) {
      return { ok: false, status: 0, data: null, error }
    } finally {
      clearTimeout(timer)
    }
  }

  async #downloadModels(task, context) {
    this.#beginStep('models', '读取模型清单', 'GET /admin/models')
    const catalog = new Map(sortModelCatalog().map((item) => [item.capability, item]))
    const selected = [...context.selected.capabilities]
    const list = await this.#serviceRequest('/admin/models', { timeoutMs: 8000 })
    if (!list.ok || !Array.isArray(list.data?.models)) {
      throw makeError('upstream_error', {
        detail: `admin_models HTTP ${list.status || 0}`,
        hint: '读取模型清单失败，已跳过模型下载；服务仍可运行，可到服务管理界面手动下载模型。',
      })
    }
    const rawModels = list.data.models
    const items = selected.map((capability) => catalog.get(capability)).filter(Boolean)
    const pending = items.filter((item) => !isModelPresent(item, rawModels))
    const totalMb = pending.reduce((sum, item) => sum + (Number(item.sizeMb) || 0), 0) || 1
    const completed = items.filter((item) => isModelPresent(item, rawModels)).map((item) => item.capability)
    const failed = []
    for (const item of items) {
      if (isModelPresent(item, rawModels)) this.#appendLog(`模型 ${item.capability} 已存在，跳过`)
    }
    this.#progressStep('models', items.length === pending.length ? 0 : 1, pending.length
      ? `准备下载 ${pending.length} 个模型（约 ${mbToGb(totalMb)}GB）`
      : '所选模型都已存在')

    let settledMb = 0
    for (const item of pending) {
      this.#ensureNotCanceled()
      this.#progressStep('models', Math.min(99, Math.round((settledMb / totalMb) * 100)),
        `开始下载 ${item.title}（${mbToGb(item.sizeMb)}GB）…`)
      const start = await this.#serviceRequest('/admin/models/download', {
        method: 'POST',
        timeoutMs: 15000,
        body: { capability: item.capability, name: item.name },
      })
      if (!start.ok || !start.data?.task_id) {
        const hint = start.status === 409
          ? `${item.title} 未下载：服务端已有另一个模型下载任务。请稍后重试。`
          : `${item.title} 未下载（HTTP ${start.status || 0}）。可稍后到服务管理界面重试。`
        failed.push({ capability: item.capability, title: item.title, hint })
        this.#appendLog(hint)
        settledMb += item.sizeMb
        continue
      }
      const remoteTaskId = String(start.data.task_id)
      const began = this.now()
      let done = false
      let failure = ''
      for (;;) {
        this.#ensureNotCanceled()
        const status = await this.#serviceRequest(`/admin/models/tasks/${encodeURIComponent(remoteTaskId)}`, { timeoutMs: 5000 })
        const data = status.data || {}
        const downloadedMb = Number(data.downloaded_mb) || 0
        if (data.failed || data.status === 'failed') {
          failure = String(data.error || data.detail || '服务端报告下载失败')
          break
        }
        if (data.done || data.status === 'done') {
          done = true
          break
        }
        const fraction = item.sizeMb ? Math.min(0.99, downloadedMb / item.sizeMb) : 0
        this.#progressStep('models', Math.min(99, Math.round(((settledMb + fraction * item.sizeMb) / totalMb) * 100)),
          `正在下载 ${item.title} ${downloadedMb.toFixed(1)}/${item.sizeMb} MB`)
        if (this.now() - began >= MODEL_POLL_TIMEOUT_MS) {
          failure = '下载超时（超过 2 小时）'
          break
        }
        await this.sleep(MODEL_POLL_MS)
      }
      settledMb += item.sizeMb
      if (done) {
        completed.push(item.capability)
        this.#appendLog(`模型 ${item.capability} 下载完成`)
      } else {
        const hint = `${item.title} 未下载：${failure || '未知原因'}。已下载的文件会保留，可稍后重试。`
        failed.push({ capability: item.capability, title: item.title, hint })
        this.#appendLog(hint)
      }
    }

    // 下载完成后以 /admin/models 的 present 为准再校验一遍。
    const verify = await this.#serviceRequest('/admin/models', { timeoutMs: 8000 })
    let verifiedModels = null
    if (verify.ok && Array.isArray(verify.data?.models)) {
      verifiedModels = verify.data.models
    } else {
      this.#appendLog('模型下载后复检失败，按下载任务结果记录。')
    }
    const finalCompleted = selected.filter((capability) => {
      const catalogItem = catalog.get(capability)
      return catalogItem && (verifiedModels ? isModelPresent(catalogItem, verifiedModels) : completed.includes(capability))
    })
    const finalFailed = selected
      .filter((capability) => !finalCompleted.includes(capability))
      .map((capability) => {
        const known = failed.find((item) => item.capability === capability)
        const catalogItem = catalog.get(capability)
        return known || {
          capability,
          title: catalogItem?.title || capability,
          hint: `${catalogItem?.title || capability} 下载后复检仍缺失，可稍后重试。`,
        }
      })
    task.models = {
      selected,
      completed: finalCompleted,
      failed: finalFailed,
      skipped: false,
    }
    const message = finalFailed.length
      ? `模型下载完成，但 ${finalFailed.length} 项未完成（服务仍可用）`
      : '所选模型已全部就绪'
    this.#endStep('models', 'done', message)
  }

  async models(options = {}) {
    const selection = selectModelCapabilities(options.models ?? this.task?.models?.selected ?? DEFAULT_MODEL_CAPABILITIES)
    const response = await this.#serviceRequest('/admin/models', { timeoutMs: 8000 })
    if (!response.ok || !Array.isArray(response.data?.models)) {
      return {
        ok: false,
        code: 'service_down',
        hint: '本地 AI 未启动或 /admin/models 不可用，无法读取模型状态。',
        catalog: MODEL_CATALOG,
        defaults: [...DEFAULT_MODEL_CAPABILITIES],
      }
    }
    const rawModels = response.data.models
    // 一个 capability 可能对应多个档位（whisper 5 个、separate 3 个）；按安装目录里的
    // 目标 name 匹配，避免「htdemucs_ft 存在就算 htdemucs 已装」这种误判。
    const models = MODEL_CATALOG.map((model) => {
      const variants = rawModels.filter((item) => matchesModelItem(model, item))
      return {
        capability: model.capability,
        title: model.title,
        label: model.label,
        expectedName: model.name,
        present: variants.some((item) => item.present),
        sizeMb: Number(model.sizeMb) || 0,
        variants: variants.map((item) => ({
          name: String(item.name || ''),
          present: Boolean(item.present),
          sizeMb: Number(item.size_mb) || 0,
          missing: Array.isArray(item.missing_files) ? item.missing_files.map(String) : [],
        })),
      }
    })
    return {
      ok: true,
      models,
      present: models.filter((item) => item.present).map((item) => item.capability),
      missing: models.filter((item) => !item.present).map((item) => item.capability),
      selected: selection.ok ? selection.capabilities : [],
      catalog: MODEL_CATALOG,
      defaults: [...DEFAULT_MODEL_CAPABILITIES],
    }
  }

  // ---------------- 取消 / 回滚 / 接管 ----------------

  cancel() {
    if (!this.task || this.task.state !== 'running') {
      return {
        ok: true,
        canceled: false,
        state: this.task?.state || 'idle',
        message: '当前没有正在进行的安装任务。',
      }
    }
    this.#appendLog('收到取消请求：终止子进程并回滚本次创建的文件')
    try { this.abort?.abort() } catch { /* 已经取消 */ }
    if (this.servicePid) {
      this.killTree(this.servicePid)
      this.servicePid = null
    }
    return {
      ok: true,
      canceled: true,
      taskId: this.task.taskId,
      state: 'canceling',
      message: '正在取消安装并清理本次创建的文件。',
    }
  }

  async #rollback(task) {
    task.phase = 'rollback'
    if (this.servicePid) {
      this.#appendLog(`停止本次启动的服务（pid ${this.servicePid}）`)
      this.killTree(this.servicePid)
      this.servicePid = null
    }
    const removed = []
    for (const path of [...task.createdPaths].reverse()) {
      if (PRESERVED_NAMES.includes(String(path).split(/[\\/]/).pop())) continue
      try {
        this.fs.rmSync(path, { recursive: true, force: true })
        removed.push(path)
      } catch (error) {
        this.#appendLog(`回滚删除失败：${path}（${String(error?.message || error)}）`)
      }
    }
    task.createdPaths = []
    // 下载/解压的临时文件在成功前不属于 createdPaths，失败时要单独清掉，
    // 否则下次安装会被“目录非空”挡住。
    for (const temp of [join(task.installDir, '.dsh-code.zip'), join(task.installDir, '.dsh-extract')]) {
      try { this.fs.rmSync(temp, { recursive: true, force: true }) } catch { /* 没有就算了 */ }
    }
    try { this.fs.rmSync(markerPath(task.installDir), { force: true }) } catch { /* 没有就算了 */ }
    if (task.createdRoot) {
      try {
        const left = this.fs.readdirSync(task.installDir)
        if (!left.length) this.fs.rmdirSync(task.installDir)
        else this.#appendLog(`保留安装目录（还留有用户数据：${left.join('、')}）`)
      } catch { /* 目录可能已经不存在 */ }
    }
    this.#appendLog(removed.length ? `已回滚 ${removed.length} 个本次创建的路径` : '没有需要回滚的路径')
  }

  #writeState(task, status) {
    const state = {
      version: 1,
      status,
      installMode: status === 'installed' ? 'managed' : 'unknown',
      installDir: task.installDir,
      serviceVersion: status === 'installed' ? this.serviceVersion : '',
      apiVersion: status === 'installed' ? '1' : '',
      createdPaths: status === 'installed' ? [...task.createdPaths] : [],
      createdAutostart: false,
      autostartName: '',
      startedByUs: status === 'installed' && Boolean(task.startedByUs),
      lastInstallAt: isIso(),
      lastError: task.error || null,
      models: task.models || null,
    }
    this.#writeJson(globalStatePath(this.homeDir), state)
    if (status === 'installed') this.#writeJson(markerPath(task.installDir), state)
  }

  /** 接管已有服务：只探测与写配置，不碰安装目录、不停服务。 */
  async adopt() {
    const config = this.getConfig() || {}
    const candidates = []
    for (const url of [normalizeUrl(config.baseUrl), SERVICE_BASE_URL]) {
      if (url && !candidates.includes(url)) candidates.push(url)
    }
    const tried = []
    let found = null
    for (const baseUrl of candidates) {
      const probe = await this.#probeServiceUrl(baseUrl)
      tried.push({
        baseUrl,
        found: probe.found,
        reason: probe.reason || '',
        serviceVersion: probe.serviceVersion || '',
      })
      if (probe.found) {
        found = { ...probe, baseUrl }
        break
      }
    }
    if (!found) {
      throw makeError('service_down', {
        detail: JSON.stringify(tried),
        hint: '没有找到可接管的本地 AI 服务：7880 未监听，或返回的不是 localai-service。请先启动服务，或在设置里填写正确地址。',
      })
    }
    if (found.serviceVersion && compareVersion(found.serviceVersion, MIN_SERVICE_VERSION) < 0) {
      throw makeError('bad_request', {
        detail: `service_version=${found.serviceVersion}`,
        hint: `检测到本地 AI ${found.serviceVersion}，低于插件支持的最低版本 ${MIN_SERVICE_VERSION}。请先升级服务端；版本过低时不会写入配置。`,
      })
    }
    await this.saveConfig({ baseUrl: found.baseUrl, installMode: 'adopted' })
    try { this.capabilities?.invalidate?.() } catch { /* 忽略 */ }
    try {
      await this.capabilities?.refresh?.({ force: true, timeoutMs: 3000 })
    } catch { /* 下一次轮询会重试 */ }
    const system = await this.#fetchJson(`${found.baseUrl}/admin/system`, 5000)
    return {
      ok: true,
      installMode: 'adopted',
      baseUrl: found.baseUrl,
      serviceVersion: found.serviceVersion,
      apiVersion: found.apiVersion,
      paths: system?.data?.paths || null,
      tried,
    }
  }

  /** 等当前任务结束（测试与脚本用；路由不需要）。 */
  async waitForIdle() {
    if (this.taskPromise) {
      try { await this.taskPromise } catch { /* 任务内部已兜住 */ }
    }
    return this.status()
  }
}

/** 把目录校验包一层，保证拿不到 fs 时也不会抛。 */
function validateInstallDirSafe(raw, installer) {
  try {
    return installerModValidate(raw, {
      env: installer.env,
      platform: installer.platform,
      fs: installer.fs,
    })
  } catch (error) {
    return { ok: false, code: 'invalid_install_dir', path: '', hint: `无法校验安装目录：${String(error?.message || error)}` }
  }
}

export function createInstaller(deps = {}) {
  return new Installer(deps)
}
