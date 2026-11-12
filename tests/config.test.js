// 配置：默认值、范围钳制、env 覆盖、原子写、token 脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_VERSION,
  ConfigStore,
  applyEnv,
  buildConfigSchema,
  defaultConfig,
  envOverrides,
  normalizeAutoReadSessions,
  normalizeConfig,
  normalizeRecordDeviceId,
  publicConfig,
  RECORD_DEVICE_ID_MAX,
} from '../lib/config.js'
import { defaultVisionPrompt, visionPreset } from '../lib/vision-presets.js'
import { makeTempDir } from './helpers.js'

test('默认配置符合 P1 契约', () => {
  const temp = makeTempDir()
  try {
    const c = defaultConfig(temp.dir)
    assert.equal(c.version, CONFIG_VERSION)
    assert.equal(c.enabled, true)
    assert.equal(c.baseUrl, 'http://127.0.0.1:7880')
    assert.equal(c.apiVersion, '1')
    assert.equal(c.token, '')
    assert.equal(c.ttsVoice, 'dafeiyu')
    assert.equal(c.cacheDir, join(temp.dir, 'fish-service-cache'))
    assert.equal(c.cacheTtlHours, 72)
    assert.equal(c.cacheMaxMb, 2048)
    assert.equal(c.requestTimeoutMs, 180000)
    assert.equal(c.asrTimeoutMs, 300000)
    assert.equal(c.visionTimeoutMs, 600000)
    assert.equal(c.healthIntervalMs, 15000)
    assert.equal(c.logLevel, 'info')
    assert.equal(c.installMode, 'unknown')
    assert.deepEqual(c.enabledCapabilities, [])
    // P2 朗读 / 语音输入默认值
    assert.equal(c.ttsSpeed, 1)
    assert.equal(c.autoRead, false)
    assert.deepEqual(c.autoReadSessions, {})
    assert.equal(c.autoReadInBackground, true)
    assert.equal(c.readMaxChars, 2000)
    assert.equal(c.readConcurrency, 2)
    assert.equal(c.readSkipCode, true)
    assert.equal(c.recordMime, 'auto')
    assert.equal(c.recordDeviceId, '')
    assert.equal(c.rememberVoiceChoice, true)
    assert.equal(c.asrLanguage, 'auto')
    // 翻译目标语言规则
    assert.equal(c.primaryLanguage, 'zh')
    assert.equal(c.secondaryLanguage, 'en')
  } finally {
    temp.cleanup()
  }
})

test('normalizeConfig 钳范围、补默认、去尾斜杠', () => {
  const temp = makeTempDir()
  try {
    const c = normalizeConfig({
      baseUrl: 'http://127.0.0.1:9999/',
      requestTimeoutMs: 999999999,
      asrTimeoutMs: 1,
      visionTimeoutMs: 'abc',
      cacheTtlHours: 0,
      cacheMaxMb: 999999,
      healthIntervalMs: 100,
      logLevel: 'TRACE',
      installMode: 'nonsense',
      token: 'x'.repeat(600),
      enabled: 'false',
      ttsVoice: '   ',
    }, { homeDir: temp.dir })

    assert.equal(c.baseUrl, 'http://127.0.0.1:9999')
    assert.equal(c.requestTimeoutMs, 1800000)
    assert.equal(c.asrTimeoutMs, 1000)
    assert.equal(c.visionTimeoutMs, 600000)
    assert.equal(c.cacheTtlHours, 1)
    assert.equal(c.cacheMaxMb, 10240)
    assert.equal(c.healthIntervalMs, 5000)
    assert.equal(c.logLevel, 'info')
    assert.equal(c.installMode, 'unknown')
    assert.equal(c.token.length, 512)
    assert.equal(c.enabled, false)
    assert.equal(c.ttsVoice, 'dafeiyu')
  } finally {
    temp.cleanup()
  }
})

