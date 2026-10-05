# 全项目产品级审查报告（2026-10-05）

> **修复进展（2026-10-05 晚）**：P1-1（undo 校验）、P1-3（游客权限收紧）、P1-6（`lower(name)` 索引）、
> CI 红灯（prettier）已修复；P1-2 按产品决策实现为"**可选房间密码**"（见 `docs/room-password.zh-CN.md`）；
> P1-4（balancer 鉴权，本机无 cargo）与 P1-5（tick 并发化）留待专项。

> **审查对象**：`opentogethertube-next`（同步观影 + AI 超分 fork）
> **代码快照**：`bedc362`（= `origin/main` = `origin/feat/upscale-quality`，2026-10-05）
> **线上快照**：`https://openvideo.117911.xyz`，`/api/status/version` 返回 `77815f1`（比代码 tip 少一个 docs 提交）
> **方法**：5 路并行代理（架构 / 安全 / 性能 / 可维护性与测试 / 代码质量）逐文件取证 + 本报告对最高严重度条目亲自复读代码 + 本机实跑质量门禁 + 线上只读探测
> **图例**：`【核实】` 本报告亲读代码/亲跑命令；`【代理】` 子代理取证，行号可直接复核；`【实况】` 线上只读探测；`【推断】` 未实机验证
> **未修改任何代码**（按任务要求；唯一附加物是本文件）

---

## 一、执行摘要

**整体健康度：6.5 / 10** —— 工程文化与测试体系显著高于同体量个人项目（约 1745 条单测全绿、zod 边界校验、SSRF 守卫、安全响应头、codegen 漂移检查、文档沉淀），但**安全默认值**与**单机扩展上限**两处短板，使本项目尚不宜按"开箱即用的公开多租户服务"标准对待；此外房间引擎存在双实现分叉，后续每个修复都要付第二遍成本。

**最核心的 3 个问题**

1. **房间安全模型有 3 个普通访客即可利用的缺口**：`UndoRequest.event` 未校验（房间状态注入 + 把全房间观众的 `<video src>` 导向任意 URL）、`Visibility.Private` 全链路未实施（"私有房间"实际公开）、匿名默认权限允许修改任意房间设置/删队列（`configure-room.*`、`manage-queue`）。
2. **单节点容量与多实例一致性**：1s 全局 tick 串行且内含 SponsorBlock/DB/Redis 阻塞 IO；`lower(name)=lower($1)` 查询用不上索引（每次房间加载全表扫描）；观众心跳触发全房间扇出（单房间 O(N²) 消息量）；多实例无房间租约，两个节点可同时持有一份房间状态互相覆盖。
3. **架构分叉与上帝模块**：`server/room.ts` 2493 行 vs `packages/ott-edge` 第二套房间引擎（2645 行、仅 1 个测试文件）；`client/src/views/Room.vue` 2575 行（`setup()` 约 1413 行）；WS 协议在 3 处定义且内容长度上限互相矛盾（255/254）。

**附注（工程门禁，建议立刻处理）**：`main` 的 CI 当前为红——`lint` job 三个 Node 版本全部在 `yarn run lint-ci` 失败，唯一原因是 `client/src/components/players/DanmakuLayer.vue` 通不过 Prettier（CI 运行 37289925263 日志可查；本机复现同一文件）。修复只需一条命令：`prettier --write client/src/components/players/DanmakuLayer.vue`。这不属于"致命阻塞"，故按要求未直接修改。

**与既往审查的关系**：2026-09-21 对抗式审查的 P0（Redis 写失败、Redis 超时）与部分 P1 已在 09-30 修复报告闭环；但其 **P1-7（UndoRequest 透传）至今仍未修**，本次上升为"已确认可利用"；ffprobe SSRF 为"部分修复"（`RunFfprobe` 策略与 DNS 重绑定留白，有记录）。本报告新增：私有房间未落地、默认权限姿态、balancer 通道鉴权、`lower(name)` 索引缺失、CI 红灯、双引擎分叉等。

---

## 二、验证矩阵（本机实跑 + 线上实测）

