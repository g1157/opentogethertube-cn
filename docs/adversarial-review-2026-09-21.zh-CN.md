# 2026-09-21 对抗式审查：从第一性原理到可执行证据

对本仓库（OpenTogetherTube 中文 fork，`feat/upscale-quality` @ `0ff882c`）与其线上实例
`https://openvideo.117911.xyz` 的一次全项目对抗式（红队）审查。

**审查对象与版本对应**

- 代码：工作区 `feat/upscale-quality`（`0ff882c`）。文中行号以此为快照，工作区继续改动后可能漂移。
- 线上：`GET /api/status/version` 返回 `66ff39201a…`（即 `66ff392`，v1.1.5 发布提交，
  只比工作区 HEAD 少一个 docs 提交，源码一致）。行号可用 `git show 66ff392:<路径>` 复核。

**方法（对抗式立场）**

- 默认系统有缺陷：每条结论先构造**触发/攻击路径**，再给**反方最强辩护**（steel-man），最后**裁决**
  （成立 / 部分成立 / 不成立 / 需实况验证）。证伪的担忧同样记录（见「被证伪的担忧」一节）——
  对抗式审查的产出不是"问题越多越好"，而是**经过证伪幸存下来的结论**。
- 四路专项深读（安全攻击面、同步引擎、文档漂移、可靠性与容量）＋ 本人对全部 P0/P1 结论逐条复核
  引用位置 + 对线上实例做非破坏性实况探测。未实测的推断一律显式标注。

**证据级别**

- 「实测确认」：对线上实例或可复现证据的实测；
- 「代码证实」：本人逐行复核过引用位置；
- 「代码分析」：专项深读代理给出（附代码摘录），本人抽查未发现偏差；
- 「推演」：基于代码行为的推断，未实测（附置信度）。

**一句话结论**

同步引擎的骨架（服务端权威时钟 + 延迟补偿 + 分层纠偏）是同类开源里最完备的设计之一，
本轮**没有找到能击穿同步正确性的根性缺陷**；真正的红线不在算法，而在**故障传播链**：
Redis 写失败可以升级为进程崩溃循环、事件循环的头阻塞没有自愈手段、两条自愈路径
（缓冲门早释、stall 恢复阶梯）依赖没有契约保证的播放器行为。安全面上，最锐利的一条是
**匿名可达的重定向 SSRF**；最能体现"保护写了但没接线"的是**登录爆破限流器是死代码**。

---

## 0. 第一性原理：这个系统到底在解决什么

**根本问题**：让 N 个异构、互不可信、网络条件各异的浏览器，围绕一条**不被本系统控制**的媒体时间轴，
达成观众感知一致的播放。

**不可约约束**（决定了架构只能这么长）：

1. **播放器控制力分层**：第三方 iframe（YouTube/Vimeo/PeerTube/Bilibili）只能 seek、不能改速率；
   原生 `<video>`（Direct/HLS/DASH）可以改速率。→ 纠偏必须分层（rate-bend → hard seek）。
2. **网络延迟不对称、抖动、不可直接测量**：只能估计（本项目取 min(RTT)/2，与 Syncplay 的
   forward-delay 补偿同源，`docs/playback-sync.zh-CN.md`）。
3. **客户端时钟不可信**：墙钟可跳变、可被 NTP 阶跃；媒体时钟与墙钟是两个时钟。
4. **浏览器策略**：autoplay 拦截、后台节流、解码能力差异（增强层还要 WebGPU）。
5. **第三方源可用性**：YouTube 配额、反爬、CORS、跨境网络（国内出口访问海外源超时是常态，
   见 `docs/ux-review-2026-09-15.zh-CN.md` 的实测）。

**架构映射**：服务端维护权威房间时钟（锚点 + 位置 + 速度，`server/room.ts`），脏属性节流广播
（50ms debounce + 1s tick）；客户端以 `min(RTT)/2` 补偿锚定（`client/src/util/connection-latency.ts`），
每 250ms 对目标位置做分层纠偏（`client/src/util/playback-sync.ts`：小漂移 rate-bend，大漂移 seek）。
**方向正确**，与 Syncplay / Jellyfin SyncPlay 属同一设计家族。

**对承重假设的判决**（本审查的核心）：

| 承重假设 | 判决 | 依据 |
| --- | --- | --- |
| 锚点 + 外推 + 延迟补偿可达成感知同步 | ✅ 成立 | bend 在原生播放器上可做到 <300ms 无感；与 Syncplay 同构 |
| 两条自愈路径（缓冲门、stall 恢复）与纠偏机制自洽 | ⚠️ 不成立 | P1-3、P1-4：互斥缺陷，依赖没有契约的播放器行为 |
| 房间状态输入可信 | ❌ 不成立 | P1-7：UndoRequest 的 `additional` 全字段透传 |
| Redis 写总会成功 | ❌ 不成立 | P0-1：写失败无 catch → 崩溃循环 |
| Redis 不可达时快速失败 | ❌ 不成立 | P1-8：无命令超时，全站悬挂 |
| "进程活着 = 服务健康" | ❌ 不成立 | P1-6：无 healthcheck、无 tick 指标、无告警 |
| 配置默认值 = 安全默认值 | ❌ 不成立 | P2-2：`TRUST_PROXY=0`、`FORCE_INSECURE_COOKIES=true` 与注释/文档互相矛盾 |
| 单节点故障可接受 | ⚠️ 知情接受 | 无 balancer/副本（`docs/architecture.md:10` 自述"not currently deployed"），恢复依赖客户端退避 |
| Rust 层（balancer/collector）为本部署服务 | ⚠️ 名义存在、实际未运行 | `deploy/next-compose.yml` 不含；且 `env/balancer.toml` 缺失（P2-9）——对当前部署是**纯复杂度税**，除非规划多机 |

