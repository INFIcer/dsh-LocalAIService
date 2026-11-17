// 一键安装的常量与目录规则。
//
// 安装器相信的东西（仓库地址、CUDA 索引、体积估算、模型清单）集中在这里，
// 换源或换版本只改这一处；预检、安装、状态页读的是同一份，不会各写一套数字。

import { join, resolve, dirname } from 'node:path'
import * as nodeFs from 'node:fs'
import { isAbsolutePath } from './fs-util.js'

/** 服务端仓库与固定分支（没有 release/tag，只能跟 main）。 */
export const REPO_URL = 'https://github.com/INFIcer/LocalAIService.git'
export const REPO_BRANCH = 'main'
export const CODELOAD_URL = 'https://codeload.github.com/INFIcer/LocalAIService/zip/refs/heads/main'

/** torch 必须从 CUDA 索引装，否则 pip 会拿 CPU 版；本机驱动 591.59 对应 cu130。 */
export const CUDA_TAG = 'cu130'
export const TORCH_INDEX_URL = 'https://download.pytorch.org/whl/cu130'
export const TORCH_SPEC = 'torch==2.11.0'

/** 引擎依赖（torch 单装，其余一组）。 */
export const ENGINE_PACKAGES = Object.freeze([
  'funasr',
  'demucs',
  'transformers',
  'sentencepiece',
  'langdetect',
  'modelscope',
  'huggingface_hub',
  'yt-dlp',
])

/** 服务固定监听 127.0.0.1:7880；安装器不改端口（换端口只记 warning，不偷偷换）。 */
export const DEFAULT_PORT = 7880
export const SERVICE_BASE_URL = 'http://127.0.0.1:7880'

/** 环境门槛：只比较，不安装驱动/系统组件。 */
export const MIN_WINDOWS_BUILD = 19045
export const MIN_DRIVER = '580.00'
export const MIN_SERVICE_VERSION = '2.5.0'
export const PYTHON_MIN = '3.11'
export const PYTHON_MAX = '3.13'

/** 磁盘估算（MB）：代码 50 + venv 7000 + 所选模型，再留 10%。 */
export const DISK_CODE_MB = 50
export const DISK_VENV_MB = 7000
export const DISK_MARGIN_RATIO = 0.1

/**
 * 模型清单：capability/name 与服务端 /admin/models/download 的请求体一致。
 * priority 决定串行下载顺序（必需 → 推荐 → 可选）；sizeMb 只用于进度与预检估算，
 * 最终以服务端 /admin/models 的 present 为准。
 */
export const MODEL_CATALOG = Object.freeze([
  { capability: 'tts', name: '', label: 'IndexTTS-2.5', title: '语音合成', priority: 'required', sizeMb: 8075 },
  { capability: 'asr', name: '', label: 'SenseVoiceSmall', title: '语音识别', priority: 'required', sizeMb: 897 },
  { capability: 'speaker', name: '', label: 'campplus', title: '声纹向量', priority: 'required', sizeMb: 27 },
  { capability: 'vad', name: '', label: 'fsmn-vad', title: '语音分段', priority: 'required', sizeMb: 4 },
  { capability: 'separate', name: 'htdemucs', label: 'htdemucs', title: '人声分离', priority: 'recommended', sizeMb: 80 },
  { capability: 'translate', name: '', label: 'NLLB-200', title: '翻译', priority: 'optional', sizeMb: 2368 },
  { capability: 'vision', name: '', label: 'Qwen2.5-VL-3B', title: '视觉理解', priority: 'optional', sizeMb: 4023 },
  { capability: 'whisper', name: 'small', label: 'faster-whisper-small', title: '精确时间戳', priority: 'optional', sizeMb: 464 },
])

/** 默认勾选：四项必需 + 人声分离（推荐）。 */
export const DEFAULT_MODEL_CAPABILITIES = Object.freeze(['tts', 'asr', 'speaker', 'vad', 'separate'])

const priorityRank = { required: 0, recommended: 1, optional: 2 }

