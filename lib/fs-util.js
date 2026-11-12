// 很小的文件工具：读 JSON、原子写 JSON、复制文件、算 hash。
// 状态文件和配置文件最怕“写一半断电”，所以统一走「临时文件 + rename」。
//
// 这里所有函数都是同步的：插件里的读写量很小，同步写更容易保证顺序；
// 真正的耗时操作（HTTP）在 lib/client.js 里是异步的。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

/** 确保目录存在；失败返回 false（调用方决定要不要报错）。 */
export function ensureDir(path) {
  try {
    mkdirSync(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 读 JSON；文件不存在、坏掉、没权限都返回 fallback，不抛。 */
export function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON：先写临时文件，再 rename；Windows 上 rename 被占用时退回直接写。 */
export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const text = JSON.stringify(value, null, 2)
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
    return true
  } catch {
    try {
      writeFileSync(path, text, 'utf8')
      return true
    } catch {
      return false
    } finally {
      try { rmSync(temp, { force: true }) } catch { /* 清不掉就算了 */ }
    }
  }
}

/** 文件大小（字节）；不存在返回 0。 */
export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 复制文件（自动建目标目录）；失败返回 false。 */
export function copyFileSafe(source, target) {
  try {
    ensureDir(dirname(target))
    copyFileSync(source, target)
    return true
  } catch {
    return false
  }
}

/** 删文件；不存在或删不掉都不报错。 */
export function removeFile(path) {
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

/** sha256 前 16 位，用于缓存文件名。 */
export function sha16(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

/** 把 `~` / `~/x` 展开成用户目录（只处理开头，不做环境变量替换）。 */
export function expandHome(path, homeDir) {
  const value = String(path == null ? '' : path).trim()
  if (!value) return ''
  if (value === '~') return homeDir
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homeDir, value.slice(2))
  return value
}

/** 本机绝对路径（Windows 盘符或 UNC 都算）。 */
export function isAbsolutePath(path) {
  const value = String(path == null ? '' : path)
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/**
 * target 是否在 root 目录里面（防目录穿越）。
 * 两边都先 resolve（消掉 `..` / `.`）；Windows 下不区分大小写。
 * 注意：target 等于 root 本身返回 false —— 我们只允许目录里的文件。
 */
export function isPathInside(root, target) {
  const rootDir = String(root == null ? '' : root).trim()
  const targetPath = String(target == null ? '' : target).trim()
  if (!rootDir || !targetPath) return false
  if (targetPath.includes('\0')) return false
  let rootAbsolute
  let targetAbsolute
  try {
    rootAbsolute = resolve(rootDir)
    targetAbsolute = resolve(targetPath)
  } catch {
    return false
  }
  const lowerCase = process.platform === 'win32'
  const compareRoot = lowerCase ? rootAbsolute.toLowerCase() : rootAbsolute
  const compareTarget = lowerCase ? targetAbsolute.toLowerCase() : targetAbsolute
  const separator = process.platform === 'win32' ? '\\' : '/'
  const prefix = compareRoot.endsWith(separator) ? compareRoot : compareRoot + separator
  return compareTarget.startsWith(prefix) && compareTarget.length > prefix.length
}