**值得保留的设计**（对抗式审查同样要保护资产）：`_playbackStart` 让播放进度可跨崩溃重建；
`serializeState` 对瞬时态（缓冲门/临时倍速）做专门改写；`voice-budget` 读失败时 fail-closed（不发中继）；
优雅停机顺序（kick → 等待 → flush）；房间懒加载（重启无恢复风暴）；边缘 Worker 的重定向逐跳复校验机制。

---

## 问题总表（按严重度）

| # | 级别 | 问题 | 类别 | 证据 |
| --- | --- | --- | --- | --- |
| P0-1 | 严重 | Redis 写失败（内存写满）→ debounce 尾调用无 catch → 未处理 rejection → 进程崩溃循环 | 可靠性 | 代码证实 |
| P1-1 | 高 | ffprobe 三条策略跟随重定向、绕开 SSRF 守卫；`/api/data/previewAdd` 匿名可达 | 安全 | 代码证实 |
| P1-2 | 高 | 登录爆破限流器是死代码（只 `get` 不 `consume`），无限口令猜测 | 安全 | 代码证实 |
| P1-3 | 高 | 缓冲门等待集清空依赖播放器行为契约（暂停本身不产生 ready）；最坏每次缓冲抖动全房停 ~15s+30s 冷却 | 同步/UX | 代码证实 |
| P1-4 | 高 | stall 自愈（8s）与漂移硬跳（~8s 冷却）同相竞速且大概率输掉，恢复阶梯被饿死 | 同步 | 代码证实（机制）+推演 |
| P1-5 | 高 | 1s tick 串行 await（SponsorBlock 最长 5s 在关键路径）+ 无重入守卫 → 全局头阻塞与并发轮次 | 可靠性 | 代码证实 |
| P1-6 | 高 | 可运维盲区：ott 无 healthcheck、无 tick/事件循环指标、`prometheus.yml` 指向上游、无告警 | 可运维 | 实测+代码 |
| P1-7 | 高 | UndoRequest 的 `additional` 透传：可注入任意源、可把全房时钟置为 NaN 使纠偏停摆 | 安全/同步 | 代码证实 |
| P1-8 | 高 | Redis 不可达时无快速失败（无命令超时/离线队列默认开启）→ tick、会话、限流全部悬挂 | 可靠性 | 代码证实（配置缺失）+推演 |
| P2-1 | 中 | CSP 仅 Report-Only（无 script-src/default-src）+ token 存 localStorage；当前无 XSS sink（已证伪） | 安全 | 实测+代码 |
| P2-2 | 中 | 配置默认值陷阱：`TRUST_PROXY=0`、`FORCE_INSECURE_COOKIES=true` 与注释/文档矛盾；线上已正确配置但重新部署会回退 | 安全/运维 | 实测+代码 |
| P2-3 | 中 | Private/Unlisted 房间无访问控制（仅"不在列表"语义），可按名枚举 | 安全 | 代码证实 |
| P2-4 | 中 | Redis 快照 debounce trailing-only 无 maxWait（丢窗口无上限）；votes 完全不持久化；永久房写放大 | 可靠性 | 代码证实 |
| P2-5 | 中 | 延迟估计器盲区：reconnect 不复位样本；不对称链路/时钟速率误差吃死区 | 同步 | 代码证实 |
| P2-6 | 中 | 临时倍速 ack 2.5s 超时：高 RTT 下自我取消，卡在 2× 约 5s | 同步 | 代码证实 |
| P2-7 | 中 | 多标签页按"页"计人：缓冲门/投票人数虚增 | 同步/产品 | 代码证实 |
| P2-8 | 中 | 依赖偏旧 + caret 放量（express4/ws7/passport-discord），基础镜像 digest pin（好） | 供应链 | 代码分析 |
| P2-9 | 中 | 文档/示例硬漂移：`env/balancer.toml` 缺失但被 AGENTS.md 与两个 Dockerfile 引用；`harness_macros` 悬空 | 工程卫生 | 代码证实 |
| P2-10 | 中 | 版本与文案一致性：zh-CN 缺 `queue-pending`（默认界面中英混排，与版本记录相矛盾）；`UPSTREAM.md` 落后 5 版 | 文档 | 代码证实 |
| P3-* | 低 | 死代码与残留（room-sync: 死键、B2M::Load 死协议、codecov 孤儿、i18n:report 死脚本、fly/heroku 残留、双工具链等） | 工程卫生 | 代码分析 |

---

## P0-1　Redis 写失败 → 未处理 rejection → 进程崩溃循环（代码证实）

**故障链**（每一环都已复核）：

1. `server/room.ts:1072`：`saveStateToRedisDebounced = _.debounce(this.saveStateToRedis, 5000);`
   ——lodash debounce 的返回值不是 Promise；尾调用真正执行时，`saveStateToRedis` 返回的 Promise
   **没有任何 `.catch`**（全文件唯一"裸奔"的 debounce；对照 `throttledSync` 在 `room.ts:1017-1023`
   有 `.catch` 与 dirty 回滚）。
