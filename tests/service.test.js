// fish.service：健康、8 类调用、任务、配置、ensureReady、错误映射、宿主装配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  CAPABILITIES_BODY,
  makeStack,
  basicHandler,
  sendBuffer,
  sendJson,
  startMock,
  writeTempFile,
} from './helpers.js'
import { apply } from '../lib/host.js'
import { defaultVisionPrompt, defaultSessionVisionPrompt } from '../lib/vision-presets.js'

function parseBody(rec) {
  try { return JSON.parse(rec.body.toString('utf8') || '{}') } catch { return {} }
}

test('health() / capabilities 符合契约，capabilities 是同步属性', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  assert.equal(stack.api.apiVersion, '1.0')
  assert.equal(stack.api.pluginVersion, '0.1.0')
  assert.equal(stack.api.capabilities.tts.available, false) // 还没探测

  const health = await stack.api.health()
  assert.equal(health.ok, true)
  assert.equal(health.serviceVersion, '2.5.0')
  assert.equal(health.apiVersion, '1')
  assert.equal(health.capabilities.tts.available, true)
  assert.equal(stack.api.capabilities.tts.model, 'IndexTTS-2.5')

  const caps = await stack.api.capabilitiesAsync()
  assert.equal(caps.asr.ready, true)
  assert.equal(typeof stack.api.health, 'function')
  assert.equal(typeof stack.api.ensureReady, 'function')
  assert.equal(typeof stack.api.voices, 'function')
  assert.equal(typeof stack.api.config.set, 'function')
})

