# 全项目严苛审查报告（2026-10-17，v1.4.6 快照）

**审查对象**：opentogethertube-next（同步观影 + 画质增强 fork）
**代码快照**：`67d26c7`（`docs: record the v1.4.6 batch`，= `origin/main`；审查进行中该批次在并行工作区落地，已纳入复核）
**线上快照**：`https://openvideo.117911.xyz`，`/api/status/version` = `67d26c7…`，与代码快照**完全一致**
**方法**：4 路并行代理（客户端核心 / 服务端核心 / ASS 字幕 / 弹幕 / 房间密码 / 缓冲门）+ 本报告对全部关键路径逐条复读 + 本机实跑三套测试、构建、codegen 漂移检查 + **本地独立实例（PORT=3100）协议级对抗测试（非破坏性，事后已清理探针房间/用户与限流计数）** + 线上只读探测 + 新特性业内对照
**图例**：【实测】本次真实执行、留有输出；【核实】本报告亲读代码确认；【代理】子代理取证（行号可复核）；【推断】未实测

---

## 一、执行摘要

**整体健康度：7 / 10** —— 工程门禁（≈1855 条单测、CI 三工作流全绿、codegen 漂移零差异、SSRF/Schema/安全头体系）仍是这类个人项目的上限水平；v1.4.0 的四个安全 P1 已闭环。但**新功能的"边界校验"没有跟上功能速度**：v1.4.0 之后新增/大改的每一个功能面都带着一个可实测的校验或生命周期缺口。本报告所有高严重度条目均有本地实测或新写探针佐证，非纸面推演。

**最核心的 5 个发现**

1. **WS 设置通道与 REST 完全不等价**（实测）：`queueMode:"banana"`、`visibility:"banana"`、50KB 弹幕源、字符串 offset 被静默接受并广播/持久化；在永久房上直接引发**每秒一次的持久化失败循环**（服务端日志实测 185 行 `Failed to persist permanent room state`，直到进程重启；该房间的设置写入被永久卡死）。
2. **undo 只做了"形状校验"，没做"语义校验"**（实测探针）：伪造的 Skip 撤销可把 `currentSource` 换成任意 `direct` URL（附带 passthrough 的 `src_url`/`thumbnail` 直达全体观众浏览器），绕过队列添加时必经的 `InfoExtract`/ffprobe/SSRF 管线。
3. **房间密码链路 4 处缺陷叠加**：DB 读哈希出错 → **fail-open**（密码房以无密码形态加载）；临时房快照丢哈希（恢复即失防，多实例下可达）；限流 off-by-one + 检查/计数非原子（实测：第 12 次才 429；20 并发全部执行昂贵的 argon2 校验、计数=20）；**客户端 401 刷新不带 Authorization，把登录用户静默换成游客 token**（实测服务端行为 + 代码链），且重放请求使一次错误密码记 2 次（实测：5-6 次 UI 出错即触发 5 分钟封禁）。
4. **房主的权限收紧会被静默回滚**（实测探针）：`permissionsRevision` 只存 Redis 快照、**DB 没有这一列**；永久房空闲卸载（>300s，快照同时被删）后从 DB 冷加载 → revision=0 → `applyPermissionAdditions` 把房主刚移除的 `set-danmaku-source` 重新授给游客。
5. **弹幕上游桥（girigiri）没有负缓存也没有速率限制**（实测）：20 次唯一关键词查询全部直达上游、平均 436ms、无 429/Retry-After；失败/空结果不落缓存可被无限重放。对照被测对象 `danmu_api` 自身（默认搜索缓存 1 分钟、弹幕缓存 5 分钟、可选 Redis）——桥的防护比它所代理的服务还薄。

**纯功能缺陷速览**：shuffle 不广播不落盘（不标脏，实测）；切源时同步遥测被先清零后上报（口径被系统性稀释）；会话级超分降档在下次任意设置写入时泄漏进 localStorage（实测）；DASH 不区分 fatal 且错误文案是 `JSON.stringify(event)`；半开连接无 pong 看门狗（顶部仍显示"已连接"，操作静默进黑洞）；jassub 主线程代码进首屏 vendor（实测 1.13MB 且被 `modulepreload`）。

---

## 二、验证矩阵

