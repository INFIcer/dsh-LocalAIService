# 接口契约（CONTRACT）

> 版本：`v0.6`（2026-11-10）：新增 `GET /metrics`（显存 / 模型 / 队列 / 版本，1 秒缓存，服务离线也返回 200 + `ok:false`）；客户端输入框左下加本地 AI 状态胶囊（2 秒轮询，详情浮层）。向后兼容。
> 前版：`v0.5`（识图提示词分四档）、`v0.4`（`visionPrefs` / `localDescribe` / `/describe-upload`）、`v0.3`（`visionDescribe` / `fish_describe_image` / 音色目录）、`v0.1`（P0 冻结稿）
> 适用：`dsh-fish-service` / `localai-service 2.5.x`
> 原则：**先改本文，再改代码**。P1 只实现本文已写明的字段；新增字段必须向后兼容。

---

## 0. 总则

### 0.1 三个版本号

| 名称 | 位置 | 当前 | 规则 |
| --- | --- | --- | --- |
| HTTP 契约 | `GET /capabilities` → `api_version` | `"1"` | 主版本不兼容；新增字段兼容 |
| Cordis 服务 | `fish.service.apiVersion` | `"1.0"` | 主版本必须相同；次版本向后兼容 |
| `fish.message` | `fish.message.apiVersion` | `"0.2"`（规划） | 0.x 允许小版本破坏，但必须显式升 `requires` |

### 0.2 通用返回包

所有工具与服务方法统一：

```json
{ "ok": true, "...": "..." }
```

```json
{ "ok": false, "code": "vram_exhausted", "hint": "显存不够……", "detail": "insufficient_vram: need 6912MB free 6000MB", "retryable": false }
```

- `code`：见第 3 节；`hint`：可直接展示给用户的中文；`detail`：诊断原文，不直接进 UI；
- 失败**不抛裸异常**（服务方法内部可以 throw `FishServiceError`，但工具层必须转成上面的包）；
- 未知字段调用方必须忽略；未知 `code` 按 `upstream_error` 处理并保留原值。

### 0.3 路径与文件

- 所有 `*Path` 都是**本机绝对路径**（Windows 用 `E:\...`；JSON 里反斜杠转义）；
- 工具返回的路径必须存在且可读；临时文件 TTL 见配置；
- 不接受 `file://`、URL；下载由服务端负责。

---

## 1. Cordis 服务：`fish.service`

### 1.1 类型定义

```ts
type CapabilityName =
  | 'tts' | 'asr' | 'translate' | 'separate'
  | 'vision' | 'media' | 'download' | 'jobs'

interface CapabilityInfo {
  available: boolean          // 服务暴露了该能力且 ready
  ready: boolean              // 模型文件齐全（服务端 capabilities.<name>.ready）
  loaded: boolean             // 当前是否占显存
  model?: string
  reason?: 'service_down' | 'model_missing' | 'not_supported' | 'api_incompatible'
  versions?: { service?: string; api?: string }
  estimateMb?: number
}

interface FishServiceApi {
  apiVersion: '1.0'
  capabilities: Record<CapabilityName, CapabilityInfo>
  health(opts?: { timeoutMs?: number }): Promise<HealthResult>
  ensureReady(cap: CapabilityName, opts?: { preload?: boolean; timeoutMs?: number }): Promise<ReadyResult>
  tts(input: string | string[], opts?: TtsOptions): Promise<TtsResult>
  asr(input: string | string[], opts?: AsrOptions): Promise<AsrResult>
  translate(input: string | string[], opts?: TranslateOptions): Promise<TranslateResult>
  separate(file: string, opts?: SeparateOptions): Promise<SeparateResult>
  visionFrames(input: VisionInput, opts?: VisionOptions): Promise<VisionResult>
  visionDescribe(input: string | string[], opts?: DescribeOptions): Promise<DescribeResult>
  visionPrefs(): VisionPrefs
  mediaProbe(input: string | string[], opts?: { timeoutMs?: number }): Promise<ProbeResult>
  jobs: JobsApi
  voices(opts?: { timeoutMs?: number; force?: boolean }): Promise<VoiceInfo[] & { directory?: string }>
  config: {
    get(): PublicConfig
    set(patch: Partial<PublicConfig>): Promise<{ ok: boolean; applied: string[]; requiresRestart: boolean; warnings: string[] }>
  }
  events: {
    on(name: FishEventName, fn: (e: FishEvent) => void): () => void
    off(name: FishEventName, fn: (e: FishEvent) => void): void
    once(name: FishEventName, fn: (e: FishEvent) => void): () => void
  }
  install: InstallApi   // 只给本插件 UI/工具；其它插件不要用
}
```

### 1.2 `capabilities` 形状

```json
{
  "tts": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "IndexTTS-2.5",
    "versions": { "service": "2.5.0", "api": "1" },
    "estimateMb": 6400
  },
  "asr": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "SenseVoiceSmall",
    "estimateMb": 1200
  },
  "translate": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "nllb-200-distilled-600M",
    "estimateMb": 1500
  },
  "separate": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "htdemucs",
    "estimateMb": 1000
  },
  "vision": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "Qwen2.5-VL-3B-Instruct-Q4_K_M",
    "estimateMb": 3400
  },
  "media": { "available": true, "ready": true, "loaded": false, "model": "ffmpeg", "estimateMb": 0 },
  "download": { "available": true, "ready": true, "loaded": false, "model": "yt-dlp", "estimateMb": 0 },
  "jobs": { "available": true, "ready": true, "loaded": false }
}
```

规则：

- `available = 服务可达 && api_version 兼容 && 服务端 capabilities.<cap> 存在 && ready`；
- `reason` 只在 `available=false` 时出现；
- `whisper` 不是独立工具能力，归到 `asr` 的 `engine=whisper`；服务端 `speaker` 能力只是声纹向量模型，不单独暴露；
- `jobs` 永远 `available=true`（只要服务可达且 `jobs.enabled`），因为它是一个 API 组，不是模型。

### 1.3 `health()`

```ts
interface HealthResult {
  ok: boolean
  baseUrl: string
  latencyMs: number
  checkedAt: string            // ISO8601
  serviceVersion?: string
  apiVersion?: string
  vram?: { freeMb: number; totalMb: number; marginMb?: number }
  capabilities?: Record<CapabilityName, CapabilityInfo>
  consecutiveFailures: number
  lastError?: { code: string; detail: string }
}
```

- 超时默认 2000ms；不发任何会加载模型的请求；
- `ok` 表示**服务可达且 api 兼容**，不是 localai `/health.ok`。localai 的 `ok` 只表示 TTS 权重就绪；模型没下时它仍是 HTTP 200 + `ok:false`，此时 `health().ok=true`、`capabilities.tts.ready=false`；
- `ok=false` 时 `capabilities` 可省略（服务都没通，不猜）；
- `latencyMs` 是本次 `/health` 的墙钟。

### 1.4 `ensureReady(cap, opts)`

```ts
interface ReadyResult {
  ok: boolean
  capability: CapabilityName
  ready: boolean
  loaded: boolean
  willLoadOnFirstUse: boolean
  waitedMs: number
  released?: string[]
  code?: string
  hint?: string
}
```

语义：

1. 服务不可达 → `service_down`；
2. `api_version` 不兼容 → `api_incompatible`；
3. 能力不存在 → `upstream_error`（`detail: unsupported capability`）；
4. `ready=false` → `model_missing`，带模型名/大小（能从 `/admin/models` 拿到就带）；
5. `preload:true` 且 `cap='tts'`：合成 `"嗯"` 一次，返回后 `loaded=true`；其它能力**不支持强制 preload**，返回 `willLoadOnFirstUse:true` 且 `ok=true`；
6. 不主动卸载任何模型；显存不够只报告，不替用户做决定。

