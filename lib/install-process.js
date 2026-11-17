// 安装器的子进程工具：带超时/取消的同步等待，以及 Windows 进程树终止。
//
// 为什么不用 shell 拼串：安装目录可能带空格/中文，参数一律走 argv 数组；
// PowerShell 的 -Command 分支单独转义单引号，不让路径变成命令。

import { spawn, spawnSync } from 'node:child_process'

const outputLimit = 64 * 1024

function appendLimited(current, chunk) {
  const next = current + chunk
  return next.length > outputLimit ? next.slice(next.length - outputLimit) : next
}

/**
 * 杀掉进程树。安装命令（git/pip）与启动脚本（powershell → python）都是多级进程，
 * 只杀直接子进程会留下 pip/python 继续占端口和文件。
 */
export function killProcessTree(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  if (platform === 'win32') {
    try {
      spawnSyncImpl('taskkill', ['/PID', String(id), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-id, 'SIGKILL')
    return true
  } catch {
    try {
      process.kill(id, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

/** 把 argv 排成一行日志（只用于展示，不用于执行）。 */
export function formatCommand(command, args = []) {
  return [command, ...args.map((arg) => {
    const text = String(arg)
    return /\s|"/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
  })].join(' ')
}

/**
 * 跑一条命令并等它结束。
 * @param {object} spec
 * @param {string} spec.command
 * @param {string[]} [spec.args]
 * @param {string} [spec.cwd]
 * @param {object} [spec.env]
 * @param {number} [spec.timeoutMs] 0 = 不限
 * @param {AbortSignal} [spec.signal]
 * @param {(stream:'out'|'err', line:string)=>void} [spec.onLine]
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, error?:Error}>}
 */
export function runProcess(spec, {
  spawnImpl = spawn,
  killTree = killProcessTree,
} = {}) {
  return new Promise((resolve) => {
    const {
      command,
      args = [],
      cwd,
      env = process.env,
      timeoutMs = 300000,
      signal = null,
      onLine = null,
    } = spec || {}

    let child
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', timedOut: false, aborted: false, error })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let timer = null

    const emit = (stream, chunk) => {
      if (!onLine) return
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line) {
          try { onLine(stream, line) } catch { /* 日志行不能影响安装 */ }
        }
      }
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { signal?.removeEventListener?.('abort', onAbort) } catch { /* 已移除 */ }
      resolve(result)
    }

    const onAbort = () => {
      if (settled) return
      aborted = true
      killTree(child.pid)
    }

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }
    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        killTree(child.pid)
      }, Number(timeoutMs))
      timer.unref?.()
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout = appendLimited(stdout, text)
      emit('out', text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr = appendLimited(stderr, text)
      emit('err', text)
    })
    child.on('error', (error) => {
      finish({ ok: false, code: -1, stdout, stderr, timedOut, aborted, error })
    })
    child.on('close', (code) => {
      finish({
        ok: code === 0 && !timedOut && !aborted,
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
        timedOut,
        aborted,
      })
    })
  })
}

/**
 * 后台启动服务：detached + 忽略 stdio，DSH 重启不影响它；
 * 返回 pid 供取消/回滚时杀进程树。
 */
export function spawnBackground(spec, { spawnImpl = spawn } = {}) {
  const { command, args = [], cwd, env = process.env } = spec || {}
  const child = spawnImpl(command, args, {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  child.on?.('error', () => { /* 后台进程的错误靠健康检查发现，这里不能抛 */ })
  child.unref?.()
  return { pid: child.pid, child }
}
