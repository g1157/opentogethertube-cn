# 2026-11-19 项目审查推进与验证记录

## 范围与证据边界

-   基线：`f240d98`（main）。此前执行 `git pull --ff-only`，从 `a398b0d` 更新。
-   前一批 47 个文件的修复已包含在 `e5a6a8e`（`win`）；续审恢复时该提交已存在，本批不重做或 amend。本文记录本地提交与验证，没有推送、发布镜像或访问生产。
-   登录限流与角色/房主快照续审已分别提交为 `020ba72`、`4f60d82`；批量媒体准入续审基于 `4f60d82`，修复与验证随本文记录。
-   原有 `.gitignore` 的 `.ace-tool/` 改动已随前批保留。续审初始工作区干净，逐文件核对前批 47 个文件与已验证快照一致；这不足以证明系统没有其他写入进程，未终止其他 Codex 会话。
-   用户七分区报告是发现线索。这里只把已复核且有回归验证的条目标记为“已修”；不宣称整个仓库没有 Critical，也不宣称约 30 条中低严重度已全部审清。
-   语义检索连续两次网络失败后采用源码、Git 差异/历史与实际测试。运行结果优先于注释及旧报告。

## 已闭环条目

| 编号 | 来源分级 | 修复与条件                                                                                                                | 主要证据                                                                                                                                                              |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01  | 高       | shutdown / unload 等批量断开遍历数组快照，避免同步删除跳过相邻连接                                                        | [clientmanager](../server/clientmanager.ts)、[真实 DirectClient 回归](../server/tests/unit/client-broadcast-lifecycle.spec.ts)                                        |
| N02  | 高       | 广播与心跳扫描使用快照，慢连接超过 8 MiB 积压被同步切断后不再漏掉下一位观众                                               | 同上；相关连接套件 48 项通过                                                                                                                                          |
| N03  | 高       | PeerTube / Invidious service/id 执行实例策略；metadata 先检查公网，再按 2 MiB / 5s / 零隐式跳转抓取                       | [实例 ID 解析](../server/services/parsing/instance-video-id.ts)、[边界回归](../server/tests/unit/services/adapters-network-boundaries.spec.ts)                        |
| N04  | 高       | Reddit 真实域名边界校验、内部入口再次验证、ID 拒绝路径注入，使用 HTTPS canonical endpoint                                 | [Reddit](../server/services/reddit.ts)、同上                                                                                                                          |
| N05  | 高       | HLS 主清单与选中变体均用 2 MiB / 5s 的有界请求                                                                            | [HLS](../server/services/hls.ts)、[manifest helper](../server/services/parsing/manifest-fetch.ts)                                                                     |
| N06  | 高       | 只有最高稳定标签 push 且 commit 在默认分支历史中才提升 latest；写权限仅给 publish job                                     | [workflow](../.github/workflows/publish-image.yml)、[策略](../scripts/image-release-policy.mjs)、[14 项策略/Git 回归](../scripts/tests/image-release-policy.test.mjs) |
| N07  | 中       | recovery start / verify 被限流立即返回，不继续读账号、建验证码、发邮件或改密                                              | [usermanager](../server/usermanager.ts)、[独立边界回归](../server/tests/unit/account-recovery-rate-limit.spec.ts)                                                     |
| N08  | 中       | 匿名列表的加载中及已保存密码房返回 currentSource: null；有效管理 API key 保留片源可见性                                   | [room API](../server/api/room.ts)、[列表/创建回归](../server/tests/unit/api/room-list-privacy.spec.ts)                                                                |
| N09  | 中       | 建房 description 与设置接口统一为 5000 字符上限，超限在建房前拒绝                                                         | [schema](../common/models/zod-schemas.ts)、[公共校验回归](../common/tests/unit/room-validation.spec.ts)                                                               |
| N10  | 中       | SW 拒绝缓存 HTML/XHTML/缺类型的 200 回退；v3 清理本应用旧缓存，保留其他 scope                                             | [sw.js](../client/public/sw.js)、[VM 回归](../client/tests/unit/service-worker-cache.spec.ts)                                                                         |
| N11  | 中       | 登录前依次预占小写用户名/IP 与每日 IP 配额；拒绝用户名不扣 IP，部分失败只退款已成功预占，成功不清空其他账号的 IP 失败分数 | [usermanager](../server/usermanager.ts)、[18 项登录准入回归](../server/tests/unit/login-rate-limit-admission.spec.ts)                                                 |
| N12  | 中       | 私有 userRoles 纳入内部脏状态，hasOwner 触发 owner 快照；正常检查点完成后恢复不再回滚角色/房主，未消除防抖与崩溃窗口      | [room](../server/room.ts)、[11 项访问状态恢复回归](../server/tests/unit/room-access-persistence.spec.ts)                                                              |
| N13  | 中       | 批量适配器拒绝的条目不再补回；缓存仅接收 service/id，非缓存安全服务必做准入；按原服务/ID 回配并保留改 ID 别名             | [提取器](../server/infoextractor.ts)、[基础适配器](../server/serviceadapter.ts)、[14 项回归](../server/tests/unit/batch-video-admission.spec.ts)                      |

