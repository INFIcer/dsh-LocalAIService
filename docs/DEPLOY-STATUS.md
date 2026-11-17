# P3 实现状态（插件侧安装流程）

> 核对时间：2026-11-17。范围：本文对应的 `docs/DEPLOY.md` 第 3 节「插件侧安装流程」。
> 结论：**后端与宿主路由已完成**；设置页 UI（client.js）未做，下一轮接入。

## 1. 已完成

| 设计条目 | 状态 | 代码位置 |
| --- | --- | --- |
| 3.1 状态机与状态文件 | 已完成（unknown → installing → installed/failed/canceled；adopted 只读） | `lib/installer.js`、`lib/install-manifest.js` |
| 3.2 预检（11 项） | 已完成（uv 项除外，见未完成） | `lib/installer.js` `preflight()` |
| 3.3 选目录与校验 | 已完成（盘符根/Windows/Program Files/UNC/相对/junction；非空目录拒绝覆盖） | `lib/install-manifest.js` `validateInstallDir()` |
| 3.4 uv 引导 | **未做**；改用系统 Python 3.11~3.13（`py -3.13` → `py -3.12` → `py -3.11` → `python`） | `lib/installer.js` `#probePython()` |
| 3.5 venv 与代码包 | 已完成（git clone --depth 1；失败回退 codeload zip；venv + pip install -e） | `#fetchCode()`、`#createVenv()`、`#installCore()` |
| 3.6 引擎依赖 | 已完成（torch 固定 `--index-url .../cu130`；支持 skipEngine） | `#installEngine()` |
| 3.7 模型下载 | 已完成（`/admin/models` + 串行 `/admin/models/download` + 1 秒轮询 + present 复检；模型缺失不算安装失败） | `#downloadModels()` |
| 3.8 启动与健康 | 已完成（PowerShell 后台启动；每 2 秒 `/health`，最多 120 秒，只看 HTTP 200；再校验 `/capabilities.api_version=1`） | `#startService()`、`#verifyService()` |
| 3.9 进度、失败与回滚 | 部分完成：进度用 `GET /install/status` 轮询；失败/取消回滚 `createdPaths`，保留 models/voices/data/outputs/logs/config.json；**SSE 未做** | `#rollback()` |
| 第 4 节 接管 | 已完成（只读探测 /health + /capabilities，写 adopt 配置，不碰目录、不重启） | `adopt()` |
| 第 5 节 升级/卸载 | 未做（API 里的 uninstall 仍返回 not_implemented） | — |

## 2. 对外接口

路由前缀沿用 `/dsh-fish-service`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/install/status` | 任务状态 + steps[] + percent + error + 最近一次状态文件 |
| POST | `/install/preflight` | body `{ installDir? }`；返回 blockers/warnings/disk/gpu/port/existing/python/git/network/ffmpeg |
| POST | `/install/start` | body `{ installDir?, skipEngine?, models? }`；同步预检后返回 `{ ok, taskId, state, steps }`，任务异步跑 |
| POST | `/install/cancel` | 取消当前任务（kill 进程树 + 回滚） |
| GET | `/install/logs?lines=200` | 安装器日志尾部 |
| POST | `/install/adopt` | 接管已有服务；失败返回 service_down/bad_request |

错误码沿用现有集合：`bad_request`（预检 blocker、目录非法/非空、重复安装）、`busy`（已有任务，HTTP 409）、`service_down`（接管时探测不到）、`not_supported`（非 Windows）、`canceled`、`upstream_error`（命令/下载/启动失败）。

## 3. 与设计文档的差异

1. **不用 uv**：目标机没有 uv，下载/校验便携版属于额外风险；先只支持系统 Python 3.11~3.13。uv 引导列后续版本。
2. **不校验 manifest/SHA256**：服务端仓库没有 release/tag/manifest，安装的是 `main` 分支；校验与离线包等 P5 发布能力一起做。
3. **固定 7880**：端口被其它程序占用时 blocker，不自动换端口（配置里也没有安装端口字段）。
4. **日志位置**：安装器日志固定在 `<DSH_HOME>\fish-service-install.log`，不写进安装目录；服务自己的日志仍在 `<installDir>\logs\`。
5. **进度不用 SSE**：`/install/status` 轮询是主通道，客户端不需要长连接；SSE 留到 UI 需要更细粒度时再加。
6. **git clone 加 `-c http.version=HTTP/1.1`**：实测本机网络下 HTTP/2 会被重置；zip 回退仍保留。
7. **adopt 版本门槛**：低于 2.5.0 只报错不写配置；设计里的「只读展示」由 UI 决定。
8. **取消/失败回滚**：只删本次 `createdPaths`；如果安装目录是本次新建的，删空后连目录一起删，但保留用户数据目录。

## 4. 未完成（后续版本）

- client.js 设置页安装向导（按钮、进度、模型勾选、错误展示）；
- uv 便携版引导、pip 镜像配置；
- 开机自启（计划任务 / 启动文件夹 VBS）；
- 升级（备份/替换/恢复）与卸载（保留用户数据）；
- 离线包与 SHA256 校验；
- SSE 进度事件、单模型重试按钮；
- 安装端口可配置、代理设置；
- 不依赖系统 Python 的「零 Python」安装。