| 项目 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| server 测试 | `NODE_ENV=test yarn workspace ott-server test` | ✅ 50 文件 / **808 通过** |
| client 测试 | `yarn workspace ott-client test` | ✅ 85+3skip 文件 / **982 通过 + 24 skip** |
| common 测试 | `yarn workspace ott-common test` | ✅ 9 文件 / **65 通过** |
| codegen 漂移 | `./scripts/codegen.sh` + `git diff` | ✅ 零差异 |
| client 构建 | `yarn workspace ott-client build` | ✅ 成功；⚠️ >500kB chunk 警告 + `src/store.ts` INEFFECTIVE_DYNAMIC_IMPORT |
| CI（GitHub） | `gh run list` | ✅ v1.4.6 与 v1.4.5 批次的 CI / Rust / CodeQL 全部 success；v1.4.6 的 Publish Image 已 success |
| 线上只读 | `curl` | ✅ HTTP→HTTPS；HSTS/CSP-Report-Only/XFO/Permissions-Policy 齐全；版本 = `67d26c7` |
| 对抗性探针 | 详见 §三（本地 3100 实例） | 10 项中 8 项命中，2 项未命中（如实记录） |
| Rust / Cypress / k6 | 未跑 | ⚠️ 本机无 cargo；E2E 不在 CI；k6 从未进 CI（与既往同） |

---

## 三、对抗性测试记录（本地实例，全部非破坏性）

| # | 探针 | 预期（安全） | 实测结果 | 判定 |
| --- | --- | --- | --- | --- |
| A1 | WS `ApplySettingsRequest`：`queueMode:"banana"` + `visibility:"banana"` + 50KB `danmakuSource`（含 `page:"/../../"`、字符串 `offset`）【实测】 | 400/拒绝 | 静默接受；REST 读回 `queueMode:"banana"`、`visibility:"banana"`；永久房进入每秒一次的持久化失败循环（日志 185 行） | ❌ 命中 |
| A2 | 伪造 `UndoRequest`（Skip 撤销，`additional.video = {service:"direct", id:"http://attacker…"}` + `src_url`/`thumbnail`）【实测】 | 拒绝（应过适配器） | `currentSource` 变为注入对象，passthrough 字段完整保留（单测探针输出原文见附录） | ❌ 命中 |
| A3 | 密码串行错误 ×12【实测】 | 第 ≤10 次后 429 | **11×401，第 12 次才 429**；Redis 计数 = 11 | ❌ off-by-one |
| A4 | 密码并发 20 连发【实测】 | 至多 ~10 次执行校验 | **20/20 全部 401（全部执行 argon2）**；计数 = 20 | ❌ 非原子 |
| A5 | 模拟客户端 401 刷新（裸 `/auth/grant` 不带 Authorization）【实测】 | 保持登录身份 | 返回**新的游客 token**：新 token `GET /user/account`=401，原 token=200 | ❌ 降级成立 |
| A6 | TOCTOU：未出示密码的连接在 auth 后 0–15ms 网格发送聊天【实测】 | 窗口内请求被拒 | **62 次尝试 0 命中**：窗口实测 <0.5ms（close 码在 1.5ms→2ms 间由 4004 跳 4006）；冷房间单次攻击（含 join 内 DB 加载）也未命中——请求路径 `mustAlreadyBeLoaded:true` 会在装载中静默丢弃 | ⚪ 未命中（代码路径仍存在，见 P2-7） |
| A7 | `GET /api/room/:name` ×50【实测】 | 有限流 | 50/50 全 200，无 429/限流头 | ❌ 无限流 |
| A8 | `/api/danmaku/girigiri/search` 唯一关键词 ×20【实测】 | 有限流/负缓存 | 全 200、平均 436ms（逐次直达上游）、无 429 | ❌ 无限流+无负缓存 |
| A9 | shuffle 后检查脏标记【实测探针】 | 触发广播 | 顺序已变（v1..v5→v3,v4,v2,v5,v1）但 `dirty=false` | ❌ 不生效 |
| A10 | 权限回滚 / 临时房密码丢失 / 降档泄漏【实测探针】 | — | 三项全部复现（见 P1-4、P1-3b、P2-2） | ❌ 命中 |
| A11 | i18n 覆盖统计【实测】 | — | en=824 键；zh-CN 缺 0；de 缺 514、es 缺 533、fr 缺 587、pt-br 缺 530、ru 缺 515、pirate 缺 769（仅 55 键）；各语言另有 12 个陈旧多余键 | 数据更新 |

---

## 四、严重问题（P1）

### P1-1 WS `ApplySettingsRequest` 业务校验缺口 → 房间状态污染 + 持久化循环（已实测，含永久房）

