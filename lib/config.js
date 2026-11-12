// 配置：默认值、范围钳制、环境变量覆盖、原子持久化、设置页脱敏。
//
// 配置的真身是 <DSH 家目录>/fish-service-config.json。
// 设置页读写的也是它；schema 只是给 DSH 的声明，不靠它存运行配置。
//
// 优先级：env > 文件 > 插件 patch 传入的配置 > 默认值。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureDir, expandHome, readJson, writeJsonAtomic } from './fs-util.js'
import { defaultVisionPrompt, normalizeVisionPresets, visionPreset, visionPromptLimit } from './vision-presets.js'

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'fish-service-config.json'
export const CAPABILITY_NAMES = Object.freeze([
  'tts', 'asr', 'translate', 'separate', 'vision', 'media', 'download', 'jobs',
])

const defaultHomeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 默认配置（cacheDir 在执行时才按家目录展开）。 */
export function defaultConfig(homeDir = defaultHomeDir()) {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    /** 唯一服务地址（唯一知道 localai 在哪里的地方） */
    baseUrl: 'http://127.0.0.1:7880',
    /** 期望的 HTTP 契约主版本 */
    apiVersion: '1',
    /** LOCALAI_TOKEN；只写不回显 */
    token: '',
    /** 界面注入开关：关闭后对应入口不显示；默认全部开启 */
    uiVoiceInput: true,
    uiVision: true,
    uiMetrics: true,
    uiAutoRead: true,
    /** 一般请求（TTS）超时 */
    requestTimeoutMs: 180000,
    /** ASR / 分离超时 */
    asrTimeoutMs: 300000,
    /** 视觉超时 */
    visionTimeoutMs: 600000,
    /** 需要识图时优先用本机视觉模型；旧配置没有该字段时按 true */
    localDescribe: true,
    /** 工具识图提示词四档；空串表示用内置默认（旧配置缺字段时自动补默认文案） */
    visionPresets: { ...defaultVisionPrompt },
    /** 工具识图的默认档位：brief / standard / detailed / text */
    visionDefaultPreset: 'detailed',
    /** 会话识图（输入框旁按钮）的提示词；空串表示用内置默认（与详细档一致） */
    visionSessionPrompt: '',
    /** 默认音色；迁移自 fish-message 时保留 dafeiyu */
    ttsVoice: 'dafeiyu',
    /** 朗读默认语速（0.5~2.0） */
    ttsSpeed: 1,
    /** 新会话默认是否自动朗读最终回复（单个会话的值见 autoReadSessions） */
    autoRead: false,
    /** 按会话保存的自动朗读：{ [sessionId]: boolean }；缺省时回落到 autoRead */
    autoReadSessions: {},
    /** 窗口在后台或最小化时是否仍自动朗读；旧配置没有该字段时按 true */
    autoReadInBackground: true,
    /** 朗读时单段最大字数（超过就分段合成） */
    readMaxChars: 2000,
    /** 朗读分段合成时的并发批数（1~4；1 = 完全串行） */
    readConcurrency: 2,
    /** 语音输入录音格式：auto / webm / wav */
    recordMime: 'auto',
    /** 语音输入使用的麦克风设备标识；空 = 跟随系统默认 */
    recordDeviceId: '',
    /** 是否记住上次的三选一（只作默认高亮，不自动执行） */
    rememberVoiceChoice: true,
    /** 语音输入默认 ASR 语言 */
    asrLanguage: 'auto',
    /** 翻译：第一语言（原文不是它时译成它） */
    primaryLanguage: 'zh',
    /** 翻译：第二语言（原文就是第一语言时译成它） */
    secondaryLanguage: 'en',
    /** 产物目录（TTS / 分离 / 关键帧） */
    cacheDir: join(homeDir, 'fish-service-cache'),
    /** 产物 TTL（小时），必须大于 fish-message 出站 TTL（24h） */
    cacheTtlHours: 72,
    /** 缓存上限（MB），超出按 LRU 删 */
    cacheMaxMb: 2048,
    /** 后台健康检查间隔 */
    healthIntervalMs: 15000,
    /** 可选：只启用这些能力（空 = 全部按服务端 capabilities） */
    enabledCapabilities: [],
    /** debug / info / warn / error */
    logLevel: 'info',
    /** P3 安装器维护；P1 只读 */
    installMode: 'unknown',
    installDir: '',
  }
}