/** 按「必需 → 推荐 → 可选」排序；目录顺序已按此写死，这里只做显式兜底。 */
export function sortModelCatalog(list = MODEL_CATALOG) {
  return [...list].sort((a, b) => (priorityRank[a.priority] - priorityRank[b.priority]))
}

/** 安装步骤表：id 给程序，title 给界面；weight 只用于总进度百分比。 */
export const INSTALL_STEPS = Object.freeze([
  { id: 'preflight', title: '检查环境', weight: 1, estimate: '约 10 秒' },
  { id: 'fetch-code', title: '下载服务端代码', weight: 3, estimate: '约 10 秒（约 1.2MB）' },
  { id: 'venv', title: '创建虚拟环境', weight: 4, estimate: '约 20 秒' },
  { id: 'pip-core', title: '安装核心依赖', weight: 10, estimate: '约 2~5 分钟，几百 MB' },
  { id: 'engine-deps', title: '安装引擎依赖（torch 等）', weight: 20, estimate: '约 10~30 分钟，约 6.5GB' },
  { id: 'start', title: '启动服务', weight: 15, estimate: '最多 2 分钟' },
  { id: 'verify', title: '校验服务能力', weight: 2, estimate: '约 5 秒' },
  { id: 'save-config', title: '保存插件设置', weight: 1, estimate: '约 1 秒' },
  { id: 'models', title: '下载模型', weight: 44, estimate: '约 10~40 分钟，取决于所选模型' },
])

/** 回滚时永远保留的用户数据（DEPLOY 3.9）。 */
export const PRESERVED_NAMES = Object.freeze([
  'models',
  'voices',
  'data',
  'outputs',
  'logs',
  'config.json',
])

/** 默认安装目录：%LOCALAPPDATA%\localai-service。 */
export function defaultInstallDir(env = process.env, homeDir = '') {
  const localAppData = String(env?.LOCALAPPDATA || '').trim()
  if (process.platform === 'win32' && localAppData) return join(localAppData, 'localai-service')
  const root = String(homeDir || env?.USERPROFILE || env?.HOME || '').trim() || '.'
  return join(root, 'localai-service')
}

/** 全局安装状态：<DSH 家目录>\fish-service-install.json。 */
export function globalStatePath(homeDir) {
  return join(homeDir, 'fish-service-install.json')
}

/** 安装目录内的标记：用于识别「这是本插件装的目录」。 */
export function markerPath(installDir) {
  return join(installDir, '.dsh-fish-service-install.json')
}

/** 安装器自己的日志（命令输出、步骤、回滚）；与服务的 logs\service.*.log 分开。 */
export function installLogPath(homeDir) {
  return join(homeDir, 'fish-service-install.log')
}

/** Windows 盘符根（C:\）；非盘符路径返回 ''。 */
export function driveRootFor(path) {
  const match = /^([a-zA-Z]):[\\/]/.exec(String(path || ''))
  return match ? `${match[1].toUpperCase()}:\\` : ''
}