test('tts：批量写缓存、只返回路径与指标、同 seed 复用缓存', async (t) => {
  const sent = []
  const handler = basicHandler({
    '/tts': (req, res, rec) => {
      const body = parseBody(rec)
      sent.push(body)
      sendBuffer(res, 200, Buffer.from(`RIFF-${body.text}`), {
        'content-type': 'audio/wav',
        'x-seed': String(body.seed ?? 99),
        'x-language': 'zh',
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const first = await stack.api.tts(['你好', '世界'], { voice: 'dafeiyu', seed: 42, speed: 1.1 })
  assert.equal(first.ok, true)
  assert.equal(first.items.length, 2)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].voice, 'dafeiyu')
  assert.equal(sent[0].seed, 42)
  assert.equal(sent[0].speed, 1.1)
  for (const item of first.items) {
    assert.ok(existsSync(item.wavPath))
    assert.ok(item.wavPath.startsWith(join(stack.store.current.cacheDir, 'tts')))
    assert.equal(item.voice, 'dafeiyu')
    assert.equal(item.seed, 42)
    assert.equal(typeof item.bytes, 'number')
    assert.equal(item.cached, false)
  }
  assert.equal('buffer' in first.items[0], false)
  assert.equal(JSON.stringify(first).includes('base64'), false)

  const second = await stack.api.tts(['你好', '世界'], { voice: 'dafeiyu', seed: 42, speed: 1.1 })
  assert.equal(sent.length, 2) // 第二次不再请求
  assert.equal(second.items[0].cached, true)
  assert.equal(second.items[0].ms, 0)
  assert.equal(second.items[0].wavPath, first.items[0].wavPath)
})

test('tts：合成前统一朗读化，缓存按改写后的文本命中', async (t) => {
  const sent = []
  const handler = basicHandler({
    '/tts': (req, res, rec) => {
      const body = parseBody(rec)
      sent.push(body)
      sendBuffer(res, 200, Buffer.from(`RIFF-${body.text}`), {
        'content-type': 'audio/wav',
        'x-seed': '3',
        'x-language': 'zh',
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const result = await stack.api.tts([
    '版本 2.5.0 已发布，延迟 69ms。',
    '| 名称 | 版本 |\n| --- | --- |\n| 内核 | 2.5.0 |',
    '\u0060lastBoot.confirmed=true\u0060 不用念。',
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(sent.map((body) => body.text), [
    '版本二点五点零已发布，延迟六十九毫秒。',
    '名称，版本。内核，二点五点零',
    '巴拉巴拉不用念。',
  ])
  assert.ok(sent[2].text.includes('巴拉巴拉'), sent[2].text)
  assert.ok(!sent[2].text.includes('lastBoot'), sent[2].text)
  assert.ok(!sent[2].text.includes('`'), sent[2].text)

  // 同一段内容换成朗读化后的写法再合成：同样的缓存 key，不再请求服务端。
  const again = await stack.api.tts(['版本二点五点零已发布，延迟六十九毫秒。'])
  assert.equal(sent.length, 3)
  assert.equal(again.items[0].cached, true)
  assert.equal(again.items[0].wavPath, result.items[0].wavPath)
})

test('tts：清洗后没有可朗读内容、或朗读化后超长都返回 bad_request', async (t) => {
  const handler = basicHandler({
    '/tts': (req, res) => sendBuffer(res, 200, Buffer.from('RIFF'), { 'content-type': 'audio/wav' }),
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  await assert.rejects(stack.api.tts(['\u0060\u0060\u0060js\nconst a = 1\n\u0060\u0060\u0060']), (error) => {
    assert.equal(error.code, 'bad_request')
    assert.match(error.hint, /可朗读/)
    return true
  })
  // 原文 4004 字没超上限，朗读化后 5005 字才超：长度校验按改写后的文本算。
  const crowded = '69ms'.repeat(1001)
  await assert.rejects(stack.api.tts([crowded]), (error) => {
    assert.equal(error.code, 'bad_request')
    assert.match(error.hint, /朗读化后/)
    return true
  })
})

test('tts：不传 seed 也查缓存；换音色/语速不命中；统计单调增长、清空后重新合成', async (t) => {
  const sent = []
  const handler = basicHandler({
    '/tts': (req, res, rec) => {
      const body = parseBody(rec)
      sent.push(body)
      sendBuffer(res, 200, Buffer.from(`RIFF-${body.text}-${body.voice}-${body.speed ?? ''}`), {
        'content-type': 'audio/wav',
        'x-seed': '11',
        'x-language': 'zh',
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const one = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(one.items[0].cached, false)
  assert.equal(one.items[0].seed, 11) // 不传 seed 时服务端随机，用响应头 x-seed 回填
  assert.equal(sent.length, 1)
  const stats0 = stack.api.cache.stats()
  assert.deepEqual(
    { hits: stats0.hits, misses: stats0.misses, hitRate: stats0.hitRate, kind: stats0.kind },
    { hits: 0, misses: 1, hitRate: 0, kind: 'tts' },
  )
  assert.equal(stats0.files, 1)
  assert.ok(stats0.bytes > 0)

  const two = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(sent.length, 1) // 第二次不再发 HTTP
  assert.equal(two.items[0].cached, true)
  assert.equal(two.items[0].ms, 0)
  assert.equal(two.items[0].wavPath, one.items[0].wavPath)
  assert.equal(two.items[0].bytes, one.items[0].bytes)

  const stats1 = stack.api.cache.stats()
  assert.equal(stats1.hits, 1)
  assert.equal(stats1.misses, 1)
  assert.equal(stats1.hitRate, 0.5)

  const three = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(three.items[0].cached, true)
  const stats2 = stack.api.cache.stats()
  assert.ok(stats2.hitRate > stats1.hitRate) // 命中率单调增长
  assert.equal(stats2.files, 1) // 同一个文件不重复计数

  // 换音色 / 换语速 → key 变了，必须重新合成
  const swapVoice = await stack.api.tts('同一句话', { voice: 'default', speed: 1.2 })
  assert.equal(swapVoice.items[0].cached, false)
  const swapSpeed = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.5 })
  assert.equal(swapSpeed.items[0].cached, false)
  assert.equal(sent.length, 3)
  assert.equal(stack.api.cache.stats().misses, 3)
  assert.equal(stack.api.cache.stats().files, 3)
  assert.equal(sent[2].speed, 1.5)

  // 清空 TTS 缓存 → 再合成是 miss；文件账本清零，历史命中计数保留
  const clear = stack.api.cache.clear({ kind: 'tts' })
  assert.equal(clear.ok, true)
  assert.equal(clear.kind, 'tts')
  assert.equal(clear.files, 3)
  assert.equal(stack.api.cache.stats().files, 0)
  assert.equal(stack.api.cache.stats().hits, 2)
  assert.equal(stack.api.cache.stats().misses, 3)

  const clearAfter = await stack.api.tts('同一句话', { voice: 'dafeiyu', speed: 1.2 })
  assert.equal(clearAfter.items[0].cached, false)
  assert.equal(sent.length, 4)
  assert.equal(stack.api.cache.stats().files, 1)

  await assert.rejects(async () => stack.api.cache.clear({ kind: 'nope' }), (e) => e.code === 'bad_request')
  const cleanup = stack.api.cache.cleanup()
  assert.equal(cleanup.ok, true)
  assert.equal(typeof cleanup.expired, 'number')
  assert.equal(typeof cleanup.lru, 'number')
})

test('tts：固定 seed 和自动（无 seed）的缓存互不串用', async (t) => {
  const sent = []
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res, rec) => {
        const body = parseBody(rec)
        sent.push(body)
        sendBuffer(res, 200, Buffer.from(`RIFF-${body.seed ?? 'auto'}`), {
          'content-type': 'audio/wav',
          'x-seed': String(body.seed ?? 77),
        })
      },
    }),
  })
  t.after(() => stack.close())

  const auto = await stack.api.tts('一句话', { voice: 'dafeiyu', speed: 1 })
  const fixed = await stack.api.tts('一句话', { voice: 'dafeiyu', speed: 1, seed: 5 })
  assert.equal(auto.items[0].cached, false)
  assert.equal(fixed.items[0].cached, false)
  assert.equal(sent.length, 2)
  assert.equal(fixed.items[0].wavPath === auto.items[0].wavPath, false)
  assert.equal(auto.items[0].seed, 77) // 服务端 x-seed 回填
  assert.equal(fixed.items[0].seed, 5)
})

test('tts：21 条 / 空文本 / 超长 / speed / language 都返回 bad_request', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())
  await stack.api.health()

  await assert.rejects(stack.api.tts(Array.from({ length: 21 }, () => 'x')), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['']), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['x'.repeat(5001)]), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['hi'], { speed: 3 }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts(['hi'], { language: 'fr' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.tts([]), (e) => e.code === 'bad_request')
})

test('asr：返回文字/分段；timestamps 走 /asr/segments；文件不存在 → bad_request', async (t) => {
  const seen = []
  const handler = basicHandler({
    '/asr': (req, res, rec) => {
      seen.push({ path: rec.path, contentType: rec.headers['content-type'] })
      sendJson(res, 200, {
        ok: true,
        text: '你好世界',
        language: 'zh',
        engine: 'sensevoice',
        duration: 1.5,
        elapsed_ms: 120,
        emotion: 'HAPPY',
        events: ['Speech', 'Laughter'],
      })
    },
    '/asr/segments': (req, res, rec) => {
      seen.push({ path: rec.path })
      sendJson(res, 200, {
        ok: true,
        text: '分段文本',
        language: 'zh',
        engine: 'whisper',
        segments: [
          { start: 0, end: 1, text: '第一段' },
          { start: 1, end: 2, text: '第二段' },
        ],
      })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())
  const wav = writeTempFile(stack.temp.dir, 'a.wav', 'RIFF')

  const r = await stack.api.asr([wav])
  assert.equal(r.ok, true)
  assert.equal(r.items[0].file, wav)
  assert.equal(r.items[0].text, '你好世界')
  assert.equal(r.items[0].durationMs, 1500)
  assert.equal(r.items[0].elapsedMs, 120)
  assert.equal(r.items[0].emotion, 'HAPPY')
  assert.deepEqual(r.items[0].events, ['Speech', 'Laughter'])
  assert.ok(seen[0].contentType.startsWith('multipart/form-data'))

  const seg = await stack.api.asr([wav], { timestamps: true })
  assert.equal(seg.items[0].segments.length, 2)
  assert.equal(seen[1].path, '/asr/segments')
  assert.equal(JSON.stringify(seg).includes('base64'), false)

  await assert.rejects(stack.api.asr(['C:\\不存在的文件.wav']), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.asr(['相对路径.wav']), (e) => e.code === 'bad_request')
})

test('translate：单条 / 批量、顺序一致、上限校验', async (t) => {
  const handler = basicHandler({
    '/translate': (req, res, rec) => {
      const body = parseBody(rec)
      sendJson(res, 200, { ok: true, text: `译:${body.text}`, source: body.source, target: body.target, chunks: 1 })
    },
    '/translate/batch': (req, res, rec) => {
      const body = parseBody(rec)
      sendJson(res, 200, { ok: true, texts: body.texts.map((x) => `译:${x}`), source: body.source, target: body.target })
    },
  })
  const stack = await makeStack({ handler })
  t.after(() => stack.close())

  const one = await stack.api.translate('hello', { source: 'auto', target: 'zh' })
  assert.equal(one.texts[0], '译:hello')
  assert.equal(one.engine, 'nllb')

  const many = await stack.api.translate(['a', 'b', 'c'], { source: 'en', target: 'zh' })
  assert.deepEqual(many.texts, ['译:a', '译:b', '译:c'])

  // 空字符串原样返回，且不发给服务端（顺序不变）
  const requestFront = stack.mock.requests.filter((x) => x.path.startsWith('/translate')).length
  const mixed = await stack.api.translate(['', 'a', ''], { source: 'en', target: 'zh' })
  assert.deepEqual(mixed.texts, ['', '译:a', ''])
  const requestAfter = stack.mock.requests.filter((x) => x.path.startsWith('/translate')).length
  assert.equal(requestAfter - requestFront, 1)
  const allEmpty = await stack.api.translate(['', ''], { target: 'zh' })
  assert.deepEqual(allEmpty.texts, ['', ''])
  assert.equal(stack.mock.requests.filter((x) => x.path.startsWith('/translate')).length, requestAfter)

  await assert.rejects(stack.api.translate(['x'], { target: 'auto' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translate(Array.from({ length: 501 }, () => 'x'), { target: 'zh' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translate(Array.from({ length: 41 }, () => 'x'.repeat(5000)), { target: 'zh' }), (e) => e.code === 'bad_request')
})

test('translate：不传 target 时按第一/第二语言自动选，检测结果作为 source', async (t) => {
  const collect = []
  const stack = await makeStack({
    config: { primaryLanguage: 'zh', secondaryLanguage: 'en' },
    handler: basicHandler({
      '/translate': (req, res, rec) => {
        const body = parseBody(rec)
        collect.push(body)
        sendJson(res, 200, { ok: true, text: `译:${body.text}`, source: body.source, target: body.target })
      },
    }),
  })
  t.after(() => stack.close())

  // 中文原文 = 第一语言 → 译成第二语言；source 检测为 zh。
  const middle = await stack.api.translate('你好，世界', {})
  assert.equal(middle.target, 'en')
  assert.equal(middle.source, 'zh')
  assert.equal(collect.at(-1).target, 'en')
  assert.equal(collect.at(-1).source, 'zh')

  // 英文原文 ≠ 第一语言 → 译成第一语言。
  const english = await stack.api.translate('hello world', {})
  assert.equal(english.target, 'zh')
  assert.equal(english.source, 'en')

  // 日文 → 第一语言。
  const day = await stack.api.translate('こんにちは', {})
  assert.equal(day.target, 'zh')
  assert.equal(day.source, 'ja')

  // 显式 target 优先：中文原文也可以显式译成日文。
  const explicit = await stack.api.translate('你好', { target: 'ja' })
  assert.equal(explicit.target, 'ja')
  assert.equal(collect.at(-1).target, 'ja')

  // 显式 source 优先于检测。
  const explicitSource = await stack.api.translate('hello', { source: 'ja', target: 'zh' })
  assert.equal(explicitSource.source, 'ja')

  // 检测不出 → 第一语言；source 传 auto。
  const empty = await stack.api.translate('12345', {})
  assert.equal(empty.target, 'zh')
  assert.equal(empty.source, 'auto')
})

test('visionDescribe：逐张调 /vision/describe，caption 跟默认档提示，score 不传', async (t) => {
  const request = []
  const image = (name) => writeTempFile(temp.dir, name, 'png-bytes')
  const stack = await makeStack({
    handler: basicHandler({
      '/vision/describe': (req, res, rec) => {
        request.push(rec)
        sendJson(res, 200, { ok: true, text: '{"caption":"窗台上的猫"}', parsed: { caption: '窗台上的猫' }, elapsed_ms: 37 })
      },
    }),
  })
  const temp = stack.temp
  t.after(() => stack.close())

  const a = image('a.png')
  const b = image('b.jpg')
  const r = await stack.api.visionDescribe([a, b])
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.deepEqual(r.items.map((x) => x.path), [a, b])
  assert.equal(r.items[0].text, '{"caption":"窗台上的猫"}')
  assert.deepEqual(r.items[0].parsed, { caption: '窗台上的猫' })
  assert.equal(r.items[0].ms, 37)
  assert.equal(request.length, 2)
  assert.match(request[0].headers['content-type'], /multipart\/form-data/)
  assert.match(request[0].body.toString('utf8'), /name="file"; filename="a\.png"/)
  // caption 必须有提示词覆盖服务端评分提示，默认档是「详细」。
  assert.match(request[0].body.toString('utf8'), /name="prompt"/)
  assert.ok(request[0].body.toString('utf8').replace(/\r\n/g, '\n').includes(defaultVisionPrompt.detailed))
  // score 保持服务端默认。
  await stack.api.visionDescribe(a, { mode: 'score' })
  assert.equal(request.at(-1).body.toString('utf8').includes('name="prompt"'), false)
  // 自定义 prompt 覆盖默认。
  await stack.api.visionDescribe(a, { mode: 'caption', prompt: '这是什么？' })
  assert.match(request.at(-1).body.toString('utf8'), /这是什么？/)
})

test('visionDescribe：最多 10 张、缺文件、非图片扩展名都拒绝', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())
  const image = writeTempFile(stack.temp.dir, 'a.png', 'x')
  await assert.rejects(
    stack.api.visionDescribe(Array.from({ length: 11 }, (_, i) => `${stack.temp.dir}\\${i}.png`)),
    (e) => e.code === 'bad_request',
  )
  await assert.rejects(stack.api.visionDescribe(join(stack.temp.dir, '不存在.png')), (e) => e.code === 'bad_request')
  const text = writeTempFile(stack.temp.dir, 'a.txt', 'x')
  await assert.rejects(stack.api.visionDescribe(text), (e) => e.code === 'bad_request')
  assert.ok(existsSync(image))
})

test('visionDescribe：prompt > preset > 配置默认档，ocr 固定只看文字档', async (t) => {
  const request = []
  const stack = await makeStack({
    handler: basicHandler({
      '/vision/describe': (req, res, rec) => {
        request.push(rec)
        sendJson(res, 200, { ok: true, text: '描述', elapsed_ms: 2 })
      },
    }),
  })
  t.after(() => stack.close())
  const image = writeTempFile(stack.temp.dir, 'a.png', 'x')
  const promptField = (rec) => {
    const text = rec.body.toString('utf8')
    const match = text.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/)
    // multipart 文本字段会把换行规范成 CRLF，比较前统一。
    return match ? match[1].replace(/\r\n/g, '\n') : ''
  }

  await stack.api.visionDescribe(image)
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.detailed)

  await stack.api.visionDescribe(image, { preset: 'brief' })
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.brief)

  // 中文档位名也认。
  await stack.api.visionDescribe(image, { preset: '详细' })
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.detailed)

  // 非法档位静默回配置默认档，不报错。
  await stack.api.visionDescribe(image, { preset: '不存在的档' })
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.detailed)

  // 显式 prompt 压过 preset。
  await stack.api.visionDescribe(image, { preset: 'brief', prompt: '只看猫' })
  assert.equal(promptField(request.at(-1)), '只看猫')

  // 旧 mode 兼容：ocr 固定「只看文字」，即使同时给了别的档位。
  await stack.api.visionDescribe(image, { mode: 'ocr', preset: 'brief' })
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.text)

  // 配置里改过的档位提示词优先于内置默认。
  await stack.api.config.set({ visionPresets: { brief: '我的简短提示' } })
  await stack.api.visionDescribe(image, { preset: 'brief' })
  assert.equal(promptField(request.at(-1)), '我的简短提示')

  // 默认档位跟着配置走。
  await stack.api.config.set({ visionDefaultPreset: 'standard' })
  await stack.api.visionDescribe(image)
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.standard)
})

test('visionDescribe：scope=session 用会话识图提示词，与工具档位互不覆盖', async (t) => {
  const request = []
  const stack = await makeStack({
    handler: basicHandler({
      '/vision/describe': (req, res, rec) => {
        request.push(rec)
        sendJson(res, 200, { ok: true, text: '描述', elapsed_ms: 2 })
      },
    }),
  })
  t.after(() => stack.close())
  const image = writeTempFile(stack.temp.dir, 'a.png', 'x')
  const promptField = (rec) => {
    const text = rec.body.toString('utf8')
    const match = text.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/)
    // multipart 文本字段会把换行规范成 CRLF，比较前统一。
    return match ? match[1].replace(/\r\n/g, '\n') : ''
  }

  // 会话识图的默认提示词与「详细」档一致。
  await stack.api.visionDescribe(image, { scope: 'session' })
  assert.equal(promptField(request.at(-1)), defaultSessionVisionPrompt)
  assert.equal(defaultSessionVisionPrompt, defaultVisionPrompt.detailed)

  // 会话识图不吃工具档位：同时给 preset 也走会话提示词。
  await stack.api.visionDescribe(image, { scope: 'session', preset: 'brief' })
  assert.equal(promptField(request.at(-1)), defaultSessionVisionPrompt)

  // 单独改会话识图提示词，工具档位不受影响。
  await stack.api.config.set({ visionSessionPrompt: '请用一句话说图。' })
  await stack.api.visionDescribe(image, { scope: 'session' })
  assert.equal(promptField(request.at(-1)), '请用一句话说图。')
  await stack.api.visionDescribe(image, { preset: 'brief' })
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.brief)

  // 显式 prompt 仍压过会话提示词；ocr 仍固定只看文字。
  await stack.api.visionDescribe(image, { scope: 'session', prompt: '只看猫' })
  assert.equal(promptField(request.at(-1)), '只看猫')
  await stack.api.visionDescribe(image, { scope: 'session', mode: 'ocr' })
  assert.equal(promptField(request.at(-1)), defaultVisionPrompt.text)
})

test('config.set：识图档位非法回默认，提示词只认四档且超长截断', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const badPreset = await stack.api.config.set({ visionDefaultPreset: '特写' })
  assert.equal(badPreset.ok, true)
  assert.ok(badPreset.warnings.some((x) => x.includes('已恢复默认')))
  assert.equal(stack.api.config.get().visionDefaultPreset, 'detailed')

  const session = await stack.api.config.set({ visionSessionPrompt: '  我的会话提示  ' })
  assert.equal(session.ok, true)
  assert.equal(stack.api.config.get().visionSessionPrompt, '我的会话提示')

  const sessionExceedLength = await stack.api.config.set({ visionSessionPrompt: '很'.repeat(4100) })
  assert.equal(sessionExceedLength.ok, true)
  assert.ok(sessionExceedLength.warnings.some((x) => x.includes('已截断')))
  assert.equal(stack.api.config.get().visionSessionPrompt.length, 4000)

  const prompt = await stack.api.config.set({
    visionPresets: { brief: '一句话', foo: '不该收', detailed: 42 },
  })
  assert.equal(prompt.ok, true)
  assert.ok(prompt.warnings.some((x) => x.includes('已忽略')))
  const presets = stack.api.config.get().visionPresets
  assert.equal(presets.brief, '一句话')
  assert.equal(presets.detailed, defaultVisionPrompt.detailed)
  assert.equal(presets.foo, undefined)

  const exceedLength = await stack.api.config.set({ visionPresets: { brief: '很'.repeat(4100) } })
  assert.equal(exceedLength.ok, true)
  assert.ok(exceedLength.warnings.some((x) => x.includes('已截断')))
  assert.equal(stack.api.config.get().visionPresets.brief.length, 4000)
})

test('visionPrefs：默认关、随配置变、可经 config.set 写入；不探服务', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  // 只读本地配置：服务一次都没探过，也要直接返回。
  assert.deepEqual(stack.api.visionPrefs(), {
    localDescribe: false,
    visionSessionReady: false,
    visionSessionPrompt: '',
    visionDefaultPreset: 'detailed',
  })
  assert.equal(stack.api.config.get().localDescribe, false)

  const result = await stack.api.config.set({ localDescribe: true, visionSessionPrompt: '我的会话提示' })
  assert.equal(result.ok, true)
  assert.ok(result.applied.includes('localDescribe'))
  assert.deepEqual(stack.api.visionPrefs(), {
    localDescribe: true,
    visionSessionReady: true,
    visionSessionPrompt: '我的会话提示',
    visionDefaultPreset: 'detailed',
  })

  // 只认明确的开：其它值一律按关（与其它布尔字段一致）。
  const off = await stack.api.config.set({ localDescribe: 0 })
  assert.equal(off.ok, true)
  assert.deepEqual(stack.api.visionPrefs(), {
    localDescribe: false,
    visionSessionReady: false,
    visionSessionPrompt: '',
    visionDefaultPreset: 'detailed',
  })

  await stack.api.config.set({ localDescribe: 1 })
  assert.equal(stack.api.visionPrefs().localDescribe, true)
  assert.equal(stack.api.visionPrefs().visionSessionReady, true)
  assert.equal(stack.api.visionPrefs().visionSessionPrompt, '我的会话提示')
})

test('separate：复制 stems 到缓存、返回 dir；未知 stem 拒绝', async (t) => {
  let sourceDir = ''
  const stack = await makeStack({
    handler: basicHandler({
      '/separate': (req, res) => {
        sendJson(res, 200, {
          ok: true,
          stems: {
            vocals: { path: join(sourceDir, 'src-vocals.wav'), duration: 1.2 },
            drums: { path: join(sourceDir, 'src-drums.wav') },
          },
          released_models: ['asr'],
        })
      },
    }),
  })
  t.after(() => stack.close())
  sourceDir = stack.temp.dir
  // 服务器返回的文件必须真实存在
  writeTempFile(sourceDir, 'src-vocals.wav', 'vocals')
  writeTempFile(sourceDir, 'src-drums.wav', 'drums')
  const src = writeTempFile(sourceDir, 'song.mp3', 'audio')

  const r = await stack.api.separate(src, { stems: ['vocals', 'drums'] })
  assert.equal(r.ok, true)
  assert.ok(existsSync(r.dir))
  assert.ok(r.stems.vocals.path.startsWith(join(stack.store.current.cacheDir, 'separate')))
  assert.ok(existsSync(r.stems.vocals.path))
  assert.equal(r.stems.vocals.duration, 1.2)
  assert.deepEqual(r.released, ['asr'])

  await assert.rejects(stack.api.separate(src, { stems: ['vocal'] }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.separate('C:\\nope.wav'), (e) => e.code === 'bad_request')
})

test('visionFrames：复制关键帧到缓存、映射 stats；url 未实现', async (t) => {
  let sourceDir = ''
  let frameA = ''
  let frameB = ''
  const stack = await makeStack({
    handler: basicHandler({
      '/vision/frames': (req, res) => {
        sendJson(res, 200, {
          ok: true,
          frames: [
            { time: 1.5, path: frameA, score: 0.8, kind: 'slide', ocr_text: '标题', summary: '第一帧' },
            { time: 3.0, path: frameB, confidence: 'low' },
          ],
          duration: 12.5,
          subtitles_from: 'embedded',
          stats: { candidates: 10, vlm_calls: 2, elapsed_ms: 800, degraded: false },
        })
      },
    }),
  })
  t.after(() => stack.close())
  sourceDir = stack.temp.dir
  frameA = writeTempFile(sourceDir, 'f1.jpg', 'fake-jpeg')
  frameB = writeTempFile(sourceDir, 'f2.jpg', 'fake-jpeg')
  const video = writeTempFile(sourceDir, 'v.mp4', 'video')

  const r = await stack.api.visionFrames({ videoPath: video }, { targetFrames: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.duration, 12.5)
  assert.equal(r.subtitlesFrom, 'embedded')
  assert.equal(r.frames.length, 2)
  assert.ok(existsSync(r.frames[0].path))
  assert.equal(r.frames[0].time, 1.5)
  assert.equal(r.frames[0].ocrText, '标题')
  assert.equal(r.frames[1].confidence, 'low')
  assert.equal(r.stats.candidates, 10)
  assert.equal(r.stats.vlmCalls, 2)
  assert.equal(JSON.stringify(r).includes('base64'), false)

  await assert.rejects(stack.api.visionFrames({ url: 'https://example.com/a.mp4' }), (e) => e.code === 'not_implemented')
  await assert.rejects(stack.api.visionFrames({}), (e) => e.code === 'bad_request')
})

test('mediaProbe：批量探测、字段映射', async (t) => {
  const stack = await makeStack({
    handler: basicHandler({
      '/media/probe': (req, res) => {
        sendJson(res, 200, {
          ok: true,
          duration: 2.5,
          format: 'wav',
          audio: { codec: 'pcm_s16le', sample_rate: 16000, channels: 1 },
          video: { codec: 'h264', width: 1280, height: 720, fps: 30 },
        })
      },
    }),
  })
  t.after(() => stack.close())
  const a = writeTempFile(stack.temp.dir, 'a.wav', 'a')
  const b = writeTempFile(stack.temp.dir, 'b.mp4', 'b')

  const r = await stack.api.mediaProbe([a, b])
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].duration, 2.5)
  assert.equal(r.items[0].format, 'wav')
  assert.deepEqual(r.items[0].audio, { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 })
  assert.deepEqual(r.items[0].video, { codec: 'h264', width: 1280, height: 720, fps: 30 })
})

test('jobs：enqueue/status/list/cancel/wait 与 payload 精简', async (t) => {
  let poll = 0
  const stack = await makeStack({
    handler: basicHandler({
      '/jobs': (req, res, rec) => {
        if (req.method === 'POST') {
          const body = parseBody(rec)
          assert.equal(body.kind, 'tts')
          return sendJson(res, 200, { ok: true, id: 'j1', state: 'queued' })
        }
        sendJson(res, 200, {
          ok: true,
          total: 1,
          jobs: [{
            id: 'j1', kind: 'tts', state: 'done', created_at: '2026-11-09T00:00:00Z',
            result: { wavPath: 'C:\\a.wav' }, payload: { text: '不应返回' },
          }],
        })
      },
      '/jobs/j1': (req, res) => {
        poll += 1
        sendJson(res, 200, {
          id: 'j1', kind: 'tts', state: poll > 1 ? 'done' : 'running',
          created_at: '2026-11-09T00:00:00Z', result: { wavPath: 'C:\\a.wav' },
        })
      },
      '/jobs/j1/cancel': (req, res) => sendJson(res, 200, { ok: true, id: 'j1', state: 'canceled', cancel_requested: true }),
    }),
  })
  t.after(() => stack.close())

  const enq = await stack.api.jobs.enqueue('tts', { text: 'hi' })
  assert.deepEqual(enq, { ok: true, id: 'j1', state: 'queued' })

  const st = await stack.api.jobs.status('j1')
  assert.equal(st.state, 'running')
  assert.equal(st.result.wavPath, 'C:\\a.wav')
  assert.equal('payload' in st, false)

  const list = await stack.api.jobs.list({ limit: 10 })
  assert.equal(list.total, 1)
  assert.equal(list.jobs[0].kind, 'tts')
  assert.equal('payload' in list.jobs[0], false)

  const canceled = await stack.api.jobs.cancel('j1')
  assert.equal(canceled.state, 'canceled')
  assert.equal(canceled.cancelRequested, true)

  const waited = await stack.api.jobs.wait('j1', { timeoutMs: 2000, pollMs: 200 })
  assert.equal(waited.state, 'done')

  await assert.rejects(stack.api.jobs.status(''), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.jobs.enqueue('nope', {}), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.jobs.enqueue('tts', {}, { files: ['C:\\a.wav'] }), (e) => e.code === 'not_implemented')
})

test('jobs.result：取任务结果；未完成时回 not_ready 而不是抛错', async (t) => {
  const stack = await makeStack({
    handler: basicHandler({
      '/jobs/j1/result': (req, res) => sendJson(res, 200, {
        ok: true,
        id: 'j1',
        state: 'done',
        result: { texts: ['译:甲', '译:乙'], source: 'zh', target: 'en', engine: 'nllb', elapsed_ms: 1234 },
      }),
      '/jobs/j2/result': (req, res) => sendJson(res, 409, { ok: false, id: 'j2', state: 'running', error: 'job_not_done' }),
    }),
  })
  t.after(() => stack.close())

  const finished = await stack.api.jobs.result('j1')
  assert.equal(finished.ok, true)
  assert.equal(finished.state, 'done')
  assert.deepEqual(finished.result.texts, ['译:甲', '译:乙'])
  assert.equal(finished.result.elapsed_ms, 1234)

  const unfinished = await stack.api.jobs.result('j2')
  assert.equal(unfinished.ok, false)
  assert.equal(unfinished.id, 'j2')
  assert.equal(unfinished.state, 'not_done')
  assert.equal(unfinished.code, 'not_ready')

  await assert.rejects(stack.api.jobs.result(''), (e) => e.code === 'bad_request')
})

test('vram.unload：请求体 all/skip_busy 默认，models 可选；返回映射与错误码', async (t) => {
  const sent = []
  const stack = await makeStack({
    handler: basicHandler({
      '/vram/unload': (req, res, rec) => {
        sent.push(parseBody(rec))
        sendJson(res, 200, { ok: true, released: ['tts', 'separate'], skipped: ['asr'], free_mb: 7100, total_mb: 8192 })
      },
    }),
  })
  t.after(() => stack.close())

  assert.equal(typeof stack.api.vram.unload, 'function')
  assert.deepEqual(await stack.api.vram.unload(), {
    ok: true,
    released: ['tts', 'separate'],
    skipped: ['asr'],
    freeMb: 7100,
    totalMb: 8192,
  })
  // 默认全卸，但跳过正在使用的模型（服务端判断忙不忙）。
  assert.deepEqual(sent[0], { all: true, skip_busy: true })

  await stack.api.vram.unload({ all: false, models: ['tts'], skipBusy: false })
  assert.deepEqual(sent[1], { all: false, models: ['tts'], skip_busy: false })

  // 单个模型名也接受；空白项不发给服务端。
  await stack.api.vram.unload({ models: ' vision ' })
  assert.deepEqual(sent[2].models, ['vision'])

  const bad = await makeStack({
    handler: basicHandler({
      '/vram/unload': (req, res) => sendJson(res, 400, { ok: false, error: 'invalid_model', detail: '不认识的模型名：nope' }),
    }),
  })
  t.after(() => bad.close())
  await assert.rejects(bad.api.vram.unload({ models: ['nope'] }), (error) => error.code === 'bad_request')

  const down = await makeStack({
    handler: basicHandler({
      '/vram/unload': (req, res) => sendJson(res, 500, { ok: false, error: 'engine_error', detail: '卸载失败' }),
    }),
  })
  t.after(() => down.close())
  await assert.rejects(down.api.vram.unload(), (error) => error.code === 'upstream_error')
})

test('translateJobs：提交 / 查状态 / 取译文 / 取消，旧版服务抛 not_supported', async (t) => {
  const collect = []
  const stack = await makeStack({
    handler: basicHandler({
      '/jobs/translate': (req, res, rec) => {
        const body = parseBody(rec)
        collect.push(body)
        sendJson(res, 200, { ok: true, id: 'j1', state: 'queued', count: body.texts.length, source: body.source, target: body.target })
      },
      '/jobs/j1': (req, res) => sendJson(res, 200, { id: 'j1', kind: 'translate', state: 'running', meta: { progress: { done: 1, total: 2 } } }),
      '/jobs/j1/result': (req, res) => sendJson(res, 200, {
        ok: true,
        id: 'j1',
        state: 'done',
        result: { texts: ['译:a', '译:b'], source: 'zh', target: 'en', engine: 'nllb', elapsed_ms: 900 },
      }),
      '/jobs/j1/cancel': (req, res) => sendJson(res, 200, { ok: true, id: 'j1', state: 'canceled', cancel_requested: true }),
    }),
  })
  t.after(() => stack.close())

  const submit = await stack.api.translateJobs.submit(['a', 'b'], { source: 'zh', target: 'en' })
  assert.deepEqual(submit, { ok: true, id: 'j1', state: 'queued', source: 'zh', target: 'en', count: 2 })
  assert.deepEqual(collect[0], { texts: ['a', 'b'], source: 'zh', target: 'en' })

  const status = await stack.api.translateJobs.status('j1')
  assert.equal(status.ok, true)
  assert.equal(status.state, 'running')
  assert.deepEqual(status.progress, { done: 1, total: 2 })
  assert.equal('payload' in status, false)

  const translated = await stack.api.translateJobs.result('j1')
  assert.equal(translated.ok, true)
  assert.deepEqual(translated.texts, ['译:a', '译:b'])
  assert.equal(translated.source, 'zh')
  assert.equal(translated.target, 'en')
  assert.equal(translated.engine, 'nllb')
  assert.equal(translated.ms, 900)

  const cancel = await stack.api.translateJobs.cancel('j1')
  assert.equal(cancel.ok, true)
  assert.equal(cancel.state, 'canceled')
  assert.equal(cancel.cancelRequested, true)

  // 参数校验沿用同步接口：target 不能 auto、条数与总字数有上限。
  await assert.rejects(stack.api.translateJobs.submit(['a'], { target: 'auto' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translateJobs.submit(Array.from({ length: 501 }, () => 'x'), { target: 'en' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translateJobs.submit(Array.from({ length: 41 }, () => 'x'.repeat(5000)), { target: 'en' }), (e) => e.code === 'bad_request')
  await assert.rejects(stack.api.translateJobs.status(''), (e) => e.code === 'bad_request')
})

test('translateJobs：旧版服务 404 抛 not_supported；未完成取结果回 not_ready；取消失败不阻塞', async (t) => {
  const legacy = await makeStack({
    handler: basicHandler({
      '/jobs/translate': (req, res) => sendJson(res, 404, { ok: false, error: 'not_found' }),
    }),
  })
  t.after(() => legacy.close())
  await assert.rejects(legacy.api.translateJobs.submit(['a'], { target: 'en' }), (e) => e.code === 'not_implemented' && /版本较旧/.test(e.hint))

  const stack = await makeStack({
    handler: basicHandler({
      '/jobs/translate': (req, res) => sendJson(res, 200, { ok: true, state: 'queued' }),
      '/jobs/j9/result': (req, res) => sendJson(res, 409, { ok: false, id: 'j9', state: 'running', error: 'job_not_done' }),
      '/jobs/j9/cancel': (req, res) => sendJson(res, 409, { ok: false, error: 'canceled' }),
    }),
  })
  t.after(() => stack.close())

  await assert.rejects(stack.api.translateJobs.submit(['a'], { target: 'en' }), (e) => e.code === 'upstream_error')

  const unfinished = await stack.api.translateJobs.result('j9')
  assert.equal(unfinished.ok, false)
  assert.equal(unfinished.code, 'not_ready')
  assert.equal(unfinished.state, 'not_done')

  const ended = await stack.api.translateJobs.cancel('j9')
  assert.equal(ended.ok, true)
  assert.equal(ended.state, 'canceled')
  assert.equal(ended.cancelRequested, false)
})

test('voices：直接映射 /voices，30 秒内不重复请求', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())
  const first = await stack.api.voices()
  assert.deepEqual(first.map((x) => x.name), ['dafeiyu', 'default'])
  assert.equal(first[0].duration, 9.4)
  // 契约兼容：仍是数组，目录挂在非枚举属性上。
  assert.ok(Array.isArray(first))
  assert.equal(first.directory, 'E:\\LocalAIService\\voices')
  assert.equal(Object.keys(first).includes('directory'), false)

  const front = stack.mock.requests.filter((r) => r.path === '/voices').length
  const second = await stack.api.voices()
  assert.deepEqual(second, first)
  assert.equal(stack.mock.requests.filter((r) => r.path === '/voices').length, front)

  // force 跳过缓存，拿最新目录。
  const force = await stack.api.voices({ force: true })
  assert.equal(force.directory, 'E:\\LocalAIService\\voices')
  assert.equal(stack.mock.requests.filter((r) => r.path === '/voices').length, front + 1)
})

test('config：get 脱敏；set 白名单、保存、警告、token 原样打码保留', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const pub = stack.api.config.get()
  assert.equal(pub.token, '')
  assert.equal(pub.configFile, stack.store.filePath)
  assert.deepEqual(pub.envOverrides, [])

  const saved = await stack.api.config.set({ ttsVoice: 'default', requestTimeoutMs: 12345 })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.applied.sort(), ['requestTimeoutMs', 'ttsVoice'])
  assert.equal(stack.store.current.ttsVoice, 'default')
  assert.equal(stack.store.current.requestTimeoutMs, 12345)

  const masked = await stack.api.config.set({ token: '***已设置***' })
  assert.deepEqual(masked.applied, [])
  assert.equal(stack.store.current.token, '')

  const before = stack.api.config.get()
  const warned = await stack.api.config.set({ baseUrl: 'ftp://bad', logLevel: 'verbose' })
  assert.equal(warned.ok, true)
  assert.deepEqual(warned.applied, [])
  assert.equal(warned.warnings.length, 2)
  assert.equal(stack.api.config.get().baseUrl, before.baseUrl)
})

test('config：P2 朗读/语音字段可写，非法值给警告且不写', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const ok = await stack.api.config.set({
    ttsSpeed: 1.25,
    readMaxChars: 3000,
    readConcurrency: 3,
    autoRead: true,
    recordMime: 'wav',
    rememberVoiceChoice: false,
    asrLanguage: 'zh',
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.applied.sort(), [
    'asrLanguage', 'autoRead', 'readConcurrency', 'readMaxChars',
    'recordMime', 'rememberVoiceChoice', 'ttsSpeed',
  ])
  assert.equal(stack.store.current.ttsSpeed, 1.25)
  assert.equal(stack.store.current.readMaxChars, 3000)
  assert.equal(stack.store.current.readConcurrency, 3)
  assert.equal(stack.store.current.autoRead, true)
  assert.equal(stack.store.current.recordMime, 'wav')
  assert.equal(stack.store.current.rememberVoiceChoice, false)
  assert.equal(stack.store.current.asrLanguage, 'zh')

  const bad = await stack.api.config.set({
    ttsSpeed: 3,
    readMaxChars: 10,
    readConcurrency: 9,
    recordMime: 'mp3',
    asrLanguage: 'ko',
  })
  assert.equal(bad.ok, true)
  assert.deepEqual(bad.applied, [])
  assert.equal(bad.warnings.length, 5)
  assert.equal(stack.store.current.ttsSpeed, 1.25)
  assert.equal(stack.store.current.readConcurrency, 3)
})

test('config：后台也自动朗读可写；默认开，旧配置缺字段也是开', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  assert.equal(stack.api.config.get().autoReadInBackground, true)

  const off = await stack.api.config.set({ autoReadInBackground: false })
  assert.equal(off.ok, true)
  assert.deepEqual(off.applied, ['autoReadInBackground'])
  assert.equal(stack.store.current.autoReadInBackground, false)
  assert.equal(stack.api.config.get().autoReadInBackground, false)

  const on = await stack.api.config.set({ autoReadInBackground: true })
  assert.deepEqual(on.applied, ['autoReadInBackground'])
  assert.equal(stack.store.current.autoReadInBackground, true)

  // 旧文件里没有这个字段：规范化后补成开。
  const prev = await makeStack({ config: { autoReadInBackground: undefined } })
  t.after(() => prev.close())
  assert.equal(prev.api.config.get().autoReadInBackground, true)
})