- **证据**
  - `server/clientmanager.ts:473-493`：WS 路径只检查 `title`（≤254）与 `description`（≤5000）长度；注释自认 "WS requests bypass the REST body schemas"。
  - `server/ws-schemas.ts:63-66`：`request` 信封 `.passthrough()`；REST 侧同一操作走 `common/models/zod-schemas.ts:124-143` 的 `RoomSettingsSchema.strict()`（枚举/结构化/上限齐全）——**两条路径不等价**【核实】。
  - `server/room.ts:2275-2283`：`grants` 若传普通对象会走 `getRoles()` 抛 TypeError（报错路径粗暴，非权限旁路）；`danmakuSource` 默认权限对**游客**开放（v1.3.11 设计）。
  - **实测**（§三 A1）：非法枚举写进房间并被 REST 读回；永久房随后每秒一次 `Error updating room …: Failed to persist permanent room state`（185 行），dirty 集合永不清空——该房间的一切设置持久化被卡死，直到重启。
- **影响**：注册用户（或游客对 danmakuSource）可把任意房间推入"设置不可保存 + 日志刷屏"状态；广播给全部观众（≤256KB 任意形状对象入 Redis/DB/客户端 `Object.assign`，`label` 还能原样进 toast）。
- **修复**：WS 路径复用 `RoomSettingsSchema.strict()`（与 REST 同一 schema）；`applySettings` 对枚举字段做白名单校验；`grants` 只接受 Grants 实例序列化。

### P1-2 `undo` 的语义校验缺口 → 任意 URL 进入 `currentSource`（已实测探针）

- **证据**
  - `server/ws-schemas.ts:69-100`：`undoEventSchema` 只保证形状（service 在白名单、id ≤2048、prevPosition 有限非负），**保留 `.passthrough()`**。
  - `server/room.ts:2011-2029`：Skip 分支把 `request.event.additional.video` **原样**赋给 `currentSource`；全路径无 `InfoExtract`/适配器校验（v1.4.0 修复只到此为止）。
  - **实测探针**：伪造 undo 后 `currentSource = {"service":"direct","id":"http://attacker.example/evil.mp4","src_url":"…alt.mp4","thumbnail":"…track.gif"}`。
- **影响**：默认权限（`playback.skip`）的任意访客可让**全体观众的浏览器**去加载任意 URL（内网探测/请求追踪/注入非法媒体使全房播放器报错）；该源不在队列中，无法被正常流程移除；`src_url` 等 passthrough 字段直达播放器。
- **修复**：`additional.video` 必须通过与 `AddRequest` 相同的适配器校验（或直接 URL 类服务禁止从 undo 进入）；schema 改 `.strict()`。

### P1-3 房间密码链路四连缺陷

1. **DB 读哈希失败 → fail-open**（【核实】）：`server/storage/room.ts:175-186` catch 后 `return null` → `roommanager.ts:200-202` 不区分"无密码/查询失败" → `room-password.ts:63-65` 见 `!passwordHash` 直接放行。DB 抖动期间密码房以无密码形态进入内存与 Redis 快照。
2. **临时房快照丢哈希**（【实测探针】）：`storableProps`（`room.ts:240-265`）不含 `passwordHash`；`roommanager.ts:199-206` 只对永久房回查 DB。带 `preserveRedis` 的卸载/多实例路径下，临时房密码静默消失（单机默认卸载会连快照一起删，触发面较窄，如实标注）。
3. **限流 off-by-one + 非原子**（【实测】§三 A3/A4）：`room-password.ts:103` 判定 `consumedPoints > 10`，而 points 也是 10 → 第 11 次仍执行校验；`api/room.ts:726/735/736` 的"读计数→verify→记失败"非原子 → 20 并发全部通过预检，全部执行 argon2。
4. **客户端 401 刷新降级 + 双记**（【实测/核实】）：`client/src/common-http.ts:33-46` 用**裸 axios 且不带 Authorization** 调 `/auth/grant`；`server/auth/index.ts:106-136` 无 Bearer 时必铸新游客 token → localStorage 被替换（Vuex `users/self` 不更新），登录用户在密码房输错一次密码即被降级为游客且刷新不恢复；同一 401 被拦截器**重放**（`:52-79`），`api/room.ts:735-737` 每次失败各记 1 点 → 一次 UI 出错 = 2 点，约 5-6 次即触发 5 分钟封禁。
- **修复**：`refreshAuthToken` 带上当前 Authorization（或改为服务端可识别的续期端点）；拦截器对 `/room/:name/password` 这类"401 即业务语义"的端点排除重放；限流改为"先 consume 再 verify"；`getRoomPasswordHash` 出错时抛错（fail-closed）；临时房密码入快照。