const lower = (value) => {
  const text = String(value || '')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

const samePath = (a, b) => lower(resolve(a)) === lower(resolve(b))

/** target 是否在 root 里面（含 root 本身）。 */
function isInsideOrSame(root, target) {
  const r = lower(resolve(root)).replace(/[\\/]+$/, '')
  const t = lower(resolve(target)).replace(/[\\/]+$/, '')
  return t === r || t.startsWith(`${r}\\`) || t.startsWith(`${r}/`)
}

/** 把用户输入拆成可安装的绝对路径；失败返回中文 hint。 */
export function validateInstallDir(raw, {
  env = process.env,
  platform = process.platform,
  fs = nodeFs,
} = {}) {
  const input = String(raw == null ? '' : raw).trim()
  if (!input) {
    return { ok: false, code: 'invalid_install_dir', path: '', hint: '没有指定安装目录。' }
  }
  if (platform !== 'win32') {
    return { ok: false, code: 'not_supported', path: input, hint: '一键安装目前只支持 Windows x64。' }
  }
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    return { ok: false, code: 'invalid_install_dir', path: input, hint: '不能用网络路径安装，请选本机磁盘上的目录。' }
  }
  if (!isAbsolutePath(input)) {
    return { ok: false, code: 'invalid_install_dir', path: input, hint: '请填写本机绝对路径，例如 C:\\Users\\你的名字\\AppData\\Local\\localai-service。' }
  }

  let target
  try {
    target = resolve(input)
  } catch {
    return { ok: false, code: 'invalid_install_dir', path: input, hint: '安装目录格式不正确。' }
  }

  if (/^[a-zA-Z]:[\\/]?$/.test(target)) {
    return { ok: false, code: 'invalid_install_dir', path: target, hint: '不能直接装在盘符根目录，请在其下新建一个专用目录。' }
  }

  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  const protectedRoots = [
    systemRoot,
    env.ProgramFiles || 'C:\\Program Files',
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    env.ProgramW6432 || 'C:\\Program Files',
    join(systemRoot, 'System32'),
  ].filter(Boolean)
  for (const root of protectedRoots) {
    if (isInsideOrSame(root, target)) {
      return {
        ok: false,
        code: 'invalid_install_dir',
        path: target,
        hint: `不能装到系统目录（${resolve(root)}）里，请换一个普通文件夹，例如 %LOCALAPPDATA%\\localai-service。`,
      }
    }
  }

  // junction / 符号链接会把实际文件写到别处；这里只识别“已存在的最近一级祖先”。
  let existing = target
  for (;;) {
    try {
      if (fs.existsSync(existing)) break
    } catch { /* 读不到就当不存在，继续往上找 */ }
    const parent = dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  try {
    if (fs.existsSync(existing)) {
      const actual = fs.realpathSync(existing)
      if (!samePath(actual, existing)) {
        return {
          ok: false,
          code: 'invalid_install_dir',
          path: target,
          hint: `安装目录经过链接/junction 指向了 ${actual}，安装器不支持这种路径，请改用真实目录。`,
        }
      }
    }
  } catch {
    return { ok: false, code: 'invalid_install_dir', path: target, hint: '无法解析安装目录，请检查路径是否存在、是否有权限。' }
  }

  return { ok: true, path: target, hint: '' }
}

/**
 * 规范化模型勾选。
 * - 省略 → 默认四项必需 + separate；
 * - 'all' / ['all'] → 全量；
 * - 空数组 → 不下载模型（服务仍可启动）；
 * - 未知 capability 直接拒绝，避免 UI 悄悄少下模型。
 * @returns {{ok:boolean, capabilities:string[], unknown:string[], hint:string}}
 */
export function selectModelCapabilities(input) {
  const known = MODEL_CATALOG.map((item) => item.capability)
  let raw = input
  if (raw === undefined || raw === null) raw = DEFAULT_MODEL_CAPABILITIES
  if (raw === 'all') raw = known
  if (typeof raw === 'string') raw = raw.split(',')
  if (!Array.isArray(raw)) {
    return { ok: false, capabilities: [], unknown: [], hint: '模型选择格式不正确，应为能力名数组。' }
  }
  const normalized = raw.map((item) => String(item == null ? '' : item).trim().toLowerCase()).filter(Boolean)
  if (normalized.includes('all')) {
    return { ok: true, capabilities: [...known], unknown: [], hint: '' }
  }
  const unknown = normalized.filter((name) => !known.includes(name))
  if (unknown.length) {
    return {
      ok: false,
      capabilities: [],
      unknown,
      hint: `不认识的模型能力：${unknown.join('、')}。可选：${known.join('、')}，或选 all。`,
    }
  }
  const unique = [...new Set(normalized)]
  const ordered = sortModelCatalog().map((item) => item.capability).filter((name) => unique.includes(name))
  return { ok: true, capabilities: ordered, unknown: [], hint: '' }
}

/** 勾选的模型总大小（MB）；用于预检磁盘与模型进度。 */
export function selectedModelsMb(capabilities) {
  if (!Array.isArray(capabilities) || !capabilities.length) return 0
  return MODEL_CATALOG
    .filter((item) => capabilities.includes(item.capability))
    .reduce((sum, item) => sum + (Number(item.sizeMb) || 0), 0)
}