2. `server/room.ts:1139-1141`：`await this.saveStateToRedisDebounced()` 等的是 debounce 包装器
   （立即返回 `undefined`），真正的写发生在 5 秒后，异常直接变成 unhandled rejection。
3. `server/redisclient.ts:40`：`redis.createClient(buildOptions())` —— 未设置命令超时，
   写命令失败（如服务端返回错误）会以 rejection 形式抵达上述链路。
4. `server/` 全目录无 `process.on("unhandledRejection")`；`package.json` engines 为 Node ≥22，
   默认 `--unhandled-rejections=throw` → **进程退出**。
5. `deploy/next-compose.yml:51` `restart: unless-stopped` → 重启 → 用户继续用 → 再次写 → 再次崩。

**触发前置**：Redis 内存写满。compose 配置 `--maxmemory 128mb --maxmemory-policy noeviction`
（`deploy/next-compose.yml:105-108`）——`noeviction` 在写满后对**写命令返回 OOM 错误**（读仍可用），
而房间快照、一周 TTL 的 SponsorBlock 缓存、24h 搜索缓存都在同一实例里累积。
写满后：**崩溃循环持续，直到内存被 TTL 释放**——但有活跃用户的房间会不断刷新自己的 TTL。

**影响**：可用性事故从"写不进 Redis"放大成"整站反复崩溃"；期间房间状态无法落盘。

**反方最强辩护**：128MB 对纯快照而言通常够用；OOM 需要长期运行才触发；重启后房间懒加载，
恢复本身损失有限。**但循环放大本身**（进程反复退出、客户端反复重连）就是不可接受的故障模式。

**裁决：成立（高置信推演——崩溃机制每一环代码证实，触发概率取决于 Redis 实际内存曲线）。**

**修复**（改动最小、收益最大，约 5 行）：给 debounce 包一层 `.catch`（与 `throttledSync` 同风格）；
`createClient` 增加 `disableOfflineQueue: true` 与命令超时；`ott` 服务补 healthcheck（并入 P1-6）。

---

## P1-1　ffprobe 重定向 SSRF：守卫只挡入口，302 直达内网（代码证实）

**攻击路径**（匿名）：

1. `GET /api/data/previewAdd?input=http://attacker.tld/x.mp4` ——`server/api.ts:19-23` 把 `/data`
   挂在鉴权中间件之前，**无需 token**。
2. `attacker.tld` 解析公网 → 通过守卫；返回 `302 Location: http://169.254.169.254/…`
   （或 `http://127.0.0.1:6379/`、内网后台）。

**证据**：三条 ffprobe 策略都只校验**入口 URL**，之后放行重定向：

- `server/ffprobe.ts:288`（`RunFfprobe`）先 `assertPublicMediaUrl(uri)`，随后 `:302-305` 注释明说
  "including redirects"、`:322` 直接 `spawn(ffprobe, [ … "-i", uri …])`——由 ffprobe 自行跟随 302；
- `server/ffprobe.ts:376,387-392`（`OnDiskPreviewFfprobe`）先守卫，随后 `axios.get(uri, {responseType:"stream"…})`
  ——**无 `maxRedirects: 0`**，axios 默认最多跟随 21 跳；
- `server/ffprobe.ts:497,503-508`（`StreamFfprobe`）同上。

**对照组证明是遗漏**——同一仓库的其它适配器全部显式禁止或手工校验重定向：
`server/services/hls.ts:54-57`、`dash.ts:57-60`、`cors-probe.ts:30-31`（`maxRedirects: 0` + 注释）、
`direct.ts:129-131`（`redirect: "error"` + 注释）、`bilibili.ts:106-113`（手工逐跳 + 每跳 `assertPublicMediaUrl`）。

**影响**：盲 SSRF（回显为解析出的媒体元数据），足以做内网端口探测、触发内网服务、访问云元数据端点；
`disk` 策略可整段下载内网内容（本部署有 64MB tmpfs 兜底，但 `preview_max_bytes` 默认 `Infinity`，
`server/ffprobe.ts:394` / `server/ott-config.ts:247-253`）。

**反方最强辩护**：守卫自身覆盖常见网段与 IPv4-mapped IPv6（`server/ffprobe.ts:26-72`），
IP 字面量直连被挡；`run` 策略下 ffprobe 是否跟随 302 依其版本；回显有限。
**但 `stream`/`disk` 由 axios 默认行为确定成立**。

**裁决：成立。** `run` 策略的跟随是**有意**的（注释为播放兼容性），但与"SSRF 守卫"的意图冲突——
守卫只管第一跳。**需实况攻击验证**（本审查未构造，避免在生产触发）。

**修复**：统一改为仓库已有的 bilibili 模式（逐跳校验）；或用 DNS 钉扎的连接；`run` 策略先解析
最终 URL 再交给 ffprobe；`preview_max_bytes` 给非无穷默认值。

---

## P1-2　登录爆破限流是死代码：只读取、不消费（代码证实）

**攻击路径**：`POST /api/user/login` 无限次猜测口令——两重爆破保护都不会触发。

**证据**：

- 限流器在 `server/usermanager.ts:62-91` 完整声明（100 次/IP/天；连续 10 次失败封 1 小时）；
- 请求处理只**读取**计数（`:220-232`）：`limiterConsecutiveFailsByUsernameAndIP.get(...)`、
  `limiterSlowBruteByIP.get(...)`；