### 1.5 `tts(input, opts)`

```ts
interface TtsOptions {
  voice?: string              // 默认 config.ttsVoice
  speed?: number              // 0.5~2.0，默认 1.0
  emotion?: string            // 服务端支持的情感文本/8 维向量；不校验内容
  language?: 'auto' | 'zh' | 'en' | 'ja' | 'es' | 'ar'
  seed?: number               // 0~2^32-1；不传=随机
  timeoutMs?: number          // 默认 config.requestTimeoutMs
  returnBuffer?: boolean      // 默认 false；UI 播放也别用，走 /audio/<id>
}

interface TtsResult {
  ok: boolean
  items: Array<{
    wavPath: string
    ms: number
    voice: string
    seed: number
    language?: string
    bytes: number
    cached?: boolean
    buffer?: Uint8Array   // 仅 returnBuffer:true 时；工具层永不返回
  }>
  ms: number
}
```

- 单条也传数组；工具层 `texts` 必填，服务方法允许 `string`（内部归一成数组）；
- **合成前统一朗读化**：Markdown 清洗（代码块与行内代码统一读成口播词「巴拉巴拉」，整段吞掉会让听者失去句子主干）后做中文读法
  （数字、日期、时间、地址、符号、多点版本号「2.5.0 → 二点五点零」），缓存的也是改写后的文本。
  这一步对所有调用方生效，不要在调用方自己再改写；
- 每条文本 **朗读化后** ≤ 5000 字；超过返回 `bad_request`（不要偷偷切）；改写后为空也返回
  `bad_request`（例如整条都是代码块）；
- 产物写 `~/.dsh/fish-service-cache/tts/`，返回稳定路径；
- `returnBuffer:true` 时 `items[].buffer` 是 `Uint8Array`（宿主内存内使用）；**工具层禁止设置该选项**，否则违反“不回传 base64”的约定；
- 响应头 `X-Audio-Path` 只用于诊断，不直接返回（可能被服务端清理）；
- 空数组 / 空字符串 → `bad_request`。

### 1.6 `asr(input, opts)`

```ts
interface AsrOptions {
  language?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue' | 'nospeech'
  engine?: 'auto' | 'sensevoice' | 'whisper'
  timestamps?: boolean         // true 时走 /asr/segments（固定 whisper）
  timeoutMs?: number           // 默认 config.asrTimeoutMs
}

interface AsrResult {
  ok: boolean
  items: Array<{
    file: string
    text: string
    language?: string
    engine?: 'sensevoice' | 'whisper'
    emotion?: string             // 上游情感标签，如 NEUTRAL / HAPPY；没有就不出现
    events?: string[]            // 上游事件标签，如 ["Speech"]、["Laughter"]；没有就不出现
    durationMs?: number
    elapsedMs?: number
    segments?: Array<{ start: number; end: number; text: string }>
    truncated?: boolean
  }>
  ms: number
}
```

- 文件必须是本机绝对路径；不存在 → `bad_request`；
- 上传上限 200MB（音频 50MB）；超限 → `bad_request`，hint 提示裁剪；
- `timestamps:true` 时用 `/asr/segments`，`segments` 最多返回 200 段；
- `emotion` / `events` 来自上游 `/asr` 的富标签解析（`parse_rich_tags`），原样透传；上游没给就不出现这两个字段；
- 临时上传文件请求结束即删。

### 1.7 `translate(input, opts)`

```ts
interface TranslateOptions {
  source?: string        // 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue' | NLLB 码；默认自动检测
  target?: string        // 省略时按第一/第二语言规则自动选；不能 'auto'
  timeoutMs?: number     // 默认 60000
  batchSize?: number     // 默认 8；1~16
}

interface TranslateResult {
  ok: boolean
  texts: string[]
  source: string         // 实际使用的语言代码；检测不出为 'auto'
  target: string
  engine: 'nllb'
  ms: number
  chunks?: number
}
```

目标语言自动规则（未显式传 `target` 时，优先级从高到低）：

| 条件 | 结果 |
| --- | --- |
| 显式传了 `target`（非 `'auto'`） | 用显式值 |
| 检测出原文 = `primaryLanguage`（默认 `zh`） | `secondaryLanguage`（默认 `en`） |
| 检测出原文 ≠ `primaryLanguage` | `primaryLanguage` |
| 检测不出原文语言 | `primaryLanguage` |

- 检测是字符启发式：假名→`ja`，谚文→`ko`，汉字→`zh`，拉丁字母→`en`，其余检测不出；
- 未显式传 `source` 时，把检测结果作为 `source` 发给服务；检测不出传 `auto`；
- 显式 `source` 优先于检测，也参与上面的目标语言判断（原文语言以显式 `source` 为准）；
- 1 条走 `/translate`；2~500 条走 `/translate/batch`；超过 500 条或 200k 字 → `bad_request`，提示用 `fish_job` 或拆批；
- 返回顺序与输入严格一致；
- 空字符串原样返回；
- `source='auto'` 只覆盖常见语种；失败 → `bad_request`，hint 要求显式 `source`。

### 1.8 `separate(file, opts)`

```ts
interface SeparateOptions {
  model?: 'htdemucs' | 'htdemucs_6s' | 'htdemucs_ft'  // 默认 htdemucs
  stems?: string[]        // 默认 ['vocals','drums','bass','other']
  timeoutMs?: number      // 默认 config.asrTimeoutMs
}

interface SeparateResult {
  ok: boolean
  stems: Record<string, { path: string; duration?: number }>
  dir: string
  ms: number
  released?: string[]     // 为腾显存被 LRU 卸掉的能力
}
```

- 产物复制到 `~/.dsh/fish-service-cache/separate/<jobid>/`，不返回服务端 `outputs/` 原路径；
- `stems` 至少 1 个；未知 stem → `bad_request`。

### 1.9 `visionFrames(input, opts)`

```ts
interface VisionInput {
  videoPath?: string      // 本机路径，与 url 二选一
  url?: string            // 公开链接；内部先下载
  jobId?: string          // 服务端任务 id，取 result.path
}

interface VisionOptions {
  targetFrames?: number   // 1~10，默认 3
  effort?: 'auto' | 'low' | 'medium' | 'high'
  planner?: 'hybrid' | 'agent'
  subtitles?: 'auto' | 'off'   // 默认 auto
  timeoutMs?: number      // 默认 config.visionTimeoutMs
}

interface VisionResult {
  ok: boolean
  frames: Array<{
    time: number
    path: string
    score?: number
    kind?: string
    ocrText?: string
    summary?: string
    why?: string
    confidence?: 'normal' | 'low'
  }>
  duration?: number
  subtitlesFrom?: 'embedded' | 'sidecar' | 'asr' | 'provided' | 'site' | 'none'
  stats?: { candidates?: number; vlmCalls?: number; elapsedMs?: number; degraded?: boolean; degradedReason?: string }
  ms: number
}
```

- 视频 ≤ 10 分钟默认同步 `/vision/frames`；> 10 分钟或 `effort=high` 默认走 `/jobs/vision` 轮询；
- `frames[].path` 复制到 DSH 缓存（原 `outputs/` 会被清理）；
- **不返回 base64 / preview**；
- 返回帧数少于 `targetFrames` 时 `ok:true` + `stats` 说明，不伪造。

### 1.10 `mediaProbe(input)`