test('非法 baseUrl 回退默认；只接受 http/https', () => {
  const temp = makeTempDir()
  try {
    assert.equal(normalizeConfig({ baseUrl: 'not a url' }, { homeDir: temp.dir }).baseUrl, 'http://127.0.0.1:7880')
    assert.equal(normalizeConfig({ baseUrl: 'ftp://127.0.0.1' }, { homeDir: temp.dir }).baseUrl, 'http://127.0.0.1:7880')
    assert.equal(normalizeConfig({ baseUrl: 'https://例子.test:8443' }, { homeDir: temp.dir }).baseUrl, 'https://例子.test:8443')
  } finally {
    temp.cleanup()
  }
})

test('cacheDir 支持 ~ 展开', () => {
  const temp = makeTempDir()
  try {
    assert.equal(normalizeConfig({ cacheDir: '~/cache' }, { homeDir: temp.dir }).cacheDir, join(temp.dir, 'cache'))
    assert.equal(normalizeConfig({ cacheDir: '~' }, { homeDir: temp.dir }).cacheDir, temp.dir)
  } finally {
    temp.cleanup()
  }
})

test('解包 DSH volatile 引用，不把 [object Object] 写进配置', () => {
  const temp = makeTempDir()
  try {
    const ref = (value) => ({
      get: () => value,
      [Symbol.for('cosmokit.volatile.write')]: () => {},
    })
    const c = normalizeConfig({
      baseUrl: ref('http://127.0.0.1:7444'),
      apiVersion: ref('1'),
      ttsVoice: ref('default'),
      cacheDir: ref('~/vc'),
      requestTimeoutMs: ref(9000),
      logLevel: ref('debug'),
    }, { homeDir: temp.dir })
    assert.equal(c.baseUrl, 'http://127.0.0.1:7444')
    assert.equal(c.apiVersion, '1')
    assert.equal(c.ttsVoice, 'default')
    assert.equal(c.cacheDir, join(temp.dir, 'vc'))
    assert.equal(c.requestTimeoutMs, 9000)
    assert.equal(c.logLevel, 'debug')
    assert.ok(!JSON.stringify(c).includes('[object Object]'))
  } finally {
    temp.cleanup()
  }
})

test('环境变量覆盖：env > 文件 > 插件参数 > 默认', () => {
  const temp = makeTempDir()
  try {
    const base = normalizeConfig({ baseUrl: 'http://127.0.0.1:7000' }, { homeDir: temp.dir })
    const { config, overrides } = applyEnv(base, {
      DSH_FISH_SERVICE_BASE_URL: 'http://127.0.0.1:7900',
      DSH_FISH_SERVICE_ENABLED: '0',
      DSH_FISH_SERVICE_HEALTH_MS: '20000',
      DSH_FISH_SERVICE_TOKEN: 'secret-token',
    }, { homeDir: temp.dir })

    assert.equal(config.baseUrl, 'http://127.0.0.1:7900')
    assert.equal(config.enabled, false)
    assert.equal(config.healthIntervalMs, 20000)
    assert.equal(config.token, 'secret-token')
    assert.deepEqual(overrides.sort(), ['baseUrl', 'enabled', 'healthIntervalMs', 'token'])
    assert.deepEqual(envOverrides({ DSH_FISH_SERVICE_BASE_URL: 'x' }), ['baseUrl'])
  } finally {
    temp.cleanup()
  }
})

test('ConfigStore：文件优先于插件参数，保存后可重读，token 不回显', () => {
  const temp = makeTempDir()
  try {
    const file = join(temp.dir, 'fish-service-config.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:7111', ttsVoice: 'default' }), 'utf8')

    const store = new ConfigStore({ homeDir: temp.dir })
    const loaded = store.load({ baseUrl: 'http://127.0.0.1:7222' }, {})
    assert.equal(loaded.baseUrl, 'http://127.0.0.1:7111')
    assert.equal(loaded.ttsVoice, 'default')

    loaded.baseUrl = 'http://127.0.0.1:7333'
    loaded.token = 'my-token'
    const saved = store.save(loaded)
    assert.equal(saved.baseUrl, 'http://127.0.0.1:7333')

    const again = new ConfigStore({ homeDir: temp.dir })
    const reread = again.load({}, {})
    assert.equal(reread.baseUrl, 'http://127.0.0.1:7333')
    assert.equal(reread.token, 'my-token')

    const pub = publicConfig(reread)
    assert.equal(pub.token, '***已设置***')
    assert.ok(!JSON.stringify(pub).includes('my-token'))

    const leftovers = readdirSync(temp.dir).filter((x) => x.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    temp.cleanup()
  }
})