const numberRange = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

const intRange = (value, fallback, min, max) => Math.round(numberRange(value, fallback, min, max))

const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/** 「按会话自动朗读」最多保存的会话数；超出部分丢弃（有上限，避免配置文件无限膨胀）。 */
export const AUTO_READ_SESSIONS_LIMIT = 200
const sessionKeyPattern = /^session-/

/**
 * 规范化「按会话自动朗读」：
 * - 只接受普通对象，其它值按空表处理；
 * - 键须以 session- 开头，值转布尔；
 * - 最多保留 200 条，超出部分丢弃；
 * - 非法项忽略，不报错。
 * 返回 { value, warnings }；warnings 是给用户看的中文提示，不含会话键。
 */
export function normalizeAutoReadSessions(value) {
  if (value == null) return { value: {}, warnings: [], valid: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      value: {},
      warnings: ['自动朗读的会话设置格式不正确，已忽略。'],
      valid: false,
    }
  }
  const output = {}
  let invalid = 0
  let exceed = 0
  for (const rawKey of Object.keys(value)) {
    const key = String(rawKey)
    if (!sessionKeyPattern.test(key)) { invalid += 1; continue }
    if (Object.keys(output).length >= AUTO_READ_SESSIONS_LIMIT) { exceed += 1; continue }
    output[key] = bool(value[rawKey], false)
  }
  const warnings = []
  if (invalid) warnings.push(`自动朗读的会话设置中有 ${invalid} 条无法识别，已忽略。`)
  if (exceed) warnings.push(`自动朗读的会话设置最多保留 ${AUTO_READ_SESSIONS_LIMIT} 条，超出的 ${exceed} 条已忽略。`)
  return { value: output, warnings, valid: true }
}

/** 「输入设备」允许的最大长度。 */
export const RECORD_DEVICE_ID_MAX = 200

/**
 * 规范化「输入设备」：
 * - 省略（旧配置没有该字段）按空串处理，行为不变，不提示；
 * - 空串合法，表示跟随系统默认；
 * - 只接受字符串；其它类型忽略并提示；
 * - 最长 200 字，超长忽略并提示。
 * 返回 { value, warnings, valid }；valid=false 表示原值非法、应整项忽略。
 */
export function normalizeRecordDeviceId(value) {
  if (value === undefined) return { value: '', warnings: [], valid: true }
  if (typeof value !== 'string') {
    return {
      value: '',
      warnings: ['输入设备的设置格式不正确，已忽略。'],
      valid: false,
    }
  }
  const device = value.trim()
  if (device.length > RECORD_DEVICE_ID_MAX) {
    return {
      value: '',
      warnings: [`输入设备设置过长（最多 ${RECORD_DEVICE_ID_MAX} 字），已忽略。`],
      valid: false,
    }
  }
  return { value: device, warnings: [], valid: true }
}

const char = (value, fallback = '') => {
  if (value == null) return fallback
  return typeof value === 'string' ? value.trim() : String(value).trim()
}

const stripTrailingSlash = (value) => char(value).replace(/\/+$/, '')

const normalizeAddress = (value, fallback) => {
  const address = stripTrailingSlash(value)
  if (!address) return fallback
  try {
    const u = new URL(address)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback
    return address
  } catch {
    return fallback
  }
}

const normalizeCapabilityList = (value) => {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : [])
  const output = []
  for (const item of raw) {
    const name = char(item).toLowerCase()
    if (CAPABILITY_NAMES.includes(name) && !output.includes(name)) output.push(name)
  }
  return output
}

/** 枚举值：不认识就回退默认。 */
const enumValue = (value, allow, fallback) => {
  const name = char(value).toLowerCase()
  return allow.includes(name) ? name : fallback
}

/** 语速：0.5~2.0，保留两位小数。 */
const normalizeSpeed = (value, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.max(0.5, Math.min(2, n)) * 100) / 100
}