“已修”指源码及对应自动化回归成立，可信度高；外部平台兼容性、真实浏览器、Docker 与线上效果尚未验证，不能宣称生产修复已完成。

### 既有 R04 / R06 与本机基线修复

-   R04：每个 Room 对象最多一项更新任务，全局并发 8，周期 tick 不再等待整个 Promise 集合。排队开始与更新返回后再次确认对象仍装载，避免卸载同名替代房间；定时启动幂等。[隔离回归](../server/tests/unit/room-update-isolation.spec.ts)。8 个槽全部长期阻塞仍会耗尽执行能力，未实现统一 DB I/O 取消。
-   R06：XML 解码最多 8 MiB、评论最多 100,000；客户端丢弃超过 2000 UTF-16 单元或含嵌套元素的单条文字。前后端各最多 4 个下载，缓存有条目及记账字节双预算。预检线性跳过注释、CDATA、处理指令；清理控制字符后再次预检，再创建 DOM。[公共预算](../common/danmaku.ts)、[有界 reader](../common/response-body.ts)、[流回归](../common/tests/unit/response-body.spec.ts)。
-   缓存 32 MiB / metadata 4 MiB 是 UTF-16 载荷及固定条目开销记账，不是 heap 实测。正文预算累计实际字节，不信任 Content-Length；取消不等待卡住的上游 cancel，微小同步块让出事件循环。
-   rate-limit 头采用 ASCII UTC HTTP date，避免中文 Windows 的本地时区名称使响应失败。[真实 HTTP 头回归](../server/tests/unit/rate-limit.spec.ts)。
-   Grafana 两个插件 SWC baseUrl 指向实际 workspace src；MSVC 使用系统 allocator，其他目标保持 jemalloc。[Cargo 目标依赖](../crates/ott-balancer/Cargo.toml)。
-   新增 Windows / Node 22 构建、SQLite 与本地 Edge runtime CI；Rust Windows CI 明确只执行非 harness 单测。新增任务通过 YAML 与策略不变量检查，本机执行不等于已经运行 GitHub hosted runner。

## 运行验证

### 独立数据库与基线分离

原 `server/db/test.sqlite` 存在旧测试账号残留，不能通过删除用户数据库来消除失败。全量检查前将该文件及可能的 journal/WAL/SHM 安全移入本工作区 `.git/codex-review-2026-11-19/` 检查点，迁移创建独立数据库；finally 恢复原文件并比较 SHA-256。`development.sqlite` 未移动。

首次独立库检查中全部运行用例通过，但新增 JSON fetch 测试的 afterEach 返回 VitestUtils 而非 void，类型检查产生 1 个未处理 source error，整体退出 1；已修复并重跑。该轮不算绿色。

### 前一批顺序验证（`e5a6a8e`）

2026-11-19，本机 Windows / Node 22.19.0 / Yarn 4.1.0。前批及登录续审的 lint、构建、全量测试均顺序运行，没有与 Vitest 临时配置生成并行。

| 检查                       | 最终结果                   | 条件或限制                                                                                |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `yarn install --immutable` | 退出 0                     | 锁文件未改；仍有 React/Grafana、Cypress peer 依赖警告                                     |
| `yarn lint-ci`             | 退出 0                     | ESLint 0 错误、27 警告；未通过关闭规则来消除错误                                          |
| `yarn build`               | 退出 0                     | 所有 workspace 声明的构建脚本通过，包含服务端、客户端及两个 Grafana 插件                  |
| 发布 tooling               | 14 通过                    | 策略与真实 Git 仓库回归；不等于已经执行发布                                               |
| common                     | 103 通过                   | 类型检查无错误                                                                            |
| 客户端                     | 1108 通过、24 跳过         | 跳过项不算已验证；不等于浏览器/手机/GPU 端到端                                            |
| 服务端                     | 1134 通过                  | 使用新建并完成迁移的 SQLite 测试库；类型检查无错误、无未处理错误                          |
| Edge / Miniflare           | 30 通过                    | 本地 runtime，不是线上部署                                                                |
| ott-vis                    | 2 通过                     | 类型检查无错误；不等于 Grafana 实例端到端                                                 |
| `yarn test` 总体           | 退出 0                     | 本轮合计 2391 个运行用例通过、24 个跳过；不重复相加此前针对性套件                         |
| 三份 workflow              | 本地 YAML 与配置不变量通过 | 检查 latest 提升门槛、权限、完整 checkout、Windows/SQLite/MSVC 任务；未运行 hosted runner |
| 本机 runtime 依赖检查      | 退出 0                     | 安装版本与锁文件及 limiter 补丁一致；没有执行 `--image` 或 Docker 验证                    |
| `git diff --check`         | 通过                       | 最终文件格式与差异检查；不等于所有未覆盖路径均正确                                        |

