# 2026-11-19 项目审查推进与验证记录

## 范围与证据边界

-   基线：`f240d98`（main）。此前执行 `git pull --ff-only`，从 `a398b0d` 更新。
-   本文记录工作区修复，不是已经提交、推送或上线的版本。没有发布镜像，也没有访问生产。
-   保留原有 `.gitignore` 的 `.ace-tool/` 改动。已有差异与本任务前序修复记录一致；这不足以证明系统没有其他写入进程，未终止其他 Codex 会话。
-   用户七分区报告是发现线索。这里只把已复核且有回归验证的条目标记为“已修”；不宣称整个仓库没有 Critical，也不宣称约 30 条中低严重度已全部审清。
-   语义检索连续两次网络失败后采用源码、Git 差异/历史与实际测试。运行结果优先于注释及旧报告。

## 本轮优先修复

| 编号 | 来源分级 | 修复与条件                                                                                          | 主要证据                                                                                                                                                              |
| ---- | -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01  | 高       | shutdown / unload 等批量断开遍历数组快照，避免同步删除跳过相邻连接                                  | [clientmanager](../server/clientmanager.ts)、[真实 DirectClient 回归](../server/tests/unit/client-broadcast-lifecycle.spec.ts)                                        |
| N02  | 高       | 广播与心跳扫描使用快照，慢连接超过 8 MiB 积压被同步切断后不再漏掉下一位观众                         | 同上；相关连接套件 48 项通过                                                                                                                                          |
| N03  | 高       | PeerTube / Invidious service/id 执行实例策略；metadata 先检查公网，再按 2 MiB / 5s / 零隐式跳转抓取 | [实例 ID 解析](../server/services/parsing/instance-video-id.ts)、[边界回归](../server/tests/unit/services/adapters-network-boundaries.spec.ts)                        |
| N04  | 高       | Reddit 真实域名边界校验、内部入口再次验证、ID 拒绝路径注入，使用 HTTPS canonical endpoint           | [Reddit](../server/services/reddit.ts)、同上                                                                                                                          |
| N05  | 高       | HLS 主清单与选中变体均用 2 MiB / 5s 的有界请求                                                      | [HLS](../server/services/hls.ts)、[manifest helper](../server/services/parsing/manifest-fetch.ts)                                                                     |
| N06  | 高       | 只有最高稳定标签 push 且 commit 在默认分支历史中才提升 latest；写权限仅给 publish job               | [workflow](../.github/workflows/publish-image.yml)、[策略](../scripts/image-release-policy.mjs)、[14 项策略/Git 回归](../scripts/tests/image-release-policy.test.mjs) |
| N07  | 中       | recovery start / verify 被限流立即返回，不继续读账号、建验证码、发邮件或改密                        | [usermanager](../server/usermanager.ts)、[独立边界回归](../server/tests/unit/account-recovery-rate-limit.spec.ts)                                                     |
| N08  | 中       | 匿名列表的加载中及已保存密码房返回 currentSource: null；有效管理 API key 保留片源可见性             | [room API](../server/api/room.ts)、[列表/创建回归](../server/tests/unit/api/room-list-privacy.spec.ts)                                                                |
| N09  | 中       | 建房 description 与设置接口统一为 5000 字符上限，超限在建房前拒绝                                   | [schema](../common/models/zod-schemas.ts)、[公共校验回归](../common/tests/unit/room-validation.spec.ts)                                                               |
| N10  | 中       | SW 拒绝缓存 HTML/XHTML/缺类型的 200 回退；v3 清理本应用旧缓存，保留其他 scope                       | [sw.js](../client/public/sw.js)、[VM 回归](../client/tests/unit/service-worker-cache.spec.ts)                                                                         |

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

### 最终顺序验证

2026-11-19，本机 Windows / Node 22.19.0 / Yarn 4.1.0。lint、构建、全量测试顺序运行，没有与 Vitest 临时配置生成并行。

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

### Rust 结果与限制

Windows / Rust 1.89 MSVC：fmt、all-target/all-feature check、严格 clippy、严格 rustdoc 通过；非 harness 单测 41 项及文档测试 1 项通过。

完整 `cargo test --workspace --all-features --locked` 中三项 harness 长期等待；串行重试仍卡在 `should_track_clients`，180s 截止后只终止本任务启动的 Cargo 进程树。不能写成“Rust 全量通过”；根因尚未确定，不能将嵌套 cargo / Windows 子进程行为直接当作已确认根因，也不能外推 Linux CI 或生产。

## 尚未解决或尚未复核

1. 出站闭环：DNS 校验与实际连接仍未固定同一解析地址；ffprobe 后续资源、其他适配器需继续审查。禁止跳转后的真实 PeerTube / Invidious / Reddit 兼容性未做外部端到端验证。
2. 账号/权限：并发登录限流、用户名大小写桶、其他会话吊销、Discord 绑定与 OAuth state、IPv6 /64 限流、角色/房主 Redis 快照仍待逐项验证。
3. 媒体/队列：批量探测失败是否仍入队、ffprobe 等待队列、DASH 年/月时长、主动小 seek、权限继承及 Undo 副作用等线索尚未完成本轮闭环。
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

原始日志、差异检查点、数据库恢复证明保存在本地 `.git/codex-review-2026-11-19/`，不提交数据库或本地日志。完整 fetch 依据与 GitHub 事件变量含义分别对照 [actions/checkout v4 README](https://github.com/actions/checkout/tree/v4#usage) 与 [GitHub Actions variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)（访问日期：2026-11-19）。