test('ConfigStore.save 写入的是规范化后的完整配置', () => {
  const temp = makeTempDir()
  try {
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    store.save({ ...store.current, requestTimeoutMs: 12345, cacheMaxMb: 4096 })
    const raw = JSON.parse(readFileSync(join(temp.dir, 'fish-service-config.json'), 'utf8'))
    assert.equal(raw.requestTimeoutMs, 12345)
    assert.equal(raw.cacheMaxMb, 4096)
    assert.equal(raw.version, CONFIG_VERSION)
    assert.equal(raw.baseUrl, 'http://127.0.0.1:7880')
  } finally {
    temp.cleanup()
  }
})

test('normalizeConfig：P2 朗读/语音字段钳范围、非法枚举回退', () => {
  const temp = makeTempDir()
  try {
    const c = normalizeConfig({
      ttsSpeed: 9,
      readMaxChars: 10,
      readConcurrency: 99,
      readSkipCode: 'false',
      autoRead: 'true',
      recordMime: 'MP3',
      rememberVoiceChoice: 0,
      asrLanguage: 'ko',
    }, { homeDir: temp.dir })
    assert.equal(c.ttsSpeed, 2)
    assert.equal(c.readMaxChars, 200)
    assert.equal(c.readConcurrency, 4)
    assert.equal(c.readSkipCode, false)
    assert.equal(c.autoRead, true)
    assert.equal(c.recordMime, 'auto')
    assert.equal(c.rememberVoiceChoice, false)
    assert.equal(c.asrLanguage, 'auto')

    const normal = normalizeConfig({
      ttsSpeed: 1.257,
      readMaxChars: 3000,
      readConcurrency: 1,
      recordMime: 'wav',
      asrLanguage: 'zh',
    }, { homeDir: temp.dir })
    assert.equal(normal.ttsSpeed, 1.26)
    assert.equal(normal.readMaxChars, 3000)
    assert.equal(normal.readConcurrency, 1)
    assert.equal(normal.recordMime, 'wav')
    assert.equal(normal.asrLanguage, 'zh')
  } finally {
    temp.cleanup()
  }
})

test('primaryLanguage / secondaryLanguage：默认 zh/en，五语言白名单，非法回退', () => {
  const temp = makeTempDir()
  try {
    const fallbackValue = normalizeConfig({}, { homeDir: temp.dir })
    assert.equal(fallbackValue.primaryLanguage, 'zh')
    assert.equal(fallbackValue.secondaryLanguage, 'en')

    for (const code of ['zh', 'en', 'ja', 'ko', 'yue']) {
      const c = normalizeConfig({ primaryLanguage: code, secondaryLanguage: code }, { homeDir: temp.dir })
      assert.equal(c.primaryLanguage, code)
      assert.equal(c.secondaryLanguage, code)
    }

    const garbled = normalizeConfig({ primaryLanguage: 'fr', secondaryLanguage: 42 }, { homeDir: temp.dir })
    assert.equal(garbled.primaryLanguage, 'zh')
    assert.equal(garbled.secondaryLanguage, 'en')
  } finally {
    temp.cleanup()
  }
})