/** 解包 DSH / cosmokit 的 volatile 配置引用；普通值原样返回。 */
function unwrapConfigValue(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function'
    && Symbol.for('cosmokit.volatile.write') in value) {
    try { return value.get() } catch { return undefined }
  }
  return value
}

/** 读进来的任何东西都走这里：补默认值、钳范围、认旧字段。 */
export function normalizeConfig(raw, { homeDir = defaultHomeDir(), onWarning = null } = {}) {
  const fallback = defaultConfig(homeDir)
  const rawConfig = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  // DSH 的 schemastery 字段如果标了 `volatile`，传进来的是 {get()} 引用而不是值。
  // 这里统一解包，避免把 `[object Object]` 写进配置。
  const src = {}
  for (const [field, value] of Object.entries(rawConfig)) {
    src[field] = unwrapConfigValue(value)
  }
  const sessionRead = normalizeAutoReadSessions(src.autoReadSessions)
  const recordingDevice = normalizeRecordDeviceId(src.recordDeviceId)
  const visionPresets = normalizeVisionPresets(src.visionPresets)
  const sessionPromptOrig = typeof src.visionSessionPrompt === 'string' ? src.visionSessionPrompt.trim() : ''
  const sessionPrompt = sessionPromptOrig.slice(0, visionPromptLimit)
  if (onWarning) {
    for (const warn of sessionRead.warnings) onWarning(warn)
    for (const warn of recordingDevice.warnings) onWarning(warn)
    if (sessionPromptOrig.length > visionPromptLimit) onWarning(`会话识图提示词超过 ${visionPromptLimit} 字，已截断。`)
  }

  const logLevelRaw = char(src.logLevel, fallback.logLevel).toLowerCase()
  const logLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info'
  const modeRaw = char(src.installMode, fallback.installMode).toLowerCase()
  const installMode = ['unknown', 'managed', 'adopted'].includes(modeRaw) ? modeRaw : 'unknown'
  const baseUrl = normalizeAddress(src.baseUrl, fallback.baseUrl)
  const apiVersion = char(src.apiVersion, fallback.apiVersion) || fallback.apiVersion

  return {
    version: CONFIG_VERSION,
    enabled: bool(src.enabled, fallback.enabled),
    uiVoiceInput: bool(src.uiVoiceInput, fallback.uiVoiceInput),
    uiVision: bool(src.uiVision, fallback.uiVision),
    uiMetrics: bool(src.uiMetrics, fallback.uiMetrics),
    uiAutoRead: bool(src.uiAutoRead, fallback.uiAutoRead),
    baseUrl,
    apiVersion,
    token: char(src.token, '').slice(0, 512),
    requestTimeoutMs: intRange(src.requestTimeoutMs, fallback.requestTimeoutMs, 1000, 1800000),
    asrTimeoutMs: intRange(src.asrTimeoutMs, fallback.asrTimeoutMs, 1000, 1800000),
    visionTimeoutMs: intRange(src.visionTimeoutMs, fallback.visionTimeoutMs, 1000, 1800000),
    localDescribe: bool(src.localDescribe, fallback.localDescribe),
    visionPresets: visionPresets,
    visionDefaultPreset: enumValue(src.visionDefaultPreset, visionPreset, fallback.visionDefaultPreset),
    visionSessionPrompt: sessionPrompt,
    ttsVoice: char(src.ttsVoice, fallback.ttsVoice).slice(0, 80) || fallback.ttsVoice,
    ttsSpeed: normalizeSpeed(src.ttsSpeed, fallback.ttsSpeed),
    autoRead: bool(src.autoRead, fallback.autoRead),
    autoReadSessions: sessionRead.value,
    autoReadInBackground: bool(src.autoReadInBackground, fallback.autoReadInBackground),
    readMaxChars: intRange(src.readMaxChars, fallback.readMaxChars, 200, 5000),
    readConcurrency: intRange(src.readConcurrency, fallback.readConcurrency, 1, 4),
    recordMime: enumValue(src.recordMime, ['auto', 'webm', 'wav'], fallback.recordMime),
    recordDeviceId: recordingDevice.value,
    rememberVoiceChoice: bool(src.rememberVoiceChoice, fallback.rememberVoiceChoice),
    asrLanguage: enumValue(src.asrLanguage, ['auto', 'zh', 'en', 'ja'], fallback.asrLanguage),
    primaryLanguage: enumValue(src.primaryLanguage, ['zh', 'en', 'ja', 'ko', 'yue'], fallback.primaryLanguage),
    secondaryLanguage: enumValue(src.secondaryLanguage, ['zh', 'en', 'ja', 'ko', 'yue'], fallback.secondaryLanguage),
    cacheDir: expandHome(char(src.cacheDir, fallback.cacheDir), homeDir) || fallback.cacheDir,
    cacheTtlHours: intRange(src.cacheTtlHours, fallback.cacheTtlHours, 1, 720),
    cacheMaxMb: intRange(src.cacheMaxMb, fallback.cacheMaxMb, 256, 10240),
    healthIntervalMs: intRange(src.healthIntervalMs, fallback.healthIntervalMs, 5000, 120000),
    enabledCapabilities: normalizeCapabilityList(src.enabledCapabilities),
    logLevel,
    installMode,
    installDir: expandHome(char(src.installDir, ''), homeDir),
  }
}