全量 `yarn test` 用时 3 分 48 秒。此前 lint 首次跑到 ESLint 时发现调度器 Promise `.finally()` 风格及测试 `globalThis` 定义两项错误，已改为等价的 awaited `try/finally` 和 Node `global` 引用并复跑通过。首次全量测试的 callback 类型错误同样已经闭环，未将原来的退出 1 当作通过。

隔离测试结束后已恢复原 `test.sqlite`，SHA-256 与运行前一致；`development.sqlite` 未移动且 SHA-256 不变。生成的独立测试库和哈希证明留在本机 `.git` 检查点。没有在旧测试库原位重新运行测试，因此不能将本次隔离结果外推为旧库数据状态已经清理或必然通过。

真实 metadata HTTP 回归包括：普通 JSON、带长度超限、chunked 超限、gzip 解码后超限、不跟随 302，以及持续送字节时仍在 5s 截止。loopback 测试仅验证资源预算；公网/私网校验另在 NODE_ENV=production 下测试，不能用 test 环境跳过 DNS 的结果证明生产 SSRF 安全。

### 登录限流续审（基于 `e5a6a8e`）

-   旧实现先读配额、认证失败后才扣点。原版 17 项回归出现 **13 失败 / 4 通过**：同账号 15 个并发请求、跨账号同 IP 110 个并发请求均能越过 10 / 100 的认证准入预算，大小写变体也使用不同桶。
-   首版并行预占仍不正确：延迟 IP 扣点确认的 110 次同账号突发测试中，只有 10 次进入认证，IP 计数却为 20。最终改为先用户名、后 IP 顺序预占；用户名拒绝不触及 IP，IP 拒绝或存储异常时只退还已成功预占的用户名点数。拒绝桶可能没有实际扣点，不能直接 reward。
-   仅配额键转小写，传给 Passport 的凭证文本保持原样；失败认证不重复扣点；成功重置连续用户名失败桶，只归还本次 IP 点数。捕获请求开始时的限流开关，避免认证中途切换开关产生无扣点退款或遗漏退款。存储异常不执行认证，转入错误处理中间件。
-   针对性测试 **21 通过**（登录 18、recovery 3）。新延迟夹具曾被完整服务端编译检出 callback 返回类型不匹配，已添加显式 void 类型并重跑；不能用 Vitest 的 spec-d 类型检查替代完整 tsc。
-   最终 `yarn lint-ci` 与 `yarn build` 均退出 0；lint 仍为 0 错误、27 警告。新迁移 SQLite 上的 `yarn test` 退出 0：服务端 **1152**、common **103**、客户端 **1108 / 24 跳过**、Edge **30**、ott-vis **2**、发布 tooling **14**，合计 **2409 通过 / 24 跳过**，用时 3 分 50 秒。针对性 21 项不重复累加。
-   全量检查的 952 个验证输入文件在运行期间哈希未变。隔离运行前发现当前 test.sqlite 哈希为 `F68832B5…`，不同于前批交接的 `CA8EC598…`，修改时间早于本次续审执行，改写来源未确认；未用旧备份覆盖当前文件。本次备份、恢复的是当前实物，前后完整 SHA-256 一致；development.sqlite 的 `DA35A40B…` 也保持不变。
-   本机 workspace 链接曾导致 Node 读取返回 UNKNOWN；immutable install 未修复。只备份并重建七个已核验目标的 junction 条目，目标源码目录未移动，未改依赖、exports 或锁文件，根因未确定。

登录准入测试使用真实 RateLimiterMemory 的 consume / reward 行为和生产 10 / 100 点预算，缩短 TTL；隔离 Passport、token、models 与 Redis transport，不进行 SQL 查询或外部认证。延迟确认测试验证记账竞态，不是对真实 Redis 的分布式压测。现有全量 API 测试通过也不能外推真实多实例 Redis、PostgreSQL、浏览器或生产认证链路。