test('autoReadSessions：默认空表；旧配置没有该字段时行为不变', () => {
  const temp = makeTempDir()
  try {
    assert.deepEqual(defaultConfig(temp.dir).autoReadSessions, {})
    const prev = normalizeConfig({ autoRead: true }, { homeDir: temp.dir })
    assert.equal(prev.autoRead, true)
    assert.deepEqual(prev.autoReadSessions, {})
    // 只有全局默认时，所有会话都按它表现（回落由客户端完成）。
    assert.deepEqual(normalizeAutoReadSessions(undefined), { value: {}, warnings: [], valid: true })
  } finally {
    temp.cleanup()
  }
})

test('localDescribe：默认开；旧配置缺字段按开；明确关闭才关；env 可覆盖', () => {
  const temp = makeTempDir()
  try {
    assert.equal(defaultConfig(temp.dir).localDescribe, true)

    // 旧配置没有该字段：按开启处理。
    assert.equal(normalizeConfig({ autoRead: true }, { homeDir: temp.dir }).localDescribe, true)
    // 无法识别的值：回落默认（开），不抛错。
    assert.equal(normalizeConfig({ localDescribe: '乱写' }, { homeDir: temp.dir }).localDescribe, true)
    for (const value of [false, 'false', 0, '0']) {
      assert.equal(normalizeConfig({ localDescribe: value }, { homeDir: temp.dir }).localDescribe, false)
    }

    // 环境变量最高优先级。
    const off = applyEnv(defaultConfig(temp.dir), { DSH_FISH_SERVICE_LOCAL_DESCRIBE: 'false' }, { homeDir: temp.dir })
    assert.equal(off.config.localDescribe, false)
    assert.deepEqual(off.overrides, ['localDescribe'])
    const on = applyEnv(defaultConfig(temp.dir), { FISH_SERVICE_LOCAL_DESCRIBE: '1' }, { homeDir: temp.dir })
    assert.equal(on.config.localDescribe, true)

    // 持久化：保存后重读仍是关。
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    assert.equal(store.current.localDescribe, true)
    store.save({ ...store.current, localDescribe: false })
    const raw = JSON.parse(readFileSync(join(temp.dir, 'fish-service-config.json'), 'utf8'))
    assert.equal(raw.localDescribe, false)
    const again = new ConfigStore({ homeDir: temp.dir })
    assert.equal(again.load({}, {}).localDescribe, false)
  } finally {
    temp.cleanup()
  }
})

