// 产物缓存：TTS wav、分离 stems、视觉关键帧。
//
// 规则（DESIGN 8.7）：
//   - 模型/音频大文件**不写** ~/.dsh 根目录，统一进 cacheDir；
//   - 启动时 + 每 6 小时清理：先删过期（TTL），再按 LRU 删到上限；
//   - 翻译结果、任务列表、日志不缓存。

import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import { copyFileSafe, ensureDir, sha16 } from './fs-util.js'

// tmp：ASR 上传的临时文件（请求结束即删）；voice：用户选择「保留语音」的录音（按 TTL/LRU 清理）。
const childDir = ['tts', 'separate', 'vision', 'tmp', 'voice']

function walkFile(root) {
  const output = []
  const go = (dir) => {
    let item = []
    try { item = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of item) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) go(path)
      else if (entry.isFile()) {
        try {
          const info = statSync(path)
          output.push({ path: path, bytes: info.size, mtimeMs: info.mtimeMs })
        } catch { /* 文件刚好被删 */ }
      }
    }
  }
  go(root)
  return output
}

export class CacheStore {
  constructor({ dir, ttlHours = 72, maxMb = 2048, logger = null } = {}) {
    this.dirPath = String(dir || '')
    this.ttlHours = Number(ttlHours) || 72
    this.maxMb = Number(maxMb) || 2048
    this.logger = logger
    this.timer = null
  }

  setDir(dir) {
    this.dirPath = String(dir || '')
    this.init()
  }

  init() {
    if (!this.dirPath) return false
    ensureDir(this.dirPath)
    for (const child of childDir) ensureDir(join(this.dirPath, child))
    return true
  }

  kindDir(kind) {
    const child = childDir.includes(kind) ? kind : 'tmp'
    return join(this.dirPath, child)
  }

  /** 保存一段二进制，返回本机绝对路径。 */
  saveBuffer(kind, buffer, { ext = '.wav', key = '', ts = Date.now(), name = '' } = {}) {
    this.init()
    const dir = this.kindDir(kind)
    ensureDir(dir)
    const prefix = key ? `${String(key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}-` : ''
    const fileName = name
      ? String(name).replace(/[\\/:*?"<>|]/g, '_')
      : `${prefix}${ts}${ext.startsWith('.') ? ext : `.${ext}`}`
    let path = join(dir, fileName)
    if (existsSync(path)) path = join(dir, `${prefix}${ts}-${Math.random().toString(16).slice(2, 8)}${ext}`)
    writeFileSync(path, buffer)
    return path
  }

  /** 按 key 找已经存在的缓存（用于固定 seed 的 TTS 复用）。 */
  findByKey(kind, key) {
    const dir = this.kindDir(kind)
    const prefix = String(key || '')
    if (!prefix) return ''
    let item = []
    try { item = readdirSync(dir) } catch { return '' }
    const hit = item.find((name) => name.startsWith(`${prefix}-`))
    return hit ? join(dir, hit) : ''
  }

  /** 复制一个服务端文件到缓存目录，返回目标路径。 */
  copyIn(kind, source, { subdir = '', name = '' } = {}) {
    this.init()
    const dir = join(this.kindDir(kind), String(subdir || ''))
    ensureDir(dir)
    const target = join(dir, name || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}${extname(source) || '.bin'}`)
    if (!copyFileSafe(source, target)) return ''
    return target
  }

  /** 给一次任务分配一个独立目录（分离/关键帧用）。 */
  makeJobDir(kind, jobId = '') {
    this.init()
    const id = String(jobId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`).replace(/[^a-zA-Z0-9_-]/g, '')
    const dir = join(this.kindDir(kind), id)
    ensureDir(dir)
    return dir
  }

  /**
   * 清空缓存。
   * - kind 省略：清生成产物（tts / separate / vision / tmp），**保留** voice（用户明确要留的录音）；
   * - kind 指定：只清那一类（可以是 voice）。
   * @returns {{kinds:string[], files:number, bytes:number}}
   */
  clear(kind = '') {
    const specified = String(kind || '').trim()
    if (specified && !childDir.includes(specified)) {
      throw new Error(`未知缓存类型：${specified}`)
    }
    const target = specified ? [specified] : childDir.filter((child) => child !== 'voice')
    const result = { kinds: target, files: 0, bytes: 0 }
    for (const child of target) {
      const dir = this.kindDir(child)
      const file = walkFile(dir)
      result.files += file.length
      result.bytes += file.reduce((and, x) => and + x.bytes, 0)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉就留给 TTL 清理 */ }
    }
    this.init()
    if (result.files || result.bytes) {
      this.logger?.info(`缓存清空：${target.join('/')}，${result.files} 个文件，释放 ${(result.bytes / 1024 / 1024).toFixed(1)} MB`)
    }
    return result
  }

