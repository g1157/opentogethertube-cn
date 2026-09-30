# 2026-09-30 审查问题核实与修复报告（`feat/upscale-quality`）

针对 `docs/code-review-2026-09-30.zh-CN.md`（下称「审查」）的逐条核实与修复记录。
每条给出：**核实结论**（代码位置与判断）、**是否已修**、**修法**（文件与要点）、**验证方式**。
未修条目也一并列出并说明原因，避免「看起来都修了」的错觉。

**核实方法**

- 逐条读代码复核审查的行号与结论；跑得动的实际跑：
  - `yarn workspace ott-server exec tsc --noEmit` → 通过（无输出）
  - `yarn workspace ott-client exec tsc --noEmit` → 通过（无输出）
  - `NODE_ENV=test yarn workspace ott-server exec vitest run` → **48 文件 / 763 用例全通过**
  - `NODE_ENV=test yarn workspace ott-client exec vitest run` → **69 文件 / 785 用例通过、24 跳过**（本报告新增用例计入其中）
  - `biome check`（改动文件）→ 无问题
  - `eslint`（改动文件，两个 workspace）→ 0 error（仅剩仓库既有的 `restrict-template-expressions` warning）
- 跑不到的仍然标注：Rust 侧无 `cargo`，未编译、未跑 `cargo test`；无真机 WebGPU / 多设备环境，画质增强仍为代码级结论。

**结论摘要**

- 审查的 P0（3 条）、P1（4 条）全部核实成立并已修复。
- P2、P3 中除「多语言大量缺 key（产品取舍）」「无障碍覆盖率」外均已修复或按设计说明保留。
- 修复过程中修正了审查的两处不准确描述（见「对审查本身的更正」）。
- 新增回归用例 7 条（J/L 方向各 1、长按不重复 seek 1、降档不落盘 1、音效懒创建 1、b23 短链解析 2），并更新密码找回用例以验证换 token 契约。

---

## 一、P0

### P0-1 `saveStateToRedisDebounced` 无 `.catch`，写失败升级为未捕获 rejection —— 已修

**核实**：成立。`server/room.ts:1088` 原为 `_.debounce(this.saveStateToRedis, 5000)`，lodash 丢弃返回值，定时器触发的那次调用没有任何人接管 rejection；全仓无 `process.on("unhandledRejection")`。

**修法**

- `server/room.ts`：按 `throttledSync` 的模式包一层自处理 rejection 的包装函数，失败只记 `log.error`，不再冒泡成未捕获拒绝。
- `server/app.ts`：新增 `installUnhandledRejectionLogger()`（模块级一次性安装），把仍然漏网的拒绝写入应用日志，避免「进程直接消失、日志什么都没有」。

**验证**：`tsc` 通过；服务端 763 用例全绿（含 room 相关）。

**对审查的更正**：审查称「`syncDirty` 的 dirty 集合已经保留了检查点，房间管理器会重试」——不准确。`syncDirty` 在 `save` 之前就 `cleanDirty()`，只有 `await` 抛错才会把快照塞回 `_dirty`；由于 debounce 会吞掉错误，这次失败不会自动重试，而是等下一次 `markDirty`（如同步心跳）再落盘。代码注释已按实际语义写明，未假装有重试。

### P0-2 Redis 客户端无连接/命令超时、未关离线队列 —— 已修

**核实**：成立。`server/redisclient.ts` 的 `buildOptions()` 只给 `url`/`socket.tls`/`database` 或 `host/port`。

**修法**

- `socket.connectTimeout = 5000`（两种连接方式都设置）：Redis 不可达时快速失败，而不是等内核超时。
- `disableOfflineQueue = true`、`commandsQueueMaxLength = 1000`：重连期间不再排队堆积陈旧命令。
- `applyCommandTimeout()`：node-redis 4.6.7 **没有全局 commandTimeout 选项**（已核对 `@redis/client` 类型定义），因此包装 `sendCommand`（所有生成命令都经它）加 5s 超时；重复的 `duplicate()` 订阅客户端不包装（订阅本就长期挂起）。测试里被 mock 掉的客户端会跳过包装。

**验证**：`tsc` 通过；服务端测试全绿（mock 客户端未受影响）。

### P0-3 本地必失败的 4 例 + announce 接口两套错误契约 —— 已修

**核实**：成立，且本地失败比审查描述更严重：