test('识图档位与提示词：旧配置补默认、空串保留、非法回退默认、只认四档', () => {
  const temp = makeTempDir()
  try {
    const fallbackValue = defaultConfig(temp.dir)
    assert.deepEqual(fallbackValue.visionPresets, { ...defaultVisionPrompt })
    assert.equal(fallbackValue.visionDefaultPreset, 'detailed')
    assert.equal(fallbackValue.visionSessionPrompt, '')

    // 旧配置没有这些字段：自动补默认，不报错。
    const prev = normalizeConfig({ autoRead: true }, { homeDir: temp.dir })
    assert.deepEqual(prev.visionPresets, defaultVisionPrompt)
    assert.equal(prev.visionDefaultPreset, 'detailed')
    assert.equal(prev.visionSessionPrompt, '')

    // 非对象 / 非字符串：补内置默认；空串保留（运行时按默认处理）。
    assert.deepEqual(normalizeConfig({ visionPresets: '乱写' }, { homeDir: temp.dir }).visionPresets, defaultVisionPrompt)
    const mixed = normalizeConfig({
      visionPresets: { brief: '  ', standard: '我的标准版', detailed: 123, foo: '不该收' },
    }, { homeDir: temp.dir })
    assert.equal(mixed.visionPresets.brief, '')
    assert.equal(mixed.visionPresets.standard, '我的标准版')
    assert.equal(mixed.visionPresets.detailed, defaultVisionPrompt.detailed)
    assert.equal(mixed.visionPresets.foo, undefined)
    assert.deepEqual(Object.keys(mixed.visionPresets).sort(), [...visionPreset].sort())

    // 配置只认档位 id；认不出回退默认（中文名由服务/工具层转换，配置层不做）。
    assert.equal(normalizeConfig({ visionDefaultPreset: 'standard' }, { homeDir: temp.dir }).visionDefaultPreset, 'standard')
    assert.equal(normalizeConfig({ visionDefaultPreset: '标准' }, { homeDir: temp.dir }).visionDefaultPreset, 'detailed')
    assert.equal(normalizeConfig({ visionDefaultPreset: '特写' }, { homeDir: temp.dir }).visionDefaultPreset, 'detailed')

    // 会话识图提示词单独存：留空用内置，过长截断，非字符串按留空。
    const session = normalizeConfig({ visionSessionPrompt: '  我的会话提示  ' }, { homeDir: temp.dir })
    assert.equal(session.visionSessionPrompt, '我的会话提示')
    const sessionExceedLength = normalizeConfig({ visionSessionPrompt: 'a'.repeat(5000) }, { homeDir: temp.dir })
    assert.equal(sessionExceedLength.visionSessionPrompt.length, 4000)
    assert.equal(normalizeConfig({ visionSessionPrompt: 42 }, { homeDir: temp.dir }).visionSessionPrompt, '')

    // 单条提示词超长截到 4000。
    const exceedLength = normalizeConfig({ visionPresets: { brief: 'a'.repeat(5000) } }, { homeDir: temp.dir })
    assert.equal(exceedLength.visionPresets.brief.length, 4000)

    // 持久化后重读仍是改过的值。
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    assert.deepEqual(store.current.visionPresets, defaultVisionPrompt)
    store.save({
      ...store.current,
      visionPresets: { ...store.current.visionPresets, text: '我的文字提示' },
      visionSessionPrompt: '我的会话提示',
    })
    const again = new ConfigStore({ homeDir: temp.dir })
    const reread = again.load({}, {})
    assert.equal(reread.visionPresets.text, '我的文字提示')
    assert.equal(reread.visionSessionPrompt, '我的会话提示')
  } finally {
    temp.cleanup()
  }
})

test('autoReadInBackground：默认开；旧配置缺字段按开；明确关闭才关', () => {
  const temp = makeTempDir()
  try {
    assert.equal(defaultConfig(temp.dir).autoReadInBackground, true)

    // 旧配置没有该字段：按开启处理（以前后台不朗读，现在默认后台也朗读）。
    const prev = normalizeConfig({ autoRead: true }, { homeDir: temp.dir })
    assert.equal(prev.autoReadInBackground, true)

    // true / 'true' / 1 / '1' 都算开；false / 'false' / 0 / '0' 算关。
    for (const value of [true, 'true', 1, '1']) {
      assert.equal(normalizeConfig({ autoReadInBackground: value }, { homeDir: temp.dir }).autoReadInBackground, true)
    }
    for (const value of [false, 'false', 0, '0']) {
      assert.equal(normalizeConfig({ autoReadInBackground: value }, { homeDir: temp.dir }).autoReadInBackground, false)
    }
    // 无法识别的值：回落默认（开），不抛错。
    assert.equal(normalizeConfig({ autoReadInBackground: '乱写' }, { homeDir: temp.dir }).autoReadInBackground, true)

    // 持久化：保存后重读仍是关。
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    store.save({ ...store.current, autoReadInBackground: false })
    const raw = JSON.parse(readFileSync(join(temp.dir, 'fish-service-config.json'), 'utf8'))
    assert.equal(raw.autoReadInBackground, false)
    const again = new ConfigStore({ homeDir: temp.dir })
    assert.equal(again.load({}, {}).autoReadInBackground, false)
    assert.deepEqual(again.warnings, [])
  } finally {
    temp.cleanup()
  }
})

