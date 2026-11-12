// P2 multipart 解析与音频字段工具（纯函数，离线）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  boundary,
  imageExt,
  imageFile,
  audioExt,
  audioFile,
  isImageExt,
  isAudioExt,
  maxImageBytes,
  maxAudioBytes,
  maxRecordMs,
  parseMultipart,
  readNumberField,
} from '../lib/upload.js'

function buildForm(boundary, segments) {
  const chunk = []
  for (const segment of segments) {
    let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${segment.name}"`
    if (segment.filename) headers += `; filename="${segment.filename}"`
    headers += '\r\n'
    if (segment.type) headers += `Content-Type: ${segment.type}\r\n`
    headers += '\r\n'
    chunk.push(Buffer.from(headers, 'utf8'))
    const data = Buffer.isBuffer(segment.data) ? segment.data : Buffer.from(String(segment.data ?? ''), 'utf8')
    chunk.push(data)
    chunk.push(Buffer.from('\r\n', 'utf8'))
  }
  chunk.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(chunk)
}

test('取边界：带引号/不带引号都能认；非 multipart 返回空串', () => {
  assert.equal(boundary('multipart/form-data; boundary=abc123'), 'abc123')
  assert.equal(boundary('multipart/form-data; boundary="a b-c"'), 'a b-c')
  assert.equal(boundary('application/json'), '')
  assert.equal(boundary(''), '')
})

test('解析multipart：字段 + 文件（二进制原样）', () => {
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff])
  const body = buildForm('BOUND', [
    { name: 'language', data: 'zh' },
    { name: 'durationMs', data: '3200' },
    { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: audio },
  ])
  const r = parseMultipart(body, 'multipart/form-data; boundary=BOUND')
  assert.equal(r.fields.language, 'zh')
  assert.equal(r.fields.durationMs, '3200')
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].field, 'file')
  assert.equal(r.files[0].filename, 'voice.webm')
  assert.equal(r.files[0].contentType, 'audio/webm')
  assert.deepEqual([...r.files[0].data], [...audio])
})

test('解析multipart：filename* / 中文文件名不炸，字段按 UTF-8 读', () => {
  const body = buildForm('X', [
    { name: 'note', data: '你好' },
    { name: 'file', filename: '录音 1.wav', type: 'audio/wav', data: Buffer.from('RIFF') },
  ])
  const r = parseMultipart(body, 'multipart/form-data; boundary=X')
  assert.equal(r.fields.note, '你好')
  assert.equal(r.files[0].filename, '录音 1.wav')
})

test('解析multipart：空体 / 错边界安全返回空结果', () => {
  assert.deepEqual(parseMultipart(Buffer.alloc(0), 'multipart/form-data; boundary=X'), { fields: {}, files: [] })
  assert.deepEqual(parseMultipart(Buffer.from('junk'), 'multipart/form-data; boundary=X'), { fields: {}, files: [] })
  assert.deepEqual(parseMultipart(Buffer.from('junk'), 'text/plain'), { fields: {}, files: [] })
})

test('取音频文件：优先 file / audio 字段，其次第一个文件', () => {
  const result = {
    files: [
      { field: 'thumb', filename: 'a.png', data: Buffer.from('x') },
      { field: 'audio', filename: 'b.webm', data: Buffer.from('y') },
    ],
  }
  assert.equal(audioFile(result).field, 'audio')
  assert.equal(audioFile({ files: [{ field: 'other' }] }).field, 'other')
  assert.equal(audioFile({ files: [] }), null)
  assert.equal(audioFile(null), null)
})

test('取音频扩展：MIME 优先，其次文件名，未知回退 .webm', () => {
  assert.equal(audioExt('audio/wav', 'x.bin'), '.wav')
  assert.equal(audioExt('audio/webm;codecs=opus', 'x'), '.webm')
  assert.equal(audioExt('audio/ogg', 'x.opus'), '.ogg')
  assert.equal(audioExt('application/octet-stream', '录音.WAV'), '.wav')
  assert.equal(audioExt('', 'x.mp4'), '.m4a')
  assert.equal(audioExt('', 'x.unknown'), '.webm')
})

test('是音频扩展 与 常量', () => {
  assert.equal(isAudioExt('a.wav'), true)
  assert.equal(isAudioExt('a.WEBM'), true)
  assert.equal(isAudioExt('a.txt'), false)
  assert.equal(maxAudioBytes, 25 * 1024 * 1024)
  assert.equal(maxRecordMs, 5 * 60 * 1000)
  assert.equal(readNumberField('3000', 0), 3000)
  assert.equal(readNumberField('abc', 7), 7)
  assert.equal(readNumberField(undefined, 7), 7)
})
test('图片：取图片文件 / 取图片扩展 / 是图片扩展 / 上限', () => {
  const result = {
    files: [
      { field: 'thumb', filename: 'a.png', data: Buffer.from('x') },
      { field: 'image', filename: 'b.webp', data: Buffer.from('y') },
    ],
  }
  assert.equal(imageFile(result).field, 'image')
  assert.equal(imageFile({ files: [{ field: 'other', filename: 'c.gif' }] }).field, 'other')
  assert.equal(imageFile({ files: [] }), null)
  assert.equal(imageFile(null), null)

  assert.equal(imageExt('image/png', 'x.bin'), '.png')
  assert.equal(imageExt('image/jpeg; charset=binary', 'x'), '.jpg')
  assert.equal(imageExt('image/x-ms-bmp', 'x'), '.bmp')
  assert.equal(imageExt('application/octet-stream', '照片.JPEG'), '.jpg')
  assert.equal(imageExt('application/octet-stream', 'x.webp'), '.webp')
  assert.equal(imageExt('text/plain', 'x.txt'), '')
  assert.equal(imageExt('', ''), '')

  assert.equal(isImageExt('a.png'), true)
  assert.equal(isImageExt('a.JPEG'), true)
  assert.equal(isImageExt('a.wav'), false)
  assert.equal(isImageExt(''), false)
  assert.equal(maxImageBytes, 15 * 1024 * 1024)
})