### P1-4 权限收紧被静默回滚（已实测探针）

- **证据**：`permissionsRevision` 在 Redis 快照内（`room.ts:264`），但 `server/storage/room.ts` 与 `server/models/room.ts` **没有该字段**【核实】；`room.ts:434-438` 对缺失 revision 一律取 0 并 `applyPermissionAdditions`（`common/permissions.ts:441-452` 直接 OR 回 bit）；`roommanager.ts:255-258` 非 commanded 卸载会删快照。
- **实测**：DB 形状加载后，被移除的 `configure-room.set-danmaku-source` 重新出现在 UnregisteredUser 掩码中（revision 被抬到 1）。
- **影响**：房主在权限编辑器里收回游客权限 → 房间空闲 >300s 卸载 → 权限复活；且此后任何 grants 变更会把"复活后的状态"写回 DB，回滚被固化。
- **修复**：`permissionsRevision` 落 DB（加列+迁移）或在 snapshots/DB 两侧都不回填"加法"而改为幂等比对。

### P1-5 弹幕上游桥：无速率限制 + 失败不缓存（已实测）

- **证据**：`server/api/danmaku.ts:254-258`（episodes 仅成功缓存）、`:281-285`（track 仅含 `<d ` 才缓存）；全文件无 `consumeRateLimitPoints`（对照 `api/room.ts:125` 等）【核实】；`server/api.ts:26` 在 passport 之前挂载 → 匿名可用。
- **实测**：20 次唯一关键词全部 200、平均 436ms；`track` 一次入站触发 2 次上游请求（play page + XML），失败可无限重放——上游放大/被封禁面。
- **对照**：`danmu_api`（客户端直连的聚合器）自身默认搜索缓存 1 分钟、弹幕缓存 5 分钟、支持 Redis（其 README 明示）；girigiri 桥的防护弱于被代理对象。
- **修复**：挂 `consumeRateLimitPoints`；失败/空结果做短 TTL 负缓存；track 缓存加响应体大小上限。

### P1-6 队列字幕 URL 无任何服务端守卫（跨用户请求注入）

- **证据**：`server/room.ts:1750-1756/1795-1800/2325-2331` 只校验扩展名（`getSubtitleFormatFromUrl`）；REST 仅 `subtitleUrl: z.string().url()`（`common/models/zod-schemas.ts:56`）、WS 路径连这点都没有（passthrough）；无长度/主机/协议白名单；`manage-queue.add/edit` 默认游客可用。
- **对照自家**：`packages/ott-edge/src/media.ts:32-59` 的 `mediaUrl()` 已有"公网 http(s)、禁 IP/localhost/凭据、≤4096"守卫——monolith 队列字幕没有对齐。
- **影响**：任意访客让**每个观众浏览器**去加载任意 URL（显式时 `subtitleUrl` 还能是被审查为"每个观众发请求"的原语）；同时 `Content-Type: text/x-ssa` 之外的内容走向、清空语义 bug（`""` 提交 400、省略字段静默清除）【代理】。
- **修复**：把 edge 的 `mediaUrl()` 守卫下沉 common 复用；`.strict()` 化；长度上限；清空语义统一（null=清除）。

---

## 五、P2 问题（按主题）

### 5.1 客户端