test('recordDeviceId：默认空串；旧配置不变；非法值忽略并提示', () => {
  const temp = makeTempDir()
  try {
    assert.equal(defaultConfig(temp.dir).recordDeviceId, '')
    // 旧配置没有该字段：按空串处理，行为与以前一致。
    const prev = normalizeConfig({ autoRead: true }, { homeDir: temp.dir })
    assert.equal(prev.recordDeviceId, '')
    assert.deepEqual(normalizeRecordDeviceId(undefined), { value: '', warnings: [], valid: true })

    // 空串合法 = 跟随系统默认；字符串保留（去首尾空白）。
    assert.equal(normalizeRecordDeviceId('').value, '')
    assert.equal(normalizeRecordDeviceId('  mic-abc  ').value, 'mic-abc')
    assert.equal(normalizeRecordDeviceId('x'.repeat(RECORD_DEVICE_ID_MAX)).value.length, RECORD_DEVICE_ID_MAX)

    // 非法类型：忽略并提示，回落空串。
    const typeWarn = []
    const type = normalizeConfig({ recordDeviceId: 42 }, {
      homeDir: temp.dir,
      onWarning: (warn) => typeWarn.push(warn),
    })
    assert.equal(type.recordDeviceId, '')
    assert.equal(typeWarn.length, 1)
    assert.match(typeWarn[0], /格式不正确/)

    // 超长：忽略并提示，回落空串。
    const lenWarn = []
    const exceedLength = normalizeConfig({ recordDeviceId: 'x'.repeat(RECORD_DEVICE_ID_MAX + 1) }, {
      homeDir: temp.dir,
      onWarning: (warn) => lenWarn.push(warn),
    })
    assert.equal(exceedLength.recordDeviceId, '')
    assert.equal(lenWarn.length, 1)
    assert.match(lenWarn[0], /最多 200 字/)

    // 合法值写进配置。
    assert.equal(normalizeConfig({ recordDeviceId: 'mic-abc' }, { homeDir: temp.dir }).recordDeviceId, 'mic-abc')
  } finally {
    temp.cleanup()
  }
})