test('config：输入设备可写、空串表示系统默认；非法值只警告不写', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const ok = await stack.api.config.set({ recordDeviceId: '  mic-abc  ' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.applied, ['recordDeviceId'])
  assert.equal(stack.store.current.recordDeviceId, 'mic-abc')
  assert.equal(stack.api.config.get().recordDeviceId, 'mic-abc')

  const empty = await stack.api.config.set({ recordDeviceId: '' })
  assert.deepEqual(empty.applied, ['recordDeviceId'])
  assert.equal(stack.store.current.recordDeviceId, '')

  const bad = await stack.api.config.set({ recordDeviceId: 123 })
  assert.deepEqual(bad.applied, [])
  assert.equal(bad.warnings.length, 1)
  assert.match(bad.warnings[0], /格式不正确/)
  assert.equal(stack.store.current.recordDeviceId, '')

  const length = await stack.api.config.set({ recordDeviceId: 'x'.repeat(201) })
  assert.deepEqual(length.applied, [])
  assert.equal(length.warnings.length, 1)
  assert.match(length.warnings[0], /200 字/)
  assert.equal(stack.store.current.recordDeviceId, '')
})

test('config：按会话自动朗读可写、规范化；非法值只警告不写', async (t) => {
  const stack = await makeStack()
  t.after(() => stack.close())

  const one = await stack.api.config.set({
    autoReadSessions: { 'session-a': true, 'session-b': 'false', 'bad-key': true },
  })
  assert.equal(one.ok, true)
  assert.deepEqual(one.applied, ['autoReadSessions'])
  assert.equal(one.warnings.length, 1)
  assert.match(one.warnings[0], /1 条无法识别/)
  assert.deepEqual(stack.store.current.autoReadSessions, { 'session-a': true, 'session-b': false })
  assert.equal(stack.store.current.autoRead, false) // 全局默认不受影响
  assert.deepEqual(stack.api.config.get().autoReadSessions, { 'session-a': true, 'session-b': false })

  const two = await stack.api.config.set({ autoReadSessions: { 'session-a': false } })
  assert.deepEqual(two.applied, ['autoReadSessions'])
  assert.deepEqual(stack.store.current.autoReadSessions, { 'session-a': false })

  // 不是普通对象：整项忽略，保留原有设置，只给提示。
  const bad = await stack.api.config.set({ autoReadSessions: ['session-a'] })
  assert.deepEqual(bad.applied, [])
  assert.equal(bad.warnings.length, 1)
  assert.deepEqual(stack.store.current.autoReadSessions, { 'session-a': false })

  // 超过 200 条：接受保存，但只保留前 200 条并提示。
  const exceed = {}
  for (let i = 0; i < 205; i += 1) exceed[`session-${i}`] = true
  const three = await stack.api.config.set({ autoReadSessions: exceed })
  assert.equal(three.ok, true)
  assert.deepEqual(three.applied, ['autoReadSessions'])
  assert.equal(Object.keys(stack.store.current.autoReadSessions).length, 200)
  assert.equal(three.warnings.length, 1)
  assert.match(three.warnings[0], /200 条/)
})