- 失败分支（`:303-311`）只回 401，**从不 `consume`/`penalty`**；全文件 grep `.consume(|.penalty(`
  在 usermanager 内**零命中**（复核确认）。`consumedPoints` 恒为 0，"已封禁"判断永不成立。

**影响**：在线撞库/爆破没有应用层节流，只受 argon2 计算成本约束（在本机 1 vCPU 下，攻击者的
并发请求反而顺带挤占 CPU——与 P1-5 的 tick 头阻塞叠加）。

**反方最强辩护**：argon2id 单次较慢；生产可通过 WAF/Cloudflare 前置拦截。
**但这是"写好的保护从未接线"，且默认部署无 WAF。**

**裁决：成立。** 修复：失败时 `consume` 两个限流器、成功时 `delete` 复位（3 行）。

---

## P1-3　缓冲门：等待集清空依赖播放器行为契约（代码证实）

**机制**（服务端逐行复核）：启用缓冲门的房间（`bufferGateMode=pause`）在**有权限的观众 ≥2 且
有人处于 `buffering`** 时暂停全房（`server/room.ts:598-639`，`waiting` 只由
`playerStatus === buffering` 构成，`:616`）；释放条件只有三种：`waiting` 清空、人数不足、
或 **15s 上限**（`:599-602`，常量 `common/constants.ts:9-11`：15s 上限 / 2s 起始宽限 / 30s 冷却）。

**问题**：清空 `waiting` 要求被等待的用户重新上报 `ready`——而**暂停动作本身不产生该信号**：
客户端只在 `PLAYBACK_STATUS` 变化时转发（`client/src/components/WorkaroundPlaybackStatusUpdater.vue`），
`OmniPlayer.vue:472-476` 的 `onPaused` 不提交新状态；唯一例外是为 YouTube 打的补丁
`hackReadyEdgeCase`（`OmniPlayer.vue:456-461`，仅 `service === "youtube"`）。
原生播放器的 `ready` 依赖 `canplay/seeked/loadeddata` 事件
（`DirectPlayer.vue:9-12`、`HlsPlayer.vue:10-13`）——**暂停态下是否触发取决于该播放器是否继续推进缓冲**，
没有契约保证。

**影响**：一次 3 秒的缓冲抖动，最坏演变为**全房停 15 秒**（然后进入 30s 冷却，此间新的抖动不再保护）；
"等待方就绪即恢复"这一快路径对部分播放器退化为"永远等满上限"。被暂停的其它观众是纯粹的受害者。

**反方最强辩护**：15s 上限防死锁；会继续缓冲的播放器（hls.js/dash.js 通常继续加载）能通过
`canplay` 提前自愈——早期释放路径**存在**，只是没有保证。

**裁决：部分成立（机制脆弱、最坏情形成立；早释路径的可达性依播放器而定，未实测）。**
修复方向：缓冲门持有时，被等待的客户端在"暂停且已就绪"时也应补报状态（把 YouTube 补丁语义泛化）。

---

## P1-4　stall 自愈与漂移硬跳同相竞速，恢复阶梯被饿死（机制代码证实，概率推演）

**两个定时器**：

- `client/src/util/media-recovery.ts:11` `STALL_TRIGGER_MS = 8000`：播放停滞 8 秒才进入
  `recoverFromStall`（微步 → 同区间重取 → 重载的阶梯）；`:190-196` 一旦元素在 seek 中、
  或位置变化 >0.05s 就**复位计时**。
- `client/src/util/playback-sync.ts:264-268`：playing 且可 bend 的播放器在漂移超 3s 时硬跳；
  硬跳冷却在有缓冲记录时是 **8000ms**（`:172`，`bufferedSinceLastSeek` 累积位）。

**竞速**：元素卡住后，漂移与 stall 计时**同时从上一个 seek 起算**；纠偏 tick 以 250ms 频率检查、
stall 巡检以 1s 频率检查——8s 到点时，几乎总是纠偏先执行硬跳（写 `currentTime` → 触发
`seeking`/位置变化 → stall 计时复位）。其后果：**`recoverFromStall` 同区间重取/重载的阶梯
大概率永远不执行**，观众看到的是每 ~8 秒一次可见跳转的循环——而 media-recovery 自己的注释
（`:6-10`）写明"Bad ranges survive seeks"（seek 修不好坏区间），两条路径的设计意图互相拆台。

**反方最强辩护**：硬跳可能促使浏览器重新解码而自愈；`canObserve` 在 seeking 期间为 false，
纠偏被推迟——推迟不改变复位事实。

**裁决：机制成立（两条定时器的同相与复位关系代码证实）；"永远输掉竞速"是推演（高置信）。**
修复方向：硬跳前查询 `isRecovering()/stalled` 状态互斥；或 stall 激活时暂停漂移硬跳，让恢复阶梯先跑。

---

## P1-5　1s tick 的全局头阻塞与自我叠加（代码证实）

**证据**：

- `server/roommanager.ts:51`：`setInterval(update, 1000)` —— **没有 `if (running) return` 单飞守卫**，
  慢 tick 会与下一 tick 并发（`update()` 无锁；`sync()` 有 `syncLock`，`update()` 没有）。
- `server/roommanager.ts:78-96`：串行 `for (room of rooms) { await room.update(); await room.sync(); }`
  ——任一房间的慢 I/O 顺延其后全部房间。