| 项目 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 全量构建 | `yarn build`（workspaces foreach） | ✅ 21.5s，全部 workspace 成功；警告：client 有 >500kB chunk、`src/store.ts` 动态导入无效 |
| server 测试 | `NODE_ENV=test yarn workspace ott-server test` | ✅ 49 文件 / **782 通过** / exit 0 |
| common 测试 | `yarn workspace ott-common test` | ✅ 8 文件 / **55 通过** / exit 0 |
| client 测试 | `yarn workspace ott-client test` | ✅ 81 通过 + 3 跳过 / **908 通过 + 24 跳过** / exit 0 |
| typecheck + ESLint（三个 workspace） | `workspace <name> lint-ci` | ✅ 全部 exit 0（server 23 warning / 0 error） |
| biome | `biome ci` | ✅ 578 文件无问题 |
| prettier | `prettier --check "**/*.vue"` | ❌ `client/src/components/players/DanmakuLayer.vue:447-450`（嵌套三元缩进） |
| CI（GitHub） | `gh run list` | ❌ main lint job 红：`77815f1` 失败（file 同上）；本分支 tip 同树，必然同样红 |
| 线上只读探测 | `curl` HEAD/GET | ✅ HTTP 301→HTTPS；HSTS/CSP-Report-Only/XFO/nosniff/Referrer-Policy/Permissions-Policy 全部存在；`/api/status/metrics` → **403**（未暴露）；版本 `77815f1` |
| Rust / Cypress / k6 | 未跑 | ⚠️ 本机无 cargo 缓存（CI rust.yml 为绿）；E2E 不在 CI；load 脚本不在 CI |

---

## 三、严重问题（P0 / P1）

> **未发现 P0**（无远程认证绕过、无 SQL 注入、无可利用 XSS、无 RCE/命令注入——以下结论已由安全代理逐条追踪完整代码路径：【代理】）。
> 以下 P1 中，第 1-3 条为**已确认可利用**（需要普通访客身份，匿名 token 免费签发）；第 4 条为条件可利用；第 5-6 条为已确认的容量/性能缺陷。

### P1-1 `UndoRequest.event` 未校验 → 房间状态注入 + 观众端请求伪造（已确认可利用）【核实】

- **证据**
  - WS 信封只校验 `type` 为数字：`server/ws-schemas.ts:59-66`（`request: z.object({type: ...}).passthrough()`）。
  - `UndoRequest` 在客户端可发白名单内：`server/clientmanager.ts:51-72`；HTTP 路径同样未校验：`server/api/room.ts:365-379`。
  - `undo()` 把 `event.additional.video` 直接赋给 `currentSource`、`prevPosition` 直接当数值用：`server/room.ts:1980-1992`（`SeekRequest` 分支 `:1963-1972` 可注入 `NaN`/对象）。
  - 客户端无校验地应用并渲染：`client/src/stores/room.ts:90-93`（`Object.assign`）、`client/src/components/players/OmniPlayer.vue:133`、`DirectPlayer.vue:36-40`。
- **影响**：房间内任意观众（默认权限即满足）可把房间 `currentSource` 替换为任意 URL 并广播/持久化（`prevQueue` 写入 Redis 与 DB）→ 所有观众的浏览器对该 URL 发起请求（可探测观众内网：`<video src>`、`<track src>`）；`playbackPosition` 可置坏使同步崩坏。
- **修复**：给 `UndoRequest` 加 zod（`event.request.type` 白名单 + `additional.video` 走 `VideoIdSchema` + `prevPosition: z.number().finite().min(0)`），并在赋值前过 `InfoExtract.getServiceAdapter(video.service)` 校验。
- **历史**：2026-09-21 对抗式审查 P1-7 已报，未修。

### P1-2 `Visibility.Private` 全链路未实施（已确认可利用）【核实】

- **证据**：`GET /api/room/:name` 只要任意 token 就返回房间全部字段，不看 visibility：`server/api/room.ts:162-188`；WS join 同样不判断：`server/clientmanager.ts:280-291`。`Visibility.Private` 只出现在模型枚举校验（`server/models/room.ts:85`）与列表过滤（`server/api/room.ts:77-79`）。
- **影响**：匿名访客可读取任意"私有"房间的队列、成员名单，并直接加入同步全部状态——"私有"语义完全不生效。
- **修复**：`getRoom`（REST）与 `joinAuthenticatedClient`（WS）判断 `Private` 时要求房主/显式授权，否则按房间不存在处理。

