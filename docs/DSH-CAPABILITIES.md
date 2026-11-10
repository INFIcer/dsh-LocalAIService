# DSH 0.2.2-rc.1 插件能力

本文回答三件事：能不能把东西放进会话（附件/图片槽位）、工具结果能不能变成可播放的文件、能不能给模型加一句提示。
结论按 `0.2.2-rc.1` 实测；依据是 asar 里的客户端 bundle 与 README（行号即 `D:\Program Files\DeepSeek Harness\resources\app.asar` 内文件的行号）。

## 一页结论

| | 能力 | 结论 | 能做什么 |
| --- | --- | --- | --- |
| A | 图片/附件槽位 | **有** | 用户消息的图片旁可以加按钮；输入框右侧可加独立图标按钮（本插件「本地识图」就是这么接的）；还能把本机文件造成草稿附件（`createDrafts` + `addAttachments`，插件「语音 → 作为附件」用这条） |
| B | 工具结果带附件 | **不能** | 没有 audio / file 类型的内容块，会话里没有音频播放器；唯一出口是官方 `present` 交付卡 |
| C | 给模型注入提示 | **有** | `ctx.systemPrompt.section()` 可加一段静态或动态文本 |

## A. 图片与附件槽位

### 能做的

- **用户消息里每张图都有一个槽位**：`conversation.chat.user.images`，`kind: "single"`，scope `session`；
  每张图单独渲染一次（`dsh-client-ui-chat/lib/client.js:9369-9373`），props 是
  `{ images, loadImage, align, compact }`（`images` 里只有这一张）。
- 槽位里能拿到标准 props：`sessionId`、`inputActions`、`renderFactorySlot`、`renderSlot`、`t`、`useStore`
  （`dsh-client-ui-renderer/lib/client.js:772-797` 的合并顺序；`inputActions` 由 `dsh-client-ui-conversation/lib/client.js:22772-22788` 提供）。
  `inputActions.insertText()` / `captureInsertion()` 就是「把文字放进输入框」的官方办法。
- 图片本身可以取到字节：`loadImage(attachment)` 返回一个浏览器地址的 Promise
  （`dsh-client-ui-conversation/lib/client.js:19952`），`fetch` 该地址即可上传识图。
- 画廊本体可以复用：`renderFactorySlot('conversation.images.content', { images, loadImage, align, compact })`
  （`dsh-client-ui-attachment/lib/client.js:2329-2355` 的官方 `MessageImages` 就是这么画的）。
- **草稿附件栏可以整条顶替并加控件**：`conversation.input.attachments` 的注册体是整条 `ComposerAttachments`
  （`dsh-client-ui-attachment/lib/client.js:2371-2375`），官方没有显式 priority，所以 `priority: 60` 即可占住。
  顶替后会拿到 ownerProps：`attachments`（草稿附件，图片项带 `file`，可直接读字节）、`canAcceptDrop`、
  `onAddFiles`（`composer.bar` 的 `intakeFiles`）、`onRemoveAttachment`、`uploads`、`onRetryFile`、
  `uploadFailureText`、`dropLimits`（`dsh-client-ui-conversation/lib/client.js:22065-22081`）。
  附件栏、拖放、文件选择器和编辑器粘贴（`client.js:21260-21282` → `intakeFiles`）最终都走同一个 `onAddFiles`。
- **能自己造附件（实测可用）**：会话作用域里的 `conversation` 服务（`ctx.get('sessions').scope(sessionId).get('conversation')`）
  有 `createDrafts(sessionId, files, uploadImages)`（`client.js:27426664`）：非图片文件会建成
  `{kind:'file', id, file}` 放进 `draftAttachments` 并启动上传；再调 `inputActions.addAttachments(ids)`
  （`client.js:27784324` 的公开 actions）把它挂进草稿，输入框就会出现官方 `FileCard` 文件卡片，
  发送时按 `{type:'file', receiptId}` 序列化（`client.js:27424501`）。本插件「语音 → 作为附件」就是这么做的。
  注意：不经过编辑器，所以只有附件栏卡片、没有正文里的 `@路径` chip。

### 不能做的

- **槽位是单占位，不是叠加**：`priority` 小的条目替换该位置上的官方条目
  （`dsh-cordis-client-runner/lib/client.js:2987`「smaller priority values replace it」；
  `dsh-client-ui-renderer/lib/client.js:1544-1554` 每格只取第一个存活条目）。官方图片槽的 priority 是 `100`，
  所以想加东西必须自己把画廊画回来，再在旁边加控件。
- **图片没有本地路径**：会话里的图片一律是上传附件（`attachment.image`），桌面端拖入的非图片文件才变 `@路径`
  chip（`dsh-client-ui-conversation` README 第 123 行）。所以识图只能走「上传字节 → 宿主存临时文件 → 视觉模型」。
- **附件栏整条顶替后，官方附件栏的细节要自己补**：官方的点缩略图看大图、拖入高亮等没有对应的子组件可复用
  （插件只 external `react`），只能手写或不做；上传、删除、重试、拖放、粘贴这些入口必须照官方语义接回。
- **`conversation.chat.user.before` 不行**：它是 chain 槽，props 只有 `{ source, kind }`
  （`dsh-client-ui-chat/lib/client.js:6183-6186`），拿不到图片，做不了「每图一个按钮」。

### 这版所有 `conversation.*` 槽位（注册名）