test('ensureReady：tts 通过；preload 只对 tts 生效；未知能力 / 缺模型返回结构化错误', async (t) => {
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res) => sendBuffer(res, 200, Buffer.from('RIFF'), {
        'content-type': 'audio/wav', 'x-seed': '1', 'x-language': 'zh',
      }),
    }),
  })
  t.after(() => stack.close())

  const ready = await stack.api.ensureReady('tts')
  assert.equal(ready.ok, true)
  assert.equal(ready.ready, true)
  assert.equal(ready.willLoadOnFirstUse, true)
  assert.equal(typeof ready.waitedMs, 'number')

  const preloaded = await stack.api.ensureReady('tts', { preload: true })
  assert.equal(preloaded.ok, true)
  assert.equal(preloaded.loaded, true)
  assert.equal(preloaded.willLoadOnFirstUse, false)

  const vision = await stack.api.ensureReady('vision', { preload: true })
  assert.equal(vision.ok, true)
  assert.equal(vision.willLoadOnFirstUse, true)

  const unknown = await stack.api.ensureReady('nope')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'upstream_error')

  const missingModel = structuredClone(CAPABILITIES_BODY)
  missingModel.capabilities.vision.ready = false
  const stack2 = await makeStack({ handler: basicHandler({ '/capabilities': (req, res) => sendJson(res, 200, missingModel) }) })
  t.after(() => stack2.close())
  const missing = await stack2.api.ensureReady('vision')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'model_missing')
  assert.match(missing.hint, /模型/)
  assert.ok(!missing.hint.includes('Qwen2.5-VL'), '界面文案里不出现模型名')
})