- `announcement.spec.ts:30` 先 `setApiKey`，`:37` 再 `main()`；`main()` → `loadConfigFile()` 会加载未纳入版本管理的 `env/base.toml`（本机存在，内容 `api_key=""`），把 key 覆盖成空。
- `server/api/announce.ts` 自己的 `InvalidApiKey` 分支不可达：`authTokenMiddleware`（`server/api.ts:42` 挂载）对带 `apikey` 头的请求先跑 `requireApiKey`，出错即返回。
- 本机 `NODE_ENV` 未设置时还有第二重失败：`env=development` → `session_secret` 为空 → express-session 在请求期抛错，4 例全部 500。CI 因 `NODE_ENV=test` 且无 `base.toml` 而全绿——这正是「靠环境巧合通过」。

**修法**

- 测试：先 `await main()` 再 `setApiKey(TEST_API_KEY)`，并注明原因。
- `server/api/announce.ts`：只保留「未提供 apikey」这一条本处理器该负责的检查，删掉不可达的 `InvalidApiKey` 分支与随之未用的 `safeCompareApiKey`/`conf` 导入。契约唯一：**带 key 由中间件判定（`{name: Error, message: "apikey is invalid"}`），不带 key 由 announce 判定（`MissingApiKey`）**。
- 顺带清理：`announce.ts` 里原本就未使用的 `conf` 导入。

**验证**：`NODE_ENV=test vitest run tests/unit/api/announcement.spec.ts` → 4/4 通过；全量服务端 763 通过。

---

## 二、P1

### P1-1 登录爆破限流器只 `get()` 不 `consume()` —— 已修

**核实**：成立。`server/usermanager.ts` 全文件只有 `limiterConsecutiveFailsByUsernameAndIP.get()` / `limiterSlowBruteByIP.get()`，计数永不增长，429 分支不可达。

**修法**（`server/usermanager.ts`）

- 新增 `recordFailedLogin(usernameIPkey, ipAddr)`：两个限流器 `consume`；`consume` 在超限时会 reject（这正是检查分支要的状态），因此内部吞掉该拒绝。
- 失败的两个分支（`err`、`user === false`）各调用一次；成功登录调用 `clearUsernameFailurePoints()` 只清「用户名+IP」计数，保留按 IP 的日限额（分布式猜密码仍会触发）。
- 仅在 `rate_limit.enabled` 时启用。

### P1-2 部署缺少应用层健康检查 —— 已修

**核实**：成立。`deploy/next-compose.yml` 中 postgres/redis 有 healthcheck，`ott` 没有。

**修法**：给 `ott` 加 healthcheck，容器内 `node -e "fetch('http://127.0.0.1:8080/api/status')…"`，`interval 30s / timeout 5s / retries 3 / start_period 60s`。配合 P0-2 的超时，健康检查才真的能反映可用性。`/api/status` 挂在鉴权之前（`server/api.ts:19`），不需要凭证。

### P1-3 房间 tick 串行、无单飞、无耗时指标 —— 已修

**核实**：成立。`server/roommanager.ts` 的 `setInterval(update, 1000)` 逐个 `await`。

**修法**：新增 `runUpdate()` 单飞包装：上一轮未结束时跳过本轮并累加 `ott_room_manager_update_skipped_total`；用 `ott_room_manager_update_duration_seconds` 直方图记录整轮耗时，`finally` 中复位标志。`setInterval` 改为调用 `void runUpdate()`（整轮异常不会变成未捕获拒绝）。

**未做**：把 SponsorBlock 等外部 IO 移出关键路径（需要改动 room.update 的语义与缓存策略，风险大于本轮收益）。耗时直方图 + 跳过计数已能让这类问题在监控里显形。

### P1-4 WebSocket 通道无速率限制 —— 已修（同时修掉审查 P3 的「balancer 下 ping 无回复」）

**核实**：成立。`consumeRateLimitPoints` 只出现在 HTTP 路由；WS 侧只校验长度与权限。

**修法**（`server/clientmanager.ts`）

- 每连接令牌桶（`WeakMap<Client, …>`，断开即回收）：
  - 通用：桶容量 40，回填 10/s；聊天单独一类：容量 5，回填 0.5/s（聊天洪水会推给房间里每个人，代价最高）。
  - 超限时回一条 `{action:"error", name:"TooManyRequests"}` 并 `return`，不断开连接、不写 error 日志刷屏；错误发送抽成 `sendClientError()`，与本就存在的 catch 分支共用。