// 环境变量：优先 DSH_FISH_SERVICE_*（契约），同时接受 FISH_SERVICE_*（简短写法）。
const envVarTable = [
  ['baseUrl', ['DSH_FISH_SERVICE_BASE_URL', 'FISH_SERVICE_BASE_URL'], 'string'],
  ['apiVersion', ['DSH_FISH_SERVICE_API_VERSION', 'FISH_SERVICE_API_VERSION'], 'string'],
  ['token', ['DSH_FISH_SERVICE_TOKEN', 'FISH_SERVICE_TOKEN'], 'string'],
  ['enabled', ['DSH_FISH_SERVICE_ENABLED', 'FISH_SERVICE_ENABLED'], 'boolean'],
  ['requestTimeoutMs', ['DSH_FISH_SERVICE_REQUEST_TIMEOUT_MS', 'FISH_SERVICE_REQUEST_TIMEOUT_MS'], 'number'],
  ['asrTimeoutMs', ['DSH_FISH_SERVICE_ASR_TIMEOUT_MS', 'FISH_SERVICE_ASR_TIMEOUT_MS'], 'number'],
  ['visionTimeoutMs', ['DSH_FISH_SERVICE_VISION_TIMEOUT_MS', 'FISH_SERVICE_VISION_TIMEOUT_MS'], 'number'],
  ['localDescribe', ['DSH_FISH_SERVICE_LOCAL_DESCRIBE', 'FISH_SERVICE_LOCAL_DESCRIBE'], 'boolean'],
  ['uiVoiceInput', ['DSH_FISH_SERVICE_UI_VOICE_INPUT', 'FISH_SERVICE_UI_VOICE_INPUT'], 'boolean'],
  ['uiVision', ['DSH_FISH_SERVICE_UI_VISION', 'FISH_SERVICE_UI_VISION'], 'boolean'],
  ['uiMetrics', ['DSH_FISH_SERVICE_UI_METRICS', 'FISH_SERVICE_UI_METRICS'], 'boolean'],
  ['uiAutoRead', ['DSH_FISH_SERVICE_UI_AUTO_READ', 'FISH_SERVICE_UI_AUTO_READ'], 'boolean'],
  ['ttsVoice', ['DSH_FISH_SERVICE_TTS_VOICE', 'FISH_SERVICE_TTS_VOICE'], 'string'],
  ['cacheDir', ['DSH_FISH_SERVICE_CACHE_DIR', 'FISH_SERVICE_CACHE_DIR'], 'string'],
  ['healthIntervalMs', ['DSH_FISH_SERVICE_HEALTH_MS', 'FISH_SERVICE_HEALTH_MS'], 'number'],
  ['logLevel', ['DSH_FISH_SERVICE_LOG_LEVEL', 'FISH_SERVICE_LOG_LEVEL'], 'string'],
  ['enabledCapabilities', ['DSH_FISH_SERVICE_ENABLED_CAPABILITIES', 'FISH_SERVICE_ENABLED_CAPABILITIES'], 'list'],
  ['installDir', ['DSH_FISH_SERVICE_INSTALL_DIR', 'FISH_SERVICE_INSTALL_DIR'], 'string'],
]