| # | 位置（v1.4.6） | 问题 | 证据 |
| --- | --- | --- | --- |
| C1 | `views/Room.vue:861-873` vs `:897-908` | 切源时 `playbackSync.reset()` 的 watcher 先创建（flush:sync），`noteSourceChanged→flush()` 后创建 → **遥测被先清零后上报**，`rateWrites/deadlineSeeks/maxDriftSeconds` 系统性为 0（v1.4.3/v1.4.5 诊断数据口径被稀释） | 【核实】两处代码；顺序依赖脆弱 |
| C2 | `stores/settings.ts:359-384` | `UPDATE_TRANSIENT`（降档）后任意一次 `UPDATE`（音量、弹幕开关…）把降档值写进 localStorage → **慢设备用户"我们记错了你的选择"**；实测：volume UPDATE 后 persisted=sharpen/1.5，下次访问从降档档位开始 | 【实测】§三 A10 |
| C3 | `components/players/DashPlayer.vue:418-430` | 不判 `fatal`；错误 `type:"unknown"` + `message: JSON.stringify(event)`（用户看到 dash.js 事件 JSON）；未接入 `media-recovery` 的 1s/3s/6s 阶梯（HLS/Direct 有） | 【核实】对比 HlsPlayer 的 fatal 判断 |
| C4 | `plugins/connection.ts:311-313` | 收到 pong 只记延迟样本，**没有"连续 N 次无 pong 就判死"的看门狗** → 半开连接时顶部仍显示已连接、操作静默失效直到 TCP 自灭（移动网络/NAT 常见） | 【核实】 |
| C5 | `views/Room.vue:1763,1808-1811` | 按住方向键每 150ms 一次房间 seek，`pendingLocalSeek` 计时被反复重置 → 有 `playback.seek` 的观众可让全房间长时间处于"跳转中"；←/J/L 共享同一时间戳会互吞按键 | 【代理】 |
| C6 | `util/upscale/pacing.ts:86-108` + `UpscaleLayer.vue:556-568` | 判据假设窗口内 `mediaTimes` 单调；长按 2× 临时倍速不写 `currentTime`、不触发 `seeking`，会让 `span` 突增 → 误降档（v1.4.4 只校准了 seek/后台） | 【代理】 |
| C7 | `util/danmaku/danmu-api.ts:387-427` | 客户端聚合器缓存**无上限且失败永久缓存**（注释自认）；所有 fetch 无超时（`fetch.ts` 无 AbortSignal）→ 聚合器挂起时弹幕 Promise 永不 settle、无提示；20 个不同视频即 20 条驻留 | 【代理】 |
| C8 | `util/danmaku/danmu-api.ts:212` | 房间弹幕源用 `videoUrl` **精确串等**匹配 → host 大小写/尾斜杠/重定向差异静默失效，回落到各人本机源且无提示 | 【代理】 |
| C9 | `components/players/DirectPlayer.vue:49` + `vite.config.js` manualChunks | `import JASSUB from "jassub"` 为静态导入且不在排除名单 → **jassub 主线程代码进首屏 vendor**（实测 dist：`vendor-*.js` 1.13MB、`index.html` modulepreload，重新构建后复现）——与"重型库懒加载"的仓库规则冲突 | 【实测】 |
| C10 | `DirectPlayer.vue:257-279` | JASSUB 初始化失败被 worker 吞掉后仍 `assVisible=true`（UI 谎报已开启）；失败实例残留导致该片源上 ASS 永久失效；恢复/重试路径不重建实例（CORS 回退后 ASS 消失）；cover/mirror 模式下 jassub 画布与画面错位（jassub 按 contain 计算） | 【代理】（未做浏览器实测） |
| C11 | `components/Notifier.vue:72-88` + `stores/toast.ts:36-40` | 通知队列无上限/无 TTL：只渲染最后 4 条、未渲染的没有计时器，速率超过消耗率时数组无界增长（"另有 N 条"计数会失控） | 【代理】 |
| C12 | `stores/room.ts` SYNC 直连 `Object.assign` | 服务端广播的任意形状对象直达本地 state（与 P1-1 叠加：巨串 label 进 toast/面板） | 【核实】 |

### 5.2 服务端

| # | 位置 | 问题 |
| --- | --- | --- |
| S1 | `api/room.ts:180-206` + `roommanager.getRoom` | `GET /room/:name` 无限流且**懒加载入内存**（实测 50 连发全 200）；游客 token 免费，可让大量永久房常驻并跑 1s tick（含 SponsorBlock/DB 写）【实测+核实】 |
| S2 | `api/room.ts:212-282` | PATCH 房间在 `processUnauthorizedRequest` 之后**额外** `storage.updateRoom(room)`（`:265`）全量写库（与 sync 持久化重复、失败 500 但内存已改），且无速率限制 → 写放大【核实】 |
| S3 | `auth/tokens.ts:7` | `EXPIRATION_TIME_LOGGED_IN = 120*24*60*60*2` → 实际 **240 天**，注释与文档写 120 天；登出只降级不吊销 → 被盗 token 窗口翻倍【核实】 |
| S4 | `auth/index.ts:100-137` | `/grant` 与 `/discord/callback` 是裸 async handler（Express 4 不捕 async）→ Redis 故障/命令超时（5s）时请求永不响应【核实】 |
| S5 | `api/playback.ts:119-139` | 遥测去重表只在 `size>1024` 时清"超过 60s"的条目；60s 窗口内不同 IP 无上限（IPv6 单机可大量地址）→ 内存/CPU 放大【代理】 |
| S6 | `api/user.ts:190-227` | `owned-rooms` 无速率限制、`findAll` 取整行（含 `passwordHash`/`prevQueue`）不投影（响应本身不泄露哈希）【代理】 |
| S7 | `roommanager.ts:172-177,232-237` | 房间查找每次线性遍历 + `toLowerCase()`；`connections` 全局数组线性查找（已知未修）【代理】 |
| S8 | `room.ts:1911-1926` + `clientmanager.ts:448-457` | 每个观众心跳 → `UpdateUser` → 全房广播（已知 O(N²)/Δt 未修）【核实路径】 |
| S9 | `room.ts:2157` | `userRoles[i] = Array.from(set)` 把数组写进 `Map<Role,Set>`（类型违规、本意从未生效的 hidden bug）【代理】 |
| S10 | `room.ts:2039-2042` | 撤销 Add 时 `currentSource=null` 但不停时钟/不重置 isPlaying → 队空时房间卡在"正在播放但无片源"状态【代理】 |
| S11 | `balancer.ts` + `clientmanager.ts:665-675` | balancer 通道仍无鉴权，且其转发**绕过 `clientMessageSchema`**（已知 P1-4 的下游放大；生产未启用）【核实】 |
| S12 | `roommanager.ts:200-202`（见 P1-3b）、`storage/room.ts:175-186`（见 P1-3a） | 密码链的 fail-open/丢失 |