- `server/room.ts:970-979`：SponsorBlock 抓取被 **await 在 tick 关键路径**上；未命中缓存时
  `server/sponsorblock.ts:64-67` 的 5s 超时会**真实计入 tick 时长**。若 Redis 写满是现实路径
  （P0-1 前置），segment 缓存写不进 → 每次换片都吃满 5s → 若干房间同 tick 换片即 Σ(5s)。

**影响**：单核 512MB 的部署里，"每房间独立"只是假象；一个慢房间可以冻结全实例的同步、卸载与
缓冲门评估。容量上（推演）：~100 房间可控、500 房间吃紧、1000 房间在活跃时进入重叠恶化。

**反方最强辩护**：`wantSponsorBlock` 前置置 false 防重试风暴；缓存 TTL 一周，稳态几乎全命中；
多数 tick 在该房间是 0 I/O。**但放大路径在 Redis 异常时必然叠加。**

**裁决：成立（结构代码证实，后果推演）。** 修复：单飞守卫 + tick 耗时直方图 +
SponsorBlock 移出关键路径（后台队列）；这三项同时收敛 P1-5 与 P1-6。

---

## P1-6　可运维盲区：卡死不可见、不自愈、无告警（实测+代码证实）

**证据**：

- `deploy/next-compose.yml:49-73`：`ott` 服务**没有 healthcheck**（对比 postgres `:85-89`、
  redis `:114-118` 都有）。`restart: unless-stopped` 只对**进程退出**生效——事件循环被
  P1-5/P1-8 悬挂卡死而进程存活时，Docker 不会重启它。
- 指标只有计数类：`ott_room_count`/`ott_users_in_rooms`（`server/roommanager.ts:256-296`）、
  `ott_clients_connected`——**没有 tick 时长、事件循环 lag、同步延迟、重连率**。
  卡死时计数类指标可能一切"正常"。
- `prometheus.yml:4-9`：抓取目标写死 **`opentogethertube.com`**（上游站点），与本部署无关；
  全仓无 alertmanager/告警规则；Grafana 插件未纳入自动化部署。
- 实测：线上 `/api/status/metrics` 与 `/api/status/voice` 均 **403**（权限门工作正常）——
  即**采集端反而是空的**。

**裁决：成立。** 修复：补 `ott` healthcheck（一个只回 `{"status":"ok"}` 的轻量路由）+
`ott_room_tick_duration_seconds` 直方图 + 修正 prometheus 抓取目标 + 最小告警（房间同步停滞、
容器重启次数）。

---

## P1-7　UndoRequest 的 `additional` 全字段透传（代码证实）

**攻击路径**（房间内任意拥有 skip/seek/add/order 权限的观众——公共房默认角色即满足）：

- WS 信封只校验外壳：`server/ws-schemas.ts:61-64` `request: z.object({ type: … }).passthrough()`
  ——内层字段**全程透传**；
- 消费处直接信任客户端数据：`server/room.ts:1893-1905`
  `this.currentSource = request.event.additional.video;`
  `this.playbackPosition = request.event.additional.prevPosition;`
  以及 `:1923-1930` 的队列 `insert(request.event.additional.video, queueIdx)`；
- REST 路径同样未校验（`server/api/room.ts` 的 undo handler 直接透传 `req.body.data.event`）。

**两种爆炸半径**：

1. `prevPosition = NaN/Infinity` → `realPlaybackPosition` 变非有限值 → 所有客户端
   `playback-sync.ts:153-163` 的 `Number.isFinite` 守卫失败 → **全房纠偏停摆**，直到下一次合法 seek；
2. `video = { service: "direct", id: "<任意 URL>" }` → 注入任意播放源并广播全员加载
   （配合 P1-1 的 SSRF 面进一步放大）。

**反方最强辩护**：官方 UI 不暴露该操作（`client/src/util/roomapi.ts` 的 `undoEvent` 直接抛未实现）；
需要房间内身份。**但"有权限"在公共房等于"任何人"。**

**裁决：成立。** 修复：为 undo 增加 zod 校验（`video` 只允许当前/队列内视频、
`prevPosition` finite 且在 [0, length]），或服务端只接受事件 id 引用而非客户端回放数据。

---

## P1-8　Redis 不可达 = 全站挂起（配置缺失，行为推演）

**证据**：`server/redisclient.ts:40` `redis.createClient(buildOptions())`——全文件没有
`disableOfflineQueue`、`reconnectStrategy`、命令级超时（grep 复核零命中）。node-redis 默认：
断连时命令**排队等待重连**（不快速失败）、无限重连。

**影响**：Redis 重启/抖动的窗口内，`await redisClient.*` 全部悬挂：`roommanager` tick 卡在
TTL 刷新或 SponsorBlock 读取 → **全实例房间同步冻结**；HTTP 会话（`server/app.ts:102` 的
RedisStore）、限流、token 校验全部悬挂 → 站点整体超时而非降级。
（对照组：`server/voice-budget.ts` 读失败时 fail-closed，是本仓库唯一正确处置的一处。）

**反方最强辩护**：Redis 与 app 同机、有 healthcheck 与 AOF，短暂抖动会自愈。
**但"自愈期间全站挂起"与"快速失败 + 降级"是两种完全不同的用户观感。**

**裁决：成立（配置缺失证实，行为推演高置信）。**

---

