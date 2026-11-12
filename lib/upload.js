// multipart/form-data 的最小解析器（P2 语音上传用）。
//
// 浏览器用 FormData 上传录音；这里不引入 busboy/ formidable 之类依赖，
// 只用 Node 内置 Buffer + indexOf 手写一份，够用且能离线单测。
//
// 限制：只处理一层 multipart，字段值按 UTF-8 文本；文件按二进制原样保留。
// 上传大小由调用方在读请求体时限制（见 lib/routes.js 的 读原始体）。

import { extname } from 'node:path'

export const maxAudioBytes = 25 * 1024 * 1024
export const maxRecordMs = 5 * 60 * 1000
/** 识图上传的图片上限；超过就拒绝，别把 4K 原图整张读进内存。 */
export const maxImageBytes = 15 * 1024 * 1024

const audioExtensions = new Set(['.webm', '.ogg', '.opus', '.wav', '.mp3', '.m4a', '.mp4', '.aac', '.flac'])

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

const mimeExt = {
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
}

/** 从 content-type 里取 boundary；没有就返回空串。 */
export function boundary(contentType) {
  const value = String(contentType || '')
  if (!/^multipart\/form-data/i.test(value)) return ''
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value)
  const boundaryToken = (match && (match[1] || match[2]) || '').trim()
  return boundaryToken
}

function parseHeaders(text) {
  const headers = {}
  for (const line of String(text || '').split('\r\n')) {
    const position = line.indexOf(':')
    if (position <= 0) continue
    headers[line.slice(0, position).trim().toLowerCase()] = line.slice(position + 1).trim()
  }
  return headers
}

function parseHandle(value) {
  const output = { name: '', filename: '' }
  const text = String(value || '')
  const name = /name\s*=\s*"([^"]*)"/i.exec(text) || /name\s*=\s*([^;]+)/i.exec(text)
  const file = /filename\s*=\s*"([^"]*)"/i.exec(text) || /filename\s*=\s*([^;]+)/i.exec(text)
  if (name) output.name = name[1]
  if (file) output.filename = file[1]
  return output
}

/**
 * 解析 multipart 请求体。
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {{fields: Record<string,string>, files: Array<{field:string, filename:string, contentType:string, data:Buffer}>}}
 */
export function parseMultipart(buffer, contentType) {
  const boundaryToken = boundary(contentType)
  const result = { fields: {}, files: [] }
  if (!boundaryToken || !Buffer.isBuffer(buffer) || buffer.length === 0) return result

  const separator = Buffer.from(`--${boundaryToken}`)
  let position = buffer.indexOf(separator)
  while (position !== -1) {
    position += separator.length
    // 结束标记 --boundary--
    if (buffer[position] === 0x2d && buffer[position + 1] === 0x2d) break
    if (buffer[position] === 0x0d && buffer[position + 1] === 0x0a) position += 2
    else if (buffer[position] === 0x0a) position += 1

    const headersFinish = buffer.indexOf('\r\n\r\n', position)
    if (headersFinish === -1) break
    const headersText = buffer.subarray(position, headersFinish).toString('utf8')
    const next = buffer.indexOf(separator, headersFinish + 4)
    if (next === -1) break

    let dataFinish = next
    // 分隔符前面固定有 \r\n。
    if (buffer[dataFinish - 2] === 0x0d && buffer[dataFinish - 1] === 0x0a) dataFinish -= 2
    else if (buffer[dataFinish - 1] === 0x0a) dataFinish -= 1

    const data = buffer.subarray(headersFinish + 4, dataFinish)
    const headers = parseHeaders(headersText)
    const handle = parseHandle(headers['content-disposition'])
    if (handle.name) {
      if (handle.filename) {
        result.files.push({
          field: handle.name,
          filename: handle.filename,
          contentType: headers['content-type'] || 'application/octet-stream',
          data: Buffer.from(data),
        })
      } else {
        result.fields[handle.name] = data.toString('utf8')
      }
    }
    position = next
  }
  return result
}

/** 找上传的音频文件：优先 file/audio 字段，其次第一个文件。 */
export function audioFile(parseResult) {
  if (!parseResult || !Array.isArray(parseResult.files)) return null
  return parseResult.files.find((x) => x.field === 'file' || x.field === 'audio')
    || parseResult.files[0]
    || null
}

/** 依 MIME / 文件名推一个安全扩展名。 */
export function audioExt(mime, filename) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase()
  if (mimeExt[type]) return mimeExt[type]
  const ext = extname(String(filename || '')).toLowerCase()
  // 音频容器是 mp4 时统一存成 .m4a（/audio 只认 .m4a 这个扩展名）。
  if (ext === '.mp4') return '.m4a'
  if (audioExtensions.has(ext)) return ext
  return '.webm'
}

/** 只看扩展名判断是不是我们愿意接收的音频。 */
export function isAudioExt(path) {
  return audioExtensions.has(extname(String(path || '')).toLowerCase())
}

/** 读 multipart 里的数值字段（缺省/非法返回兜底）。 */
export function readNumberField(field, fallback = 0) {
  const n = Number(field)
  return Number.isFinite(n) ? n : fallback
}

// 图片：MIME 与扩展名两张表，服务端只认这几种（与 /vision/describe 一致）。

const imageMIMEExt = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
}

/** 找上传的图片文件：优先 file/image 字段，其次第一个文件。 */
export function imageFile(parseResult) {
  if (!parseResult || !Array.isArray(parseResult.files)) return null
  return parseResult.files.find((x) => x.field === 'file' || x.field === 'image')
    || parseResult.files[0]
    || null
}

/**
 * 依 MIME / 文件名推一个图片扩展名；不是图片返回空串。
 * @param {string} mime - 请求里的 content-type。
 * @param {string} filename - 原始文件名。
 * @returns {string} 形如 `.png`；认不出返回 ''。
 */
export function imageExt(mime, filename) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase()
  if (imageMIMEExt[type]) return imageMIMEExt[type]
  const ext = extname(String(filename || '')).toLowerCase()
  return imageExtensions.has(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : ''
}

/** 只看扩展名判断是不是图片。 */
export function isImageExt(path) {
  const ext = extname(String(path || '')).toLowerCase()
  return ext === '.jpeg' || imageExtensions.has(ext)
}