### P1-3 匿名默认权限过大（已确认可利用，属上游设计遗留）【核实】

- **证据**：`defaultPermissions()` 给 `UnregisteredUser` 授予 `playback.*`、`manage-queue`（含 remove）、`chat`、`configure-room.*`：`common/permissions.ts:176-200`；`PATCH /api/room/:name` 只要求 token（`server/api/room.ts:194-247`），权限检查按访客角色放行（`server/room.ts:2199-2203`）。
- **影响**：任意匿名访客可改任意公开房间的标题/简介/可见性/队列模式/便签/弹幕源，可删他人队列项——对公开部署是明显的滥用面。
- **修复**：把 `configure-room.*`、`manage-queue.remove` 的默认 `minRole` 提升为 `RegisteredUser`（或在建房时按 owner 生成收紧模板）。属产品决策，建议至少给"仅房主可配置"模板。

### P1-4 Balancer 通道无鉴权 + `clientId` 可伪造 → 可冒充任意房间成员（条件可利用）【核实】

- **证据**：balancer WS 服务端 `wss.on("connection")` 不做任何鉴权：`server/balancer.ts:33-40`；`join` 直接采用对端指定的 `msg.client` 作为客户端 id：`server/clientmanager.ts:635-643`；`client_msg` 按 `msg.client_id` 找客户端转发：`:655-665`；身份推导**优先**用 `clientId` 命中房间成员角色：`server/room.ts:1289-1302`。成员 id 本就通过 room users 广播（`server/room.ts:676-689`）。
- **影响**：能访问 3002 端口者可用受害者的 client id 发请求 → 命中房主角色 → 改权限/踢人/卸房。**条件**：需要开启 balancing 且端口可达；本仓库参考生产配置开启（`deploy/ott-prod.toml:15-16`），但 `deploy/next-compose.yml` 未部署 balancer、只发布 8080 到回环（`:52-55`），线上实际暴露面待核。
- **修复**：balancer 握手加共享密钥鉴权；`join` 的 client id 强制由服务端生成；禁止 `client_msg` 覆盖已存在 client；监听绑定限制到私网。

### P1-5 1s 全局 tick 串行且内含阻塞 IO（已确认，决定单节点容量上限）【核实】

- **证据**：`setInterval(..., 1000)` → `for (const room of [...rooms]) { await room.update(); await room.sync(); }`：`server/roommanager.ts:52-55,101-120`；tick 内直接 `await` SponsorBlock 网络请求（5s 超时）：`server/room.ts:1014-1018` + `server/sponsorblock.ts:39-50`；脏设置触发 `await` Postgres UPDATE：`server/room.ts:1199-1204`。
- **影响**：总耗时 = Σ(每房 IO)；数百活跃房间 + 任一慢响应 → 本轮被跳过（有单飞守卫与 `ott_room_manager_update_skipped_total` 指标），**全节点**所有房间同步延迟抬升。
- **修复**：房间级受限并发池；SponsorBlock/DB 写改为不阻塞 tick 的后台任务（已有 dirty 重试机制可复用）。
- **历史**：09-30 修复报告 P1-3 已加单飞+耗时直方图，明确保留"移出关键路径"未做（风险>收益）。本报告认为该项应重新立项，它是房间数天花板的主因。

### P1-6 `lower(name)=lower($1)` 查询无法使用索引 → Rooms 全表扫描（已确认，性价比最高的一次修复）【核实】

- **证据**：`Sequelize.where(fn("lower", col("name")), fn("lower", roomName))`：`server/storage/room.ts:32-39`；命中 `getRoomByName`（`:41`，每次从 DB 加载房间）、`isRoomNameTaken`（`:64`，建房/改名/空写检查）、`updateRoom`（`:111`）、`deleteRoom`（`:123`）；迁移只给 `name` 唯一约束：`server/migrations/20190830172621-create-room.js:13-18`（函数包装后不可用）；Rooms 行很宽（`prevQueue` JSONB）。
- **修复**：新增迁移 `CREATE INDEX rooms_lower_name ON "Rooms" (lower(name));`（或加规范化 `nameLower` 唯一列）。一行 DDL，立刻消除最热 DB 路径的顺序扫描。

---

## 四、优化建议（P2 / P3）