## P2 级问题（逐条）

**P2-1　CSP 仅 Report-Only + token 存 localStorage（实测+代码）。**
线上响应头实测：`content-security-policy-report-only: base-uri 'self'; object-src 'none';
frame-ancestors 'self'; report-uri /api/csp-report`——**没有 `default-src`/`script-src`，且不强制**
（`server/security-headers.ts:100-101` 注释自述"Deliberately no script whitelist"）。
token 双写：服务端下发 httpOnly cookie，同时响应体返回明文 token，客户端落盘
`localStorage`（`client/src/stores/users.ts:57-59`），WS 鉴权也读它（`client/src/plugins/connection.ts`）；
有效期游客 14 天、登录 **240 天**（`server/auth/tokens.ts:7` 注释写 "120 days"，代码却是
`120 * 24 * 60 * 60 * 2`——又一处注释/代码漂移）。**当前无 XSS sink（已证伪，见后）**，
所以这是纵深防御缺失而非可利用链：一旦未来引入任一注入点，CSP 无缓冲、localStorage 全量失守。
修复：CSP 转强制（Vue 构建无需 `unsafe-inline`）；token 只走 httpOnly cookie、WS 用一次性 ticket。

**P2-2　配置默认值陷阱（实测+代码）。**
`deploy/next-compose.yml:20` `TRUST_PROXY: ${TRUST_PROXY:-0}`、`:15`
`FORCE_INSECURE_COOKIES: ${FORCE_INSECURE_COOKIES:-true}`，而 `server/api/status.ts:25-31` 的
`isLocalOrAdmin` 依赖 `req.ip`（注释假设 trust proxy 已生效）、`server/app.ts:113-133` 只在
`trust_proxy > 0` 时才设置 trust proxy 并给 session cookie 加 Secure——**默认值下：
同机反代使 `req.ip` 恒为 127.0.0.1 → `/api/status/metrics`、`/voice` 对全网可读；
且 `consumeRateLimitPoints(res, req.ip, …)` 的限流桶全站合并为一个（1000 点/小时全站共享，
一次刷量即可 429 所有人）；token cookie 无 Secure。** 实测：**线上两项均未命中**
（metrics/voice 403；`set-cookie: … HttpOnly; Secure; SameSite=Lax`）——说明线上 env 已正确覆盖，
但 `deploy/.env.example:14-15` 的注释建议与取值自相矛盾，**按默认值重新部署会静默关掉两项保护**。
修复：统一三处默认值；`isLocalOrAdmin` 只信 apikey 不信 `req.ip`。

**P2-3　Private/Unlisted 房间无访问控制（代码证实）。**
`roommanager.getRoom`（`server/roommanager.ts:136-184`）与 WS 加入（`server/clientmanager.ts:280-287`）
都不检查 `visibility`；列表接口才过滤 Private。按名直取（REST `server/api/room.ts:162-188` 返回
title/description/queue/users/grants）与加入均可达。即 Private 的语义实为"不在列表出现"，
可按名枚举进入。修复：加入时对 Private 校验 owner/邀请令牌，或把语义写进文案。

**P2-4　Redis 快照与持久化的边界（代码证实）。**
`saveStateToRedisDebounced`（`server/room.ts:1072`）是 trailing-only **无 `maxWait`**——活跃房间的
写入可被无限顺延（不是"固定丢 5s"）；崩溃最多丢**整份运行时快照**（队列/锚点/grants 等，
`onBeforeUnload`/`leaveRoom` 的 flush 只覆盖优雅路径与空房）。另外 `votes`/`votesToSkip`/
`temporaryPlaybackSpeed`/`playbackPreparation` **完全不持久化**（`room.ts:191-200` 的 Omit 列表）；
永久房间在每次播放状态变化时把整条队列写入 `prevQueue` 并落 Postgres（写放大，`:1128-1151`）。

**P2-5　延迟估计器盲区（代码证实）。**
`client/src/util/connection-latency.ts`：min(8 样本)/2、5s 合理上限、180s 老化。
`connect()` 会 `resetLatencySamples()`（`connection.ts:120`）但 **`reconnect()` 不复位**
（`:131-139`）——网络切换（WiFi→蜂窝）后最长 ~2 分钟内用旧样本补偿；不对称链路下
`RTT/2` 的方向性偏差可达上百 ms，直接挤压 300ms 死区；墙钟速率误差（±100ppm ≈ 0.36s/小时）
在两次 sync 之间靠 bend 持续吸收。

**P2-6　临时倍速的 ack 竞速（代码证实）。**
客户端 2500ms 未收到服务端确认即自我取消（`client/src/util/temporary-playback-speed.ts`），
而服务端成功后进入 5s 租约；RTT > 2.5s 的链路上会出现"先 2× 再回退、中间卡 ~5s"。

**P2-7　多标签页按"页"计人（代码证实）。**
每连接一个 `RoomUser`（`server/clientmanager.ts:311-315`），缓冲门与投票的 eligible 按
`realusers` 计数（`room.ts:612-616`、`voteskip.ts`）——同一账号开两个标签页即可用"一个人"
触发全房暂停或虚增投票人数。

**P2-8　供应链（代码分析）。**
基础镜像按 digest pin（`deploy/next.Dockerfile:1`，好）；但 `server/package.json` 的
express `^4.21`（v4 维护尾声）、ws `^7.5`（当前主版本 8）、`passport-discord ^0.1.4`（少维护）、
大量 caret 放量；`patches/rate-limiter-flexible+2.4.1.patch` 为良性再导出补丁。修复：关键依赖
精确 pin + 定期 digest 升级。