test('autoReadSessions：键须以 session- 开头、值转布尔、非法项忽略并提示', () => {
  const temp = makeTempDir()
  const warnings = []
  try {
    const c = normalizeConfig({
      autoReadSessions: {
        'session-a': true,
        'session-b': 'false',
        'session-c': 1,
        'session-d': 0,
        'not-a-session': true,
        '': true,
      },
    }, { homeDir: temp.dir, onWarning: (warn) => warnings.push(warn) })
    assert.deepEqual(c.autoReadSessions, {
      'session-a': true,
      'session-b': false,
      'session-c': true,
      'session-d': false,
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /2 条无法识别/)

    // 只要不是普通对象就整项丢弃，不报错。
    for (const invalid of [[], 'session-a', 42]) {
      const normalize = normalizeAutoReadSessions(invalid)
      assert.deepEqual(normalize.value, {})
      assert.equal(normalize.valid, false)
      assert.equal(normalize.warnings.length, 1)
    }
  } finally {
    temp.cleanup()
  }
})

test('autoReadSessions：最多保留 200 条，超出部分丢弃并提示', () => {
  const temp = makeTempDir()
  const warnings = []
  try {
    const table = {}
    for (let i = 0; i < 205; i += 1) table[`session-${i}`] = i % 2 === 0
    const c = normalizeConfig({ autoReadSessions: table }, {
      homeDir: temp.dir,
      onWarning: (warn) => warnings.push(warn),
    })
    assert.equal(Object.keys(c.autoReadSessions).length, 200)
    assert.equal(c.autoReadSessions['session-199'], false)
    assert.equal('session-200' in c.autoReadSessions, false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /最多保留 200 条/)
  } finally {
    temp.cleanup()
  }
})

test('ConfigStore：按会话自动朗读能保存并重读', () => {
  const temp = makeTempDir()
  try {
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    store.save({
      ...store.current,
      autoReadSessions: { 'session-a': true, 'session-b': false },
    })
    const raw = JSON.parse(readFileSync(join(temp.dir, 'fish-service-config.json'), 'utf8'))
    assert.deepEqual(raw.autoReadSessions, { 'session-a': true, 'session-b': false })

    const again = new ConfigStore({ homeDir: temp.dir })
    assert.deepEqual(again.load({}, {}).autoReadSessions, { 'session-a': true, 'session-b': false })
    assert.deepEqual(again.warnings, [])
  } finally {
    temp.cleanup()
  }
})

test('schemastery 配置 schema 能构建（拿不到包时允许为 undefined）', async () => {
  const temp = makeTempDir()
  try {
    const z = (await import('@deepseek-ai/schemastery')).default
    const schema = buildConfigSchema(z, temp.dir)
    assert.equal(typeof schema, 'function')
    const text = String(schema)
    assert.match(text, /baseUrl/)
    assert.match(text, /ttsVoice/)
    assert.match(text, /cacheDir/)
  } finally {
    temp.cleanup()
  }
})

test('界面开关：默认开，明确关闭才关，非法值回落默认，env 可覆盖', () => {
  const temp = makeTempDir()
  try {
    const keys = ['uiVoiceInput', 'uiVision', 'uiMetrics', 'uiAutoRead']
    const fallbackValue = defaultConfig(temp.dir)
    for (const key of keys) assert.equal(fallbackValue[key], true)

    // 旧配置没有这四个字段：按开处理，行为与以前一致。
    const prev = normalizeConfig({ autoRead: true }, { homeDir: temp.dir })
    for (const key of keys) assert.equal(prev[key], true)

    // 无法识别的值：回落默认（开），不抛错。
    assert.equal(normalizeConfig({ uiVoiceInput: '乱写' }, { homeDir: temp.dir }).uiVoiceInput, true)

    // false / 'false' / 0 / '0' 都算关；true / 'true' / 1 / '1' 都算开。
    for (const key of keys) {
      for (const value of [false, 'false', 0, '0']) {
        assert.equal(normalizeConfig({ [key]: value }, { homeDir: temp.dir })[key], false)
      }
      for (const value of [true, 'true', 1, '1']) {
        assert.equal(normalizeConfig({ [key]: value }, { homeDir: temp.dir })[key], true)
      }
    }

    // 环境变量最高优先级；大小写两套变量名都认。
    const override = applyEnv(defaultConfig(temp.dir), {
      DSH_FISH_SERVICE_UI_VISION: 'false',
      FISH_SERVICE_UI_AUTO_READ: '0',
      FISH_SERVICE_UI_METRICS: 'true',
    }, { homeDir: temp.dir })
    assert.equal(override.config.uiVision, false)
    assert.equal(override.config.uiAutoRead, false)
    assert.equal(override.config.uiMetrics, true)
    assert.deepEqual(override.overrides.sort(), ['uiAutoRead', 'uiMetrics', 'uiVision'])
  } finally {
    temp.cleanup()
  }
})

test('界面开关：保存后真正落盘，重读仍是关闭', async () => {
  const temp = makeTempDir()
  try {
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    store.save({
      ...store.current,
      uiVoiceInput: false,
      uiMetrics: false,
      uiVision: true,
      uiAutoRead: false,
    })
    const raw = JSON.parse(readFileSync(join(temp.dir, 'fish-service-config.json'), 'utf8'))
    assert.equal(raw.uiVoiceInput, false)
    assert.equal(raw.uiMetrics, false)
    assert.equal(raw.uiVision, true)
    assert.equal(raw.uiAutoRead, false)

    const again = new ConfigStore({ homeDir: temp.dir })
    const reread = again.load({}, {})
    assert.equal(reread.uiVoiceInput, false)
    assert.equal(reread.uiAutoRead, false)
    assert.deepEqual(again.warnings, [])

    // schema 里也要有这四项，设置页才能正常绑定。
    const z = await import('@deepseek-ai/schemastery')
    const text = String(buildConfigSchema(z.default, temp.dir))
    for (const key of ['uiVoiceInput', 'uiVision', 'uiMetrics', 'uiAutoRead']) assert.match(text, new RegExp(key))
  } finally {
    temp.cleanup()
  }
})
