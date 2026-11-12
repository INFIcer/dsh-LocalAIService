// 日志：内存环（设置页看最近 200 行）+ 落盘文件（超过 5 MB 滚动一次）。
// 所有写入都包在 try/catch 里：日志坏了不能影响主流程。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const gradeWeight = { debug: 10, info: 20, warn: 30, error: 40 }

export class Logger {
  constructor({ filePath, level = 'info', maxMemory = 200, maxBytes = 5 * 1024 * 1024 } = {}) {
    this.filePath = filePath || ''
    this.level = gradeWeight[level] ? level : 'info'
    this.maxMemory = maxMemory
    this.maxBytes = maxBytes
    this.lines = []
  }

  setLevel(level) {
    if (gradeWeight[level]) this.level = level
  }

  enabled(level) {
    return (gradeWeight[level] || 20) >= (gradeWeight[this.level] || 20)
  }

  log(level, message) {
    const logLevel = gradeWeight[level] ? level : 'info'
    const text = String(message == null ? '' : message).replace(/\r?\n/g, ' ⏎ ')
    const time = new Date()
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    const line = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} `
      + `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)} `
      + `[${logLevel.toUpperCase()}] ${text}`

    this.lines.push(line)
    if (this.lines.length > this.maxMemory) this.lines.splice(0, this.lines.length - this.maxMemory)

    if (!this.enabled(logLevel) || !this.filePath) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath) && statSync(this.filePath).size > this.maxBytes) {
        const prev = `${this.filePath}.1`
        try { if (existsSync(prev)) unlinkSync(prev) } catch { /* 删不掉就继续追加 */ }
        try { renameSync(this.filePath, prev) } catch { /* 滚动失败就继续追加 */ }
      }
      appendFileSync(this.filePath, `${line}\n`, 'utf8')
    } catch {
      // 写不进日志不影响服务。
    }
  }

  debug(msg) { this.log('debug', msg) }
  info(msg) { this.log('info', msg) }
  warn(msg) { this.log('warn', msg) }
  error(msg) { this.log('error', msg) }

  recent(n = 200) {
    const count = Math.max(1, Math.min(1000, Number(n) || 200))
    return this.lines.slice(-count)
  }
}