test('错误映射：507 → vram_exhausted；503(ready=false) → model_missing；400 → bad_request；504 → timeout', async (t) => {
  const status = { code: 507 }
  const stack = await makeStack({
    handler: basicHandler({
      '/tts': (req, res) => {
        if (status.code === 507) return sendJson(res, 507, { ok: false, error: 'insufficient_vram', need_mb: 6912, free_mb: 6000 })
        if (status.code === 504) return sendJson(res, 504, { ok: false, error: 'job_timeout' })
        return sendJson(res, 400, { ok: false, error: 'invalid_text', detail: '文本不合法' })
      },
    }),
  })
  t.after(() => stack.close())

  await assert.rejects(stack.api.tts('hi'), (e) => e.code === 'vram_exhausted' && /显存/.test(e.hint))
  status.code = 400
  await assert.rejects(stack.api.tts('hi'), (e) => e.code === 'bad_request')
  status.code = 504
  await assert.rejects(stack.api.tts('hi'), (e) => e.code === 'timeout')

  const missingModel = structuredClone(CAPABILITIES_BODY)
  missingModel.capabilities.tts.ready = false
  const stack2 = await makeStack({ handler: basicHandler({ '/capabilities': (req, res) => sendJson(res, 200, missingModel) }) })
  t.after(() => stack2.close())
  await assert.rejects(stack2.api.tts('hi'), (e) => e.code === 'model_missing'
    && /模型/.test(e.hint)
    && !/IndexTTS/.test(e.hint)
    && /IndexTTS/.test(e.detail))
  assert.equal(stack2.mock.requests.some((r) => r.path === '/tts'), false)
})