**P2-9　文档/示例硬漂移（代码证实）。**
`env/` 目录只有 `example.toml/docker.base.toml/heroku.base.toml`——**`env/balancer.toml`、
`env/collector.toml` 不存在**，却被 AGENTS.md 的命令示例与 `deploy/balancer.Dockerfile`、
`deploy/collector.Dockerfile` 的 CMD 引用（"能照做但必失败"）；根 `Cargo.toml:16` 的
`harness_macros = { path = "crates/harness_macros" }` 指向不存在的目录（"睡眠炸弹"：
任何 `--all-features` 解析会失败）；AGENTS.md 命令示例抽查 2/6 不可运行。

**P2-10　版本与文案一致性（代码证实）。**
`room.tabs.queue-pending` 只在 `client/src/locales/en.ts:287` 存在，zh-CN 缺失而
`Room.vue` 在用——默认中文界面会显示英文 "Up next {count}"，且与 v1.1.2 版本记录
"队列页签徽标改为「待播 N」"的声称相矛盾；`UPSTREAM.md` 声称本地版本 v1.0.0，
而 git tag 已到 **v1.1.5**（落后 5 版）；README.en 未同步中文版新增亮点。

---

## P3 级（汇总，均代码分析）

- **死代码/残留**：Redis `room-sync:` 只有删除没有写入（`server/roommanager.ts:222`，旧同步机制残留）；
  `B2M::Load` 协议变体在生产路径无构造点（仅 harness 测试）；`codecov.yml` 是孤儿（无任何
  workflow 上传）；`client/package.json:10` 的 `i18n:report` 依赖不存在的 `vue-cli-service`；
  `announce.sh` 默认读不存在的 `env/*.env`；fly×6/heroku/nginx.prod.conf 等上游部署残留；
  biome+eslint8+prettier2 双工具链并存。
- **时间源混用**：锚点/节流用墙钟（`dayjs`/`Date.now`），媒体时钟独立——NTP 阶跃/休眠唤醒时
  冷却窗口与 deadline 判定会临时失真（真实触发频率低）。
- **边缘路径**（`packages/ott-edge`）：能力是 server 的子集（无 ffprobe 生态、无语音、仅
  direct/hls/dash 三适配器），配额说明诚实；风险是共享 `client/dist` 产物目录与首页并列宣传
  带来的误用，而非实现缺陷——**其重定向逐跳复校验、Origin 校验、token 哈希存储反而严于主站**。
- **短片边缘**：<4s 视频的播完感知（1s tick 量化 + 2.5s `mediaEndedRecently` 补丁）语义边界；
  该补丁不 gate `onSyncMsg`/纠偏 tick，慢 tick 下异常 sync 可致短片重播一次（推演）。
- **换源对齐降级**：换源时 `playbackSync.reset()` 的"全量硬跳"意图会被随后带
  `tolerateSmallDrift` 的 sync 覆盖；对可 bend 播放器，权威位置 <3s 时改为 ≤1.15× 速率追赶
  （~十几秒的轻微慢放），可感知度低但不符合 reset 的原意。

---

## 被证伪的担忧（对抗式审查的诚实面）

以下担忧经构造与复核后**不成立或显著弱于预期**，同样是有价值的结论：

1. **存储型 XSS 不存在**：客户端全量搜索 `v-html/innerHTML/eval/new Function/document.write` → 零命中；
   唯一的链接化组件（`ProcessedText.vue`）只匹配 `https?://` 且用 `{{ }}` 转义插值。
2. **账号找回不可爆破**：`crypto.randomBytes(32)` + 10 分钟 TTL + 限流（`usermanager.ts:916` 附近）。
3. **admin apikey 时序安全**：`timingSafeEqual` + 空 key 拒绝（`server/admin.ts:24-36`）。
4. **WS 输入面总体完整**：zod discriminatedUnion 覆盖全部 action、256KB `maxPayload`、
   10s 未鉴权踢、请求类型白名单（`clientmanager.ts:51-72`）——缺口集中在 P1-7 的 undo 透传。
5. **"暂停房每 2 秒反复 seek"**：稳态证伪——暂停后目标位置是常量，一次 seek 归零后不再重复；
   0.3–1s 死区内 tick 不动作。
6. **"cancelBend 会把 2× 覆盖回旧速率"**：证伪——`getBendBase()` 读的是已提交的新 `playbackSpeed`。
7. **"缓冲门会永久死锁"**：证伪——15s 上限每秒被检查（P1-3 是"提前释放不保证"，不是死锁）。
8. **"重启后房间恢复风暴"**：证伪——房间懒加载，重启后 tick 遍历空数组。
9. **"Redis 快照固定丢 5 秒"**：修正方向与直觉相反——无 `maxWait` 时窗口**可以远超 5s**
   （也可能从未落盘），而非稳定 5s。
10. **"边缘 Worker 安全面弱于主站"**：证伪——边缘反而更严（逐跳重定向复校验、Origin/Sec-Fetch-Site
    校验、token SHA-256 哈希存储、请求体 64KiB 上限）。

---

## 实况验证记录（2026-09-21，非破坏性）

对 `https://openvideo.117911.xyz` 的只读探测（curl，未做攻击验证）：