```ts
interface ProbeResult {
  ok: boolean
  items: Array<{
    file: string
    duration?: number
    format?: string
    audio?: { codec?: string; sampleRate?: number; channels?: number }
    video?: { codec?: string; width?: number; height?: number; fps?: number }
  }>
  ms: number
}
```

- 1~10 个文件；单文件 ≤ 200MB；
- 只调 `/media/probe`；不触发 ffmpeg 转码。

### 1.11 `jobs`

```ts
interface JobsApi {
  enqueue(kind: 'tts'|'asr'|'separate'|'translate'|'download'|'analyze'|'vision',
          payload: Record<string, unknown>,
          opts?: { priority?: number; files?: string[]; timeoutMs?: number }): Promise<{ ok: boolean; id: string; state: string }>
  status(id: string, opts?: { timeoutMs?: number }): Promise<JobRecord>
  wait(id: string, opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<JobRecord>
  cancel(id: string): Promise<{ ok: boolean; id: string; state: string; cancelRequested?: boolean }>
  list(filter?: { kind?: string; state?: string; limit?: number; offset?: number }): Promise<{ ok: boolean; total: number; jobs: JobRecord[] }>
}

interface JobRecord {
  ok: boolean
  id: string
  kind: string
  action?: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  priority?: number
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  attempts?: number
  error?: string
  result?: Record<string, unknown>
  progress?: { stage?: string; percent?: number; downloadedBytes?: number; totalBytes?: number; speed?: number; eta?: number }
}
```

- `enqueue` 的 `files` 会先上传到服务端（multipart），`payload.file` 用服务端路径；
- `wait` 默认总超时 600s；下载任务可传 1800s；`signal` 取消时调用 `cancel`；
- `status` 不返回完整 `payload`（可能含用户文本）；只返回 `kind/state/result/error` 摘要；
- `cancel` 对终态返回 `canceled` 扩展码，不是错误。

### 1.12 `voices()`

```json
[
  { "name": "dafeiyu", "filename": "dafeiyu.wav", "format": "wav", "duration": 9.4 },
  { "name": "default", "filename": "default.mp3", "format": "mp3", "duration": 3.157 }
]
```

- 直接映射 `/voices`；不缓存超过 30 秒（音色目录可能新增文件）；`{ force: true }` 跳过缓存；
- 返回仍是**数组**（旧调用方 `voices().map(...)` 不变）；服务端返回的 `directory` 挂在数组的非枚举属性 `directory` 上，`Object.keys`/JSON 序列化都看不到它；
- 名称不含扩展名；上传音色不在本契约内（服务端 `/api/v1/upload` 可选）。

### 1.13 `config`

`get()` 返回**脱敏**配置：`token` 只返回 `"***"` 或 `""`，其余字段原样。

`set(patch)` 只接受白名单：

| 字段 | 可写 | 校验 |
| --- | --- | --- |
| `baseUrl` | ✅ | `http://` / `https://`；设置页「测试连接」走 `POST /test` |
| `apiVersion` | ✅ | 数字（如 `1`、`1.0`） |
| `token` | ✅ | 字符串 ≤512；只写，不回显 |
| `enabled` | ✅ | boolean |
| `ttsVoice` | ✅ | 字符串；不强制存在于 `/voices`（离线也能保存） |
| `ttsSpeed` | ✅ | 0.5~2 |
| `autoRead` / `autoReadInBackground` / `rememberVoiceChoice` | ✅ | boolean |
| `autoReadSessions` | ✅ | 对象；键以 `session-` 开头，最多 200 条 |
| `readMaxChars` | ✅ | 200~5000 |
| `readConcurrency` | ✅ | 1~4 |
| `recordMime` | ✅ | `auto/webm/wav` |
| `recordDeviceId` | ✅ | 字符串 ≤200 |
| `asrLanguage` | ✅ | `auto/zh/en/ja` |
| `primaryLanguage` / `secondaryLanguage` | ✅ | `zh/en/ja/ko/yue` |
| `requestTimeoutMs` / `asrTimeoutMs` / `visionTimeoutMs` | ✅ | 1000~1800000 |
| `localDescribe` | ✅ | boolean |
| `uiVoiceInput` / `uiVision` / `uiMetrics` / `uiAutoRead` | ✅ | boolean（界面注入开关） |
| `visionPresets` | ✅ | 对象，`brief/standard/detailed/text` 四键各 ≤4000 字 |
| `visionDefaultPreset` | ✅ | `brief/standard/detailed/text` |
| `visionSessionPrompt` | ✅ | 字符串 ≤4000 字 |
| `cacheDir` | ✅ | 绝对路径 |
| `cacheTtlHours` / `cacheMaxMb` | ✅ | 1~720 / 256~10240 |
| `healthIntervalMs` | ✅ | 5000~120000 |
| `enabledCapabilities` | ✅ | 字符串数组（服务端能力名子集；空 = 全开） |
| `logLevel` | ✅ | `debug/info/warn/error` |
| `installDir` / `installMode` / `version` | ❌ | 由安装器维护 |

返回：

```json
{ "ok": true, "applied": ["ttsVoice"], "requiresRestart": false, "warnings": [] }
```

### 1.14 `events`

| 事件 | payload | 触发 |
| --- | --- | --- |
| `model-loaded` | `{capability, model, at}` | 轮询发现 `loaded=false→true` |
| `model-unloaded` | `{capability, model?, at}` | `loaded=true→false` |
| `error` | `{code, capability?, detail, at}` | 请求失败（节流：同 code 30s 一次） |
| `service-down` | `{reason, at}` | 连续 2 次健康失败 |
| `service-up` | `{serviceVersion, at}` | 失败后首次成功 |

- 事件是**尽力而为**：轮询间隔内最多延迟 15s；不保证每次模型加载都触发；
- 监听器异常不影响主流程；`on` 返回 disposer。

### 1.15 `install`（内部 API）

```ts
interface InstallApi {
  status(): Promise<InstallStatus>
  preflight(opts?: { installDir?: string; port?: number }): Promise<PreflightResult>
  start(opts: { installDir: string; models: string[]; installEngine: boolean; autoStart: boolean }): Promise<{ ok: boolean; taskId: string }>
  cancel(): Promise<{ ok: boolean }>
  adopt(opts?: { baseUrl?: string }): Promise<{ ok: boolean; installMode: 'adopted'; serviceVersion?: string }>
  uninstall(opts: { removeModels?: boolean; keepConfig?: boolean }): Promise<{ ok: boolean; removed: string[]; kept: string[] }>
  models(): Promise<ModelInfo[]>
  logs(opts?: { lines?: number; file?: 'service' | 'err' }): Promise<{ ok: boolean; lines: string[] }>
}
```

详细字段与状态机见 [`DEPLOY.md`](DEPLOY.md) 第 3 节。

### 1.16 `visionDescribe(input, opts)`（v0.3）

单张 / 多张**本机图片**理解，包装本地服务 `POST /vision/describe`（multipart：`file` + 可选 `prompt`）。

```ts
interface DescribeOptions {
  prompt?: string                    // 覆盖所有默认提示词；最长 4000 字
  preset?: VisionPreset              // 工具识图档位；默认用 config.visionDefaultPreset
  scope?: 'tool' | 'session'         // 默认 'tool'；'session' 用会话识图提示词
  mode?: 'caption' | 'score' | 'ocr' // 默认 'caption'；旧调用方兼容
  timeoutMs?: number                 // 默认 config.visionTimeoutMs
}

type VisionPreset = 'brief' | 'standard' | 'detailed' | 'text'

interface DescribeItem {
  path: string
  text: string
  parsed?: unknown                   // 服务端能解析出 JSON 时原样返回
  ms: number                         // 服务端 elapsed_ms，缺失时用本机耗时
}

interface DescribeResult {
  ok: true
  items: DescribeItem[]
  ms: number
}
```