test('宿主装配：provide fish.service、注册 9 个工具与 >5 条路由，stop 可卸载', async (t) => {
  const mock = await startMock(basicHandler())
  const temp = (await import('./helpers.js')).makeTempDir()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = temp.dir
  t.after(async () => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await mock.close()
    temp.cleanup()
  })

  const provided = {}
  const tools = []
  const routes = []
  const effects = []
  const ctx = {
    provide: (name, value) => { provided[name] = value },
    tools: { register: (def) => { tools.push(def); return () => { const i = tools.indexOf(def); if (i >= 0) tools.splice(i, 1) } } },
    webServer: { register: (def) => { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1) } } },
    effect: (fn, _label) => { const d = fn(); effects.push(d); return () => { if (typeof d === 'function') d() } },
  }

  const app = apply(ctx, { baseUrl: mock.url, cacheDir: join(temp.dir, 'cache'), logLevel: 'error' })
  t.after(() => app.stop())

  assert.equal(provided['fish.service'], app.api)
  assert.equal(app.api.apiVersion, '1.0')
  assert.equal(tools.length, 9)
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    'fish_asr', 'fish_describe_image', 'fish_job', 'fish_media_probe', 'fish_separate',
    'fish_service_status', 'fish_translate', 'fish_tts', 'fish_vision_frames',
  ])
  const paths = routes.map((r) => r.path)
  for (const p of ['/dsh-fish-service/health', '/dsh-fish-service/state', '/dsh-fish-service/save', '/dsh-fish-service/test', '/dsh-fish-service/logs']) {
    assert.ok(paths.includes(p), p)
  }
  assert.equal(routes.every((r) => r.kind === 'exact'), true)

  app.stop()
  assert.equal(tools.length, 0)
  assert.equal(routes.length, 0)
})