### 角色与房主快照续审（基于 `020ba72`）

-   沿 `promoteUser → syncDirty → serializeState` 与 `owner setter → hasOwner → syncDirty` 复核后补充回归。清理夹具错误后的 HEAD 基线为 **11 项预期行为失败**：升/降级、认领、替换和移除房主均仍恢复旧 Redis 快照；永久存储拒绝时角色变更也没有待重试脏标记。
-   内部脏集合允许私有 `userRoles`，角色变更显式调度检查点；`hasOwner` 同时触发保存实际 owner 身份。客户端同步字段白名单不变，完整角色集合和 owner 对象不广播。Redis owner 仍只保存 id，不保存 Buffer hash / salt；回归覆盖临时与永久房间、旧房主失权及存储失败后重试。
-   新增恢复回归 **11 通过**；与授权 24、密码房 5、调度隔离 6 项共同验证 **46 通过**。首轮夹具的 debounce spy 清理顺序、凭证字段类型与正则作用域 lint 错误均按真实输出修复，没有关闭规则，未把带清理错误的首次运行当作干净基线。
-   完整服务端编译、`yarn lint-ci`、`yarn build` 均退出 0；全量新迁移 SQLite 的 `yarn test` 退出 0，用时 3 分 47 秒。服务端 **1163**、common **103**、客户端 **1108 / 24 跳过**、Edge **30**、ott-vis **2**、发布 tooling **14**，合计 **2420 通过 / 24 跳过**；此前针对性测试不重复累加。
-   全量运行的 953 个验证输入文件哈希未变；本批原 test.sqlite 的 `F68832B5…` 已恢复，development.sqlite 的 `DA35A40B…` 保持不变，完整哈希与恢复日志另存于 `room-access-followup/`。

边界：这批验证使用真实 Room 序列化、同步和恢复代码，但 Redis transport 是项目现有 mock，SQL 写入与广播在新回归中隔离。沿用现有 5 秒防抖保存，仅证明正常检查点完成后的恢复；连续更新推迟保存、Redis 失败及非优雅退出在途窗口未消除，不是事务级即时权限持久化。房主替换/移除用 setter 验证快照，不代表新增了公开转让/解绑 API，也不代表已验证真实数据库的解绑语义。

### 批量媒体准入续审（基于 `4f60d82`）

-   原 `getManyVideoInfo` 会补回基础适配器跳过的失败输入；非缓存安全服务根据客户端元数据计算缺项，可跳过实际 fetch；跨服务输出只按 id 匹配，别名改变 service/id 后还会丢失原请求身份。缓存查询接受完整客户端对象，真实缓存无记录分支又可能把这些元数据作为结果返回。
-   缓存专项首次没有初始化 models/index 的导出绑定，findAll 未被调用，该次失败不能当作漏洞运行证据。初始化模型并仅 mock SQL 查询后重跑干净 A/B：HEAD **12 项预期行为失败 / 2 通过**，修复后 **14 全部通过**；原数据库哈希未变。
-   缓存查询现在只接收 service/id；克隆结果避免改写调用方对象。非缓存安全服务即使客户端元数据齐全、缓存字段列表为空也必须执行 fetch。请求中未取得成功结果的条目不再复原，只保留完整缓存命中；原服务和请求 id 各自参与回配，跨服务同值 ID 不混淆。
-   基础批处理可选回调报告原请求 id，支持 PeerTube / Invidious 转成不同 service/id 的媒体地址；返回值仍为 Video[]，YouTube / Pluto 原有批处理实现不变，同 ID 的旧批处理返回数组仍兼容。回归覆盖缓存命中、拒绝项邻接、客户端元数据、SQL 缓存未命中、顺序/别名、调用对象不变及可用条目的队列 extras。
-   完整服务端编译、`yarn lint-ci`、`yarn build` 均退出 0；新迁移隔离 SQLite 上的 `yarn test` 退出 0，用时 3 分 48 秒。服务端 **1177**、common **103**、客户端 **1108 / 24 跳过**、Edge **30**、ott-vis **2**、发布 tooling **14**，合计 **2434 通过 / 24 跳过**，不重复累加此前针对性或全量运行。
-   954 个验证输入文件在全量运行期间哈希未变；原 test.sqlite 的 `F68832B5…` 和 development.sqlite 的 `DA35A40B…` 保持不变，迁移库与恢复证明单独保存在 `batch-media-followup/`。