- `input` 是单个路径或路径数组，**最多 10 张**；路径必须是本机绝对路径、存在、是文件（复用 `checkLocalFile`）；
- 扩展名只接受 `.jpg/.jpeg/.png/.webp/.gif/.bmp`，否则 `bad_request`；
- 能力名 `vision`：先走 `requestCapability('vision')`，服务离线/模型没装按现有错误分类返回；
- 提示词优先级：显式 `prompt` > `scope='session'` 时的会话识图提示词 > 显式 `preset` > `config.visionDefaultPreset`；空串的档位提示词按内置默认处理；
- `scope` 只影响提示词来源：`'tool'`（默认）用工具档位，`'session'` 用 `config.visionSessionPrompt`（留空时与「详细」档一致），此时忽略 `preset`；
- 旧 `mode` 仍兼容：`caption` 走上面的优先级，`ocr` 固定「只看文字」档，`score` **不传** `prompt`（沿用服务端 `vlm_frame_score.md` 评分提示）；
- 提示通过 multipart 的 `prompt` 字段覆盖服务端用户消息；
- 逐张串行调用（服务端一次只处理一张），任一张失败整体失败，不返回半成品；
- 只返回文字 / `parsed` / 耗时，**不返回 base64、不返回图片本体**。

### 1.17 `visionPrefs()`（v0.4，v0.5 扩充）

识图偏好，只读。给别的插件（鱼讯）判断「要不要走本地识图、会话识图能不能用」用，不探服务、不联网、不加载模型。

```ts
interface VisionPrefs {
  localDescribe: boolean      // 设置页「本地识图」开关；未配置时为 false
  visionSessionReady: boolean // 会话识图是否可用（当前与 localDescribe 同值）
  visionSessionPrompt: string // 会话识图实际用的提示词；关闭时为空串
  visionDefaultPreset: VisionPresetName // 工具识图默认档位，缺省 'detailed'
}
```

- 只读本地配置：`localDescribe: config.localDescribe !== false`，配置在归一化时已把缺字段补成 `false`，因此旧配置文件（没有该字段）返回 `false`，只有显式打开才是 `true`；
- `visionSessionPrompt`：配置里留空时返回内置「详细」档文本（关闭时返回空串），调用方可直接展示或转发；
- `visionDefaultPreset`：工具识图（`scope='tool'`）未显式指定 `preset` 时用的档位，取值 `brief/standard/detailed/text`，配置非法时回落 `detailed`；
- 同步返回，不抛异常；设置页改完立即生效，无需重启；
- 调用方做「继承 / 开 / 关」三态时：读 `visionPrefs().localDescribe` 作为「继承」时的值，
  自己的开关覆盖它即可；
- 本插件内部也用它：`POST /describe-upload` 在关闭时直接 400，并从这里取默认档位；
  `fish_describe_image` 在关闭时工具层直接返回 `not_supported`；工具提示段在关闭时输出空串。

---

## 2. DSH 工具契约

### 2.1 通用规则

- 工具名全局唯一；本插件固定 9 个（第 2.2 节）；
- `parameters` 是标准 JSON Schema（object 根，`additionalProperties:false`）；
- `output` 用 JSON Schema 描述成功包；失败包统一 `{ok:false, code, hint, detail?, retryable}`；
- 所有路径必须绝对路径；工具不做 `~` 展开（由调用方/LLM 给绝对路径）；
- 批量上限是硬限制，超限 `bad_request`，不静默截断。

### 2.2 工具清单

| 工具 | 参数（必填加 *） | 返回 | 主要错误 |
| --- | --- | --- | --- |
| `fish_tts` | `texts*` (1~20)、`voice`、`speed` 0.5~2、`language`、`seed` | `items[{wavPath,ms,voice,seed,bytes}]` | `service_down`、`model_missing`、`vram_exhausted`、`timeout`、`bad_request` |
| `fish_asr` | `files*` (1~10)、`language`、`engine`、`timestamps` | `items[{file,text,segments?,engine,ms}]` | 同上 + `bad_request`（文件不存在/超限） |
| `fish_translate` | `texts*` (1~200)、`source`、`target`（省略时自动） | `{texts,source,target,ms}` | `bad_request`（语言/长度）、`service_down`、`vram_exhausted` |
| `fish_separate` | `file*`、`model`、`stems[]` | `{stems,dir,ms,released?}` | `model_missing`（htdemucs_ft）、`vram_exhausted`、`timeout` |
| `fish_vision_frames` | `videoPath*`、`targetFrames` 1~10、`effort`、`planner`、`subtitles` | `{frames[],duration,subtitlesFrom,stats,ms}` | `model_missing`、`vram_exhausted`、`timeout`、`bad_request` |
| `fish_describe_image` | `paths*` (1~10)、`detail` (`brief/standard/detailed/text`，也认中文名)、`mode` (`caption/score/ocr`)、`prompt` | `{ok,items:[{path,text,parsed?,ms}],ms}` | `bad_request`（非图片/不存在/超 10 张）、`service_down`、`model_missing`、`vram_exhausted`、`timeout` |
| `fish_media_probe` | `files*` (1~10) | `{items[],ms}` | `bad_request`、`service_down` |
| `fish_job` | `action*` (`status/cancel/list/wait`)、`jobId`、`kind`、`state`、`limit` | 任务记录/列表 | `bad_request`（缺 jobId）、`canceled`、`timeout` |
| `fish_service_status` | 无 | `{ok,baseUrl,version,apiVersion,capabilities,vram,voices,install,autostart,lastError}` | 永远 `ok:true`（服务不可达时 `ok:false` 但仍有诊断） |

### 2.3 `fish_tts` 完整 schema

```json
{
  "name": "fish_tts",
  "description": "把文字转换为语音，可一次合成多条。返回音频文件路径与耗时。文本会先朗读化（代码块与行内代码读成「巴拉巴拉」、数字/地址转中文读法），所以听到的是改写后的内容。首条可能因加载模型较慢，超时默认 180 秒。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "texts": {
        "type": "array",
        "items": { "type": "string", "minLength": 1, "maxLength": 5000 },
        "minItems": 1,
        "maxItems": 20,
        "description": "要合成的文本（1~20 条）；单条也传数组。每条朗读化后不超过 5000 字（长度在运行期按改写后文本校验）。"
      },
      "voice": { "type": "string", "description": "音色名，如 dafeiyu/default；默认取配置。" },
      "speed": { "type": "number", "minimum": 0.5, "maximum": 2.0, "default": 1.0 },
      "language": { "type": "string", "enum": ["auto", "zh", "en", "ja", "es", "ar"], "default": "auto" },
      "seed": { "type": "integer", "minimum": 0, "maximum": 4294967295, "description": "不传=随机；同一 seed 可复现。" }
    },
    "required": ["texts"]
  },
  "output": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "wavPath": { "type": "string" },
            "ms": { "type": "number" },
            "voice": { "type": "string" },
            "seed": { "type": "number" },
            "language": { "type": "string" },
            "bytes": { "type": "number" },
            "cached": { "type": "boolean" }
          },
          "required": ["wavPath", "ms", "voice", "seed", "bytes"]
        }
      },
      "ms": { "type": "number" }
    },
    "required": ["ok", "items", "ms"]
  }
}
```

成功示例：

```json
{
  "ok": true,
  "items": [
    { "wavPath": "C:\\Users\\Administrator\\.dsh\\fish-service-cache\\tts\\a1b2c3d4-1794200000.wav", "ms": 8530, "voice": "dafeiyu", "seed": 42, "language": "zh", "bytes": 182300, "cached": false }
  ],
  "ms": 8530
}
```