> 分组呈现；每条含位置与一行建议。标记了【代理】的行号均可直接复核。

### 4.1 安全与配置（P2）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| S1 | `server/ffprobe.ts:357-379`；`server/services/direct.ts` | `RunFfprobe`（生产默认策略）只校验入口 URL，HLS/多段容器内部子资源由 ffprobe 自行请求（盲 SSRF 探内网）；DNS 重绑定 TOCTOU 仍在 | 解析 manifest 子资源逐个过守卫，或改用代理出口；至少对探测结果加出口限速 |
| S2 | `deploy/next-compose.yml:15`；`server/app.ts:114-129` | `FORCE_INSECURE_COOKIES` 默认 `true`，生产 Cookie 无 `Secure` | 线上入口已是 Cloudflare→Caddy HTTPS；设置 `TRUST_PROXY=2` 并去掉该开关 |
| S3 | `packages/ott-edge/src/room-state.ts` vs `server/room.ts` | 第二套房间引擎（权限/投票/位置外推/脏字段全部重实现），任何修复需双端落地；`edge.test.mjs` 单文件覆盖 2645 行实现 | 把纯规则下沉 `common/room-rules.ts`；Edge 版明确标注"实验" |
| S4 | `server/app.ts:277`；`:257-266` | `main()` 无 `.catch()`；仅安装 `unhandledRejection` 日志（启动期 rejection 变"进程在、服务不可用"僵尸态） | 补 `uncaughtException` 处理器 + `main().catch(shutdown)` |
| S5 | `server/usermanager.ts:352-378` | 登出不清 Cookie、不吊销 token（只降级为访客） | `res.clearCookie()` + `tokens.revoke()` |

### 4.2 安全与配置（P3）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| S6 | `server/api/room.ts:381-418,365-379`；`api/room.ts:53`；`api/danmaku.ts:214-294` | vote/undo/改名/房间列表/弹幕检索无速率限制 | 统一复用 `consumeRateLimitPoints` |
| S7 | `server/api/room.ts:125-160` | 匿名可创建**永久**房间（囤名/占库） | 永久房间要求登录，限每账号数量 |
| S8 | `server/services/reddit.ts:92-99`（`host.endsWith("reddit.com")`）；youtube/googledrive 同类 | `evilreddit.com` 可通过白名单 | 改为 `=== "reddit.com" || endsWith(".reddit.com")` |
| S9 | `server/usermanager.ts:506-509` | 开发环境 `password === "1"` 直通密码策略 | 删除或改为显式配置开关 |
| S10 | `server/security-headers.ts:100-101` | 仅 `Content-Security-Policy-Report-Only`，无强制 CSP | 收集期后上线 `script-src 'self'`（`index.html` 无内联脚本，条件具备） |
| S11 | `docs/security-headers.zh-CN.md:9` vs `security-headers.ts:98` | 文档写"禁用 microphone"，实现为 `microphone=(self)`（语音需要） | 更正文档 |
| S12 | `server/api/data.ts:19-36` | `previewAdd` 无 token、`input` 无长度上限（worker 侧有） | 复用 zod schema + token 要求 |

