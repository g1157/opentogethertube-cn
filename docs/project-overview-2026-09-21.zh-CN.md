# 2026-09-21 项目全貌：从第一性原理出发的系统审视

本文回答"**这个系统是什么、为什么这么设计**"。问题清单与裁决在配套文档
[`adversarial-review-2026-09-21.zh-CN.md`](./adversarial-review-2026-09-21.zh-CN.md)；
发布记录在 [`version-notes.zh-CN.md`](./version-notes.zh-CN.md)；fork 策略在根目录 `UPSTREAM.md`。

**版本快照**：本地 `feat/upscale-quality` @ `0ff882c`；线上 `https://openvideo.117911.xyz`
部署于 `66ff392`（v1.1.5 发布提交，源码与本工作区一致）。

**方法**：五路专项深读（核心同步机制、服务端、Rust 层、客户端、基础设施与运维）+
对关键引用逐条复核 + 线上实例非破坏性实测。统计数字（测试/迁移/工作流数量）为当日实测。

---

## 1. 定位

- 开源（AGPL-3.0）实时视频同步房间服务：一群人通过浏览器"同看"同一个视频，房间共享
  播放状态、队列、聊天、房间笔记与权限体系。
- **中文 fork**：以上游 `dyc3/opentogethertube` v0.15.0 为基线（`UPSTREAM.md`），本地演进到
  v1.1.5，采用"选择性移植上游改动 + 18080 验证后晋升 8080"的双端口发布策略。
- 媒体源覆盖 13 个适配器：YouTube、Invidious（YouTube 代理）、Vimeo、PeerTube、Bilibili、
  Reddit、Tubi、Pluto、Odysee、Google Drive、直链、HLS、DASH。
- 房间治理：队列（含投票模式/DJ 模式）、跳段投票、粒度权限（`common/permissions.ts`）、
  房间笔记、P2P 语音（WebRTC + 成本刹车）、画质增强（anime4k WebGPU，本分支开发中）。

## 2. 系统总览

```text
浏览器 (Vue 3 SPA)
   │  REST: /api/*          WS: /api/room/:name
   ▼
Monolith (Express + Room 引擎, server/)
   ├──▶ Redis 7    房间快照 / 会话 token / 限流 / 搜索与 SponsorBlock 缓存 / 公告 pub-sub
   ├──▶ Postgres 15 永久房间 / 用户 / 视频元数据缓存 / 房间笔记
   └──(可选, 生产未部署)──▶ Rust Balancer ──▶ Collector(只观测)
```

**一条"暂停"命令的旅程**（理解全部数据流的钥匙）：

1. 客户端 `RoomApi.pause()` → WS `{action:"req", request:{type:PlaybackRequest, …}}`
   （`client/src/util/roomapi.ts`）；
2. `clientmanager` 白名单校验 → `Room.processRequest()`（`server/room.ts`）；
3. 状态变更 → `markDirty("isPlaying")` → **50ms debounce** 的 `sync()`；
4. `syncDirty()` 只序列化**脏字段**并广播（`ServerMessageSync`），持久化侧：
   Redis 快照 5s debounce、永久房间落 Postgres；
5. 各客户端 `ServerMessageHandler` → `room/sync` mutation → 锚点重算；
6. `Room.vue` 的 `onSyncMsg` → `applyIsPlaying()` → 实际播放器暂停；每 250ms 的
   `playbackSync.tick()` 持续把本地播放器纠偏到房间时钟。

**技术栈**：前端 Vue 3 + **Vuex**（非 Pinia）+ Vuetify（6 主题）+ vue-i18n（zh-CN 默认）+
vue-query + hls.js/dashjs/anime4k-webgpu；后端 TypeScript + Express + Sequelize + `ws`
（原生 WebSocket，非 socket.io）+ winston + prom-client；数据 Redis 7 / Postgres 15；
Rust（balancer/collector/harness）；构建 Vite；lint Biome + 旧 ESLint/Prettier 并存。

## 3. 第一性原理：约束 → 设计映射

系统的根本任务：**让 N 个异构、互不可信、网络各异的浏览器，围绕一条不被本系统控制的媒体
时间轴达成感知一致的播放。**