失败示例：

```json
{ "ok": false, "code": "vram_exhausted", "hint": "显存不够（需要约 6.4 GB，当前空闲 2.1 GB）。关掉占显存的程序，或在服务 WebUI 里卸载其它模型。", "detail": "insufficient_vram: need 6912MB free 6000MB", "retryable": false }
```

**界面显示（v0.4）**：返回值（`items` / `ms` / 失败包）完全不变；工具结果渲染成一行文字，不再铺 JSON：

```text
语音已生成（1 段）：C:\Users\Administrator\.dsh\fish-service-cache\tts\a1b2c3d4-1794200000.wav
```

失败时这一行就是 `hint`。原因见 `docs/DSH-CAPABILITIES.md`：会话里没有音频附件类型，文件要靠官方 `present`
工具变成交付卡；系统提示会引导模型在用户要文件时调用它。

### 2.4 `fish_asr` 完整 schema

```json
{
  "name": "fish_asr",
  "description": "本地转写音频/视频（可一次多个）。默认 SenseVoice；timestamps=true 时用 whisper 分段。返回文字与可选分段；不返回音频。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "files": {
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1,
        "maxItems": 10,
        "description": "本机绝对路径；音频或视频，单文件 ≤200MB。"
      },
      "language": { "type": "string", "enum": ["auto", "zh", "en", "ja", "ko", "yue", "nospeech"], "default": "auto" },
      "engine": { "type": "string", "enum": ["auto", "sensevoice", "whisper"], "default": "auto" },
      "timestamps": { "type": "boolean", "default": false, "description": "true 时走 /asr/segments（固定 whisper）。" }
    },
    "required": ["files"]
  },
  "output": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "file": { "type": "string" },
            "text": { "type": "string" },
            "language": { "type": "string" },
            "engine": { "type": "string" },
            "durationMs": { "type": "number" },
            "elapsedMs": { "type": "number" },
            "segments": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": { "start": { "type": "number" }, "end": { "type": "number" }, "text": { "type": "string" } },
                "required": ["start", "end", "text"]
              }
            },
            "truncated": { "type": "boolean" }
          },
          "required": ["file", "text"]
        }
      },
      "ms": { "type": "number" }
    },
    "required": ["ok", "items", "ms"]
  }
}
```

### 2.5 `fish_job` 完整 schema

```json
{
  "name": "fish_job",
  "description": "查询/取消/等待本地服务任务，或列最近任务。长任务（下载、视觉、批量翻译）先用 enqueue 再轮询；本工具只做查询与控制，不提交新任务。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "action": { "type": "string", "enum": ["status", "cancel", "list", "wait"] },
      "jobId": { "type": "string", "description": "action=status/cancel/wait 时必填。" },
      "kind": { "type": "string", "enum": ["tts", "asr", "separate", "translate", "download", "analyze", "vision"] },
      "state": { "type": "string", "enum": ["queued", "running", "done", "failed", "canceled"] },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
      "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 1800000, "default": 600000 }
    },
    "required": ["action"]
  }
}
```

### 2.6 其余工具参数与返回

**`fish_translate`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `texts` | string[] | ✅ | 1~200 条，每条 ≤5000 字，总 ≤200k 字 | 要翻译的文本 |
| `source` | string | ❌ | `auto` / `zh` / `en` / NLLB 码 | 默认 `auto`；超短文本检测不稳，建议显式 |
| `target` | string | ✅ | 不能 `auto` | 目标语言 |

返回：`{ok, texts[], source, target, engine:"nllb", ms, chunks?}`。
错误：`bad_request`（语言/长度/超 500 条）、`service_down`、`vram_exhausted`、`timeout`。

**`fish_separate`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `file` | string | ✅ | 本机绝对路径，≤200MB | 音频或视频 |
| `model` | string | ❌ | `htdemucs`（默认）/`htdemucs_6s`/`htdemucs_ft` | `htdemucs_ft` 需额外权重，缺则 `model_missing` |
| `stems` | string[] | ❌ | 默认 `["vocals","drums","bass","other"]` | 未知 stem → `bad_request` |

返回：`{ok, stems:{vocals:{path,duration?}, ...}, dir, ms, released?}`。
错误：`model_missing`、`vram_exhausted`、`timeout`、`bad_request`。

**`fish_vision_frames`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `videoPath` | string | ✅ | 本机绝对路径；与 `url` 二选一（工具层只暴露 path） | 视频/图片目录 |
| `targetFrames` | integer | ❌ | 1~10，默认 3 | 关键帧数 |
| `effort` | string | ❌ | `auto`（默认）/`low`/`medium`/`high` | 预算档位 |
| `planner` | string | ❌ | `hybrid`（默认）/`agent` | 规划器 |
| `subtitles` | string | ❌ | `auto`（默认）/`off` | 是否用软字幕/ASR 辅助选帧 |

返回：`{ok, frames:[{time,path,score?,kind?,ocrText?,summary?,why?,confidence?}], duration?, subtitlesFrom?, stats?, ms}`。
错误：`model_missing`、`vram_exhausted`、`timeout`、`bad_request`；视频没有视频流 → `bad_request`。

**`fish_describe_image`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `paths` | string[] | ✅ | 1~10 张，本机绝对路径 | 只收 `.jpg/.jpeg/.png/.webp/.gif/.bmp` |
| `detail` | string | ❌ | `brief`/`standard`/`detailed`/`text`，也接受中文名（简短/标准/详细/只看文字） | 选择识图档位；不传或认不出时用设置里的默认档（默认「详细」） |
| `mode` | string | ❌ | `caption`（默认）/`score`/`ocr` | 旧参数；`score` 用于画面评分，`ocr` 固定「只看文字」档 |
| `prompt` | string | ❌ | ≤4000 字 | 完全覆盖提示词，优先级最高 |

返回：`{ok, items:[{path,text,parsed?,ms}], ms}`。
错误：`bad_request`（非图片/不存在/超 10 张）、`service_down`、`model_missing`、`vram_exhausted`、`timeout`。

**`fish_media_probe`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `files` | string[] | ✅ | 1~10 个，单文件 ≤200MB | 本机绝对路径 |

返回：`{ok, items:[{file,duration?,format?,audio?,video?}], ms}`。
错误：`bad_request`（文件不存在/超限）、`service_down`、`timeout`。

### 2.7 `fish_service_status` 返回示例

```json
{
  "ok": true,
  "baseUrl": "http://127.0.0.1:7880",
  "version": "2.5.0",
  "apiVersion": "1",
  "latencyMs": 12,
  "vram": { "freeMb": 6973, "totalMb": 8192 },
  "capabilities": { "tts": { "available": true, "ready": true, "loaded": false, "model": "IndexTTS-2.5" } },
  "voices": ["dafeiyu", "default", "female-A"],
  "install": { "installMode": "adopted", "installDir": "E:\\LocalAIService", "serviceVersion": "2.5.0" },
  "autostart": { "supported": true, "enabled": true, "name": "LocalAIService-Service" },
  "lastError": null
}
```

### 2.8 工具错误返回示例

```json
{ "ok": false, "code": "service_down", "hint": "本地 AI 服务没在运行。点『启动服务』，或运行 start_ai_service.ps1。", "detail": "fetch failed: ECONNREFUSED 127.0.0.1:7880", "retryable": true, "retryAfterMs": 5000 }
```

---

## 3. 错误码

### 3.1 完整表