### 4.3 性能与容量（P2）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| P1 | `server/room.ts:1878-1893` → `clientmanager.ts:703-741` | 每个观众心跳触发一次全房间广播 → 单房间 O(N²)/Δt（N=100、3s 间隔 ≈ 3.3k msg/s） | 用户状态更新聚合进 1s sync tick 增量批处理 |
| P2 | `client/src/plugins/vuetify.ts:1-5` | `import * as components/directives` + 全量样式，tree-shaking 失效（产物体积证据：vendor chunk 含未使用组件，构建告警 >500kB） | 交给 `vite-plugin-vuetify` autoImport，按需引入 |
| P3 | `server/clientmanager.ts:74,803-822,92-107` | `connections` 全局数组线性查找（每条 WS 消息、每个 WebRTC signal） | 改 `Map<ClientId, Client>` + token 索引 |
| P4 | `server/roommanager.ts:166-171,222-228` | 房间查找每次遍历全部已加载房间且循环内 `toLowerCase()` | 维护 `Map<lowerName, Room>` |
| P5 | `server/storage/room.ts:15-29`；`api/room.ts:69,92` | `/api/room/list` 无分页且取出每房 `prevQueue` JSONB；响应无缓存 | 分页 + 投影去掉 `prevQueue` |
| P6 | `server/ffprobe.ts:380-427` | ffprobe 无并发上限、失败/超时无负缓存（重复点击反复 spawn 20s） | 进程内 LRU（含负结果）+ 信号量 |
| P7 | `server/services/youtube.ts:358,376` | 频道→上传列表 ID 缓存无 TTL（永久驻留） | 加 `EX` |
| P8 | `server/infoextractor.ts:154-170` | 搜索缓存键由用户输入拼接、无键数上限（TTL 24h） | 键归一化/hash + 全局上限 |
| P9 | `server/room.ts:1127-1136,1182-1204` | 每次队列变更全量深拷贝写 Postgres `prevQueue`（∝队列长度） | 上限或仅存 Redis |
| P10 | `server/websockets.ts:7` | 无 `perMessageDeflate`；全站无 HTTP `compression` | 按阈值开压缩 |
| P11 | `server/usermanager.ts:812-823` | `userByIdCache` 无淘汰、带密码材料常驻 | 读取时删过期 + 容量上限 |
| P12 | `server/roommanager.ts:159-209` | 多实例无房间租约（两节点可同时载入同名房间互相覆盖） | Redis `SET room-owner NX PX` 租约 |
| P13 | `server/models/user.ts:64-67`；`migrations/20200620171123...` | `Users.discordId`、`Rooms.ownerId` 无索引 | 补索引 |
| P14 | `client/src/views/Room.vue:955-956` 等 | 4Hz 定时驱动 5 个 tick + 多个 250ms 定时器，页面隐藏仍跑 | `document.hidden` 暂停 + `timeupdate` 驱动 |

### 4.4 性能与容量（P3）

`server/redisclient.ts:54-85`（每条 Redis 命令包 `Promise.race`+5s 定时器）；`server/api.ts:28-45`+`app.ts:163-174`+`auth/index.ts:75`（已认证 REST 每请求 3 次 Redis 往返，可进程内短 TTL 缓存）；`server/room.ts:1061-1070`（debounce 无 `maxWait`，去抖饥饿）；`server/roommanager.ts:248`（`room-sync:` 死键只删不写）；`server/room.ts:1002-1012`（Vote 模式每秒克隆+深比较全队列）；`server/app.ts:202-212`（SPA 路由每请求磁盘读 index.html）。

### 4.5 架构与耦合（P2）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| A1 | `server/room.ts:277-2493` | God module：状态/投影/权限/分发/抓取/缓冲门/便签/投票/首帧全在一类；`processRequest` 每次请求重建 15 个 `Map` + 23 项 `Record`（`:1350-1415`） | 表提升为模块级常量；按域拆 `room/handlers/*` |
| A2 | `client/src/views/Room.vue:537-1845`（`setup()` ≈1413 行）+ 620 行 SCSS | 前端 God 组件 | 抽 `useRoomPlayback()/useRoomVoice()/useRoomLayout()` |
| A3 | `common/models/zod-schemas.ts:35` (max 255) vs `:127` (max 254) vs `server/clientmanager.ts:468` (>254) | title 上限三处不一致：REST 创建可 255，之后 patch/WS 拒绝保存 | 统一共享常量，三处引用同一 schema |
| A4 | `server/room.ts:89` ⇄ `server/roommanager.ts:1` | 真实 ES 模块循环依赖（Room 反向持有 manager） | 事件/回调端口注入 |
| A5 | `common/models/types.ts:1,48`；`client/src/components/players/DirectPlayer.vue:55,428` | common 泄漏 express-session 类型；zod schema 运行时进客户端且 `client` 未声明 zod 依赖 | 平台类型上移 server；客户端自写轻量校验或显式声明 |
| A6 | `server/balancer.ts:329-358,436`；`crates/ott-balancer-protocol/src/monolith.rs:232-273` | 手写校验 `default: return false` 静默丢弃新消息；本地 `GossipRoom` 与生成物同名不同构 | 生成类型 + 穷尽 switch |
| A7 | `deploy/next.Dockerfile:9-15`；`docs/architecture.zh-CN.md:299` | 生产镜像未 COPY `deploy/base.toml`/`env/`，实际默认值来自上游基础镜像；文档称 env/toml 生效 → 配置来源分裂（`trust_proxy` 等安全相关默认值） | 显式 COPY 或改纯环境变量并修文档【推断：镜像内部未实机验证】 |