function findEnvVar(env, displayNames) {
  for (const name of displayNames) {
    if (env && env[name] !== undefined && env[name] !== '') return { key: name, value: env[name] }
  }
  return null
}

/**
 * 环境变量覆盖（返回新对象，不改入参）。
 * @returns {{config: object, overrides: string[]}}
 */
export function applyEnv(config, env = process.env, { homeDir = defaultHomeDir() } = {}) {
  const patch = {}
  const overrides = []
  for (const [field, displayNames, type] of envVarTable) {
    const hit = findEnvVar(env, displayNames)
    if (!hit) continue
    if (type === 'boolean') patch[field] = bool(hit.value, config[field])
    else if (type === 'number') patch[field] = Number(hit.value)
    else if (type === 'list') patch[field] = String(hit.value).split(',')
    else patch[field] = hit.value
    overrides.push(field)
  }
  if (!overrides.length) return { config, overrides }
  return {
    config: normalizeConfig({ ...config, ...patch }, { homeDir }),
    overrides,
  }
}

/** 设置页 / 宿主路由能看到的配置（token 打码）。 */
export function publicConfig(config) {
  const c = normalizeConfig(config)
  return {
    ...c,
    token: c.token ? '***已设置***' : '',
  }
}

/** 让设置页知道哪些字段被环境变量钉住了（改了也不生效）。 */
export function envOverrides(env = process.env) {
  const output = []
  for (const [field, displayNames] of envVarTable) {
    if (findEnvVar(env, displayNames)) output.push(field)
  }
  return output
}

/** 配置持久化。 */
export class ConfigStore {
  constructor({ homeDir = defaultHomeDir(), fileName = CONFIG_FILE } = {}) {
    this.homeDir = homeDir
    this.filePath = join(homeDir, fileName)
    this.current = null
    this.overrides = []
    /** 最近一次载入/保存时被丢弃的非法项（给日志用，不含会话键）。 */
    this.warnings = []
  }

  /** 文件 > pluginConfig > 默认；最后套 env。 */
  load(pluginConfig = {}, env = process.env) {
    const file = readJson(this.filePath, null)
    const merge = { ...(pluginConfig || {}), ...(file || {}) }
    this.warnings = []
    const normalize = normalizeConfig(merge, {
      homeDir: this.homeDir,
      onWarning: (warn) => this.warnings.push(warn),
    })
    const result = applyEnv(normalize, env, { homeDir: this.homeDir })
    this.current = result.config
    this.overrides = result.overrides
    return this.current
  }

  save(config) {
    this.warnings = []
    const normalize = normalizeConfig(config, {
      homeDir: this.homeDir,
      onWarning: (warn) => this.warnings.push(warn),
    })
    ensureDir(this.homeDir)
    if (!writeJsonAtomic(this.filePath, normalize)) return null
    // 文件里存的是“不含 env”的值；运行值仍要套 env（env > file）。
    const result = applyEnv(normalize, process.env, { homeDir: this.homeDir })
    this.current = result.config
    this.overrides = result.overrides
    return this.current
  }

  get() {
    return this.current
  }
}