| code | 来源 | HTTP/条件 | `retryable` | hint（固定文案） |
| --- | --- | --- | --- | --- |
| `service_not_installed` | 插件 | 无配置 + 探测不到 + 无安装标记 | false | 还没装本地 AI 服务。打开 设置 → 插件 → 本地 AI → 安装服务。 |
| `service_down` | 插件 | ECONNREFUSED / 健康超时 / 进程不在 | true | 本地 AI 服务没在运行。点『启动服务』，或运行 start_ai_service.ps1。 |
| `model_missing` | 服务+插件 | `cap.ready=false`；或 `/admin/models` `present=false`；或 503 + 缺权重 | false | 缺少 {model} 模型（约 {size}）。到『模型管理』勾选下载。 |
| `model_loading` | 服务+插件 | 503 detail 含“加载/loading”；或冷加载 in-flight 超 3s 再次请求 | true | 模型正在加载，通常 10~60 秒；稍后再试。 |
| `vram_exhausted` | 服务 | 507 `insufficient_vram` | false | 显存不够（需要约 {need}，当前空闲 {free}）。关掉占显存的程序，或在服务 WebUI 里卸载其它模型。 |
| `busy` | 插件 | 队列等待中；或 503 含“队列/busy” | true | 服务正在忙（队列还有 {n} 个任务），已经排队；可用 fish_job 查进度。 |
| `timeout` | 插件 | 504 `job_timeout`/`comfy_error`；fetch AbortError | true（一次） | 等太久了（>{timeout} 秒），模型可能正在加载。稍后重试；长文本请分段。 |
| `bad_request` | 服务 | 400/401/403/404/413/422 | false | 参数不对：{detail}。修正后重试，不要原样重试。 |
| `upstream_error` | 服务 | 500/502/503（能力 ready 但失败） | true（一次） | 服务内部报错：{detail}。可重试一次；仍失败看 logs\service.err.log。 |
| `api_incompatible` | 插件 | `api_version` 主版本 ≠ 1 | false | 服务契约版本不匹配（服务 {v}，插件支持 1.x）。请升级插件或服务。 |
| `canceled` | 服务+插件 | 409 `job_canceled`；或用户取消 | false | 任务已取消。 |
| `not_implemented` | 插件 | 契约保留、本版未做 | false | 这个功能还没实现（{feature}）。 |
| `not_supported` | 插件 | 插件配置把能力显式关闭（如 `localDescribe=false`） | false | 该能力未启用，请到「设置 → 插件 → 本地 AI」中打开后再试。 |

### 3.2 HTTP 映射细节

| HTTP | 服务端 `error` | 映射 | 备注 |
| --- | --- | --- | --- |
| 400 | `invalid_*` / `voice_not_found` | `bad_request` | 不重试 |
| 401 | `unauthorized` | `bad_request` | hint 提示检查 token；**不**自动重试 |
| 403 | `result_path_not_allowed` | `bad_request` | 路径越界；不要换路径重试 |
| 404 | `voice_not_found` / `job_not_found` | `bad_request` | 音色不存在 → 刷新 `/voices` |
| 409 | `job_not_done` / `not_cancelable` | `bad_request` | 任务状态不允许 |
| 409 | `job_canceled` | `canceled` | 用户取消 |
| 413 | — | `bad_request` | 提示裁剪/压缩 |
| 422 | 校验错误 | `bad_request` | FastAPI 默认 |
| 500 | — | `upstream_error` | 可重试一次 |
| 502 | `comfy_error` | `upstream_error` | 仅 comfy 后端 |
| 503 | `engine_error` / `asr_error` / …且 `cap.ready=false` | `model_missing` | 先看 `/admin/models` |
| 503 | 同上但 `cap.ready=true` | `upstream_error` | 引擎加载失败 |
| 503 | detail 含“加载/loading” | `model_loading` | 服务端没有独立 code，按文案识别 |
| 504 | `job_timeout` / `comfy_error` | `timeout` | 不无限重试 |
| 507 | `insufficient_vram` | `vram_exhausted` | 带 `need_mb/free_mb` 进 detail |

### 3.3 重试策略

- `service_down` / `busy` / `model_loading`：最多重试 1 次，退避 2~5s；
- `timeout`：最多 1 次；长文本先分段；
- `upstream_error`：最多 1 次；
- `vram_exhausted` / `model_missing` / `bad_request` / `api_incompatible`：**不自动重试**；
- 任何重试都不得重复“有副作用”的步骤（发语音用幂等 key）。

---

## 4. 宿主 HTTP 路由（UI 用）