  /** 缓存用量（宿主 /state 与设置页用）。 */
  usage() {
    if (!this.dirPath || !existsSync(this.dirPath)) {
      return { dir: this.dirPath, bytes: 0, mb: 0, files: 0, byKind: {}, ttlHours: this.ttlHours, maxMb: this.maxMb }
    }
    const file = walkFile(this.dirPath)
    const byKind = {}
    let bytes = 0
    for (const fileItem of file) {
      bytes += fileItem.bytes
      const relative = fileItem.path.slice(this.dirPath.length + 1)
      const category = relative.split(/[\\/]/)[0] || 'other'
      byKind[category] = byKind[category] || { bytes: 0, files: 0 }
      byKind[category].bytes += fileItem.bytes
      byKind[category].files += 1
    }
    return {
      dir: this.dirPath,
      bytes,
      mb: Math.round((bytes / 1024 / 1024) * 10) / 10,
      files: file.length,
      byKind,
      ttlHours: this.ttlHours,
      maxMb: this.maxMb,
    }
  }

  /** 先删过期，再按 LRU 删到上限。 */
  cleanup({ now = Date.now() } = {}) {
    const result = { expired: 0, lru: 0, bytesFreed: 0, scanned: 0 }
    if (!this.dirPath || !existsSync(this.dirPath)) return result
    const file = walkFile(this.dirPath)
    result.scanned = file.length
    const deadline = now - this.ttlHours * 3600 * 1000
    const keep = []
    for (const fileItem of file) {
      if (fileItem.mtimeMs < deadline) {
        try { rmSync(fileItem.path, { force: true }); result.expired += 1; result.bytesFreed += fileItem.bytes } catch { /* 删不掉就留 */ }
      } else {
        keep.push(fileItem)
      }
    }
    let totalByte = keep.reduce((and, x) => and + x.bytes, 0)
    const limit = this.maxMb * 1024 * 1024
    if (totalByte > limit) {
      keep.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const fileItem of keep) {
        if (totalByte <= limit) break
        try {
          rmSync(fileItem.path, { force: true })
          totalByte -= fileItem.bytes
          result.lru += 1
          result.bytesFreed += fileItem.bytes
        } catch { /* 删不掉就留 */ }
      }
    }
    // 清理空目录（不删根）
    for (const child of childDir) {
      const dir = join(this.dirPath, child)
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: false, force: true })
      } catch { /* 目录里还有东西或正被使用 */ }
    }
    this.init()
    if (result.expired || result.lru) {
      this.logger?.info(`缓存清理：过期 ${result.expired} 个、LRU ${result.lru} 个，释放 ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`)
    }
    return result
  }

  /** 每 6 小时自动清理；返回停止函数。 */
  startAutoCleanup({ intervalMs = 6 * 3600 * 1000 } = {}) {
    this.stopAutoCleanup()
    this.timer = setInterval(() => {
      try { this.cleanup() } catch (error) { this.logger?.warn(`缓存清理失败：${error?.message || error}`) }
    }, intervalMs)
    this.timer.unref?.()
    return () => this.stopAutoCleanup()
  }

  stopAutoCleanup() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export { sha16 }