| 不可约约束 | 设计应对 | 落点 |
| --- | --- | --- |
| 播放器控制力分层（iframe 只能 seek，原生可改速率） | 分层纠偏：rate-bend → hard seek | `client/src/util/playback-sync.ts` |
| 延迟不对称、抖动、不可测 | 单程延迟估计（min RTT/2）+ 锚点前移 | `connection-latency.ts`、`stores/room.ts` |
| 客户端时钟不可信 | 只做相对外推，不用绝对时间戳 | `common/timestamp.ts` |
| 房间状态是共享可变状态 | 服务端权威时钟 + 脏属性增量广播 + Mutex | `server/room.ts` |
| 第三方源不稳定（配额/反爬/CORS） | 适配器 + 多层缓存 + fallback（YouTube 网页解析、Invidious 代理） | `server/infoextractor.ts`、`server/services/*` |
| 单实例容量有限 | 房间单节点持有 +（设计好的）balancer 水平扩展 | `server/balancer.ts`、`crates/ott-balancer` |

**承重假设的逐条判决**（"哪些假设其实不成立"）见对抗式审查文档的 §0——
一句话版本：时钟/外推/纠偏的数学是成立的；不成立的是对"播放器会主动汇报状态""Redis 写总会成功"
"进程活着=服务健康""默认配置是安全的"这几条。

## 4. 同步引擎（系统的心脏）

### 4.1 服务端权威时钟与状态投影

- 时钟三要素：`_playbackStart`（锚点，`dayjs`）、`_playbackPosition`、`_playbackSpeed`；
  `realPlaybackPosition` = 播放中则外推，否则冻结（`server/room.ts`）。
- 同一状态有 **4 种投影**：`RoomState`（内存全量）/ `RoomStateSyncable`（可广播，剔除
  owner/votes/users 等）/ `RoomStateStorable`（存 Redis）/ `RoomStatePersistable`（存 PG）。
  这张"投影清单"是安全边界的一部分（密码、投票不广播也不落盘到公开路径）。
- 广播机制：每个 setter → `markDirty(prop)` → 50ms debounce `sync()`；`syncDirty()` 快照并清空
  dirty、失败时回滚；`sync()` 有 Mutex 防两路调用（debounce 与 1s tick）交错。

### 4.2 消息面（`common/models/messages.ts`，Zod 校验于 `server/ws-schemas.ts`）

| 方向 | 消息 |
| --- | --- |
| 服务端 → 客户端 | `sync`、`user`、`you`、`notes`、`event`/`eventcustom`、`chat`、`announcement`、`voice`、`signal`、`pong`、`error`、`unload` |
| 客户端 → 服务端 | `auth`、`kickme`、`status`（播放器状态/就绪确认）、`notify`、`req`（房间请求，白名单）、`voice`、`signal`、`ping` |

### 4.3 延迟估计与锚定

- 客户端每 15s `ping`，服务端回 `pong`（服务端限 1 次/秒/连接）；
- 保留最近 8 个 RTT 样本（>5s 视为异常丢弃，>180s 老化），**单程延迟 = min(样本)/2**；
- 锚点 = 收到 sync 的时刻 − 单程延迟（与 Syncplay 的 forward-delay 补偿同源，
  `docs/playback-sync.zh-CN.md`）。

### 4.4 客户端纠偏状态机（`client/src/util/playback-sync.ts`，250ms 一拍）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| BEND_START / BEND_STOP | 0.3s / 0.15s | 进入微调 / 退出微调（迟滞死区） |
| BEND_FULL | 0.5s | 漂移达到该值时节流阀满 |
| MAX_BEND | ±8% | 温和微调上限 |
| CATCHUP_FULL / CATCHUP_MAX_BEND | 1.0s / ±15% | 追赶区 |
| HARD_SEEK_DRIFT | 3s（不可 bend 时 1s；room-sync 路径为 0.3s） | 硬跳阈值 |
| seek 冷却 | 2s（自上次 seek 以来有缓冲则 8s） | 防 seek 风暴 |
| bend 期限 | 8–30s | 超期回退硬跳 |

- **支持 bend 的播放器**：Direct、HLS、DASH（原生 `<video>`，可写 playbackRate）；
  YouTube/Vimeo/PeerTube/Bilibili 只能 seek。