### 4.6 架构与耦合（P3）

`server/` 顶层 33 个 `.ts` 平铺（新代码按域建目录）；`server/usermanager.ts` 同时是路由+passport+密码策略+缓存+事件总线；Redis 键名散落 10+ 模块（建 `redis-keys.ts`）；`server/room.ts:1523-1528` 服务能力判定硬编码在房间域模型；`common/typeutils.ts` 类型体操大部分零引用；`packages/ott-vis/types.ts` 第三份协议手写镜像（单向 `toMatchTypeOf` 测试形同虚设）。

### 4.7 可维护性与测试（P1→建议优先 / P2）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| T1 | `server/auth/index.ts`、`server/auth/tokens.ts` | **零直接单测**（测试中仅被 `vi.spyOn` 整体 mock）；登录/授权/token 轮换只靠不在 CI 的 Cypress | 补 supertest spec（TTL、轮换、guest vs 登录） |
| T2 | `server/tests/unit/jest.setup.redis-mock.js:2-6` | `redis-mock@0.56.3` 顶替真实 Redis（`subscribe` no-op、`duplicate` 返回自身）→ Pub/Sub、TTL 完全没测；CI 起的 Redis 闲置 | 真 Redis 集成 spec |
| T3 | `.github/workflows/main.yml`；`codecov.yml` | Cypress E2E 9 个 spec 不在 CI；覆盖率门禁是"影子配置"（无上传步骤） | 加 e2e job（或 nightly）+ codecov-action / vitest thresholds |
| T4 | `server/storage/room.ts:58-61`；`server/usermanager.ts:753-755` | log-only catch 把 DB 故障伪装成"房间不存在"/"无需合并" | 区分 not-found 与查询错误 |
| T5 | `client/src`（无全局兜底）；`connection.ts:319-321` | 客户端无 `window.onerror`/Vue errorHandler；消息分发异常静默 | 加全局错误上报 |
| T6 | `server/package.json`（express 4 / ws 7 / ts-node loader / node-abort-controller 死依赖）；`patches/rate-limiter-flexible+2.4.1.patch`（依赖范围 `^2.2.1`） | 高风险版本钉子 + 补丁版本漂移风险 | 排期升级，补丁改为 exports 深路径 |

### 4.8 可维护性与测试（P3）

`client/tests/unit/{Chat,LogInForm,Room}.spec.js` 三个 `describe.skip` 死测试（Vuetify2 遗留）；`client/tests/e2e/` 空壳；Docker 构建无 PR 冒烟；cargo bench 从不运行；依赖审计（cargo audit / yarn npm audit）缺失；`Room.vue` 编排中枢无测试（仅 `Room.spec.js:63` skip）。

### 4.9 代码质量与规范（P2）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| Q1 | `client/src` 共 **134 处 `console.*`**（`DashPlayer.vue` 33、`HlsPlayer.vue` 14、`connection.ts` 含热路径 `console.log`） | 遗留调试输出，`no-console` 被关闭无兜底 | 统一 logger（DEBUG 开关） |
| Q2 | `common/constants.ts` 缺失：内容上限（254/5000/300）、限流点数（50/×4/5）、同步阈值散落 | 重复常量 | 收敛共享常量 |
| Q3 | `server/room.ts:2144-2262`（119 行 `applySettings`）、`ffprobe.ts:433`（120 行）等 10+ 个 90-120 行方法 | 长函数 | 随拆分顺手收敛 |
| Q4 | `clientmanager.ts:462-482` 手写长度校验（与 zod 双份） | 协议校验三处定义 | 统一到共享 schema |

### 4.10 代码质量与规范（P3）

死代码：`client/src/util/roomapi.ts:77-82`（`throw "Not yet implemented"`）、`client/src/models/vuex.ts`、`client/src/styleProxy.js`、`common/result.ts:49-52` 等零引用导出、【代理】`server/room.ts:396-408` 死分支/`:1849-1851` `i--` 后立即 break；注释：`server/usermanager.ts:156,705`、`server/room.ts:1961` 情绪化注释，`server/ffprobe.ts:9` 过期 FIXME；`server/express-types.d.ts:1,3` 缺 `.js` 扩展（全仓唯一违规）；`client/src/util/playerHelper.js` camelCase 无类型文件;`品` 命名漂移 `danmu-api.ts`；魔法数（`playback-sync.ts:172,267`、`Room.vue:956`）缺乏具名常量。