### 5.3 同步与缓冲

- **单人缓冲门 15s/30s 循环**【代理】：`room.ts:641-705` 超时释放 + 冷却 30s 后可再次触发——单个观众（或持续上报 buffering 的客户端）可让单人房陷入"15s 停 / 30s 播"的周期；`OmniPlayer.vue` 的 `@buffering` **无条件**上报（`media-loading-state.ts` 有 paused 守卫、它没有）→ "手动暂停的人也让全房暂停 15s"可达。
- **半开/挂起标签页的状态不复报**【代理】：`WorkaroundPlaybackStatusUpdater.vue` 只发变化值，`visibilitychange` 在移动端被丢弃时不触发 → 服务端 `playerStatus` 永久停留 buffering。
- v1.4.6 的"元素缓冲时暂停纠偏"（`playback-sync.ts` canObserve + bufferedSinceLastSeek 冷却）方向正确，建议后续把"buffering 中的 pendingSeek 仍执行"这一语义写进 `playback-sync.zh-CN.md`（本次已更新文档，未发现回归）。

---

## 六、P3 与工程债

- **i18n 覆盖（实测数字）**：en=824 键、zh-CN 零缺失；**de 缺 514 / es 缺 533 / fr 缺 587 / pt-br 缺 530 / ru 缺 515 / pirate 缺 769（仅 55 键）**；各语言另有 12 个陈旧键。选择器仍声明 8 种语言——"声明但半英文"的不诚实问题比 09-30 时更严重（en 键基增长而翻译未跟）。建议：维护集收敛为 zh-CN+en 或标注覆盖率。
- **文档漂移**：`docs/ai-handbook.zh-CN.md` 快照仍写 v1.4.1+v1.4.2（2026-10-07）：§9 迁移 22 → 实际 **26**；client spec 83 → **88**；§3 行数/计数多处过期；architecture.zh-CN.md 快照停在 v1.2.6。
- **构建**：`src/store.ts` INEFFECTIVE_DYNAMIC_IMPORT（common-http 动态导入它但被 App.vue 等静态导入，vite 明示"dynamic import 不会拆分"）；>500kB chunk 警告（与 Vuetify 全量引入、jassub 进 vendor 同源）。
- **已知未修（复核仍存在）**：console 噪声约 140+ 处/40 文件（代理统计）；`Room.vue` 2690 行（script 约 1640 行）；token TTL 注释错；`userByIdCache` 无淘汰；`redis-mock` 无 TTL/订阅（`server/tests/unit/jest.setup.redis-mock.js`）；Cypress 不在 CI；codecov 仍无上传步骤；ffprobe 负缓存缺失；`/api/room/list` 无分页+取 `prevQueue` 整行。
- **v1.4.6 增量复核**（并行工作区落地）：`playback-sync` buffering 暂停、voice 双点防抖 + join epoch、本地实测时长兜底、聊天字号——代码逻辑自洽，未发现新缺陷；注意 `voice.ts` 的 `joinEpoch` 与 `speakingTimer===null` 守卫都属"时序防御"，建议补一个"getUserMedia 挂起 3s 后 leave"的用例钉住（当前无）。

---

## 七、与既往审查的关系