- 媒体恢复（`media-recovery.ts`）、seek 语义（`media-seek.ts`，50ms 无操作阈值）、
  首帧对齐（`playback-preparation.ts`：空房恢复、出队换片、`playNow` 都会选一名有播放权限的
  观众 prime 并等 ready 确认——换片时房间先停在片头，确认首帧后才启动时钟）
  是纠偏之外的三个配套机制——它们的互斥缺陷见对抗式审查 P1-3/P1-4。

### 4.5 播放器抽象（两层、彼此独立）

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 服务端 `ServiceAdapter` | `server/serviceadapter.ts` + 13 个适配器 | **只做元数据**：URL 识别、抓取标题/时长/缩略图、搜索、缓存 |
| 客户端 `MediaPlayer` 接口 | `client/src/components/composables/media-player.ts` + `players/*.vue` | **实际播放**：play/pause/seek/rate/音量/字幕/画质；能力用运行时探测（`MediaPlayerWithCaptions` 等） |

`OmniPlayer.vue` 按 `source.service` 分发到 7 个播放器组件（全部异步 code-split）。

### 4.6 房间生命周期与扩展模型

- 加入握手三段：完整 `sync` → `JoinRequest` → 仅位置的 `sync`（补偿 join 期间空房恢复导致的
  时钟变化）；重连带 `?reconnect=true`，空房恢复靠 `resumeOnNextJoin` + 首帧对齐；出队换片
  走同一套持有逻辑（`holdPlaybackForPreparation`），从数据库恢复的房间由 `restoreFromStorage`
  标记为「无播放意图」，进入房间不会自动开播；
- 房间**单节点持有**：Redis 只存快照（崩溃可恢复播放进度，因为 `_playbackStart` 是绝对时间戳），
  **不参与同步消息扇出**；多机扩展靠 Rust balancer 路由（`load_epoch` 解决重复加载），
  但该路径在本 fork 的生产未启用。

## 5. 服务端（Express monolith）

### 5.1 启动与中间件顺序（`server/app.ts`）

metrics → 安全响应头（CSP Report-Only 等）→ cookie 解析 → 静态客户端文件（先于会话，避免为
静态资源建会话）→ express-session（Redis store）→ passport → WebSocket/房间循环启动 →
body 解析 → 请求日志（仅 `/api/*`）→ API 路由 → SPA 兜底。优雅停机：kick 全部客户端 →
等待 1s → flush 房间 → 退出。

### 5.2 API 面（`server/api.ts`）

| 路由组 | 内容 | 鉴权 |
| --- | --- | --- |
| `/api/status` | 健康、版本、指标、语音用量 | 公开（metrics/voice 需 loopback 或 apikey） |
| `/api/playback` | 匿名播放质量遥测 | 公开 |
| `/api/auth` | token 发放、Discord OAuth | 公开 |
| `/api/data` | `previewAdd`（URL/搜索解析） | 公开 |
| `/api/user` | 登录/注册/找回/账号 | token |
| `/api/room` | 列表/创建/查询/改设置/队列/撤销 | token |
| `/api/announce` | 全局公告 | apikey |

### 5.3 认证、限流、房间引擎、存储

- **认证**：512 字节随机 token 存 Redis（游客 14 天、登录 **240 天**），登录/注册/Discord 回调
  时轮换（防会话固定）；httpOnly cookie 与 Bearer 双通道；访客自动生成昵称。
- **限流**：rate-limiter-flexible（1000 点/小时/桶），按端点扣点（建房 50、加队列 5、
  搜索 5、grant 20/IP 等）；爆破防护限流器**写了但未接线**（缺陷见 P1-2）。
- **房间引擎**（`server/room.ts` + `roommanager.ts`）：内存 Room 数组 + **1s 全局 tick**
  （更新/同步/卸载）；房间懒加载（重启无恢复风暴）；卸载时写最终快照；
  房间与传输层通过 `roommanager` 的 EventEmitter 总线解耦（publish/command）。
- **存储**：Sequelize（23 个迁移），永久房/用户/视频缓存/笔记落 Postgres；Redis 承载
  房间快照、会话、限流、搜索缓存（24h）、SponsorBlock 分段（约一周）、公告通道。