### 4.11 文档与工具链（P3）

`docs/ai-handbook.zh-CN.md` 数字漂移：迁移 22→**24**、server 测试 47→**48**、client 69→**81**、k6 7→6；§6.1 API 表缺 `/api/danmaku`；`Room.vue` 行数 2468→2575。双 linter/双 formatter 并行（Biome 2.4 + ESLint 8 EOL + prettier 2，6 个项目级 `.eslintrc` + 1 个孤儿根配置，规则 ~90% 复制）；`rust.yml` 无 `paths-ignore`（改 docs 也全量跑 Rust）。

---

## 五、重构优先级清单（按"改造成本 vs 收益"排序）

### Tier 0 —— 今天就能做（<1 小时，风险≈0）

1. `prettier --write` `DanmakuLayer.vue` → **恢复 main CI 绿**（唯一红灯）。
2. `Rooms (lower(name))` 表达式索引迁移 → 消除最热 DB 路径全表扫描（P1-6）。
3. 统一 title/description 长度常量，删 `clientmanager.ts:462-482` 手写副本（顺带修 255/254 不一致，P2-A3/Q2/Q4）。
4. 删死代码（Q 节 4.10 清单）+ `node-abort-controller` 死依赖。
5. 刷新 handbook 的迁移/测试计数与 `/api/danmaku` API 行（4.11）。

### Tier 1 —— 1~2 天（收益直接）

6. `UndoRequest` zod 化 + 视频适配器校验（P1-1，安全榜首）。
7. `Visibility.Private` 在 REST + WS 全链路落地（P1-2）。
8. 默认权限收紧：`configure-room.*`/`manage-queue.remove` → `RegisteredUser`（P1-3，产品决策，建议做）。
9. balancer 握手加共享密钥 + client id 服务端生成（P1-4，若确定不启用 balancing 则在文档标注"实验"）。
10. `getClient`/`getClientByToken`/`roommanager.getRoom` 改 Map（4.3-P3/P4）。
11. 心跳聚合进 tick（4.3-P1）；`/api/room/list` 分页 + 去 `prevQueue`（4.3-P5）。
12. `main().catch` + `uncaughtException` 处理器（4.1-S4）。

### Tier 2 —— 数天（结构性）

13. tick 并发化 + SponsorBlock/DB 写移出关键路径（P1-5，容量天花板）。
14. `room.ts` 请求分发拆分 + 两张表模块级化（4.5-A1）；`Room.vue setup()` 拆 composable（4.5-A2）。
15. Vuetify autoImport + chunk 拆分（4.3-P2）；客户端 134 处 console 统一 logger（4.9-Q1）。
16. ffprobe 负缓存 + 并发信号量（4.3-P6）；YouTube 缓存 TTL（P7）；搜索键上限（P8）。
17. 真 Redis 集成测试 + auth 路由/token 单测（4.7-T1/T2）；CI 补 Cypress 与覆盖率门禁（T3）。
18. Edge 与 monolith 共享 `common/room-rules.ts`（4.1-S3），阻断继续分叉。

### Tier 3 —— 立项级（跨迭代）

19. 多实例房间租约 + 跨节点 pub/sub（4.3-P12；决定水平扩展能力）。
20. Rust 协议单一来源（生成类型穷尽校验、去手写镜像，4.5-A6）；监控栈与 collector 的部署归属决策。
21. 配置来源统一（镜像内 env/ 唯一来源，4.5-A7）；旧依赖升级（express5/ws8/tsx loader）。

---

## 六、实况验证记录（2026-10-05，线上只读探测）