| 既往条目 | 状态（2026-10-17） |
| --- | --- |
| 09-21 P0-1/P0-2（Redis 写失败/超时） | 已修（09-30）；v1.2.6 起未回归 |
| 09-21 P1-7 / 10-05 P1-1（UndoRequest 透传） | **形状已修（v1.4.0），语义未修** → 本次 P1-2（实测仍可注入 URL） |
| 10-05 P1-2（Private 可见性） | 产品决策落地为"可选房间密码"；`Visibility.Private` 枚举本身仍不与访问控制联动（选"不公开"而不设密码仍可通过链接访问）——维持现状但应明确文档语义 |
| 10-05 P1-3（游客默认权限） | 已收紧 `configure-room.*`/`manage-queue.remove`；`set-danmaku-source`/`set-notes`/`edit` 仍对游客开放（其中 danmakuSource 恰是没有校验的字段 → 与 P1-1 叠加） |
| 10-05 P1-4（balancer 鉴权） | 未修；新增确认 balancer 转发绕过 schema（S11） |
| 10-05 P1-5（tick 串行）/ P1（心跳 O(N²)） | 未修，维持 |
| 10-05 P1-6（lower(name) 索引） | 已修（v1.4.0） |
| 10-05 CI 红灯 | 已修，且 v1.4.5/v1.4.6 批次 CI 全绿 |
| 10-05 S3（edge 双引擎分叉）/ S6（限流缺口） | 未修；本次给限流缺口补充了实测证据与新端点（danmaku 桥） |
| 10-05 T2（redis-mock 假替真） | 未修 |
| improvement-directions 的 12 条主张 | 1.2/1.3（档位两轴、GPU 时间驱动）未做；2.2（能力描述符）未做；1.4 第 1 步（HDR 识别即拒绝）未做；2.3（缓冲门点名/上限自适应）未做；其余同前 |
| 本次新增 | P1-1/P1-2/P1-3/P1-4/P1-5/P1-6，C1-C12、S1-S12，i18n 数字更新、jassub 首屏实测 |

---

## 八、业内对照（每个"可能有问题的功能"别人怎么做）

| 问题域 | 成熟做法 | 本项目的差距与建议 |
| --- | --- | --- |
| WS 消息业务校验 | socket.io + zod/typia 的"事件即 schema"；Shaka/CAF 的 Capabilities 显式接口（improvement-directions §2.2 已引） | REST 与 WS 必须共用同一 schema，而不是"WS 旁路 + 手写长度检查"；把 `RoomSettingsSchema` 变成唯一来源 |
| 客户端回传状态的可信度 | 权威服务端原则：客户端只见证、不回传可执行状态（Syncplay/Jellyfin/CRDT 房间均如此）；事件回滚应由服务端事件日志按 id 重放 | undo 不应信任客户端回传的事件对象；服务端保存事件日志，客户端只发"撤销第 N 条" |
| 房间密码（fail 语义/限流） | Jellyfin/Nextcloud 分享密码；rate-limiter-flexible 官方推荐"consume 先行、block 后拒绝"；密钥校验类操作 fail-closed | 读出错必须拒绝而不是放行；限流先 consume；刷新 token 必须带凭据（OAuth 静默续期的标准形态） |
| 上游桥缓存/限流 | `danmu_api` 默认搜索缓存 1min/弹幕 5min、可 Redis；bilibili 生态普遍长缓存 + 负缓存 | girigiri 桥补负缓存 + 限流 + 大小上限（P1-5） |
| 让观众浏览器加载的 URL | ott-edge 自己的 `mediaUrl()`（公网 http(s)、禁私网/凭据、长度上限）；YouTube/Vimeo 的嵌入 URL 同样有域白名单 | monolith 的字幕/队列 URL 向 edge 对齐（P1-6） |
| ASS 渲染与体积 | JASSUB 是事实标准（libass-wasm 已 3 年未更新）；官方提供 worker/wasm 资产供按需加载 | 主线程 JS 动态化（与 hls.js/three/anime4k 同列排除名单）；失败必须向上暴露而不是静默 |
| 播放器错误恢复 | hls.js 官方"fatal 分类恢复"；dash.js `autoRecover`（improvement-directions §2.5） | DashPlayer 补 fatal 判定 + 接 media-recovery（P2-C3） |
| 半开连接 | WebSocket 心跳的通行做法是"missing pong × N → 主动断开"（ws 官方 `isAlive` 模式，服务端已用；客户端对称实现） | 客户端补 pong 看门狗（P2-C4） |
| i18n 策略 | 成熟产品只声明完全支持的 locale，或标注完成度（improvement-directions §3.3） | 维持 8 语言声明与 37%-93% 缺口并存是不诚实的（本次数字：de 38%…pirate 7%） |
| 通知队列 | 常见模式：cap + TTL + 合并同类 | toast 加容量上限与过期丢弃（P2-C11） |