### 5.4 视频源与元数据管线（`server/infoextractor.ts`）

DB 缓存 → Redis 搜索缓存 → 适配器抓取；只补 `missingInfo` 字段；YouTube 走 Data API v3
（配额耗尽有**网页解析 fallback**）；Invidious 探测 DASH/HLS 清单并选高码率或回退渐进流；
直链/HLS/DASH 用 ffprobe 探测（三种策略，其重定向缺口见 P1-1）；SponsorBlock 5s 超时
（在 tick 关键路径上，见 P1-5）。

### 5.5 WebSocket 层与错误处理

- 原生 `ws`；首消息必须是 `auth`（10s 超时踢）；帧级 Zod 校验；256KB `maxPayload`；
  服务端 10s 心跳 ping；房间请求白名单（内部请求类型不可由客户端发起）。
- 错误体系：`common/exceptions.ts` 的 `OttException` 为根，服务端约 30 个子类带 status/code；
  WS 请求失败以 `error` 消息返回而不断连。缺点：4 处近乎重复的 per-router errorHandler（`// FIXME`）。
- 观测：prom-client（HTTP/DB/Redis/房间/WS/语音）+ winston 命名空间日志。

## 6. Rust 层（设计完备，生产未部署）

| crate | 职责 |
| --- | --- |
| `ott-balancer` | 负载均衡器核心：hyper HTTP/WS，单 dispatcher actor，选点策略，房间路由 |
| `ott-balancer-bin` | 5 行二进制入口（供 harness 拉起真实进程） |
| `ott-balancer-protocol` | 双端协议类型；`typeshare` 生成 `server/generated.ts`，防双语言漂移 |
| `ott-collector` | Rocket 服务：轮询各 balancer 状态 + tracing 事件流，**只观测，不参与路由** |
| `ott-common` | 服务发现（DNS/Fly/Manual/Harness）与 WS 升级工具 |
| `harness` / `harness-tests` | 集成测试框架：真实 balancer 进程 + 模拟 monolith/client |

- 选点：同 region 优先 → `MinRooms`（默认，按房间数）/ `HashRing`（生产配置，粘性）/ `Random`；
  房间首访时选点并 `Join`，monolith 自行加载房间；
- 重复加载冲突：Redis `INCR roommanager:load_epoch` 提供全局 epoch，balancer 按 epoch 裁决
  卸载/接管，配专门集成测试（harness 覆盖重复房间/重启/区域优先）；
- 现状：`deploy/next-compose.yml` 不含 balancer/collector（`docs/architecture.md:10` 自述
  "not currently deployed"）；`B2M::Load` 为死协议分支；`env/balancer.toml` 缺失——
  对单机部署而言这是**备而不用的复杂度税**（见 P2-8/P2-9）。

## 7. 客户端（Vue 3 SPA）

- 结构：`main.ts` 装载 Vuex/router/vue-query/i18n/Vuetify/连接插件；路由全懒加载；
  `views/Room.vue`（约 2000 行）协调播放、队列、聊天、语音、手势、快捷键等注入式服务。
- 状态：Vuex 命名空间模块 `room/users/settings/events/toast/misc/notes` + 根状态
  （`playerStatus` 等）；设置持久化在 localStorage。
- **连接是插件注入的服务**（`plugins/connection.ts`，`OttRoomConnectionReal`/`Mock`），不在
  store 里；`connected` 以**收到第一条 sync** 为准（服务端确认加入）；重连为抖动指数退避 + 重放。
- 服务端消息 → `ServerMessageHandler` 映射到 store；上报（播放状态、用户名变更）经
  `Workaround*` 桥组件回流——历史迁移痕迹，也是缓冲门缺陷（P1-3）的一部分。
- i18n：zh-CN 默认、en 回退、其余语言懒加载；其他语言普遍缺 8–14 个分节（可回退）。
- 构建：Vite；大依赖（hls.js/dashjs/three/anime4k）manualChunks 拆出；生产剥离
  `console.log/info`；无 PWA（仅版本轮询更新提示与 Media Session 集成）。

## 8. 基础设施与工程

### 8.1 部署拓扑（`deploy/next-compose.yml`）