- `https://openvideo.117911.xyz/` → 200，`via: 1.1 Caddy`（Cloudflare 回源，cf-ray SIN）。
- HTTP → HTTPS：`301 Location: https://…`。
- 安全头齐全：`strict-transport-security: max-age=31536000; includeSubDomains`、`content-security-policy-report-only: base-uri 'self'; object-src 'none'; frame-ancestors 'self'; report-uri /api/csp-report`、`x-frame-options: SAMEORIGIN`、`x-content-type-options: nosniff`、`referrer-policy: strict-origin-when-cross-origin`、`permissions-policy: camera=(), microphone=(self), geolocation=()`。
- `/api/status` → 200（healthcheck 语义有效）；`/api/status/version` → `{"revision":"77815f1…"}`（与 main tip 差一个 docs 提交）。
- `/api/status/metrics` → **403**（trust proxy 判定下的本地豁免未被滥用；`isLocalOrAdmin` 逻辑在 `server/api/status.ts:25-31`）。
- 未做任何写操作/攻击性验证（未实际利用文中任何漏洞）。

---

## 七、与同类开源项目的对照

| 项目 | 定位 | 相对本项目的强/弱 |
| --- | --- | --- |
| **CyTube** | 老牌开源自托管同步频道（JS/Node） | 运维与权限模型更成熟（管理员/房主体系）；本项目在同源适配器与弹幕渲染更丰富 |
| **SyncTube / SyncTV** | 轻量同步室（Node） | 架构更简单、上手快；本项目同步引擎（bend/seek 阶梯、首帧对齐、缓冲门）明显更细但复杂度高 |
| **Syncplay** | 桌面播放器同步（P2P，无网页） | 精确控制更强、无需服务器算力；本项目胜在浏览器零安装与消息/语音/弹幕整合 |
| **Teleparty / Watch2Gether / Kosmi** | 闭源 SaaS | 本项目可自托管、可接自有源与超分；对方在规模化容错与商业化运维积累不可比 |
| **Jellyfin + SyncPlay 插件** | 自有媒体库同步 | 有原生播放器与媒体库；本项目支持"任意网页源 + AI 超分"是差异化 |

**结论**：本项目在"同源（openvideo）= 同步 + 聊天 + 语音 + AI 超分"的组合上没有直接对位的开源竞品；它需要补的课不是功能，而是**安全默认值**（对照 CyTube 的角色体系）与**单机/多机运维成熟度**（对照 Syncplay 的无状态与 CyTube 的长期运营经验）。

---

## 八、局限与未验证项

- **Rust**：本机无 cargo 缓存未跑（`rust.yml` 在 CI 为绿）；balancer/collector 不在本 fork 生产 compose 中，未做端到端协议联调。
- **Cypress / k6**：未运行（前者不在 CI，后者从未进 CI）。
- **压测**：性能结论来自代码取证与量级推算（【代理】+【推断】），未做实机压测；`ott_room_manager_update_duration_seconds` 直方图可直接用于后续量化。
- **镜像内部**：`next.Dockerfile` 配置来源分裂属【推断】（未 docker 实机查看基础镜像 `/app/env`）。
- **攻击性验证**：安全发现全部为只读代码路径追踪；未对线上或本地实例发起任何利用请求。P1-1/P1-2/P1-3 建议在修复前于本地环境写 PoC 回归测试。

---

## 附：与既有审查文档的关系

| 既往条目 | 状态（2026-10-05） |
| --- | --- |
| 09-21 P0-1 Redis 写失败未捕获 / P0-2 Redis 超时 / P1-1 ffprobe 重定向 / P1-2 登录限流 / P1-4 stall 竞速 / P1-8 Redis 不可达 | 09-30 修复报告：已修/部分修 |
| 09-21 **P1-7 UndoRequest `additional` 透传** | **仍未修**，本次升级为 P1-1（已确认可利用 + 观众端 SSRF 面） |
| 09-21 P1-5 1s tick 头阻塞 | 部分修复（单飞+指标）；根因保留，本次 P1-5 |
| 09-30 §四.2 ffprobe SSRF | 部分修复（axios 路径已修）；`RunFfprobe`/DNS 重绑定留白，本次 4.1-S1 |
| 09-30 待复核「登录后 socket 未重鉴权」 | 备注为既有设计，未变 |
| 本次新增 | 私有房间、默认权限姿态、balancer 鉴权、`lower(name)` 索引、CI 红灯、双引擎分叉、255/254 不一致、134 处 console 等 |

> 行号均可通过 `git show bedc362:<path>` 复核；线上数据可用 `curl -s https://openvideo.117911.xyz/api/status/version` 复核。
