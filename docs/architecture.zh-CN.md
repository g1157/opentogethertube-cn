# 架构总览

> 2026-11-19 补充：以 `f240d98` / `v1.4.20` 为基础，以下包含尚未提交、尚未发布的工作区修复；
> 本轮证据与剩余范围见 [审查记录](archive/project-review-2026-11-19.zh-CN.md)。

本文描述 OpenTogetherTube 中文版（本仓库）**当前实现**的架构：进程与组件、运行时数据流、
同步引擎、服务端与客户端内部结构、数据与配置、测试与发布流程。面向想深入代码的贡献者与运维者；
"改哪里、有哪些坑"的速查版见配套的 [AI 工作手册](./ai-handbook.zh-CN.md)。

**版本快照**：`v1.4.20` 的实现；审查基线为 `e3c6e832`（`v1.4.19`），发布身份以 Git 标签与镜像 revision 为准。
[本轮审查与完善清单](archive/project-review-2026-11-17.zh-CN.md)记录验证范围与剩余风险，具体行为以代码为准。

---

## 1. 定位与边界

一个实时视频同步 Web 应用：一群人通过浏览器"同看"同一批媒体，房间共享播放状态、队列、
聊天、便签与权限体系。本仓库是上游 [OpenTogetherTube](https://github.com/dyc3/opentogethertube)
`v0.15.0` 的简体中文分支（来源与移植范围见 [UPSTREAM.md](../UPSTREAM.md)），默认简体中文、
免注册开房，重点工程投入在**同步边界情况**与**浏览器内画质增强**。

系统边界：

- **不托管、不转码、不代理媒体**。播放源是第三方直链（MP4/HLS/DASH/自定义清单）或平台的
  iframe 嵌入；画质增强整条链路在客户端（WebGPU/WebGL2），**服务器不需要 GPU**。
- **单实例是完整的部署形态**。Rust 多实例组件在本分支生产未启用（§9），
  多机扩展是"备而不用"的能力。
- **Cloudflare 预览版是能力子集**：无账号体系、无语音、无 SponsorBlock 等，见 §10。

---

## 2. 系统总览

```mermaid
flowchart LR
  subgraph Browser["浏览器"]
    SPA["Vue 3 SPA<br/>播放器 + 同步纠偏 + 画质增强"]
  end

  SPA -- "REST /api/*" --> Monolith
  SPA -- "WebSocket /api/room/:name" --> Monolith

  subgraph Monolith["Monolith（Node.js / Express + ws）"]
    API["REST 路由"]
    WS["WebSocket + 房间引擎"]
  end

  Monolith -- "房间快照 / 会话 / 限流 / 缓存" --> Redis[("Redis 7")]
  Monolith -- "永久房间 / 用户 / 元数据缓存 / 便签" --> PG[("PostgreSQL 15")]
  Monolith -. "balancing.enabled（默认关）" .-> Balancer["Rust Balancer（生产未启用）"]
  Balancer -. "观测" .-> Collector["ott-collector"]

  Edge["Cloudflare 预览版<br/>Worker + Durable Object + D1"] -. "能力子集，独立部署" .-> SPA
```

**组件一览：**

| 组件 | 位置 | 技术栈 | 职责 |
| --- | --- | --- | --- |
| 客户端 | `client/` | Vue 3.5 + **Vuex 4**（非 Pinia）+ Vuetify 3 + vue-i18n + vue-query | SPA、播放器、同步纠偏、画质增强、聊天/便签/语音 UI |
| 服务端（Monolith） | `server/` | TypeScript + Express + Sequelize + `ws`（原生 WebSocket）+ winston + prom-client | REST API、WebSocket 房间、权威时钟、信息提取、持久化 |
| 共享层 | `common/` | TypeScript | 消息协议与 Zod 校验、权限、异常、时间计算、结果类型 |
| Rust 层 | `crates/*` | Rust（hyper/tungstenite/Rocket） | 负载均衡器、协议、collector、集成测试框架（生产未部署） |
| 边缘预览 | `packages/ott-edge` | Cloudflare Worker + Durable Object + D1 | 无服务器子集实现 |
| 监控面板 | `packages/ott-vis*` | React + D3 + Grafana SDK | 自研 Grafana 面板/数据源插件 |
| 部署 | `deploy/`, `docker/` | Docker Compose | 镜像构建、迁移、资源限制、备份、TLS |

---

## 3. 仓库结构

```text
client/            Vue 3 前端（Vite；src/{components,stores,util,views,plugins,locales}）
server/            Express monolith（api/、auth/、services/、storage/、models/、migrations/、tests/）
common/            前后端共享 TS（models/messages.ts 为消息协议；permissions/exceptions/timestamp…）
crates/            Rust workspace：ott-balancer(-bin/-protocol)、ott-collector、ott-common、harness(-tests)
packages/          ott-edge（Cloudflare 预览版）+ ott-vis / ott-vis-panel / ott-vis-datasource（Grafana）
db/                仅本地 SQLite 产物；真正的迁移在 server/migrations/
deploy/            生产部署：init.sh、next-compose.yml、next.Dockerfile、备份脚本、上游遗留的 Fly/Ansible 资产
docker/            本地开发 compose（含 with-balancer 变体）与构建用 Dockerfile
env/               配置模板（example.toml、balancer.example.toml；实际 *.toml 不入库）
scripts/           codegen.sh（typeshare 生成）、anime4k GLSL 转换器、版本号脚本
tests/             Cypress E2E 与 k6 负载脚本（单元测试在各 workspace 内）
docs/              中文专题文档（本文件所在处）
```

---

## 4. 运行时数据流

### 4.1 HTTP 请求生命周期（`server/app.ts`）

中间件顺序（有意安排）：

1. **指标**：`metricsMiddleware`（所有请求计数/耗时）。
2. **安全响应头**：`installSecurityHeaders`（含 report-only CSP 与 `/api/csp-report` 端点，先于会话/静态资源）。
3. **Cookie 解析**。
4. **静态客户端文件**：先于会话中间件挂载，避免为静态资源创建会话。
5. **express-session**（Redis store）：cookie 名可配置，`sameSite=lax`，生产 + 非 localhost + `trust_proxy>0` 时 `secure`；
   `FORCE_INSECURE_COOKIES=true` 可强制关闭（裸 IP/HTTP 部署用）。
6. **passport**：Local / Discord / Bearer 三种策略；Bearer 只接受已登录 token。
7. **WebSocket 与房间循环启动**：`websockets.setup(server)` → `clientmanager.setup()` → `roommanager.start()`。
8. **Body 解析**（仅 API 需要）。
9. **请求日志**（仅 `/api/*`，跳过 `/api/status`）。
10. **API 路由** `/api`，随后是 **SPA 兜底**。
11. `initExtractor()` → `server.listen(port)`。

优雅停机：踢掉全部 WebSocket 客户端 → 等 1s → `roommanager.shutdown()`（卸载全部房间、flush 快照）→ 退出。

### 4.2 WebSocket 连接与加入房间

- 客户端连接 `ws(s)://<host>/api/room/<name>[?reconnect=true]`。
- **首消息必须是 `auth`**：10 秒内未完成认证即被踢（`OttWebsocketError.MISSING_TOKEN`）；
  token 来自 Redis 会话（`auth:<token>`），最长 1024 字符（真实 token 约 684 字符）。
- 认证后处理 `JoinRequest`；服务端先回完整 `sync`，再补便签 / 语音。早到的普通消息等待 pending join，
  成员建立后才处理；断开后停止，密码异步校验结束也重核连接。登录 / 认领可用 `reauthenticate` 原地更新身份。
- `connected` 语义：客户端在**收到第一条 `sync`** 时才认为连接成功（见 §7.3）。
- 心跳：服务端每 10s 扫一遍连接，`isAlive` 为 false 直接 `terminate()`，否则发 WS ping；收到 pong 置 alive。
- 应用层延迟探测：客户端每 15s 发 `{action:"ping", t0}`，服务端回 `pong`（每连接限 1 次/秒）。
- 消息尺寸：`maxPayload = 256 KB`；聊天/标题/描述在 WS 层有独立长度上限。
- 每连接令牌桶（v1.2.6 加入）：通用 40 突发 / 10 每秒，聊天 5 突发 / 0.5 每秒；超限回 `error` 消息而不掉线。

### 4.3 一条「暂停」命令的旅程

1. 客户端 `RoomApi.pause()` → WS `{action:"req", request:{type:PlaybackRequest, state:false}}`
   （`client/src/util/roomapi.ts`）。
2. `clientmanager` 校验（Zod → 房间请求白名单）→ `room.processUnauthorizedRequest()`（`server/room.ts`）。
3. 权限判定（`RoomRequestType → 权限名` 映射）后调用 setter：`isPlaying = false` → `markDirty("isPlaying")`。
4. **50ms debounce** 的 `throttledSync()` 合并突发变更；`sync()` 由 Mutex 串行，`syncDirty()` 只序列化脏字段，
   广播 `ServerMessageSync`；脏集合在 I/O 前快照并清空，失败时回滚重试。
5. 持久化侧：Redis 快照 **5s debounce**（`room:<name>`，TTL 7200s）；永久房间另同步写 Postgres。
6. 各客户端 `ServerMessageHandler` → Vuex `room/sync` mutation → 重算播放锚点（减去单程延迟）。
7. `views/Room.vue` 收到 sync 后 `applyIsPlaying()` 实际暂停播放器；每 250ms 的 `playbackSync.tick()`
   持续把本地播放器纠偏到房间时钟（§5.4）。

---

## 5. 同步引擎

### 5.1 服务端权威时钟

房间播放状态由三个量决定：`_playbackStart`（锚点，`dayjs`）、`_playbackPosition`、`_playbackSpeed`。
`realPlaybackPosition` = 播放中则按锚点外推，暂停则冻结——**广播的永远是"此刻的位置"**，客户端拿绝对锚点
自行外推（`common/timestamp.ts:calculateCurrentPosition`）。

### 5.2 状态的四种投影（`server/room.ts`）

同一份房间状态按用途投影，这是安全边界的一部分：

| 投影 | 去向 | 包含 | 明确排除 |
| --- | --- | --- | --- |
| `RoomState` | 服务端内存 | 全部 | — |
| `RoomStateSyncable` | **广播给客户端** | 标题/队列/播放状态等 | owner、votes、userRoles、users、resumeOnNextJoin |
| `RoomStateStorable` | **Redis 快照** | 可恢复播放所需 | hasOwner、votes、users、临时倍速、playbackPreparation；owner 只留 id（绝不落密码材料） |
| `RoomStatePersistable` | **Postgres（永久房间）** | 仅设置类字段 | 播放进度、队列（队列快照存 `prevQueue` 字段） |

新增需要同步/持久化的字段时，必须显式加进对应投影的 `*Props` 列表，否则不会被广播或保存。

### 5.3 脏字段广播与持久化

- 每个 setter → `markDirty(prop)` → 50ms debounce `sync()`；`sync()` 用 Mutex 防 debounce 与 1s tick 交错。
- 广播只包含脏字段（增量 `sync`），客户端按字段逐项应用。
- Redis：storable 脏字段触发 5s debounce 保存；房间卸载时 flush；写失败只记日志，脏集合保留待下次重试
  （v1.2.6 修复了"Redis 写失败变成未捕获 rejection"）。
- Postgres：仅永久房间，脏设置变化时 `storage.updateRoom()`；grants 与 permissionsRevision 同一 checkpoint。
  当前 pause / seek 等仍可能附带整条 prevQueue 快照，仍有写放大；不同房间的 tick 已隔离，见下条。
- SponsorBlock 以单飞异步任务刷新，不再 await 在全局 tick 内；返回结果绑定 source 和 requestId，卸载使旧结果失效。
- 1s tick（`roommanager.runUpdate`）：按房间对象单飞，全局最多 8 个并发任务，每个房间最多一个执行中或排队任务；
  周期调度不等待全部房间，显式 `update()` 仍可等待当前快照。每项执行 `room.update()`
  （缓冲门、保活、出队、投票排序）+ `room.sync()`；装载对象失效后不再卸载同名替代房间。
  超过 `room.unload_after`（默认 300s）无活动的房间被卸载。8 个任务全部长期阻塞仍会耗尽槽位，未实现 DB I/O 取消。
- 指标口径：`ott_room_manager_update_duration_seconds` 记录单房间执行与 checkpoint 时间，不含排队；
  `ott_room_manager_update_skipped_total` 记录繁忙房间被周期调度跳过的次数，不再代表整轮跳过。

### 5.4 客户端纠偏状态机（`client/src/util/playback-sync.ts`）

每 250ms 一拍；核心是"能改速率就用速率收敛，不能改才跳"：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `BEND_START` / `BEND_STOP` | 0.3s / 0.15s | 进入/退出微调的迟滞死区 |
| `CATCHUP_FULL` | 1s | 温和 ±8% 区上界，之后到 3s 线性增至 ±15% |
| `MAX_BEND` | ±8% | 温和微调上限（可 bend 的播放器） |
| `CATCHUP_MAX_BEND` | ±15% | 1–3s 漂移时的追赶区上限 |
| 周期 tick 硬跳阈值 | 可 bend 播放中 3s，初始 8s 冷却期 10s；不可 bend / 关闭开关 1s | 周期被动纠偏 |
| 收到 sync 的纠偏阈值 | 可 bend 播放中 3s；暂停 / 不可 bend / 关闭开关 300ms | `seekIfDriftIsLarge`，与 tick 不同 |
| `BEND_DEADLINE_MS` / `MAX_BEND_DEADLINE_MS` | 8s / 30s | 收敛期限，超期回退硬跳 |
| seek 冷却 | 2s；上次 seek 后有缓冲则 8s | 防 seek 风暴 |
| `RATE_WRITE_THRESHOLD` | 0.002 | 速率写入死区 |
| `LATENCY_PROBE_INTERVAL_MS` | 15s | ping 间隔 |
| 单程延迟 | 最近 8 个样本的 `min(RTT)/2`（>5s 丢弃、>180s 老化） | 锚点前移量 |

**能力分层**：Direct / HLS / DASH 是原生 `<video>`，可写 `playbackRate` → 支持速率微调；
YouTube / Vimeo / PeerTube 依平台 API seek；Bilibili 无控制 API，只能重载和估算位置。
纠偏层通过 `supportsRateBend()` 运行时探测；开关是按设备保存的普通偏好。

### 5.5 三个配套机制

- **首帧准备轮次**（`playback-preparation.ts` + `server/room.ts`）：换片 / 出队 / 立即播放时快照 eligible，
  客户端在首帧与缓冲跑道（MP4 3s、HLS / DASH 6s）后回执；多人全体 ready 走 +1s 起播，8s partial，20s forced。
  未知时长的原生点播仍进入准备，明确 `isLive` 的直播跳过；后台 / 失败成员不无限阻塞。
  从存储恢复的房间保持暂停。详见 [playback-sync](playback-sync.zh-CN.md)。
- **媒体恢复**（`media-recovery.ts`）：网络错误 1s/3s/6s 三次重试，解码错误一次；卡顿阶梯 = 等待（HLS 交给 hls.js 自愈，不重建 MSE；无引擎级重试的源走重载）→ +0.3s 跳转 → +3s 跳转（超时 8s 触发）；MSE 重建只发生在错误路径。
- **seek 语义**（`media-seek.ts`）：50ms 容差，先暂停再写 `currentTime`，`readyState ≥ 2` 且位置收敛才算完成。

### 5.6 缓冲联动（房间设置，可选）

`bufferGateMode=pause` 且房间内 ≥2 名有播放权限的观众时，有人明确上报 `buffering` 则全房间暂停等待：
上限 `BUFFER_GATE_MAX_WAIT_MS=15s`、启动宽限 2s、冷却 30s；后台标签页不算等待方。详见
[buffer-gate.zh-CN.md](./buffer-gate.zh-CN.md)。

---

## 6. 服务端

### 6.1 API 面（`server/api.ts` + `server/api/*`）

| 路由组 | 内容 | 鉴权 |
| --- | --- | --- |
| `/api/status` | 健康、版本（`/version`，no-store）、指标（`/metrics`）、语音用量（`/voice`） | 公开；metrics/voice 需 loopback 或 apikey |
| `/api/playback` | 匿名播放质量遥测 `POST /quality` | 公开（进程内限速 5s/次） |
| `/api/auth` | `GET /grant`（游客 token）、Discord OAuth | 公开 |
| `/api/data` | `GET /previewAdd`（URL/搜索解析） | 公开 |
| `/api/user` | whoami、改名、登录/登出/注册、密码找回、账号管理、owned-rooms | token |
| `/api/room` | 列表、生成、创建、查询/改设置/删除、undo、vote、queue | token（列表的 apikey 可选） |
| `/api/announce` | 全局公告 | apikey |
| `/api/dev` | 测试辅助端点 | 仅 `env=development` 挂载 |

### 6.2 WebSocket 层

- 原生 `ws`（`noServer` + HTTP `upgrade`）+ `server/clientmanager.ts` 路由；帧级 Zod 校验（`server/ws-schemas.ts`）。
- 客户端 → 服务端消息：`auth`、`kickme`、`status`（播放状态 + 首帧确认）、`notify`、`req`（房间请求）、
  `voice`、`signal`、`ping`、`diagnostics`、`reauthenticate`。
- 服务端 → 客户端消息：`sync`、`user`、`you`、`notes`、`event`、`eventcustom`、`chat`、`announcement`、
  `voice`、`signal`、`pong`、`error`、`unload`。
- **房间请求白名单**：内部请求类型（如 UpdateUser 的成员变更路径）不可由客户端直接发起。
- 请求失败以 `error` 消息返回而不断连；`MissingToken` 等才踢。

### 6.3 房间引擎

- `server/room.ts` 持有状态、setter、权限映射与全部请求处理（`processUnauthorizedRequest` → `processRequest`）。
- 权限：`common/permissions.ts` 28 个权限位 + 角色继承（Owner/Administrator/Moderator/TrustedUser/
  RegisteredUser/UnregisteredUser）；投票跳过阈值 = `ceil(人数 × 0.5)`（仅计有 `playback.skip` 的用户）。
- 生命周期：内存 → Redis 快照（崩溃恢复播放进度）→ Postgres（永久房间设置）；房间懒加载，重启不恢复风暴。
- 永久房间每次设置变更落库，且只有永久房间允许便签；临时房间不碰 Postgres。
- `roommanager` 用 EventEmitter 总线（`publish`/`command`/`load`/`unload`）与传输层解耦；
  `INCR roommanager:load_epoch` 为多机场景提供装载序号（balancer 用），成功后才把实例公开到 rooms。
  建房 / 装载 / 卸载按小写名字加 Mutex，避免大小写变体重复装载，锁随使用者归零释放。

### 6.4 认证、限流

- **token**：`crypto.randomBytes(512)` 的 base64（不透明，无 JWT）；Redis `auth:<token>` 存会话；
  游客 14 天、登录 240 天；登录/注册/Discord 回调/密码重置都会**轮换 token**（防会话固定）。
  httpOnly cookie 与 Bearer 双通道；游客昵称由中文昵称生成器生成。
- **全局限流**：`rate-limiter-flexible`，1000 点/小时/IP，超限封 120s；按端点扣点（建房 50/200、
  队列 5（批量 ×3/视频）、搜索 5/75、`auth/grant` 20、注册 100、密码找回 100/10、账号 10、CSP 25）。
- **登录爆破**：IP 维度 100 次失败/24h（封 24h）+ 用户名×IP 维度 10 次连续失败（封 1h，成功清零）。
- API key 校验用 `timingSafeEqual`（`server/admin.ts`）。房间请求先验证 token 会话，再使用 token 匹配的缓存成员。
  语音加入的预算判断与座位保留同步执行；relay 选择单飞并绑定当前参与者 Set，旧会话结果不能落入新会话。

### 6.5 信息提取与媒体源适配器

`server/infoextractor.ts` 管线：**DB 缓存（CachedVideos）→ Redis 搜索缓存 → 适配器抓取**；
只补 `missingInfo` 缺的字段；`OutOfQuotaException` 时尽量返回部分缓存。

13 个适配器（`server/services/`）：`youtube`、`invidious`（YouTube 代理）、`vimeo`、`peertube`、
`bilibili`、`reddit`、`tubi`、`pluto`、`odysee`、`googledrive`、`direct`、`hls`、`dash`。

- 缓存：视频字段在 `CachedVideos`；标题/描述/缩略图/时长在"视频较新（≤7 天）时保鲜 7 天、否则 30 天"，
  `mime` 永久返回；搜索缓存 24h；`previewAdd` 响应缓存 1h（cache-safe 服务 7 天）。
- `isCacheSafe=false`（不写缓存）：pluto、bilibili、reddit、tubi、direct、hls、dash。
- YouTube 走 Data API v3，配额耗尽有网页解析 fallback；Invidious 探测 DASH/HLS 清单选高码率，失败回退渐进流。
- PeerTube / Invidious 的 `{service, id}` 入口也校验实例白名单；PeerTube 绑定完整主机与端口，
  Invidious 保留已批准 hostname 可使用其他端口的既有规则。Reddit 按真实域名边界校验并使用 HTTPS canonical endpoint。
  这三个适配器的 metadata 请求使用公网地址检查、2 MiB 解码正文上限、5s 请求截止和零隐式重定向；
  DNS 检查与实际连接仍非同一次固定解析，不能视作完整 SSRF 闭环。
- 防盗链探测（`services/media-access.ts`）：先用本应用 origin 的 Referer 探测首个分片，被拒再试无 Referer，
  实测可播才记录 `referrerPolicy:"no-referrer"`。

### 6.6 直链探测（`server/ffprobe.ts`）

三种策略（`info_extractor.direct.ffprobe_strategy`）：`run`（默认，把 URL 直接交给 ffprobe，Range 读取）、
`stream`（自行下载字节流入管道）、`disk`（下载到临时文件）。子进程硬截止 20s、ffprobe I/O 12s，启动前解析最多 5 次重定向；
每次启动前解析的重定向都过公网检查，DNS 与解析请求有 5s 边界，ffprobe 使用最终 `resolvedUri`。
子进程仍会独立解析 DNS、读取后续 HTTP 资源，完整出站闭环尚未实现，见审查清单。
HLS/DASH 不走 ffprobe，分别用 `m3u8-parser` / `saxes` 解析清单；DASH 只提取有界预览元数据，不展开完整 DOM 或时间线。
HLS 的主清单与选中变体、DASH 的文字清单各请求限定 2 MiB / 5s，拒绝隐式重定向。

**弹幕资源边界**（`common/danmaku.ts`、`common/response-body.ts`）：XML 解码正文最多 8 MiB，
最多 100,000 个评论元素；浏览器丢弃超过 2000 UTF-16 单元或含嵌套元素的单条文字。
前后端各最多 4 个同时下载；超额立即失败，不建立无界等待队列。流读取累计实际字节，
超限或截止会取消 reader，不等待卡住的 cancel；预检跳过注释、CDATA 与处理指令，拒绝实际 DOCTYPE/ENTITY。
浏览器 XML 截止 10s，服务端 metadata 10s / XML 15s；浏览器评论缓存与服务端 XML 缓存各 32 MiB，
服务端搜索/集数缓存各 4 MiB。缓存采用 UTF-16 载荷与固定条目开销记账，不是实测 JS heap。

### 6.7 存储

**Redis**（`server/redisclient.ts`；5s 连接/命令超时、关闭离线队列）：

| Key | 用途 | TTL |
| --- | --- | --- |
| `room:<name>` | 房间快照（`RoomStateStorable`） | `room.expire_after`（默认 7200s） |
| `room-sync:<name>` | 多机同步通道遗留键，现在只会在卸载时删除 | — |
| `roommanager:load_epoch` | 全局装载序号（balancer 用） | 无 |
| `search:<service>:<query>` | 搜索结果缓存 | 24h |
| `segments:<videoId>` | SponsorBlock 分段 | 7 天 |
| `ytchannel:<k>:<v>` | YouTube 频道→播放列表缓存 | 无 |
| `auth:<token>` | 会话 token | 游客 14 天 / 登录 240 天 |
| `accountrecovery:<key>` | 密码找回验证码 | 600s |
| `voice:relay-bytes:<YYYY-MM>` | 语音中继月度用量 | 62 天 |
| `announcement`（pub/sub 频道） | 全局公告扇出 | — |

**Postgres**（Sequelize；迁移在 `server/migrations/`，当前 27 个）：

| 模型 | 表 | 关键内容 |
| --- | --- | --- |
| `Room` | `Rooms` | 永久房间：name/title/description/visibility/queueMode/ownerId/permissions JSONB/role-* 列/prevQueue 等 |
| `User` | `Users` | username/email（唯一）、argon2 salt/hash、discordId |
| `CachedVideo` | `CachedVideos` | (service, serviceId) 唯一；title/description/thumbnail/length/mime |
| `RoomNote` | `RoomNotes` | 追加式便签：roomName/authorName/authorId/text |

存储层在 `server/storage.ts` + `server/storage/*`；房间名匹配用 `lower(name)`；`Grants` ↔ JSONB 转换。
本地开发/测试用 SQLite（`server/db/*.sqlite`），CI 同时跑 SQLite 与 Postgres 两条路径。

### 6.8 配置、观测与错误

- 配置加载：`env/base.toml` → `env/<env>.toml`（`<env>` 取 `NODE_ENV`），可选叠加
  `heroku.base.toml` / `docker.base.toml`；schema 在 `server/ott-config.ts`（convict），支持环境变量覆盖；
  严格校验要求 `session_secret` ≥80 字符、`api_key` ≥40 字符。
- 主要配置段：`db`、`redis`、`add_preview.search`、`info_extractor.*`、`rate_limit`、`voice.*`、
  `room.{unload_after,expire_after,enable_create_*}`、`video.sponsorblock`、`balancing.*`、`mail`、`discord`。
- 指标（prom-client）：HTTP 请求/耗时/错误、DB、Redis、房间数/人数、房间 tick 耗时/跳过、WebSocket 关闭码、
  语音用量；`GET /api/status/metrics` 暴露。
- 日志：winston，命名空间 + 房间上下文，级别可配；v1.2.6 起进程级 `unhandledRejection` 兜底只记日志。
- 错误：`common/exceptions.ts` 的 `OttException` 为根，服务端另有约 30 个子类（`server/exceptions.ts`）；
  路由各自持 errorHandler，把 `OttException` 映射为 4xx，其余 500 `{name:"Unknown"}`。

---

## 7. 客户端

### 7.1 启动与路由

`main.ts` 依次装载 Vuex、vue-router、vue-query、i18n、Vuetify、连接插件、音效插件；生产构建额外安装
版本更新检查（每 120s 轮询 `/api/status/version`，见 §7.8）。所有路由懒加载（`client/src/router.ts`）：
首页、房间列表、我的房间、账号、`/room/:roomId`（核心）、帮助、归属页、密码重置、404；`/r/:id` 与
`/rooms/:id` 重定向到房间。**没有鉴权路由守卫**。

### 7.2 状态（Vuex 模块）

| 模块 | 职责 |
| --- | --- |
| 根状态 | `playerStatus`、缓冲、登录态、全屏、公告/错误 toast |
| `room` | 房间状态镜像；`SYNC` mutation 应用增量 sync，重算 `playbackStartTime`（减去单程延迟） |
| `users` | 房间成员 Map、`you.id`、token（localStorage）；`getNewToken` 单飞 |
| `settings` | 客户端设置持久化到 `localStorage["settings"]`；`UPDATE` 持久 + 应用，`UPDATE_TRANSIENT` 仅本次会话（自动降档用） |
| `events` | 把房间事件映射为本地化 toast |
| `notes` | 房间便签数组与上限 |
| `toast` | 通知队列（合并连续播放/seek 事件） |
| `misc` | 建房 loading 等杂项 |

设置读入时做版本迁移（如 locale 版本变化重置为 zh-CN）。vue-query 目前只用于账号页。

### 7.3 连接服务（插件注入，不在 store 里）

`client/src/plugins/connection.ts` 提供 `OttRoomConnectionReal`（测试用 Mock）：

- 重连：**线性退避** `min(30s, (1s + 2s×次数)) × (0.5–1.5 随机)`，不是指数退避；`?reconnect=true` 跳过首次加入语义。
- 回到前台或网络恢复（`visibilitychange` → 可见、`online`）时若**已知连接中断（`issue` 非空）**且仍未连上，立即重连，不等退避计时器到期；首次连接仍在途时不打扰（否则会被误标成会话恢复）。
- `connected` 在收到第一条 `sync` 时置真；`active` 表示"应当连接"。
- 关闭码 ≥4000 为服务端踢出（未知码可重试 2 次）；`<4000` 视为网络问题并重连。
- 断线提示（`RoomConnectionNotice`）：中断持续 **10 秒**且仍未连上才显示横幅；短暂掉线（后台回来、休眠、切网）完全静默，由自动重连消化。
- 延迟探测：每 15s `ping`，服务端回 `pong`；样本保留 8 个，取 `min/2` 作为单程延迟。

### 7.4 消息处理与回流

`components/ServerMessageHandler.vue` 把服务端消息映射到动作：
`sync→room/sync`、`user→users/user`、`you→users/you`、`notes→notes/notes`、`event(custom)→events`、
`error→根 error`、`announcement→根 announcement`；
`WorkaroundPlaybackStatusUpdater.vue`（防抖 200ms）上报播放状态（`status`），
`WorkaroundUserStateNotifier.vue` 上报改名（`notify`）。

### 7.5 Room.vue 与 250ms 循环

`views/Room.vue`（约 3056 行）是房间编排器：连接、RoomApi、播放器 composable、播放同步/首帧准备/
媒体恢复/画质上报、语音、手势、快捷键、全屏、聊天/队列/便签/设置等全部在此接线。
每 250ms 的 `setInterval` 更新真实位置、Media Session、下一集预取、首帧准备与 `playbackSync.tick()`。
播放器事件 → `applyIsPlaying()`/`applySeek()`；服务端 sync → 重算锚点再应用。

### 7.6 播放器抽象

接口 `client/src/components/composables/media-player.ts`（能力用可选方法做运行时探测）：

| 组件 | 封装 | 速率微调 | 字幕 | 画质档 |
| --- | --- | --- | --- | --- |
| `DirectPlayer` | 原生 `<video>` | ✅ | ✅ | Safari `videoTracks` |
| `HlsPlayer` | hls.js / 原生 | ✅ | ✅ | ✅（levels） |
| `DashPlayer` | dash.js | ✅ | ✅ | ✅ |
| `YoutubePlayer` | YouTube iframe API | ❌ | ✅ | 有限 |
| `VimeoPlayer` | @vimeo/player | ❌ | ✅ | ❌ |
| `PeertubePlayer` | PeerTube embed API | ❌ | ❌ | ❌ |
| `BilibiliPlayer` | 官方 iframe | ❌ | ❌ | ❌ |

`OmniPlayer.vue` 按 `source.service` 分发（sourceKey 变化强制重载）；Direct/HLS/DASH 接入 `UpscaleLayer`。

### 7.7 画质增强（全部在客户端）

档位：off、sharpen、film、anime4k、anime4k-quality、anime4k-ultra。全部保留在菜单里；
片源能力由 `MediaPlayer.isVideoEnhancementSupported` 提供，iframe / Direct 无 CORS 回退不支持纹理读取，
控件明确禁用并保留全局偏好。GPU 可用性另外实测，失败由增强层报告和降级。

| 档位 | 实现 | 说明 |
| --- | --- | --- |
| 清晰化 | WebGL2（`cas.ts`） | FSR1 EASU → 自有邻域限幅锐化，不是 AMD CAS / RCAS |
| 影视 | WebGL2（`film.ts`） | 去噪 / 去带 / 抖动 → EASU → 0.6 系数锐化 |
| AI 快速 | WebGPU Mode A 或 WebGL2 S | 探针成功后才导入 WebGPU 库 |
| AI 质量 | WebGPU A+A 或 WebGL2 A+A (HQ) | 目标尺寸闸门决定实际执行链 |
| AI 极致 | 显式 WebGL2 A+A (HQ) | 55 段 shader 定义；本轮 1.5× 目标实际 47 pass（含呈现） |

- `scale.ts` 为唯一尺寸来源：自动按 contain / cover、显示框与 DPR（≤3）计算，正常源至少 1×；
  CNN 在精细指针设备且有 WebGPU 后端时有 1.25× 下界（WebGL2 回退链不加：那会让 1080p 源开 x2 段、
  全链在 4K 上跑），自动像素预算为 4K、最大 3×，显式 0.25×–3× 不受自动预算约束。
- WebGL2 上下文（`cas.ts` / `film.ts` / `anime4k-webgl.ts`）声明 `powerPreference: "high-performance"`，
  否则混合显卡笔记本会把整条 CNN 链放在核显上（WebGPU 档本就如此申请适配器）。
- 共用 `video-render-loop.ts`：rVFC 按 mediaTime 去重、后台跳过、暂停 / seek / resize 重绘、fatal 释放。
  WebGPU 首帧等待 4s 可取消；generation 与原元素回调归属防止慢启动覆盖新实例。
- GL program 按 context 缓存，链接后释放 shader；WebGL CNN 闲置 15s 释放中间纹理 / framebuffer，重绘再创建。
- 降档观察 video 呈现节奏 / <18fps / 管线丢帧；两个 6s 坏窗口才降级，重建首窗口不评分，
  暂停 / seek / 缓冲 / 后台重置；一帧超过 1s 且媒体时钟仍在前进算「慢」而不是停顿（否则 0.9 fps
  的档位永不降级）；`UPDATE_TRANSIENT` 不覆写偏好。该判据不是 GPU 完成测量。
- 生成 GLSL 禁止手改。机制、实测与限制见 [video-enhancement](video-enhancement.zh-CN.md)。

### 7.8 i18n 与构建

- i18n：默认 `zh-CN`、回退 `en`（两者立即加载），其余语言（de/es/fr/pirate/pt-br/ru）按需动态 import；
  切换语言同时更新 `Accept-Language`。非中英语言目前普遍缺数百个键（已知项）。
- 构建（`client/vite.config.js`）：Vite；`hls.js`/`dashjs`/`three`/`anime4k-webgpu` 保持异步分块（动态 import），
  其余依赖进 `vendor`；生产剥离 `console.log/info`；dev server 8080 代理 `/api` 到 3000（含 WS）。
- Service Worker 按 registration scope 隔离缓存，只缓存 assets，清理自己的旧缓存，限制 128 条；
  写入交给 waitUntil，quota 错误不改变成功网络响应。条目上限不是字节上限。
- 消息音效在第一次启用后的播放时才加载，单飞、请求 5s、错误被捕获；入房不预先下载或创建 AudioContext。
- 更新检查：`util/client-update.ts` 每 120s + `pageshow/online/visibilitychange` 拉 `/api/status/version`，
  比对 revision（git hash 或 `cloudflare-preview-N.N.N`），提示刷新且避免打断输入。

---

## 8. 共享层 `common/`

- `models/messages.ts`：全部 WS 消息类型（服务端→客户端 13 种、客户端→服务端 10 种、房间请求 23 种），
  是前后端协议的唯一定义；服务端另有 Zod 校验 `server/ws-schemas.ts`。
- `permissions.ts`：28 个权限位、角色继承、`Grants` 序列化（始终强制 Owner/Administrator 全权限）。
- `exceptions.ts`：`OttException` + 权限/角色/token 三个基础异常；服务端子类在 `server/exceptions.ts`。
- `timestamp.ts`：`calculateCurrentPosition(start, now, offset, speed)`——全系统位置外推的唯一公式。
- `result.ts`：`Ok/Err` 风格 `Result<T,E>` 与 `intoResult/intoResultAsync`。
- `constants.ts`：服务列表、房间名正则、便签/缓冲门/临时倍速等共享常量。
- `nicknames.ts`：中文游客昵称生成。
- 导入约定：服务端引用带 `.js` 扩展名；client 引用不带；`exports` 默认解析原始 TS，生产镜像用
  `--conditions=lean` 走 `ts-out/` 编译产物。

---

## 9. Rust 层（多实例组件，生产未启用）

| crate | 职责 |
| --- | --- |
| `ott-balancer` | 核心负载均衡器：hyper HTTP + WS 升级、单 dispatcher actor、选点策略、房间路由、HTTP 代理 |
| `ott-balancer-bin` | 二进制入口（harness 用它拉起真实进程） |
| `ott-balancer-protocol` | 双端协议类型；`typeshare` 生成 `server/generated.ts`（CI 校验漂移） |
| `ott-common` | 服务发现（Dns/Fly/Manual/Harness）与 WS 升级工具 |
| `ott-collector` | Rocket 服务：轮询各 balancer `/api/state` + 订阅事件流，只观测不参与路由 |
| `harness` / `harness-tests` | 集成测试框架：真实 balancer 进程 + 模拟 monolith/client，覆盖路由/重复加载/重启/区域优先 |

- 选点策略：同 region 优先 → `MinRooms`（默认，按房间数）/ `HashRing`（生产配置，粘性）/ `Random`。
- 房间首访时选点并 `Join`，monolith 自行加载；重复加载用 Redis `load_epoch` 裁决（小者被 `B2MUnload`，大者接管）。
- Monolith 侧：`server/balancer.ts`，`BALANCING_ENABLED=1` 时监听 `BALANCING_PORT`（默认 3002）。
- **生产状态**：本分支的 `deploy/next-compose.yml` 不含 balancer/collector；
  仅在 `docker/with-balancer.docker-compose.yml`（开发/演示）中一起构建运行。
- 运行方式（参考）：`cp env/balancer.example.toml env/balancer.toml` →
  `cargo run -p ott-balancer-bin -- --config env/balancer.toml`；配置也支持 `BALANCER_*` 环境变量。
  v1.2.6 起全局配置用 `OnceLock`，唯一可变的 region 用 `RwLock` 包装。

---

## 10. Cloudflare 预览版（`packages/ott-edge`）

无需服务器的能力子集：Worker 静态资源（`client/dist`，SPA 兜底）+ `/api/*` 路由；
**Durable Object `RoomObject`** 持有房间与 WebSocket（hibernation-safe、`setWebSocketAutoResponse("ping","pong")`），
D1 存身份/房间索引/媒体缓存/限流，`MaintenanceObject` 每 6h 清理过期数据（替代 Cron）。

- 支持：永久/临时房间、公开房间列表、昵称与权限、踢人、MP4/HLS/DASH/自定义清单直链、同步播放/聊天/队列/投票、恢复。
- 不支持：账号登录、跨浏览器身份、DJ 模式、SponsorBlock、undo、语音。
- 限制：每房间 100 连接、每身份 4 连接、每身份 20 房间、单消息 64KB、队列 ≤200 项、媒体解析 2MiB/16 请求。
- 媒体 / 分片 probe 使用 AbortController，期限取 12s 与剩余总预算较小者，完成后清 timer；
  live HLS / 自定义清单保留 isLive，header probe 超时不会丢掉有效 HLS 元数据。
- 配额与费用见 [cloudflare-quotas.zh-CN.md](./cloudflare-quotas.zh-CN.md)，部署见
  [DEPLOYMENT-CLOUDFLARE.md](../DEPLOYMENT-CLOUDFLARE.md)。

---

## 11. 测试、CI 与发布

**测试布局**（截至本文快照）：

| 位置 | 规模 | 运行 |
| --- | --- | --- |
| `server/tests/unit/**` | 65 个 runtime spec + 1 个 type spec | `yarn workspace ott-server test`（需 `NODE_ENV=test` 与已迁移的测试库） |
| `client/tests/unit/**` | 100 个 `*.spec.ts` + 3 个旧 `.spec.js`（skip） | `yarn workspace ott-client test`（脚本已带 `NODE_ENV=test`） |
| `common/tests/unit/**` | 8 个 runtime spec + 1 个 type spec | `yarn workspace ott-common test` |
| `tests/e2e/integration/*.spec.ts` | 9 个 Cypress 用例 | `yarn cy:run`（本地运行，**不在 CI**；含上游英文选择器） |
| `crates/**` | Rust 单元 + harness 集成测试 | `cargo test` |
| `tests/load/*.js` | 7 个 k6 脚本 | `k6 run <script>`（需手动准备房间） |

单文件用例：`yarn workspace ott-server exec vitest run tests/unit/room.spec.ts`（client/common 同理）。

**CI（`.github/workflows/`）**：

- `main.yml`：Node 22/24/26 矩阵；`lint-ci`（Biome + Prettier .vue + 各 workspace lint）；
  `scripts/codegen.sh` 后 `git diff --exit-code` 校验 typeshare 生成物漂移；SQLite 与 Postgres 两条测试路径；
  typos；Grafana 插件兼容检查；新增 Windows / Node 22 的全 workspace 构建与 SQLite / 本地 runtime 测试。
  `docs/**`、`env/**`、`*.md` 的改动不触发。
- `rust.yml`：Rust 1.84，Linux fmt/check/clippy/doc/test；新增 Windows MSVC 的严格静态检查与非 harness 单测。
  Windows 的进程型 harness 仍存在等待问题，明确排除而不宣称已验证。
- `codeql-analysis.yml`：JS/TS 静态分析。
- `publish-image.yml`：推送 `v*` 标签触发；通过 `workflow_call` 复用上述 Node / PostgreSQL / typos /
  Grafana / codegen 与 Rust 全部门禁，只有全部成功后才构建并校验 client revision。
  镜像按本仓 `yarn.lock` 安装服务端生产依赖，核验版本与补丁、非 root 身份和应用目录边界后，
  先推 `ghcr.io/g1157/opentogethertube-cn:<tag>`；只有 push 事件触发的最高稳定 semver 标签、
  且标签 commit 属于默认分支历史时才提升 `:latest`。手动运行、旧标签、预发布或其他分支不提升 latest；
  手动分支构建使用 `edge-<commit前12位>`。`scripts/image-release-policy.mjs` 有纯策略与真实 Git 回归测试。
  `packages: write` 仅给 publish job，复用检查只继承 `contents: read`；构建前获取完整分支与标签历史。

**发布流程**：只提交本批代码与版本记录 → 本地 lint / 测试 / 生产构建通过 → 推送已验证 revision →
打并推 annotated tag → Actions 镜像 → 备份 / 导入同一镜像 / 独立端口验收 / 正式更新与端到端验证。
标签不移动，回退保留旧镜像、数据库与环境备份，实际流程见 [DEPLOYMENT.md](../DEPLOYMENT.md)。
具体发布提交、镜像摘要与上线验收见对应版本的 GitHub Release。
版本记录在[version-notes.zh-CN.md](./version-notes.zh-CN.md)。

---

## 12. 部署与运维

`deploy/init.sh` 生成 `compose.yml`、`backup.sh` 与 `.env`（随机密钥；拒绝覆盖已有 `.env`）。
`deploy/next-compose.yml` 四容器：

| 服务 | 镜像 | 限额 | 说明 |
| --- | --- | --- | --- |
| `migrate` | 应用镜像 | — | 幂等迁移，成功后应用才启动 |
| `ott` | `${OTT_IMAGE}` | 512m / 1 CPU，read_only，cap_drop ALL，仅绑 127.0.0.1 | Node 堆 384MB；健康检查 `/api/status` |
| `postgres` | `postgres:15-bookworm` | 384m | `shared_buffers=64MB`、`max_connections=50` |
| `redis` | `redis:7-alpine` | 192m | AOF everysec、`noeviction`、必须密码 |

容量起点 2 vCPU / 2 GiB（总内存上限约 1.06 GiB）；备份 `backup.sh`（pg_dump，保留 14 份，systemd 定时器模板）；
TLS 可选 Cloudflare Tunnel（`TRUST_PROXY=1`）或裸 IP 的 Caddy + ACME shortlived 证书。详见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

---

## 13. 扩展指南

| 想做什么 | 改动位置 |
| --- | --- |
| 新增媒体源适配器 | `server/services/<name>.ts` 继承 `ServiceAdapter`；`server/infoextractor.ts` 注册；`common/constants.ts` 的 `ALL_VIDEO_SERVICES`；`info_extractor.services` 允许列表；播放器侧如需嵌入则加 `client/src/components/players/*` 并在 `OmniPlayer.vue` 分发；服务端测试放 `server/tests/unit/services/` |
| 新增 WS 消息 | `common/models/messages.ts` 联合类型 → 客户端消息加 `server/ws-schemas.ts` 与 `clientmanager` 路由；服务端消息加 `ServerMessageHandler.vue` 映射与 store mutation |
| 新增房间设置 | `common/models/types.ts` + `zod-schemas.ts` → `server/room.ts`（字段、setter、投影列表、`applySettings`）→ `RoomSettingsForm.vue` → 双语文案 |
| 新增权限 | `common/permissions.ts`（`PERMISSIONS` 位 + 默认授予）；如需回填历史房间，加迁移 |
| 调整同步算法 | `client/src/util/playback-sync.ts` + 单测；同步更新 [playback-sync.zh-CN.md](./playback-sync.zh-CN.md) |
| 新增画质增强档 | `client/src/util/upscale/*` + `stores/settings.ts`（`UPSCALE_MODES`）+ `VideoSettings.vue` + `UpscaleLayer.vue` 选择与降档阶梯 + [video-enhancement.zh-CN.md](./video-enhancement.zh-CN.md) |
| 数据库变更 | `server/migrations/YYYYMMDDHHMMSS-描述.js` + 模型；`yarn db:migrate`；在版本记录中注明 |
| 新增界面语言 | `client/src/locales/<lang>.ts` + `i18n.ts`/语言选择器；参考 [how-to-add-new-language.md](./how-to-add-new-language.md) |
| 修改部署 | `deploy/`（见其 README）；改完在 18080 验收再晋升 |

---

## 14. 关键文件索引

| 关注点 | 入口 |
| --- | --- |
| 同步引擎（服务端） | `server/room.ts`、`server/roommanager.ts`、`common/models/messages.ts`、`common/timestamp.ts` |
| 同步引擎（客户端） | `client/src/util/playback-sync.ts`、`playback-preparation.ts`、`media-recovery.ts`、`media-seek.ts`、`views/Room.vue` |
| 延迟补偿 | `client/src/util/connection-latency.ts`、`client/src/plugins/connection.ts` |
| WS 传输 | `server/websockets.ts`、`server/client.ts`、`server/clientmanager.ts`、`server/ws-schemas.ts` |
| 认证 | `server/auth/*`、`server/usermanager.ts`、`server/admin.ts` |
| 视频源 | `server/infoextractor.ts`、`server/serviceadapter.ts`、`server/services/*`、`server/ffprobe.ts` |
| 播放器与增强 | `client/src/components/players/*`、`client/src/util/upscale/*` |
| 状态与桥接 | `client/src/store.ts`、`client/src/stores/*`、`client/src/components/ServerMessageHandler.vue` |
| 部署 | `deploy/next-compose.yml`、`deploy/next.Dockerfile`、`deploy/init.sh`、`DEPLOYMENT.md` |
| Rust 层 | `crates/ott-balancer`、`crates/ott-balancer-protocol`、`crates/ott-collector`、`crates/harness` |
| Cloudflare 预览版 | `packages/ott-edge/src/*`、`DEPLOYMENT-CLOUDFLARE.md` |

## 15. 文档地图

- **用户向**：`player-interactions`、`playback-sync`、`buffer-gate`、`player-stats`、`voice`、`room-notes`、
  `media-parsing`、`video-enhancement`、`upscale-*`。
- **运维向**：根目录 `DEPLOYMENT.md`、`DEPLOYMENT-CLOUDFLARE.md`、`deployment-options`、`cloudflare-quotas`、`security-headers`。
- **过程记录（已归档）**：`version-notes`（逐版本）、`archive/code-review-2026-09-30` / `archive/fix-report-2026-09-30`（审查与修复）、
  `archive/project-overview-2026-09-21`、`archive/adversarial-review-2026-09-21`、`archive/ux-review-*`。当前索引见 [docs/README.md](./README.md)。
- **上游遗留（英文）**：`architecture.md`（WIP 概述，本文是其详细替代）、`synchronization.md`、`api.yaml`（REST OpenAPI）、
  `config.md`、`db.md`、`custom-media-format.md`、`how-to-deploy.md`、`how-to-add-new-language.md`。
- **AI 向**：[ai-handbook.zh-CN.md](./ai-handbook.zh-CN.md)。