单机四容器：`migrate`（幂等迁移，先于应用）→ `ott`（512m/1 CPU，read_only、cap_drop ALL、
no-new-privileges、仅绑定 127.0.0.1）+ `postgres:15`（384m）+ `redis:7`（192m、AOF everysec、
noeviction）。TLS 入口由同机 Caddy 或 Cloudflare Tunnel 承担。另有独立的 Cloudflare Workers
预览路径（`packages/ott-edge`，能力为 server 子集，文档自述诚实）。

### 8.2 CI 与测试（数量为 2026-09-21 实测）

| 项 | 内容 |
| --- | --- |
| CI（4 个 workflow） | `main.yml`：Node 22/24/26 矩阵 ×（lint+生成代码漂移检查）、sqlite 与 postgres 双路径测试、typos、Grafana 插件兼容；`rust.yml`：fmt/clippy/doc/test；`codeql-analysis.yml`；`publish-image.yml`（tag 触发发布 GHCR） |
| 单元测试 | server 45 个 spec、client 63 个 spec、common 7 个 spec（Vitest；版本记录称服务端 711/客户端 544 个用例） |
| E2E | Cypress 9 个集成 spec（account/auth/建房/权限/播放/事件/设置/登录/WS）——**本地运行，不在 CI** |
| Rust | harness 集成测试 + balancer benches（joins/latency/selection） |
| 压测 | `tests/load/` 7 个 k6 脚本 |

### 8.3 观测现状

prom-client 指标族齐全（HTTP/DB/Redis/房间/连接/语音），winston 结构化日志；
但 `prometheus.yml` 抓取目标写死上游域名、Grafana 插件未自动化、无告警规则、
无 tick/事件循环健康度指标——"有指标、没有看指标的人"（缺口详见 P1-6）。

### 8.4 文档地图（`docs/`，25 个文件）

中文为主：`playback-sync`（同步算法）、`buffer-gate`、`voice`、`room-notes`、`security-headers`、
`player-interactions`/`player-stats`/`player-strategy-research`、`media-parsing`、`video-enhancement`、
`cloudflare-quotas`、`deployment-options`、两份 `ux-review`、`plan-review`、`version-notes`、
本份 `project-overview` 与 `adversarial-review`；英文：`architecture.md`（WIP）、`api.yaml`、
`config.md`、`db.md`、`custom-media-format.md`、`synchronization.md`、`how-to-deploy.md`。

## 9. 关键文件索引

| 关注点 | 入口 |
| --- | --- |
| 同步引擎（服务端） | `server/room.ts`、`server/roommanager.ts`、`common/models/messages.ts`、`common/timestamp.ts` |
| 同步引擎（客户端） | `client/src/util/playback-sync.ts`、`playback-preparation.ts`、`media-seek.ts`、`media-recovery.ts`、`views/Room.vue` |
| 延迟补偿 | `client/src/util/connection-latency.ts`、`client/src/plugins/connection.ts` |
| WS 传输 | `server/websockets.ts`、`server/client.ts`、`server/clientmanager.ts`、`server/ws-schemas.ts` |
| 认证 | `server/auth/*`、`server/usermanager.ts` |
| 视频源 | `server/infoextractor.ts`、`server/serviceadapter.ts`、`server/services/*` |
| 播放器 | `client/src/components/players/*`、`client/src/components/composables/media-player.ts` |
| 状态与桥接 | `client/src/store.ts`、`client/src/stores/*`、`client/src/components/ServerMessageHandler.vue` |
| 部署 | `deploy/next-compose.yml`、`deploy/next.Dockerfile`、`DEPLOYMENT.md` |
| Rust 层 | `crates/ott-balancer`、`crates/ott-balancer-protocol`、`crates/ott-collector`、`crates/harness` |

## 10. 与其他文档的关系与局限

- **本文**：描述性全貌（"是什么/为什么"）；**对抗式审查**：问题与裁决（"哪里会坏"）；
  两者应配套阅读，版本快照一致。
- 局限：所有结论来自静态深读 + 引用复核 + 线上只读探测；未做真机双端同步实验、
  故障注入与攻击验证（清单见对抗式审查文档"局限声明"）。