- `msg.action === "ping"` 分支：`DirectClient` 在 `onData` 里回 pong，经 balancer 的客户端消息会落到 `onClientMessage`，此前只记 `Unknown client message`，`connection-latency` 永远采不到样本。现在直接回 `{action:"pong", t0}`（同样受上述桶约束）。
- `notify → usernameChanged` 触发的用户缓存失效也随之被限制在 10 次/秒，审查中「客户端可无限触发缓存清理」的问题一并缓解。

---

## 三、客户端（非画质增强）

| # | 问题 | 核实 | 修法 |
| --- | --- | --- | --- |
| 二.1 | `J` 键变前进 | 成立 | `client/src/views/Room.vue`：`backward = ArrowLeft \|\| KeyJ`，并加注释；新增 2 条用例锁定方向 |
| 二.2 | 音量 watcher 随首个组件卸载失效 | 成立 | `media-player.ts`：watcher 放进 `effectScope(true)`（detached），随页面存活；`UPDATE` 仍只提交一次 |
| 二.3 | HLS 的 `end` 未转发、DASH 不发 `end` | 成立 | `OmniPlayer.vue` 给 HlsPlayer/DashPlayer 接 `@end="onEnd"`；`DashPlayer.vue` 的 `<video>` 加 `@ended` 并 `emit("end")`（补进 `defineEmits`） |
| 二.4 | zh-CN 缺 `room.tabs.queue-pending` | 成立 | `zh-CN.ts` 补 `"queue-pending": "待播 {count}"` |
| 二.5 | 长按 `→` 在 500ms 窗口内重复 seek | 成立 | `Room.vue`：`e.repeat` 的自动重复不再 seek（只保留首次），长按仍是加速手势；新增用例 |
| 二.6 | 统计面板断点 760 与 800 不一致 | 成立 | `PlayerStatsPanel.vue` 改为 800px 并注明与 `util/breakpoints.ts` 的同步关系 |
| 二.7 | 登录后未对已打开的 socket 重新鉴权（注释不准确） | 成立（注释问题） | 未改行为：轮换 token 后重连才生效是既有设计。本次只把 `PasswordReset.vue` 的 token 采纳补上（见三.4） |

`room.notes-collapse`/`room.notes-expand` 缺键（审查第六节）：**已修**——键一直在 `player.*` 命名空间且各语言都有，改 `Room.vue` 两处引用，不再新增重复键。

---

## 四、服务端与安全

### 四.1 Discord 回调开放重定向 —— 已修

- `/discord` 存 session 时只接受字符串（重复 query 参数会变成数组，原代码 `startsWith` 会抛错）。
- 回调处除 `startsWith("/")`/`startsWith("//")` 外新增 `includes("\\")`：`/%5Cevil.com` 经浏览器归一化会离开本站。

### 四.2 ffprobe 路径的 SSRF 守卫 —— 部分修复

- **已修**：`server/ffprobe.ts` 新增 `safeMediaDownload()`，`OnDiskPreviewFfprobe`/`StreamFfprobe` 改用它：`maxRedirects: 0` 手动跟跳，**每一跳都过 `assertPublicMediaUrl`**，最多 5 跳，3xx 无 Location 或 ≥400 直接报错。此前 axios 默认跟随重定向，一次预检挡不住 302 到内网。
- **未修（保留说明）**：`RunFfprobe`（默认策略，本部署 compose 用 `FFPROBE_STRATEGY=run`）把 URL 交给 ffprobe 进程，链接内部的 DNS 解析与重绑定不受我们控制；ffmpeg 的 http 协议本身不跟随 HTTP 重定向，所以重定向向量主要存在于上面两条 axios 路径。DNS 重绑定若要彻底解决需要出口代理/DNS pinning，属基础设施改动，未在本轮做。

### 四.3 b23.tv 短链是死代码 —— 已修

- `ServiceAdapter` 新增 `resolveShortLink(link)` 默认原样返回；`BilibiliAdapter` 覆写为「仅 b23.tv 才跟随跳转，且每一跳过 SSRF 检查」。
- `infoextractor.ts` 三处取 id 前都先 `await adapter.resolveShortLink(...)`（多行输入改为 for 循环）。
- 新增 2 条适配器用例（跟随跳转、非短链不动）。