前缀 `/dsh-fish-service`。这些路由给**本插件客户端**用，不是公共 API；token 由宿主注入，浏览器不接触。

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok, pluginOk, serviceDown, enabled, pluginVersion, baseUrl, lastCheckAt, latencyMs, consecutiveFailures, serviceVersion?, apiVersion?, lastError?}`（宿主自身健康，不是 localai 的） |
| GET | `/state` | — | 设置页聚合状态：`plugin{version,configFile,logFile,enabled,baseUrl}/config/health/capabilities/voices(名字数组)/voicesDirectory/visionDefaults{presets,session}/cache/errors/envOverrides`（服务离线时 `voicesDirectory` 为空字符串） |
| POST | `/save` | `{config}`、`{patch}` 或裸补丁 | `{ok, applied, requiresRestart, warnings, config}` |
| POST | `/test` | `{timeoutMs?}` | `{ok, reachable, compatible, baseUrl, latencyMs, checkedAt, serviceVersion?, apiVersion?, capabilities?, lastError?, code?, hint?}` |
| GET | `/logs` | `?lines=1~1000` | `{ok, lines:[]}`（本插件日志文件，不含服务日志） |
| GET | `/voices` | — | `{ok, voices:[...]}`；服务失败仍 200 + `ok:false` |
| POST | `/translate` | `{text, source?, target?}` | `{ok, text, source, target, ms}`；参数错 400、服务错 502 |
| POST | `/translate/batch` | `{texts:[{id,text}], source?, target?, batchSize?, timeoutMs?}`（≤500 段、总 ≤20 万字） | `{ok, source, target, engine, ms, results:[{id, translated, detectedLang?, error?}]}` |
| POST | `/translate/jobs` | `{texts:[string], source?, target?}` | `{ok, id, state, source, target, count}`；旧服务 200 + `{ok:false, code:"not_supported"}` |
| GET | `/translate/jobs/status` | `?id=` | `{ok, id, state, progress?, error?}` |
| GET | `/translate/jobs/result` | `?id=` | `{ok, id, state, texts, source, target, engine, ms?}`；未完成 200 + `{ok:false, code:"not_ready"}` |
| POST | `/translate/jobs/cancel` | `{id}` | 取消结果；失败也 200 |
| POST | `/read` | `{text, voice?, speed?, maxChars?}` | `{ok, wavPath, ms, items[{wavPath,url,ms,voice,bytes,chars,cached}], chunks, chars, codeBlocks, truncated, concurrency, cachedChunks, cacheHits, degraded?}`（P2，一次全合成） |
| POST | `/read/plan` | `{text, maxChars?, voice?, speed?}` | `{ok, segments:[{index,text,chars}], chars, codeBlocks, codeLines, truncated, voice, speed, maxChars}`（P2.1，不合成；`segments[].text` 已清洗并朗读化） |
| POST | `/read/segment` | `{index, total?, text, voice?, speed?}` | `{ok, index, wavPath, url, ms, cached, bytes, voice?, speed?, total?}`（P2.1，单段合成、自动命中缓存） |
| GET | `/cache/stats` | — | `{ok, kind:"tts", files, bytes, hits, misses, hitRate}`（P2.1，服务层内存计数） |
| POST | `/cache/clear` | `{kind?}` | `{ok, kind, files, bytes, kinds}`；省略 kind 清产物但保留 `voice`（P2.1） |
| POST | `/cache/cleanup` | — | `{ok, expired, lru, bytesFreed, scanned}`（P2.1，调 `CacheStore.cleanup()`） |
| POST | `/open-folder` | `{path}` | `{ok, path}`；在文件管理器里打开目录，只接受 `cacheDir` 或**服务当前音色目录**本身/子目录（realpath 校验，非 Windows 返回「暂不支持」） |
| POST | `/open-webui` | — | `{ok:true}`；先探测服务可达，只拼 `/ui`，Windows 用 `cmd start` 打开；非 Windows 200 + `not_supported` |
| GET | `/audio?path=` | — | `audio/*`；只允许 `cacheDir` 内的 `.wav/.webm/.ogg/.opus/.mp3/.m4a`，≤128MB（P2） |
| POST | `/transcribe-upload` | multipart `file` + `durationMs?` + `language?` | `{ok, text, ms, elapsedMs?, language?}`；≥1500 字节、≥300ms、≤5 分钟；临时文件请求结束删除（识别异常短文本时会短时保留排查） |
| POST | `/voice-upload` | multipart `file` + `durationMs?` | `{ok, path, bytes, mime}`（P2，存 `cacheDir/voice`） |
| POST | `/describe-upload` | multipart `file`（`image/*`）+ `mode?` + `scope?` + `preset?` | `{ok, text, mode, scope, preset?, ms, bytes}`（v0.4；v0.5 加 `scope`/`preset`。`scope=session` 用会话识图提示词、不传 `preset`；工具档位缺省取 `visionPrefs().visionDefaultPreset`；图片只存临时文件、请求结束即删） |
| GET | `/metrics` | — | `{ok:true, ms, gpu:{name,usedMb,totalMb,freeMb,percent}, modelsLoaded:[], queue:{queued,running,queuedByKind,runningByKind}, scheduler:{currentKind,loadedModel}, service:{version,uptimeSeconds}, vision:{loaded,ready}}`；宿主并行抓 localai 的 `/admin/system` 与 `/jobs/stats?limit=1`（各 1500ms 超时），结果缓存 1 秒。两侧都失败时仍返回 200 + `{ok:false, code:"service_down", hint:"本地 AI 未启动"}`（服务未启动的常规分支，不是错误）；只有一侧成功时另一侧给中性默认值。`percent` 为整数，缺字段不报错 |

`/describe-upload` 的客户端用途：输入框旁的「本地识图」按钮调用它（`scope=session`、`mode=caption`，不传 `preset`）；
成功后客户端把「［图片：文件名］＋描述」按顺序插入输入框（图片不需要先加进草稿、不上传、不进模型），失败只提示一句。
`scope` 缺省时按 `tool` 处理，传 `preset` 或 `mode=ocr` 时仍可走工具档位；非法 `preset` 回配置默认档。
消息发出后的旧「图片下方按钮」与草稿附件栏入口均已移除。

安装器、模型下载/激活、服务启停、管理界面嵌入等安装/模型管理类 HTTP 路由**不在本插件内**（P1/P3 未实现）；
本插件只在 `/state`、`/health` 里暴露安装/服务状态相关字段，安装动作由安装器（`install` 相关工具）承担。

安全：

- 写操作（POST，以及 `GET /metrics`）检查同源：`Origin` 的 host 必须与请求 Host 一致；没有 `Origin` 的本机脚本/测试放行；不看 `Referer`；
- `/open-folder` 只打开 `cacheDir` 或服务音色目录本身/子目录：缓存根每次从配置取，音色目录每次实时 `GET /voices` 取（不落配置、不缓存成任意路径）；路径须为绝对路径、已存在、是目录，两边 realpath 后再判包含关系，防符号链接穿越；服务离线时只允许 `cacheDir`；
- `/audio?path=` 只读 `cacheDir` 内、扩展名白名单、≤128MB 的音频文件；用 `isPathInside` 按解析后的路径字符串前缀判断（不 realpath）；
- `/logs` 只读本插件自己的日志文件，`lines` 限 1~1000，不接受任意路径；
- `/describe-upload` 只收 `image/jpeg|png|webp|gif|bmp`，单张 ≤15MB；`localDescribe` 关闭时直接 400；图片落 `cacheDir/tmp`，请求结束（含失败）立即删除；
- `/transcribe-upload`、`/voice-upload` 走 multipart，音频 ≤25MB、图片 ≤15MB，临时文件请求结束删除（识别异常短文本时短时保留排查）；
- 不返回 token、不返回 localai 的绝对 `outputs/` 路径。

---

## 5. 配置 schema

### 5.1 完整示例

```json
{
  "version": 1,
  "enabled": true,
  "uiVoiceInput": true,
  "uiVision": true,
  "uiMetrics": true,
  "uiAutoRead": true,
  "baseUrl": "http://127.0.0.1:7880",
  "apiVersion": "1",
  "token": "",
  "requestTimeoutMs": 180000,
  "asrTimeoutMs": 300000,
  "visionTimeoutMs": 600000,
  "localDescribe": false,
  "visionPresets": {
    "brief": "",
    "standard": "",
    "detailed": "",
    "text": ""
  },
  "visionDefaultPreset": "detailed",
  "visionSessionPrompt": "",
  "ttsVoice": "dafeiyu",
  "ttsSpeed": 1,
  "autoRead": false,
  "autoReadSessions": {},
  "autoReadInBackground": true,
  "readMaxChars": 2000,
  "readConcurrency": 2,
  "recordMime": "auto",
  "recordDeviceId": "",
  "rememberVoiceChoice": true,
  "asrLanguage": "auto",
  "primaryLanguage": "zh",
  "secondaryLanguage": "en",
  "cacheDir": "%DSH_HOME%/fish-service-cache",
  "cacheTtlHours": 72,
  "cacheMaxMb": 2048,
  "healthIntervalMs": 15000,
  "enabledCapabilities": [],
  "logLevel": "info",
  "installMode": "unknown",
  "installDir": ""
}
```

### 5.2 字段说明

| 字段 | 类型 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `version` | int | 1 | 只读 | schema 版本；迁移用 |
| `enabled` | bool | true | — | 总开关 |
| `uiVoiceInput` | bool | true | — | 界面注入：语音输入按钮 |
| `uiVision` | bool | true | — | 界面注入：本地识图按钮 |
| `uiMetrics` | bool | true | — | 界面注入：性能监控 |
| `uiAutoRead` | bool | true | — | 界面注入：自动朗读按钮 |
| `baseUrl` | string | `http://127.0.0.1:7880` | `http(s)://` | 唯一服务地址 |
| `apiVersion` | string | `"1"` | — | 期望的服务契约主版本 |
| `token` | string | `""` | ≤512 | 只写不回显 |
| `requestTimeoutMs` | int | 180000 | 1000~1800000 | TTS/一般 |
| `asrTimeoutMs` | int | 300000 | 1000~1800000 | ASR/分离 |
| `visionTimeoutMs` | int | 600000 | 1000~1800000 | 视觉 |
| `localDescribe` | bool | false | — | 本地识图总开关（v0.4）；默认关闭；关闭时工具层直接 `not_supported`；旧配置缺字段按 false |
| `visionPresets` | object | 四档内置提示词 | 只认 `brief/standard/detailed/text` 四个字符串键，每个 ≤4000 字 | 工具识图四档提示词；空串表示用内置默认，缺字段自动补默认（v0.5） |
| `visionDefaultPreset` | enum | `detailed` | `brief/standard/detailed/text` | 工具识图默认档；非法值回退 `detailed`（v0.5） |
| `visionSessionPrompt` | string | `""` | ≤4000 字 | 会话识图（输入框旁按钮）单独用的提示词；留空时与「详细」档一致（v0.5） |
| `ttsVoice` | string | `dafeiyu` | 存在于 `/voices` | 默认音色 |
| `ttsSpeed` | number | 1 | 0.5~2.0 | 朗读语速（P2） |
| `autoRead` | bool | false | — | 自动朗读最终回复（P2）；默认关，避免迁移后突然出声 |
| `autoReadSessions` | object | `{}` | 键以 `session-` 开头，最多 200 条 | 记住哪些会话开自动朗读（P2） |
| `autoReadInBackground` | bool | true | — | 会话在后台时也朗读（P2） |
| `readMaxChars` | int | 2000 | 200~5000 | 朗读单段最大字数（P2） |
| `readConcurrency` | int | 2 | 1~4 | 朗读分段合成的批间并发度（P2.1；1 = 完全串行） |
| `recordMime` | enum | auto | auto/webm/wav | 语音输入录音格式（P2） |
| `recordDeviceId` | string | `""` | ≤200 | 指定录音设备；空 = 系统默认（P2） |
| `rememberVoiceChoice` | bool | true | — | 记住三选一上次选择（P2，只做高亮） |
| `asrLanguage` | enum | auto | auto/zh/en/ja | 语音输入 ASR 语言（P2） |
| `primaryLanguage` | enum | `zh` | `zh/en/ja/ko/yue` | 翻译第一语言：原文不是它时译成它（v0.3） |
| `secondaryLanguage` | enum | `en` | `zh/en/ja/ko/yue` | 翻译第二语言：原文就是第一语言时译成它（v0.3） |
| `cacheDir` | string | `%DSH_HOME%/fish-service-cache` | 绝对路径 | 产物缓存目录 |
| `cacheTtlHours` | int | 72 | 1~720 | 必须 > fish-message 出站 TTL（24h） |
| `cacheMaxMb` | int | 2048 | 256~10240 | LRU 上限 |
| `healthIntervalMs` | int | 15000 | 5000~120000 | 健康轮询 |
| `enabledCapabilities` | list | `[]` | 服务端能力名子集 | 空 = 按服务端能力全开；非空时只启用列出的能力（设置页勾选） |
| `logLevel` | enum | info | `debug/info/warn/error` | 日志级别 |
| `installMode` | enum | `unknown` | `unknown/managed/adopted` | 安装器维护 |
| `installDir` | string | `""` | 绝对路径 | managed 模式（P1 安装器维护） |

### 5.3 环境变量

| 变量 | 字段 | 优先级 |
| --- | --- | --- |
每个变量都有 `DSH_FISH_SERVICE_*` 与更短的 `FISH_SERVICE_*` 两种写法，前者优先。

| 变量（`DSH_FISH_SERVICE_*`） | 字段 | 类型 |
| --- | --- | --- |
| `BASE_URL` | `baseUrl` | string |
| `API_VERSION` | `apiVersion` | string |
| `TOKEN` | `token` | string |
| `ENABLED` | `enabled` | boolean |
| `REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | number |
| `ASR_TIMEOUT_MS` | `asrTimeoutMs` | number |
| `VISION_TIMEOUT_MS` | `visionTimeoutMs` | number |
| `LOCAL_DESCRIBE` | `localDescribe` | boolean |
| `UI_VOICE_INPUT` | `uiVoiceInput` | boolean |
| `UI_VISION` | `uiVision` | boolean |
| `UI_METRICS` | `uiMetrics` | boolean |
| `UI_AUTO_READ` | `uiAutoRead` | boolean |
| `TTS_VOICE` | `ttsVoice` | string |
| `CACHE_DIR` | `cacheDir` | string |
| `HEALTH_MS` | `healthIntervalMs` | number |
| `LOG_LEVEL` | `logLevel` | string |
| `ENABLED_CAPABILITIES` | `enabledCapabilities` | 逗号分隔 list |
| `INSTALL_DIR` | `installDir` | string |

优先级：env > 配置文件 > 默认值；env 覆盖只记日志、不阻断启动。

### 5.4 迁移导入规则

| 来源 | 字段 | 规则 |
| --- | --- | --- |
| `~/.dsh/fish-message-config.json` | `asrBaseUrl` / `ttsBaseUrl` | 两者一致且 `/capabilities` 可达 → 写入 `baseUrl`；不一致 → 不自动导入，设置页提示 |
| 同上 | `ttsVoice` | 写入 `ttsVoice`（仅当 `/voices` 里存在） |
| `~/.dsh/tts-rvc/settings.json` | `index.baseUrl` | 仅作为候选；不覆盖 fish-message 的一致值 |
| 浏览器 `localStorage['dsh-tts-settings']` | `provider` / `voice` | 宿主不读；设置页提供客户端导入按钮（P2） |

---

## 6. `fish.message` 服务（规划）

> 当前 `dsh-fish-message 0.1.0` **没有**这个服务；需要时补一个最小实现，HTTP 路由不变。

### 6.1 定义

```ts
interface FishMessageApi {
  apiVersion: '0.2'
  getVoice(messageId: string): Promise<{
    ok: boolean
    filePath: string
    messageId: string
    durationMs?: number
    sender?: { qq?: string; name?: string }
    error?: { code: 'message_not_found' | 'no_voice_attachment'; hint: string }
  }>
  sendVoice(opts: { sessionId: string; wavPath: string; text?: string }): Promise<{
    ok: boolean
    messageId?: string
    error?: { code: string; hint: string; detail?: string }
  }>
  sendText(opts: { sessionId: string; text: string }): Promise<{
    ok: boolean
    messageId?: string
    error?: { code: string; hint: string; detail?: string }
  }>
  health(): Promise<{ ok: boolean; transport: 'ws' | 'http'; bound: number }>
}
```

### 6.2 约束

- `sessionId` 是 DSH 的 `session-...` 或去掉前缀的 id；message 自己负责映射到 QQ 绑定；
- `wavPath` 必须是本机存在文件；message 负责转码/发送；
- `sendVoice` 失败时**不删除** `wavPath`；调用方可重试；
- 不通过 `fish.message` 暴露原始 QQ 号/消息全文，除非调用方明确需要；
- message 的 HTTP 路由保持现有 `/dsh-fish-message/*`，不做破坏性改动。

---

## 7. 契约测试（P1 就要有）

| # | 测试 | 断言 |
| --- | --- | --- |
| 1 | mock `/health` 200 | `health().ok=true`，`serviceVersion` 解析正确 |
| 2 | mock `/capabilities` 缺 `tts` | `capabilities.tts.available=false`，`reason=not_supported` |
| 3 | mock `api_version:"2"` | `api_incompatible`，写工具拒绝 |
| 4 | mock 507 | `vram_exhausted`，hint 含“显存”，`retryable=false` |
| 5 | mock 503 + `ready=false` | `model_missing`，不是 `upstream_error` |
| 6 | mock 503 + `ready=true` | `upstream_error`，`retryable=true` |
| 7 | mock 504 | `timeout`，只重试 1 次 |
| 8 | mock 400 | `bad_request`，不重试 |
| 9 | 连接拒绝 | `service_down`，2s 内返回 |
| 10 | 工具结果扫描 | 不含 `base64`、不含 `token`、不含 `service.err.log` 全文 |
| 11 | 批量超限 | `fish_tts` 21 条 → `bad_request`，不截断 |

测试不依赖真实模型：用 Node 内置 `http` 起 mock localai，按上表返回固定 JSON；真实模型只做 P1 手工冒烟。