边界：真实 Direct 的 file: 拒绝、基础批处理和真实缓存辅助函数参与回归；SQL 查询/写入与外部元数据响应均隔离，没有读取实际私有文件、发外部媒体请求或启动 ffprobe。更严格的降级策略会过滤需要重新 fetch 但未取得结果的不完整缓存；完整缓存命中仍不 fetch。Direct 内部已经允许的“可支持 MIME、探测失败则未知时长”行为不变。本批不清理旧缓存数据，也未验证历史受污染数据、真实平台端到端兼容性或新增探测负载的压测；ffprobe 等候预算与出站地址闭环仍未解决。

### Rust 结果与限制

Windows / Rust 1.89 MSVC：fmt、all-target/all-feature check、严格 clippy、严格 rustdoc 通过；非 harness 单测 41 项及文档测试 1 项通过。

完整 `cargo test --workspace --all-features --locked` 中三项 harness 长期等待；串行重试仍卡在 `should_track_clients`，180s 截止后只终止本任务启动的 Cargo 进程树。不能写成“Rust 全量通过”；根因尚未确定，不能将嵌套 cargo / Windows 子进程行为直接当作已确认根因，也不能外推 Linux CI 或生产。

## 尚未解决或尚未复核

1. 出站闭环：DNS 校验与实际连接仍未固定同一解析地址；ffprobe 后续资源、其他适配器需继续审查。禁止跳转后的真实 PeerTube / Invidious / Reddit 兼容性未做外部端到端验证。
2. 账号/权限：并发登录准入与用户名大小写桶已按 N11 闭环，角色/房主触发快照与正常检查点恢复已按 N12 验证；真实 Redis 多实例、保存失败与崩溃窗口、其他会话吊销、Discord 绑定与 OAuth state、IPv6 /64 限流仍待逐项验证。
3. 媒体/队列：批量失败输入复原、客户端元数据绕过与原服务/id 回配已按 N13 修复并回归。ffprobe 等候队列预算/超时及交接计数疑似竞争（目前仅源码推断、未运行确认）、历史缓存数据与真实平台兼容性、DASH 年/月时长、主动小 seek、权限继承及 Undo 副作用仍未闭环。
4. 客户端：后台准备回执、字幕遮罩、对象引用重置、设置权限快照回滚、Direct probe 晚到结果、WebGPU 分辨率切换、iOS 全屏手势仍待验证；不以 mock 单测替代真机结论。
5. 运维/周边：便签大小写、Redis 键规范、备份 .partial、原报告中的公开地址、Rust scheduler 竞争及 collector 边界尚未全部复核。
6. 未覆盖的完整模块仍包括原报告列出的历史迁移、deploy/migrate、docker 脚本、部分平台适配器、播放器/controls 模板、film 增强、Rust selection/state_stream/harness、Grafana panel 内部等。读取某入口或运行已有测试不等于逐行审清该模块。
7. 未验证 PostgreSQL、Docker 镜像运行、GitHub 发布执行、生产部署、真实 GPU 完成/在途资源、浏览器/手机/HDR 与所有第三方服务端到端。

## 复验命令与日志

```powershell
$env:NODE_ENV = "test"
$env:DB_MODE = "sqlite"
$env:VITEST_MAX_THREADS = "2"
$env:VITEST_MIN_THREADS = "1"
$env:VITEST_MAX_FORKS = "2"
$env:VITEST_MIN_FORKS = "1"
yarn install --immutable
yarn lint-ci
yarn build
# Use a fresh migrated test DB and restore the previous DB; do not delete it.
yarn db:migrate
yarn test
cargo fmt --all -- --check
cargo check --workspace --all-targets --all-features --locked
cargo clippy --workspace --no-deps --all-features --all-targets --locked -- -D warnings
cargo doc --workspace --no-deps --all-features --locked
cargo test --workspace --exclude harness --exclude harness-tests --all-features --locked
```

不要改动或格式化 Vitest 正在生成的 tsconfig.vitest-temp.json。全仓 lint / build / test 顺序执行，避免临时文件竞态误判。

原始日志、差异检查点、数据库恢复证明保存在本地 `.git/codex-review-2026-11-19/`，登录、角色快照和批量媒体续审分别位于其 `login-followup/`、`room-access-followup/` 和 `batch-media-followup/` 目录，不提交数据库或本地日志。完整 fetch 依据与 GitHub 事件变量含义分别对照 [actions/checkout v4 README](https://github.com/actions/checkout/tree/v4#usage) 与 [GitHub Actions variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)（访问日期：2026-11-19）。