---

## 九、修复优先级（按 成本 ÷ 收益）

**Tier 0（当天，低风险）**
1. WS 设置通道复用 `RoomSettingsSchema.strict()`（P1-1 的根因；同时顺手删 `clientmanager.ts:473-493` 的手写副本）。
2. `undoEventVideoSchema` 去 `.passthrough()` + `room.undo` 补适配器校验（P1-2）。
3. 房间密码限流改"先 consume 再 verify"；`getRoomPasswordHash` 错误 fail-closed；`refreshAuthToken` 带 Authorization + 拦截器排除 `/password` 重放（P1-3）。
4. 弹幕桥挂 `consumeRateLimitPoints`（10-20 点/次）+ 失败短 TTL 负缓存（P1-5）。
5. 切换 watcher 顺序/把 `reset()` 并入 `noteSourceChanged`（C1）——一行级修复，恢复遥测口径。

**Tier 1（1-2 天）**
6. `permissionsRevision` 落 DB（迁移）（P1-4）。
7. 字幕 URL 守卫（复用 edge mediaUrl 下沉 common）+ 清空语义统一（P1-6）。
8. `UPDATE_TRANSIENT` 字段集隔离（transient 字段单独存放或 persist 时排除降档字段）（C2）。
9. dash fatal 判定 + 错误文案 + 接恢复阶梯（C3）；客户端 pong 看门狗（C4）。
10. jassub 动态 import + manualChunks 排除（C9，可与 C10 的失败上报一起做）。
11. shuffle `markDirty()`（A9，一行）。
12. `lower(name)` 之外的 S1/S2 限流补齐（GET/PATCH room、danmaku、owned-rooms）。

**Tier 2（立项级）**
13. TOCTOU 收口（joinStatus 与密码门的顺序、或"未完成 join 的连接只能 ping/auth"）（A6 代码路径仍存在）。
14. 单人缓冲门循环语义、buffering 上报守卫（5.3）。
15. i18n 策略收敛；handbook/architecture 快照刷新；danmaku 客户端缓存上限+TIMEOUT（C7/C8）。
16. tick 并发化、心跳聚合、Map 化查找（10-05 P1-5 系列，未动）。

---

## 十、局限与未验证项

- **未做浏览器实测**：JASSUB 的静默失败、cover/mirror 错位、弹幕层级（C10 组）为代理取证+代码阅读，未在真实浏览器复现；建议用真片源 + 无 CORS 字幕站做一轮验证。
- **TOCTOU 未演示成功**：代码路径确凿（`client.ts:92` 先置 Joined、`clientmanager.ts:284-299` 后才校验密码、`room.ts:1336-1356` 支持非成员身份），但本机窗口 <0.5ms（62 次扫描 0 命中；冷房间单次攻击亦未命中，因 `mustAlreadyBeLoaded` 在装载期静默丢弃）——生产环境下 Redis/DB 延迟与事件循环负载可能把窗口拉宽，未测。
- **多实例/balancer 路径**：balancer 未启用未联调；"临时房密码丢失"依赖 `preserveRedis` 卸载路径，单机默认不可达（已标注）。
- **Rust / Cypress / k6**：未运行（同既往）。
- **线上**：仅只读探测（版本、响应头），未做任何写入或攻击性验证；全部利用验证均在本地独立实例、非破坏性完成，并已清理探针房间/用户/限流计数。
- 并行工作区在本审查期间推送了 v1.4.6（客户端小批次）：其增量已被纳入复核；若后续有新的并行提交，以工作区代码为准。

> 附：探针的关键输出已浓缩进本报告；原始 JSON 留在本次会话的临时目录（会话结束即清理），所有行号可用 `git show 67d26c7:<path>` 复核。

## Sources

- [ThaUnknown/jassub（libass 的浏览器封装，ASS/SSA 事实标准）](https://github.com/ThaUnknown/jassub)
- [libass-wasm（旧路线，3 年未更新）](https://www.npmjs.com/package/libass-wasm)
- [huangxd-/danmu_api（客户端直连的聚合器；默认搜索缓存 1min、弹幕缓存 5min、支持 Redis）](https://github.com/huangxd-/danmu_api)