| 探测 | 结果 | 说明 |
| --- | --- | --- |
| `GET /` | 200 | 实例健康 |
| `GET /api/status` | `{"status":"ok","searchEnabled":true}` | 服务正常 |
| `GET /api/status/version` | `66ff39201a…` | 与工作区仅差 1 个 docs 提交 |
| `GET /api/status/metrics` | **403** | P2-2 陷阱未命中（线上 trust proxy 已正确配置） |
| `GET /api/status/voice` | **403** | 同上 |
| `GET /api/auth/grant` 响应头 | `Set-Cookie: … HttpOnly; Secure; SameSite=Lax` | P2-2 的 cookies 部分未命中 |
| 首页响应头 | CSP **Report-Only** 实测、HSTS、X-Frame-Options、Referrer-Policy、Permissions-Policy | P2-1 实况证实 |

**未做及原因**：SSRF 攻击验证（需攻击者基础设施，且不应在生产触发）；登录爆破验证（会实际
损害账号安全）；Redis OOM/断连故障注入（生产环境）；双端真机播放同步实验（需两台真实设备与人肉操作）。
以上留待后续"受控环境实验清单"。

---

## 与同类项目对比（收尾）

| 项目 | 形态 | 同步方法 | 媒体源 | 与 OTT 的差异/启示 |
| --- | --- | --- | --- | --- |
| **Syncplay** | 桌面客户端组 | forward-delay 补偿（OTT 的延迟补偿同源） | 本地文件（mpv/VLC 等） | 直接控制播放器 → 不需要 bend/seek 分层；OTT 是它的"浏览器 + 异构源"版本 |
| **Jellyfin SyncPlay** | 媒体服务器内置 | 服务端下发"延迟后播放"指令 | 仅 Jellyfin 库内媒体 | 同样房间时钟模型；控制的是自家播放器 → 同步确定性更高；OTT 对 iframe 只有 seek，分层纠偏是必然取舍 |
| **Watch2Gether / Kosmi** | 商业网页 | 注入/内嵌控制多站点 | 多站点 | 闭源、不可自托管；OTT 的差异点在开源自托管 + 权限/队列/投票 |
| **Teleparty** | 浏览器扩展 | 扩展直接驱动官方播放器 | Netflix/YouTube 等签约站点 | 闭源、绑定站点；OTT 无法也不应碰 DRM 站点 |
| **Hyperbeam** | 虚拟浏览器（云端房） | 云端渲染，客户端只是画面 | 任意 | 用"控制整个环境"换同步确定性，成本与带宽高；与 OTT 目标人群不同 |

**定位结论**：OTT 占据的缝隙是"**开源自托管 + 异构媒体源 + 房间治理（队列/投票/权限）**"，
在同类里没有直接替代品；与 Syncplay/Jellyfin 同属"权威时钟 + 延迟补偿"家族，方向已被验证。
它的独有代价是**对第三方播放器的控制力最弱**——这既是 P1-3/P1-4 这类"行为契约"缺陷的根源，
也是架构上无法绕开的约束（只能通过把契约显式化来缓解：给播放器设计明确的"就绪/停滞"语义接口，
而不是假设它们会主动汇报）。

---

## 修复优先级（若只做十件事）

1. **P0-1**：给 `saveStateToRedisDebounced` 加 `.catch`；`redisclient` 加 `disableOfflineQueue`
   与命令超时；补 `ott` healthcheck。（同时收敛 P1-8）
2. **P1-2**：登录失败 `consume` 两个限流器（3 行）。
3. **P1-1**：ffprobe 出站统一禁重定向/逐跳校验（照抄 `bilibili.ts` 模式）。
4. **P1-5**：tick 单飞守卫 + tick 时长指标 + SponsorBlock 移出关键路径。
5. **P1-6**：`prometheus.yml` 目标修正 + 最小告警（重启次数、tick 停滞）。
6. **P1-7**：undo 的 `additional` 加 zod（或改为事件 id 引用）。
7. **P1-3**：缓冲门持有时，被等待客户端"暂停且已就绪"也补报状态（泛化 YouTube 补丁语义）。
8. **P1-4**：stall 激活时暂停漂移硬跳，给恢复阶梯让路。
9. **P2-2**：统一 `TRUST_PROXY`/`FORCE_INSECURE_COOKIES` 三处默认值；`isLocalOrAdmin` 只信 apikey。
10. **P2-9/P2-10**：删/补 `env/balancer.toml` 引用与 `harness_macros`；补 zh-CN `queue-pending`；
    更新 `UPSTREAM.md` 版本。

---

## 局限声明

- 以**静态审查 + 引用复核**为主；P1-3/P1-4 的"真实发生率"、P0-1 的"Redis 内存曲线"、
  P2-6 的"高 RTT 自取消"均未在受控环境实测。
- Rust 层（balancer/collector/harness）未运行其测试；对其结论基于代码阅读与协议分析。
- 行号为 `feat/upscale-quality`（`0ff882c`）快照；线上为 `66ff392`，源码一致、行号可 `git show` 复核。
- 线上探测为非破坏性只读；未做任何攻击验证与故障注入。

**外部参考**：[Jellyfin SyncPlay 指南](https://jellywatch.app/blog/jellyfin-watch-party-group-watch-guide-2026)、
[Teleparty 开源替代列表](https://alternativeto.net/software/netflix-party/?license=opensource)。