`conversation.approval.detail`、`conversation.chat.assistant-actions`、`conversation.chat.flow`、
`conversation.chat.message.images`、`conversation.chat.node`、`conversation.chat.reasoning.body`、
`conversation.chat.text-interaction`、`conversation.chat.turnTail`、`conversation.chat.user.before`、
`conversation.chat.user.images`、`conversation.composer`（chain）、`conversation.composer.bar`、
`conversation.composer.dock`、`conversation.header`、`conversation.images.content`（root 工厂）、
`conversation.input.activity`、`conversation.input.attachments`、`conversation.input.dock`、
`conversation.input.left`、`conversation.input.model`、`conversation.input.overlay`、
`conversation.input.permission`、`conversation.input.plan`、`conversation.input.right`、
`conversation.plan-review.actions`、`conversation.session`、`conversation.session.header`、
`conversation.session.header.actions`、`conversation.session.header.corner`、
`conversation.session.header.lineage`、`conversation.session.header.utilities`、
`conversation.session.header.views.actions`、`conversation.trajectory.images`、`conversation.user.text.node`、
`conversation.view`。

**interactions**：`ui.interactions.register({ id, onInteraction })` + 同名 key 的
`conversation.chat.text-interaction` 槽位（本插件的划词朗读/翻译就是这么接的）。这版没有「交互 → 图片」的通道，
文字选中才有。

## B. 工具结果里的附件

### 结论：不能直接给

- 工具卡只认两种内容块：`type: "text"`（有 `text` 字符串）和 `type: "image"`；其余类型、结构不对的，一律退回通用 JSON 卡
  （`dsh-client-ui-tool/lib/client.js:2947-2952` 的 `fullyRendered()`）。
- 消息内容没有 `audio` / `file` 类型，客户端也没有任何音频渲染器：全 `client-ui-*` 里只有侧栏 PDF 预览用到
  `<audio>`（`dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js:18168`）。
- 工具可以自备图文内容（`projectContent` / `finalizeContent`），但产物仍是 text/image
  （`@deepseek-ai/dsh-tools` README 第 94 行）。自定义工具卡可以整行替换官方卡片
  （`tool.call.toolview`，按工具名 key；`dsh-client-ui-tool/lib/client.js:2011`），但要把标题、状态、参数全自己画，
  风险高且没有渲染测试环境，本插件不采用。

### 唯一能「让文件出现在界面」的通道：官方 `present`

- 工具调 `present({ path, description })` 后，宿主往会话追加一条 `deliverables/presented`
  （`@deepseek-ai/dsh-tool-present/lib/index.js:119`），本轮结束时在 turn tail 出交付卡；
  点击进右侧预览（音频可播），也能用系统默认应用打开。
- **插件不能自己造这条事件**：新事件类型要求 envelope 带 `ignorable: true`，运行时 `Session.append()` 带不上，
  会把会话卡成打不开（`@deepseek-ai/dsh-agent-preset` 的 `cordis-plugin-development/references/practices.md` 第 21 条）。
- 所以本插件的做法：`fish_tts` 的返回文字压成一句（生成了几段、文件在哪），并在系统提示里让模型在用户要文件时调用 `present`。

## C. 给模型加提示

### 能做

- `ctx.systemPrompt.section({ name, order, text, interpolate })`：`text` 可以是字符串或函数（每次组装提示词时求值），
  空字符串的段会被删掉，所以能跟着配置实时开关
  （`@deepseek-ai/dsh-system-prompt/lib/index.js:255-258`、README「renderPrompt」一节）。
- `order` 只要求是有限数字，内置段从 `-1000` 到 `10200`；同层重名会抛错。
- 注册方式：`ctx.inject(['systemPrompt'], (scope) => { scope.systemPrompt.section({...}) })`，宿主没有该服务时
  整段跳过而不是让插件起不来（`practices.md` 第 18、20 条）。

### 注意

- 文本里别写 `{{`：那是提示词插值语法，未注册的变量会让组装报错；本插件注册时传 `interpolate: false`。
- 只影响「模型看到什么」，不会改用户消息，也不会拦截工具调用——想让识图一定走本地，只能靠这句提示 + 设置开关。

## 本插件据此做的取舍

1. 输入框右侧加「本地识图」按钮：注册 `conversation.input.right`（`order: 31`，与麦克风同一排），
   文件选择图片后串行识别，把「文件名 + 描述」用 `insertText` 插进输入框；图片不加进草稿、不上传、不进模型。
   官方附件栏保持原样（不注册 `conversation.input.attachments`）。消息发出后的旧「图片下方按钮」已去掉。
   识图提示词分四档（简短/标准/详细/只看文字），工具识图与这个按钮的会话识图各用各的设置。
2. 语音结果不再铺 JSON，只留一行「生成了几段、文件在哪」；文件形态交给模型调用 `present`。
3. 两段系统提示（识图一段、文件一段），按设置实时开关，`interpolate: false`。
4. 本地 AI 状态显示在输入框左下：注册 `conversation.input.left`（`id: 'fish-metrics'`，`order: 40`，与自动朗读同一排）。
   这是 list 槽，每个条目按 `id` 独立登记，不替换官方条目，也不影响同槽的其它插件；胶囊只占这一排的高度，详情放在点击后弹出的浮层里。
   最初考虑挂 `shell.bottom`（root 作用域 single 槽，通栏、空时不占高、跨页面常驻），但该槽已被内置的 experimental inspector
   以默认优先级占用；single 槽按 `priority` 升序取最小者渲染，要显示就得用负优先级把它顶掉，代价是用户失去 inspector，所以放弃。
