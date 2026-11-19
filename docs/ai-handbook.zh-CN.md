# AI 工作手册（opentogethertube-next）

> 2026-11-19 补充：以 `f240d98` / `v1.4.20` 为基础，以下包含尚未提交、尚未发布的工作区修复；
> 本轮证据与剩余范围见 [审查记录](project-review-2026-11-19.zh-CN.md)。

给在本仓库工作的 AI 代理的速查手册：**改哪里、怎么跑、有哪些坑**。目标是让新会话不必重新
调查代码结构。人类可读的完整架构说明见 [architecture.zh-CN.md](./architecture.zh-CN.md)。

**版本快照**：`v1.4.20` 的实现，审查基线为 `e3c6e832`（`v1.4.19`）。发布身份以 Git 标签与
镜像 revision 为准。[本轮审查](project-review-2026-11-17.zh-CN.md)记录已修、剩余事项和实际验证范围。
**维护规则**：发版或大改后更新本文件（§9 有核查命令）；过期信息比没有信息更糟。

---

## 1. 一分钟速览

- **是什么**：实时视频同步观看（"一起看"）服务的简体中文分支，基线是上游
  [OpenTogetherTube](https://github.com/dyc3/opentogethertube) `v0.15.0`（见 `UPSTREAM.md`）。
  免注册开房；当前工作重心是**同步边界情况**与**浏览器内画质增强（Anime4K/FSR）**。
- **形态**：Yarn 4 monorepo（`client`/`server`/`common`/`packages/*`）+ Cargo workspace（`crates/*`）。
- **技术栈**：Vue 3 + **Vuex 4（不是 Pinia）** + Vuetify；Express + **原生 `ws`（不是 socket.io）** +
  Sequelize（PG/SQLite）+ Redis；Rust balancer/collector（**生产未启用**）；Cloudflare Worker 预览版（能力子集）。
- **Git 事实**：`origin` = `https://github.com/g1157/opentogethertube-cn.git`；`origin/main` 是主干和发布线。
  `feat/upscale-quality` 自 2026-10-03 起跟随 main，旧提交保存在
  `archive/upscale-webgpu-frame-check`。其他 worktree 的本地 main 可能是陈旧指针，操作前核对
  `git status -sb`、`git rev-parse HEAD origin/main` 和 `git worktree list`，不要把某个 worktree 的情况当成全局事实。
- **语言**：文档、审查记录、版本记录以中文为主；UI 文案 `en.ts` 与 `zh-CN.ts` 必须成对更新。
- **版本号注意**：`package.json`/`Cargo.toml` 里写的是 `0.14.1`（上游遗留），**发布身份是 git 标签与镜像标签**
  （本文实现 `v1.4.20`），不要去"修正"这些版本号。

---

## 2. 命令速查

环境：Node 22–26（`engines: >=22 <27`，CI 跑 22/24/26，推荐 24）；Yarn 固定 4.1.0（走 `corepack`）。

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `corepack enable && yarn install --immutable` |
| 本地开发（后端 3000 + 前端 8080，Vite 代理 `/api`、含 WS） | `yarn dev`（Windows：`yarn dev-windows`） |
| 构建全部 | `yarn build`；单包 `yarn workspace ott-{server,client,common} build` |
| Lint（CI 等价，改完代码必跑） | `yarn lint-ci`（= `biome ci` + `prettier --check "**/*.vue"` + 各 workspace `lint-ci`） |
| Lint（自动修复） | `yarn lint` |
| 全部测试 | `NODE_ENV=test yarn test`（各 workspace 依次跑；服务端需要测试环境） |
| 服务端测试 | `NODE_ENV=test yarn workspace ott-server test`（**必须带 NODE_ENV=test**，否则 session_secret 为空） |
| 单个服务端用例 | `NODE_ENV=test yarn workspace ott-server exec vitest run tests/unit/room.spec.ts` |
| 客户端测试 | `yarn workspace ott-client test`（脚本自带 `NODE_ENV=test`）；单例 `yarn workspace ott-client exec vitest run tests/unit/foo.spec.ts` |
| 组件测试 | `yarn cy:run:component`（= 客户端 `test:component`） |
| common 测试 | `yarn workspace ott-common test` |
| Cypress E2E（**不在 CI**，含上游英文选择器） | `yarn cy:open` / `yarn cy:run`（需先起本地服务） |
| 数据库迁移 | `yarn db:migrate`（= `yarn workspace ott-server run sequelize db:migrate`） |
| 测试库迁移 | `NODE_ENV=test yarn workspace ott-server run sequelize db:migrate` |
| 回退一个迁移 | `yarn db:migrate:undo` |
| typeshare 生成（改过 `crates/ott-balancer-protocol` 后必跑） | `./scripts/codegen.sh`（会重写 `server/generated.ts` 与 `packages/ott-vis/generated.ts`；CI 用 `git diff --exit-code` 校验漂移） |
| Rust 检查（CI 等价） | `cargo fmt --all -- --check`；`cargo clippy --workspace --no-deps --all-features --all-targets -- -D warnings`；`cargo test` |
| 启动 balancer（开发） | `cp env/balancer.example.toml env/balancer.toml && cargo run -p ott-balancer-bin -- --config env/balancer.toml` |
| Cloudflare 预览版测试/部署 | `yarn workspace ott-edge test`；`yarn workspace ott-edge deploy:preview`（流程见 `DEPLOYMENT-CLOUDFLARE.md`） |
| 负载测试 | `k6 run tests/load/<script>.js`（部分脚本需手动准备房间） |

---

## 3. 仓库地图

```text
client/src/
  main.ts App.vue store.ts router.ts i18n.ts common-http.ts
  plugins/        connection（WS 连接服务）、vuetify、sfx
  stores/         room users settings events notes toast misc（Vuex 模块）
  views/          Room.vue（约 3056 行，房间编排中枢）、Home/RoomList/Account/…
  util/           playback-sync / playback-preparation / media-recovery / media-seek /
                  connection-latency / roomapi / player-* / client-update / voice / upscale/*
  components/     ServerMessageHandler.vue、Workaround*.vue、players/*、controls/*、
                  composables/media-player.ts、Chat/VideoQueue/RoomNotes/PlayerStatsPanel…
  locales/        en.ts zh-CN.ts de/es/fr/pirate/pt-br/ru（后 6 个按需加载、普遍缺键）
client/tests/unit/  100 个 *.spec.ts（含组件用例）+ 3 个旧 .spec.js（当前 skip）

server/
  app.ts          入口（无 index.ts）：启动顺序/优雅停机见架构文档 §4.1
  api.ts api/     REST 路由（status/playback/auth/data/user/room/announce/dev）
  auth/           路由 + tokens.ts（Redis 会话 token）
  clientmanager.ts client.ts websockets.ts ws-schemas.ts   WS 层与房间路由
  room.ts roommanager.ts    房间状态机 + 1s tick + 事件总线
  usermanager.ts rate-limit.ts admin.ts   用户/限流/API key
  infoextractor.ts serviceadapter.ts services/* ffprobe.ts sponsorblock.ts   媒体管线
  storage.ts storage/*  models/*  migrations/（27 个）   持久化（PG/SQLite）
  redisclient.ts ott-config.ts metrics.ts logger.ts exceptions.ts voice*.ts balancer.ts
  tests/unit/     65 个 *.spec.ts + 1 个 *.spec-d.ts（fixtures/、redis mock）
  config/config.mjs + .sequelizerc    Sequelize CLI 配置

common/           共享 TS：models/messages.ts（协议）、permissions.ts（28 权限位）、
                  exceptions.ts、timestamp.ts、constants.ts、nicknames.ts、result.ts…
crates/           7 个 crate：ott-balancer(-bin/-protocol)、ott-collector、ott-common、harness(-tests)
packages/         ott-edge（Cloudflare 预览版）、ott-vis / ott-vis-panel / ott-vis-datasource（Grafana）
deploy/           init.sh、next-compose.yml、next.Dockerfile、next-backup.sh；其余为上游 Fly/Ansible 遗留
docker/           本地开发 compose（含 with-balancer 变体）
env/              example.toml、balancer.example.toml 等模板；真实 *.toml 全部 gitignored
scripts/          codegen.sh、anime4k-glsl-to-webgl2.{mjs,sh}、set-version.sh
tests/            e2e/（Cypress 9 spec）、load/（k6 7 脚本）、assets/
docs/             中文专题文档（见 §10）；ai-handbook 与 architecture 是本套
```

---

## 4. 子系统速查卡

### 4.1 服务端（`server/`）

- **入口**：`app.ts` 的 `main()`；配置先加载（`ott-config.ts`），随后 Redis/限流器初始化，再按
  中间件顺序装配（细节见架构文档 §4.1）；优雅停机 = 踢客户端 → 1s → 卸载房间 flush → 退出。
- **请求路径**：REST → `api/*.ts` → `room.processUnauthorizedRequest()`；WS → `clientmanager`
  校验（Zod + 白名单）→ 同一个房间入口。
- **关键常量**（改动前先知道）：
  - 房间广播 debounce **50ms**（`room.ts` `throttledSync`）；`sync()` 有 Mutex。
  - Redis 快照 debounce **5s**（`saveStateToRedisDebounced`，TTL `room.expire_after`=7200s）。
  - tick **1s**（`roommanager.runUpdate`）：每房单飞、最多 8 项并发、每房最多一项排队；周期调度不等全部房间。
    房间 `unload_after`=300s；8 项永久挂起仍会耗尽槽位。指标 duration 是单房执行时间，skipped 是繁忙房间跳过数。
  - WS：`maxPayload` 256KB；auth 超时 10s；心跳扫描 10s；令牌桶 40 突发/10 每秒（聊天 5/0.5）。
  - 延迟探测 pong 服务端限 1 次/秒/连接。
  - 全局限流 1000 点/小时/IP（封 120s）；各端点扣点见架构文档 §6.4。
  - token：512 字节随机 base64（约 684 字符），游客 14 天 / 登录 240 天，登录类操作轮换。
- **四种状态投影**（`RoomState` / `Syncable` / `Storable` / `Persistable`）各有 `*Props` 列表：
  **加字段必须同步加到对应列表**，否则不广播/不落盘（架构文档 §5.2）。
- **房间请求**：`RoomRequestType` → 权限名映射在 `room.ts` 顶部；客户端可发起的类型白名单在
  `clientmanager.ts`。
- **房间密码**（可选，房主设定）：`server/room-password.ts`（argon2 哈希 + Redis 通行证，24h）。
  校验点：WS join（踢 `ROOM_PASSWORD_REQUIRED=4006`，在 full sync 之前）与 REST `getRoomChecked()`（401）；
  `PATCH/POST /api/room/:name/password` 负责设置/校验；hash 只存 Postgres `Rooms.passwordHash`，
  **绝不进 Redis 快照与 sync**（只同步布尔 `hasPassword`）。细节见 `docs/room-password.zh-CN.md`。
- **测试**：`server/tests/unit/**`；Redis mock helper 在 `tests/unit/redisV4Mock.ts`。
- **本轮生命周期修复**：同名建房 / 装载 / 卸载按小写名字加 Mutex；loadEpoch 成功后才发布房间；
  token 校验先于缓存成员身份；grants 与 permissionsRevision 同一落盘 checkpoint；
  SponsorBlock 请求脱离 tick、单飞并绑定片源；早到的 status 等待加入完成，断开后停止旧命令。
  语音预算判断与座位保留同步执行，relay 选择单飞且绑定本次参与者 Set。

### 4.2 客户端（`client/`）

- **入口**：`main.ts` 装 Vuex/router/vue-query/i18n/Vuetify/connection/sfx；生产另装版本更新检查
  （`util/client-update.ts`，120s 轮询 `/api/status/version`）。
- **状态**：全部 Vuex（模块见 §3）；设置持久化 `localStorage["settings"]`，`UPDATE` 持久、
  `UPDATE_TRANSIENT` 仅本次会话（自动降档在用）。
- **连接**（`plugins/connection.ts`）：重连是**线性退避** `min(30s, (1s+2s×次数))×(0.5–1.5)`，不是指数；
  `connected` 在**收到第一条 `sync`** 后才为 true；`send()` 在未 connected 时抛错；服务端关闭码 ≥4000
  为踢出。`visibilitychange`（回到前台）与 `online` 时，若已知断线（`issue` 非空）且未连接则立即重连，
  首次连接在途时不动；断线横幅（`RoomConnectionNotice`）有 **10 秒宽限**，短暂掉线不提示，只有持续
  失败才显示。
  服务端错误文案走 `util/server-error.ts`：按 `name` 映射到 `errors.*`，**拿不到响应时用
  `errors.network`**（不要再落回泛化的 `errors.unknown`）；新增服务端错误名要同步 en/zh-CN 文案。
- **同步**：`util/playback-sync.ts`（常量与状态机见架构文档 §5.4，**不要凭记忆改数值**）；
  `views/Room.vue` 每 250ms tick 一次；首帧对齐 `playback-preparation.ts`、恢复 `media-recovery.ts`、
  seek `media-seek.ts`、延迟 `connection-latency.ts`（8 样本，`min/2`）。
- **换片就绪（Playback Start v2）**：`server/room.ts` 的 `playbackPreparation` 现在是准备轮次
  （`eligible` / `ready` / `deadlineAt` / `hardDeadlineAt` / `fallback`）；所有 eligible 客户端在
  “首帧 + 缓冲跑道”后上报 ready，多人全体 ready 走 +1 秒定时开始，8 秒未齐则 partial，
  20 秒无人 ready 则 forced。客户端 `playback-preparation.ts` 负责上报与失败/后台标签页回执；
  `playback-sync.ts` 有 8 秒初始冷却、“缓冲不足不硬跳”和 live 源跳过 VOD 硬跳。
  改阈值时同步更新 `docs/playback-sync.zh-CN.md`。
- **播放器**：接口 `components/composables/media-player.ts`；实现 `components/players/*`；
  分发 `OmniPlayer.vue`；只有 Direct/HLS/DASH 支持速率微调（`supportsRateBend()`）。
- **画质增强**：`util/upscale/*`（机制和边界见 [video-enhancement](video-enhancement.zh-CN.md)）（档位、渲染器选择、WebGPU 探针、目标池、自动降档、帧节奏判据
  `pacing.ts`——媒体时钟/下限/管线丢帧三判据）；UI 在
  `components/controls/VideoSettings.vue` 与 `components/players/UpscaleLayer.vue`。
  生成文件 `anime4k-glsl.ts` / `anime4k-ultra-glsl.ts` **由脚本生成，禁止手改**。
  共用 `video-render-loop.ts`：rVFC 按 mediaTime 去重、暂停 / seek / resize 重绘、后台跳过、fatal 释放；
  WebGPU 首帧等待 4s 可取消，旧 generation 不覆盖新实例；WebGL CNN 闲置 15s 释放中间目标。
  片源能力由 `MediaPlayer.isVideoEnhancementSupported` 提供，Direct CORS 回退响应式禁用菜单，偏好保留。
  video rVFC 和管线丢帧不是增强 GPU 完成帧率。
- **i18n**：默认 `zh-CN`、回退 `en`；两者立即加载，其余按需 import；新增文案两边都要加。

### 4.3 共享层（`common/`）

- 协议唯一来源 `models/messages.ts`（服务端→客户端 13 种、客户端→服务端 10 种、房间请求 23 种）；
  客户端消息另有 Zod 校验（`server/ws-schemas.ts`）。
- 权限 `permissions.ts`：28 个权限位、角色继承；`Grants` 始终强制 Owner/Administrator 全权限（两处 `HACK`）。
  默认值里 `manage-queue.remove` 与 5 个 `configure-room` 设置位只给 RegisteredUser 及以上（游客不能改房间/删队列）；
  收紧既有权限靠抬高 `minRole`（装载时 validation 自动剥离），不是回填迁移。
- `timestamp.ts:calculateCurrentPosition` 是全系统唯一的位置外推公式，改同步逻辑从这里对表。
- 导入约定：**服务端引用要带 `.js` 扩展名**，client 不带；`exports` 默认解析原始 TS，生产镜像
  `--conditions=lean` 用 `ts-out/`。

### 4.4 Rust 层（`crates/`）

- **生产未启用**：`deploy/next-compose.yml` 不含 balancer/collector；只有
  `docker/with-balancer.docker-compose.yml`（开发）会拉起它们。文档里别写"生产有负载均衡"。
- monolith 侧开关：`server/balancer.ts` + `BALANCING_ENABLED`（默认 false）/`BALANCING_PORT`（3002）。
- 配置样例 `env/balancer.example.toml`；全局配置 `OnceLock`，region 是可变的 `RwLock` 包装
  （v1.2.6 修复，见 `docs/fix-report-2026-09-30.zh-CN.md` 第六节）。
- 改动协议类型后必须 `./scripts/codegen.sh`，否则 CI lint 作业漂移检查失败。

### 4.5 Cloudflare 预览版（`packages/ott-edge`）

- Worker 静态资源 + `/api/*`；Durable Object `RoomObject` 持房间与 WS，D1 存索引/身份/缓存，
  `MaintenanceObject` 每 6h 清理。能力子集：无账号/语音/SponsorBlock/DJ/undo。
- 客户端构建走专用脚本 `build:client`（`OTT_EDGE_PREVIEW=true`）；版本串在两处（`package.json` 的
  `build:client` 与 `wrangler*.jsonc` 的 `vars.OTT_CLIENT_REVISION`），升级要同时改。
- 测试：`yarn workspace ott-edge test`（wrangler dry-run + `node --test`）。

### 4.6 部署与 CI

- 生产：`deploy/init.sh` 生成 `compose.yml`+`.env`；四容器 `migrate`/`ott`/`postgres`/`redis`；
  `ott` 512m/1CPU、read_only、仅绑 127.0.0.1；升级 = 改 `.env` 里的 `OTT_IMAGE` 再 `up -d`；
  回退 = 换回旧 tag + `up -d --no-deps`。先 18080 验收、同镜像晋升 8080。
- 发布：推 `vX.Y.Z` 标签 → `publish-image.yml` 复用 `main.yml` 和 `rust.yml`，全部门禁通过后构建推
  GHCR（`ghcr.io/g1157/opentogethertube-cn:<tag>` 与 `:latest`）。镜像按本仓锁文件安装生产依赖，
  推送前核验依赖、补丁、非 root 身份与应用产物；client revision 必须等于发布提交。
  发版同时要更新 `docs/version-notes.zh-CN.md`（见 §6 约定）。
- CI：`main.yml`（Node 22/24/26 × lint+codegen 漂移、SQLite/Postgres 双测试、typos、Grafana 兼容）、
  `rust.yml`（fmt/clippy/doc/test，Rust 1.84）、CodeQL；`docs/**.md` 改动不触发 CI。

---

## 5. 常见任务 → 改哪里

| 任务 | 步骤 |
| --- | --- |
| 新增媒体源适配器 | `server/services/<x>.ts` 继承 `ServiceAdapter` → `server/infoextractor.ts` 注册 → `common/constants.ts` `ALL_VIDEO_SERVICES` → 配置允许列表 `info_extractor.services` → 如需嵌入播放器加 `client/src/components/players/*` 并在 `OmniPlayer.vue` 分发 → 测试 `server/tests/unit/services/` |
| 新增 WS 消息 | `common/models/messages.ts` → 客户端消息：`server/ws-schemas.ts` + `clientmanager` 路由；服务端消息：`ServerMessageHandler.vue` 映射 + 对应 store mutation |
| 新增房间设置 | `common/models/types.ts` + `zod-schemas.ts` → `server/room.ts`（字段/setter/投影/`applySettings`）→ `RoomSettingsForm.vue` → en+zh-CN 文案 |
| 新增权限 | `common/permissions.ts`（位 + 默认授予）；新增位要历史房间生效则加回填迁移（`ROOM_PERMISSIONS_REVISION`）；收紧既有位改 `minRole` 即可追溯生效 |
| 改同步算法 | `client/src/util/playback-sync.ts` + 单测 + `docs/playback-sync.zh-CN.md` 同步更新 |
| 改画质增强 | `client/src/util/upscale/*` + `stores/settings.ts`（`UPSCALE_MODES`）+ `VideoSettings.vue` + `UpscaleLayer.vue`（选择与降档）+ `docs/video-enhancement.zh-CN.md` |
| 改音效/画面本机偏好 | `client/src/util/audio-eq.ts`（均衡曲线、CORS 路由判断与 WebKit 熔断 `elementAudioRoutingSupported`）+ `stores/settings.ts` + `composables/media-audio-boost.ts`（Web Audio 图）+ `players/{Direct,Hls,Dash}Player.vue`（CSS 类与接线）+ `VideoSettings.vue` + `ClientSettingsDialog.vue`（音量增强）+ en/zh-CN 文案 |
| 改播放器设置菜单/控制条按钮 | `VideoSettings.vue`（主菜单与二级页）+ `DanmakuSettingsMenu.vue`/`DanmakuSettingsPanel.vue`（弹幕面板，两处共用）+ `QualitySwitcher.vue`/`QualityMenuPanel.vue` + `ClosedCaptionsSwitcher.vue`/`SubtitleMenuPanel.vue` + `VideoControls.vue`（按钮排布）+ `tests/unit/PlayerMenus.component.spec.ts` |
| 改播放器全屏 | `client/src/util/player-fullscreen.ts`（原生全屏、网页内回退、手机横屏锁定）+ `stores/settings.ts`（`fullscreen` 状态）+ `tests/unit/player-fullscreen.spec.ts` |
| 数据库变更 | `server/migrations/YYYYMMDDHHMMSS-描述.js` + 模型；`yarn db:migrate`；在版本记录注明"有迁移"（大多数版本是"无数据库迁移"） |
| 加 UI 文案 | `client/src/locales/en.ts` 与 `zh-CN.ts` 同时加 |
| 加 API 端点 | `server/api/<组>.ts` + 挂载；如需限流调用 `consumeRateLimitPoints(res, req.ip, 点数)`；考虑更新 `docs/api.yaml` |
| 发版 | 更新 `docs/version-notes.zh-CN.md` → 提交 → 打 `vX.Y.Z` 注释标签推送 → CI 出镜像 → 服务器改 `OTT_IMAGE` 拉取；18080 验收后晋 8080 |

---

## 6. 约定

- **格式**：tabs、双引号、分号、print width 100、`arrowParens: avoid`（`.prettierrc`，只作用于 `*.vue`；
  其余由 Biome 管）。提交前跑 `yarn lint-ci`（CI 等价），别用 `yarn lint` 掩盖违规。
- **风格**：TypeScript strict；`import type`；服务端导入带 `.js`；不新增依赖（能自实现就自实现，
  仓库明显偏好小而自包含的方案）；错误用 `OttException` 子类 + Zod 校验边界。
- **测试**：文件名 `*.spec.ts`（仓库里没有 `*.test.ts`；`*.spec-d.ts` 是类型测试）。
  - 服务端测试要 `NODE_ENV=test`（否则 `session_secret` 空、express-session 抛错）。
  - 客户端 `@vue/test-utils` 的 `emitted()` 在 production 构建下静默失效——测试必须 `NODE_ENV=test`。
  - fake timers 只伪造必要项：`vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout"] })`；
    全量 fake 会连 `setImmediate` 一起伪造，`flushPromises()` 静默挂起；路由 `isReady()` 需要
    `await vi.advanceTimersByTimeAsync(0)`。
- **提交**：conventional commit、英文祈使句标题 + 说明性正文；结尾加
  `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>`；只提交本任务相关文件/区块，别扫入无关在途改动。
- **文档**：长文放 `docs/`，中文，`<主题>-<YYYY-MM-DD>.zh-CN.md`（审查类）或稳定名（机制类）；
  机制文档与代码同一提交更新；版本改动写进 `docs/version-notes.zh-CN.md`（每版一条，按领域分组）。
- **README**：`README.md`（中文）与 `README.en.md` 必须同步维护，结构一致。

---

## 7. 陷阱清单

1. **Vuex 不是 Pinia**。别引入 Pinia；新状态加到 `client/src/stores/*`。
2. **`connected` = 收到第一条 `sync`**，不是 WS 打开；`send()` 在未 connected 时会抛。
3. **重连是线性退避**（最多 30s + 抖动），文档/注释都按此描述，别"顺手改成指数"。
4. **投影清单**：新字段不加进 `RoomStateSyncable`/`Storable`/`Persistable` 的 props 列表就静默不同步/不保存。
5. **`sync()` 的 Mutex 与脏集合回滚**：不要在 setter 里 await sync；广播失败时脏字段会重新入队。
6. `room-sync:<name>` 是遗留键，当前只删不写；别把它当活跃机制。
7. `env/*.toml` 默认 gitignored（只有 `example.toml`、`docker.base.toml`、`heroku.base.toml`、
   `balancer.example.toml` 入库）；不要提交真实配置/密钥。
8. `.commandcode/` 整个目录 gitignored（taste 学习数据）；AI 的临时产物放这里或系统 scratchpad，不要进 `docs/`。
9. **生成物禁手改**：`server/generated.ts`、`packages/ott-vis/generated.ts`（`./scripts/codegen.sh` 重生成）、
   `client/src/util/upscale/anime4k-glsl.ts` 与 `anime4k-ultra-glsl.ts`（脚本生成；Biome 已排除这些文件）。
10. **迁移在 `server/migrations/`**（27 个）；根目录 `db/` 与 `server/db/*.sqlite` 只是本地 SQLite 产物。
11. **NODE_ENV=test 的两个坑**见 §6；服务端单测不带它会直接报配置错误。
12. **locale 只补 `en.ts` 或只补 `zh-CN.ts`** 会导致另一语言回退显示英文键；两个都要改。
13. **balancer 不在生产 compose 里**；改 Rust 后本机没工具链时 CI 会兜底（`rust.yml`），别宣称已验证。
14. **各 worktree 的本地 main 可能不同步**；先核实，主干参照 `origin/main`。
15. **版本号 0.14.1 是上游遗留**；不要全局替换成 vX，发布身份只有 git tag/镜像 tag。
16. Cypress 用例含上游英文选择器与外部媒体假设，**不在 CI**；改动 UI 别以它绿为准。
17. `docs/` 里的日期审查文档（`*-2026-*.zh-CN.md`）是**历史记录**，不要改写结论；新发现写新文档并在
    版本记录引用。
18. **房密 hash 不进 Redis/同步**：只存 `Rooms.passwordHash`；Redis 只放通行证
    `room-password:<房>:<hash版本>:<token>`（24h，改密即失效）；`serializeState` 永远不包含它。
19. **收紧默认权限别写回填迁移**：抬高 `Permission.minRole`，老房间在 `setRoleGrants` 装载时自动剥离；
    `ROOM_PERMISSIONS_REVISION` 机制只用于"加权限"，不能用于收紧。
20. **表达式索引只在 postgres 建**（`rooms_lower_name` 的迁移在 sqlite 上是空操作）：Sequelize sqlite 的
    `describeTable` 遇到表达式索引会让 `removeColumn`/`changeColumn` 直接崩；Rooms 的列删除（down）改用
    直落 SQL 绕开建表重建。

---

## 8. 已知剩余项（更新至 2026-11-19）

结合 [11-17 全项目完善清单](project-review-2026-11-17.zh-CN.md) 与
[11-19 优先修复及验证记录](project-review-2026-11-19.zh-CN.md) 阅读；未复核的分区线索不能当作运行事实。

- 高档 GPU 成本和真实增强完成时间 / 在途提交尚未进入自动降档判据；Windows、移动设备与 HDR 缺少本轮真机验收。
- 跨房间 tick 已隔离并限制并发；pause / seek 的 prevQueue 落盘仍存在写放大，建房 DB / 密码 / sync 失败的完整回滚待设计。
- RunFfprobe 已使用校验后的最终 URL，仍有独立 DNS 解析与后续 HTTP 资源边界；DNS 5s 超时不取消底层 lookup。
- `corsFromHeaders` 仍将非空 ACAO 作为诊断，未匹配实际 Origin；最终纹理能力由浏览器加载与回退决定。
- HLS / DASH 清单已限制 2 MiB / 5s；弹幕 XML 已有 8 MiB / 100,000 评论、单条文字 2000 UTF-16 单元、
  4 个下载槽和缓存记账上限。隐藏页准备回执、字幕与换源生命周期仍需继续核对；记账预算不等于实测 heap。
- 队列导出已覆盖 `ALL_VIDEO_SERVICES` 的 13 种服务；新增服务时同时补导出 URL 与导入往返测试。
- Bilibili 官方 iframe 无控制 API，暂停不能直接作用到 iframe，位置为估算；该限制必须在产品里清楚说明。
- 非中英 locale 仍缺键；移动布局、键盘焦点、屏幕阅读器和字幕 / 语音 / 外部平台还需完整实机矩阵。
- Rust balancer 的 HTTP body 全量 collect，collector 的入站鉴权与 CORS 需在启用前处理；这些组件当前不在生产 compose。
- SponsorBlock 不再阻塞 tick，Edge probe 已有 AbortController，socket 登录可原地 reauthenticate；这些旧“未修”项已失效。
- 11-17 的 Rust 1.84 / harness 验证属于历史记录；11-19 Windows / Rust 1.89 MSVC 的 fmt、check、严格 clippy、
  rustdoc 与非 harness 单测已通过，但完整 harness 在 180s 内未完成，不外推 Linux 或生产结果。

---

## 9. 事实核查与维护

发版或大改后，用这些命令刷新本手册里的数字，别凭记忆：

```bash
git describe --tags --always HEAD          # 版本快照
git rev-parse HEAD origin/main             # 主干是否同点
rg --files server/migrations | rg '\.js$' | wc -l   # 27 migrations
rg --files server/tests | rg '\.spec\.ts$' | wc -l   # 65 runtime specs, plus 1 type spec
rg --files client/tests | rg '\.spec\.ts$' | wc -l   # 100 runtime specs, plus 3 legacy JS specs
rg --files common/tests | rg '\.spec\.ts$' | wc -l   # 8 runtime specs, plus 1 type spec
rg --files tests/e2e/integration | rg '\.spec\.ts$' | wc -l   # 9
rg -n "debounce" server/room.ts
rg -n "MAX_BEND|HARD_SEEK_DRIFT|CATCHUP_FULL" client/src/util/playback-sync.ts
```

同时核对：`README.md` 文档表、`AGENTS.md` 是否仍指向本文、`docs/version-notes.zh-CN.md` 最新条目。

## 10. 文档索引

- **架构**：[architecture.zh-CN.md](./architecture.zh-CN.md)（详细）、`architecture.md`（英文 WIP 遗留）。
- **机制专题**：`playback-sync`、`buffer-gate`、`video-enhancement`、`upscale-*`、`player-stats`、
  `media-parsing`、`voice`、`room-notes`、`security-headers`。
- **运维**：根目录 `DEPLOYMENT.md`、`DEPLOYMENT-CLOUDFLARE.md`、`deployment-options`、`cloudflare-quotas`。
- **本轮审查**：[project-review-2026-11-17](project-review-2026-11-17.zh-CN.md)、
  [watch-party-comparison-2026-11-17](watch-party-comparison-2026-11-17.zh-CN.md)。
- **历史/审查**：`version-notes`、`code-review-2026-09-30`、`fix-report-2026-09-30`、
  `project-overview-2026-09-21`、`adversarial-review-2026-09-21`、`ux-review-*`。
- **上游遗留（英文）**：`synchronization.md`、`api.yaml`、`config.md`、`db.md`、`custom-media-format.md`、
  `how-to-deploy.md`、`how-to-add-new-language.md`。