### 四.4 密码找回的会话固定 —— 已修

- `accountRecoveryVerify` 改为轮换：新 token 签发并写入 session、吊销旧 token、下发 cookie，响应体带上 `token`。
- `PasswordReset.vue` 收到 token 后 `users/SET_AUTH_TOKEN`（与登录/注册一致），否则客户端会拿着已吊销的 token 继续请求。
- `accountrecovery.spec.ts` 更新为验证新契约：响应带新 token、旧 token 立即 401、后续用例用新 token。

### 四.5 用户缓存的唯一失效钩子可被客户端无限触发 —— 已修（限制频率）

见 P1-4 的通用令牌桶：`notify` 也被限制在 10 次/秒，缓存不会被单个客户端长期打穿。

### 四.6 balancer 部署下延迟探测收不到回复 —— 已修

见 P1-4 的 `ping → pong` 分支。

### 四.7 `corsFromHeaders` 把任何非空 ACAO 当作允许；3xx 被读成成功 —— 部分修复

- **已修**：`media-access.ts` 只把 2xx 当作「最终响应」。探测不跟跳（`maxRedirects: 0`），302 的响应头描述的是跳转本身，据此判断 CORS/Referer 策略没有意义。
- **按设计保留**：`corsFromHeaders` 对非空 ACAO 返回 true 未改。客户端在真正用 CORS 失败时有一套兜底（丢弃 `crossorigin` 重试并记住结果），乐观判定换来的收益大于代价；改成只认 `*` 会让「回显具体源但实际允许我们」的站点白白失去画质增强。此点与审查判断不同，属有意识的取舍。

### 四.8 「This is a bug.」内部口吻 —— 已修

`server/usermanager.ts` 三处（登录失败、账号无密码、校验异常）改为 `"An unknown error occurred. Please try again later."`，细节保留在服务端日志。

---

## 五、画质增强

| # | 问题 | 核实 | 修法 |
| --- | --- | --- | --- |
| 一.1 | WebGPU「质量」档改倍率不生效 | 成立 | `UpscaleLayer.vue` 的 scale watcher 从仅 `anime4k` 改为 `anime4k \|\| anime4k-quality`（两者都可能走「构建时固化尺寸」的 WebGPU 管线） |
| 一.2 | 播放详情「渲染目标」永远为空 | 成立 | 各渲染器在首帧同步上报 target，而 `start()` 在返回后清空它。改为 `start()` **开始处**（`stopRenderers()` 之后）清空、卸载时也清空，成功路径不再清 |
| 一.3 | 自动降档写进 localStorage | 成立 | settings store 抽出 `normalizeSettings`/`persistSettings`，新增 `UPDATE_TRANSIENT`（只改内存不落盘）；降档用 `UPDATE_TRANSIENT`。失败回退（设备确实跑不动）仍持久化——那是稳定事实，不是瞬态 |
| 一.4 | 影视档锐化滑块被禁用但着色器在读它 | 成立 | `VideoSettings.vue`：滑块对 `sharpen` 与 `film` 都启用（`film.ts` 每帧读 `getStrength()`，是实时的） |
| 一.5 | 文案与 v1.2.5 新行为矛盾 | 成立 | `zh-CN.ts`/`en.ts`：`scale-auto`、`scale-hint`、`intro-anime4k-quality`、帮助页 `enhance.text` 全部改写为「跟随显示尺寸；AI 档在鼠标设备上不低于 1.25× 源；无 WebGPU 时走 WebGL2」 |
| 一.6 | CNN 倍率下限被套用到不需要它的档位 | 成立 | `scale.ts` 新增 `isCnnUpscaleTier()`（`anime4k`/`anime4k-quality`/`anime4k-ultra`，三者的放大阶段都受 1.2× 门槛约束）；`UpscaleLayer`/`player-stats`/`VideoQueueItem` 三处改为 `isCnnUpscaleTier(mode) && canAffordCnnUpscale()` |
| 一.7 | 统计面板断点 760 vs 800 | 成立 | 见三.6 |

---

## 六、Rust 负载均衡器

**配置的线程安全（审查四.1）—— 已修，但未编译验证（本机无 `cargo`）**