/** cordis / schemastery 配置 schema；拿不到 schemastery 时返回 undefined，插件照常加载。 */
export function buildConfigSchema(z, homeDir = defaultHomeDir()) {
  const fallback = defaultConfig(homeDir)
  // 不标 `volatile`：P1 的配置真身是 fish-service-config.json，设置页走宿主路由读写；
  // 如果标成 volatile，DSH 会把每个字段包成 {get()} 引用，静态 ConfigStore 读不到实际值。
  return z.object({
    enabled: z.boolean().default(fallback.enabled).description('总开关'),
    baseUrl: z.string().default(fallback.baseUrl).description('本地 AI 服务地址'),
    apiVersion: z.string().default(fallback.apiVersion).description('期望的 HTTP 契约主版本'),
    token: z.string().default('').description('LOCALAI_TOKEN；只写不回显'),
    requestTimeoutMs: z.natural().default(fallback.requestTimeoutMs).description('TTS/一般请求超时（毫秒）'),
    asrTimeoutMs: z.natural().default(fallback.asrTimeoutMs).description('ASR/分离超时（毫秒）'),
    visionTimeoutMs: z.natural().default(fallback.visionTimeoutMs).description('视觉超时（毫秒）'),
    localDescribe: z.boolean().default(fallback.localDescribe).description('本地识图：需要看图时优先用本机视觉模型'),
    uiVoiceInput: z.boolean().default(fallback.uiVoiceInput).description('界面开关：语音识别（关闭后输入框不显示麦克风按钮）'),
    uiVision: z.boolean().default(fallback.uiVision).description('界面开关：本地识图（关闭后输入框不显示识图按钮）'),
    uiMetrics: z.boolean().default(fallback.uiMetrics).description('界面开关：性能监控（关闭后不显示显存与任务状态）'),
    uiAutoRead: z.boolean().default(fallback.uiAutoRead).description('界面开关：自动朗读（关闭后所有会话都不再自动朗读）'),
    visionPresets: z.dict(z.string()).default(fallback.visionPresets).description('工具识图提示词：brief/standard/detailed/text 四档；空=用内置默认'),
    visionDefaultPreset: z.string().default(fallback.visionDefaultPreset).description('工具识图默认档位：brief/standard/detailed/text'),
    visionSessionPrompt: z.string().default(fallback.visionSessionPrompt).description('会话识图提示词；空=用内置默认（与详细档一致）'),
    ttsVoice: z.string().default(fallback.ttsVoice).description('默认音色'),
    ttsSpeed: z.number().min(0.5).max(2).default(fallback.ttsSpeed).description('朗读语速 0.5~2.0'),
    autoRead: z.boolean().default(fallback.autoRead).description('新会话默认自动朗读最终回复'),
    autoReadSessions: z.dict(z.boolean()).default({}).description('按会话保存的自动朗读设置'),
    autoReadInBackground: z.boolean().default(fallback.autoReadInBackground).description('窗口在后台或最小化时仍自动朗读'),
    readMaxChars: z.natural().min(200).max(5000).default(fallback.readMaxChars).description('朗读单段最大字数'),
    readConcurrency: z.natural().min(1).max(4).default(fallback.readConcurrency).description('朗读分段合成并发度 1~4'),
    recordMime: z.string().default(fallback.recordMime).description('录音格式：auto/webm/wav'),
    recordDeviceId: z.string().default(fallback.recordDeviceId).description('语音输入使用的麦克风设备标识；空=跟随系统默认'),
    rememberVoiceChoice: z.boolean().default(fallback.rememberVoiceChoice).description('记住语音输入上次选择'),
    asrLanguage: z.string().default(fallback.asrLanguage).description('语音输入 ASR 语言：auto/zh/en/ja'),
    primaryLanguage: z.string().default(fallback.primaryLanguage).description('翻译第一语言：zh/en/ja/ko/yue'),
    secondaryLanguage: z.string().default(fallback.secondaryLanguage).description('翻译第二语言：zh/en/ja/ko/yue'),
    cacheDir: z.string().default(fallback.cacheDir).description('产物缓存目录'),
    cacheTtlHours: z.natural().default(fallback.cacheTtlHours).description('产物 TTL（小时）'),
    cacheMaxMb: z.natural().default(fallback.cacheMaxMb).description('缓存上限（MB）'),
    healthIntervalMs: z.natural().default(fallback.healthIntervalMs).description('健康检查间隔（毫秒）'),
    enabledCapabilities: z.array(z.string()).default([]).description('只启用这些能力；空=自动'),
    logLevel: z.string().default(fallback.logLevel).description('日志级别：debug/info/warn/error'),
  }).description('dsh-fish-service 配置')
}