- `crates/ott-balancer/src/config.rs`：`ConfigCell`（`UnsafeCell` + `unsafe impl Sync`）整体删除，改为 `static CONFIG: OnceLock<BalancerConfig>`。`set`/`init_default` 用 `OnceLock::set`（原子、先到先得），并发 `init_default()` 的数据竞争消失；`get()` 仍返回 `&'static`。
- 唯一会被「边读边改」的字段（region，基准测试会改）改为 `RegionSetting(RwLock<Region>)`，提供 `get()`/`set()` 与 `Deserialize` 实现；调用点：`balancer.rs` 两处读取、`benches/joins.rs`（原来通过 `get_mut()` 别名写入，现改为 `region.set(...)`）。`get_mut()`（返回 `&'static mut` 的安全函数）随之删除。
- 未做：本机无法编译/跑 `cargo test`，请在 CI（`rust.yml`）确认。

---

## 七、工程卫生

- `Cargo.toml`：删除悬空的 `harness_macros` 工作区依赖（全仓无任何引用，`crates/` 下也没有该目录）。
- 新增 `env/balancer.example.toml`（含 manual 发现方式的最小示例）并在 `env/.gitignore` 中放行；`AGENTS.md` 与 `deploy/balancer.Dockerfile` 引用的 `env/balancer.toml` 现在有可复制的来源。

---

## 八、明确未修（含原因）

| 项 | 原因 |
| --- | --- |
| P2-4 非英语言大面积缺 key（de/es/fr/pt-br/ru 缺 396–475 个） | 产品取舍：要么投入长期维护，要么在语言选择器里标注覆盖度，不是本轮能「顺手修」的。默认语言 zh-CN 与 en 的缺口已补齐 |
| P3-3 无障碍覆盖不均衡 | 需要逐组件设计与读屏实测，属独立工作项 |
| P1-3 中「把 SponsorBlock 移出关键路径」 | 需要重新设计 `room.update()` 的 IO 边界与缓存，风险大于收益；已加耗时指标以便量化后再做 |
| 四.2 的 DNS 重绑定 | 需要出口代理 / DNS pinning，属基础设施改动 |
| `corsFromHeaders` 乐观判定 | 有意识保留（见四.7） |
| 页脚指向上游的链接 | 页脚那一行本就标注为「上游项目」，是应当保留的署名；只把首页「更多功能」链接改成指向本 fork 的 issue 列表 |

---

## 九、对审查本身的更正（复核时发现）

1. **P0-1 的重试描述**：见 P0-1「对审查的更正」。
2. **P0-3 的本地失败原因不止一处**：除 `env/base.toml` 覆盖 api_key 外，`NODE_ENV` 未设为 `test` 时 `session_secret` 为空会让这 4 例变成 500。CI 同时满足「NODE_ENV=test」与「没有 base.toml」两个条件才全绿。
3. **一.6 的适用范围**：审查说「三处调用都无条件传 `cnnUpscale`」，成立；但需要下限的档位不止 `anime4k`——`anime4k-quality` 与 `anime4k-ultra` 的 WebGL2 链路同样带 1.2× 门槛（`anime4k-webgl.ts:42`），因此白名单是三档而非一档。
4. **二.7（登录后 socket 未重鉴权）**：注释确实不准确，但这是既有设计而非本分支回归；本轮只补齐了密码找回路径的 token 采纳。

---

## 十、验证记录（本机）

```sh
NODE_ENV=test node .yarn/releases/yarn-4.1.0.cjs workspace ott-server exec tsc --noEmit     # 无输出
NODE_ENV=test node .yarn/releases/yarn-4.1.0.cjs workspace ott-client exec tsc --noEmit     # 无输出
NODE_ENV=test node .yarn/releases/yarn-4.1.0.cjs workspace ott-server exec vitest run       # 48 files / 763 passed
NODE_ENV=test node .yarn/releases/yarn-4.1.0.cjs workspace ott-client exec vitest run       # 69 files / 784 passed, 24 skipped
node .yarn/releases/yarn-4.1.0.cjs biome check <changed files>                              # no issues
node .yarn/releases/yarn-4.1.0.cjs prettier --check "**/*.vue"                              # 见下
```

- 未执行：`cargo build/test`（本机无 `cargo`）、Cypress E2E、真机 GPU / WebGPU 验证、故障注入。
- `prettier --check "**/*.vue"` 请在提交前跑一次（本机已对改动的 `.vue` 执行 `--write`）。
