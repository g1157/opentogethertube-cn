# 2026-11-23 全项目复查：异步错误边界、CORS 判定与交付瘦身

> **已归档（历史快照）**：本文的数字、行号与结论只代表写作时的版本，当前实现请以 [文档索引](../README.md) 与代码为准。

## 范围与证据边界

-   基线：`eb15cf5`（`main`，工作区干净）。
-   本轮按入口、跨模块调用、资源生命周期、协议边界与构建产物复查；重点放在此前审查列出的
    R11、R12、R09，以及“未解决”列表中一直没编译过的 Rust 测试。
-   证据分为三类：**源码核实**（路径与调用链存在）、**本机执行**（测试 / 构建 / lint / cargo）、
    **未验证**（真实浏览器、手机、GPU、生产部署）。本文不把本机单测外推成线上验收。
-   没有执行生产攻击性负载，没有部署镜像，没有真机 / 真实 GPU 端到端。

## 已确认问题与修复

| 编号 | 级别 | 证据与影响 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| N01 | P1 | Express 4 不等待 async 路由返回的 Promise。`user`、`auth`、`danmaku`、`status`、`dev` 与 `usermanager` 里的 async 处理器在 Redis / SQL 抛错时会一直不返回，只留下 unhandled rejection；`req.login` / `req.logout` 的异步回调也在响应链之外 | 新增 [asyncHandler](../../server/util/async-handler.ts) 与 [apiErrorHandler](../../server/api/error-handler.ts)，把 rejection 交给路由错误中间件；`buildApiRouter` 末尾挂载统一 JSON 错误处理；登录 / 注册 / 登出改为可 await 的 `loginAsync` / `logoutAsync` / `authenticateLocal`；`main()`、SIGINT / SIGTERM 与 `passportErrorHandler` 也不再吞掉启动 / 关闭失败 | 8 项 async 错误回归；全量服务端 1237 通过 |
| N02 | P2 | `body-parser` 在路由之前报错，绕过了 API 路由内的错误处理，`/api` 的坏 JSON 会得到 Express 默认 HTML 错误页；返回体形状与其余 API 不一致 | `apiErrorHandler` 识别 `error.status` 4xx（400 / 413 / 415），返回 `{ success:false, error:{ name, message } }`；`app` 在 `/api` 路径上复用同一处理器 | 新增坏 JSON 回归；`cache-headers` / `async-errors` 全绿 |
| N03 | P2 | `corsFromHeaders` 只看 `Access-Control-Allow-Origin` 是否非空。源站只允许别的站点时，探针仍报“支持 CORS”，画质增强随后读取像素失败；探针也没发送浏览器实际发送的 `Origin` | 探针发送 `Origin`；`corsFromHeaders` 在已知请求源时要求 `*` 或与源站 origin 完全一致（scheme / host / port 归一化）；HLS 主清单、选中的媒体清单、DASH 清单都携带 app origin 后再判定 | `cors-probe` 5 项、`media-access` 13 项、`hls` 7 项通过 |
| N04 | P2 | 永久房 `saveRoom` 成功后，密码落盘、`room.update()` 或 `room.sync()` 失败会留下数据库行；同名重试得到“已存在”，但房间从未真正加入。临时房也可能留下密码键 / Redis 快照 | `createRoomUnlocked` 在保存后的失败路径调用 `rollbackRoomCreation`：停掉计时器、清 `room:` / `room-sync:` / 临时房密码键，永久房删除数据库行；清理失败只记录日志，不覆盖原始错误 | `room-load-concurrency` 新增 1 项回滚回归；原有 4 项通过 |
| N05 | P2 | `VideoQueue.insert` / `move` 在锁外检查 `_items.length`，排队的其它操作先执行时，检查结果可能已过期；插入会落在错误的位置而不是拒绝 | 边界检查移入同一把 `Mutex` 内；新增“先 evict 再 insert / move”的并发回归 | `videoqueue` 2 项通过 |
| N06 | P2 | 多数 API 响应没有显式缓存策略。房间状态、账号数据与密码判定依赖 Cookie / Header 中的 token，共享缓存不应保存 | `buildApiRouter` 对全部 API 响应默认 `Cache-Control: no-store`；`previewAdd`、girigiri 等需要缓存的路由随后覆盖自己的头 | `cache-headers` 1 项通过；原有缓存头测试通过 |
| N07 | P2 / 成本 | `createVuetify` 全量注册 `vuetify/components` 与 `vuetify/directives`，生产包把未使用的组件全部带上；此前尝试移除时，18 项组件测试因运行时 `template` 字符串不再能解析而回滚 | 生产构建不再注册全量组件；开发和测试构建仍保留注册，供运行时 `template` 字符串使用；SFC 模板仍由 `vite-plugin-vuetify` 改写为直接导入 | 客户端 107 个文件 / 1164 项通过；生产构建退出 0；`vendor` JS 约 1119 → 931 KB，vendor CSS 约 220 → 144 KB（未压缩） |
| N08 | P2 | 2026-11-20 记录里 `crates/ott-balancer` 的改动“未编译”。本轮实际运行发现两个 in-flight gauge 测试并行互踩全局 Prometheus 指标：一个测试 reset 后另一个测试读到 0 | 两个测试用 `tokio::sync::Mutex` 串行化；只改测试，不改指标实现 | `cargo fmt`、严格 `clippy -D warnings`、非 harness 全量测试通过 |
| N09 | P3 | `loadLanguageAsync` 在 composition 模式下把 `i18n.global.locale`（ref）与字符串比较，同语言分支永远不成立，虽然随后被已加载列表兜底 | 取 `.value` 后再比较 | 客户端全量通过；无行为变化 |
| N10 | P3 | 房间认领（claim）分支调用 `room.syncUser` 没有 await，广播失败会成为游离 rejection | 改为 `await room.syncUser(...)` | 服务端全量通过 |
| N11 | P2 / 性能 | Vote 模式房间每个 tick 都对整个队列 `orderBy` 并序列化，即使没有任何投票或队列变化 | `queueOrderDirty` 标志在投票、队列变更、模式切换时置位，排序成功后清除。第一版直接读 `_dirty` 是错的：`sync()` 的 50ms 防抖会先清空 dirty，下一次 tick 就永远不排序；专项回归覆盖“投票后排序、空闲 tick 不排序” | `room.spec.ts` 新增 1 项，54 项通过 |
| N12 | P3 / 性能 | `Room.update()` 仅为了判断“有没有观众”就构造完整的 `users` 数组并计算每个角色 | 改用 `realusers.length` | 服务端全量通过 |
| N13 | P2 / 播放 | 准备轮启动（`startPreparedPlayback`）直接置 `isPlaying`，没有刷新 `lastPlayAt`；准备时间超过 2s 启动宽限后，首位观众的一次 buffering 报告就能让 buffer gate 立刻再次暂停 | 启动准备轮时刷新 `lastPlayAt` | `buffer-gate` 29 项、`playback-preparation` 39 项通过 |
| N14 | P2 / 后台成本 | HLS 在隐藏标签页把前向缓冲压到 60s，DASH 仍按完整偏好下载；两个播放器各写一套判断 | 新增共享 `visibleBufferSeconds`，HLS / DASH 共用；DASH 监听 `visibilitychange` 并更新 buffer 设置 | 新增 2 项 helper 回归；`MediaPlayers` 18 项通过 |
| N15 | P3 / 性能 | 250ms 时钟每次都在房间“应播未播”时尝试自愈 `play()`；预取只在队列长度变化时重置，投票重排后会继续预热错误的下一项 | 自愈最多 1 次/秒；预取按 `queue[0]` 的 service:id 重置。两者都不改变播放状态机，只减少重复工作 | 客户端全量 1164 通过 / 24 skip |
| N16 | P2 / 播放 | R14：周期 tick 与收到 sync 的被动纠偏阈值不同；不可微调时 tick 用 1s，sync 用 300ms，同一漂移会因入口不同而一个修、一个不修 | 抽出共享 `passiveSeekLimit`：可微调且播放中 3s（初始 10s）；无微调时原生 300ms，嵌入式 1s（seek 是 API 重载/估算）。`seekIsExpensive` 由播放器 `supportsRateBend === false` 决定 | `playback-sync` 新增 3 项，56 项通过；原有 native / embedded 行为保留 |
| N17 | P2 / 播放 | `media-seek` 的硬 seek 死区只有 50ms。新换源已在 0.1s 后开始播放时，房间位置 0 仍会 pause + `currentTime=0`，清空音频管线，表现为开头卡顿 | 死区调到 250ms，与首帧准备、恢复快照的容差一致；真实跳转不受影响 | 新增 `media-seek` 2 项；`media-recovery` / `playback-sync` 全绿 |
| N18 | P2 / 播放 | 文档称后台标签页会以 `visible:false` 退出准备轮，但 `isOwner` 先要求 `visible !== false`；已在后台的观众不会上报，其他观众白等 8s | 准备引擎在 `reconcile` 中对已隐藏且 eligible 的观众一次性上报 `firstFrame:false, visible:false`；`visibilitychange` 触发一次 `tick`。服务端原有 drop 路径现在真正被走到 | 客户端新增 1 项，25 项通过；服务端新增 1 项，41 项通过 |
| N19 | P2 / 播放 | 准备轮启动用 `Date.now()` 与 `startAt` 比较。系统时钟回拨后，相对定时器已到期但 `Date.now` 还没追上，房间会卡在“已 ready 但不开始” | 定时器回调设置 `playbackStartTimerDue`，启动判断接受“相对定时器已到期或墙钟已到期”；`clearPlaybackStartTimer` 同时清标记。`update()` 的兜底也读这个标记 | `playback-preparation` 新增 1 项，41 项通过 |
| N20 | P3 / 播放 | `onPlayerApiReady` 先调用 250ms 时钟，再无条件 `applyIsPlaying`；时钟自愈和事件可能各发一次 `play()` | 与 `onPlayerReady` 一样检查 `timestampUpdate()` 的返回值，只有在时钟没有自愈时才补一次 | 客户端全量通过 |
| N21 | P2 / 播放 | `currentSource` 的对象身份变化就重置 `playbackSync` / `localPlaying`。服务端学习未知时长或其它元数据更新时会重发 `currentSource`，即使仍是同一个视频，也会把正在播放的画面暂停并重新 seek | 源切换判断改为 `service:id`（或 player 身份）变化；同源元数据更新提前返回。时长学习不再触发播放状态重置 | `RoomInteraction` 45 项、客户端全量通过 |
| N22 | P3 / 播放 | 准备失败原因可超过 200 字符，WS schema 会拒绝整条 `status` 消息并 kick 客户端；诊断信息反而让人掉线 | 发送前截断到 200 字符 | `playback-preparation` / 客户端全量通过 |
| N23 | P2 / 播放 | 探测失败的 Direct/HLS/DASH 未知时长 VOD 永远没有 `length`，服务端看不到片尾，队列停在已结束的视频 | 准备回执新增 `durationSeconds`；服务端仅在源仍无可用长度、且回执属于本轮 source 时填入并走正常片尾检测 | 服务端新增 1 项（42 项通过）；客户端 `sendReady` 过滤 7 天上限 |
| N24 | P1 / 可靠性 | Redis 超时只包装了公共 `sendCommand`，但 node-redis v4 的 `get/set/multi` 等走私有 executor，实际命令没有截止时间；连接在但服务不回时房间操作可能一直等待 | 对实际使用的 `get/set/setEx/exists/del/incr/incrBy/expire/pExpire/ttl/pTTL/keys/info/dbSize/publish/eval/ping` 注入 `AbortSignal` command options；`multi().exec()` 也增加调用方截止。多命令不可逐条取消，已在代码注释说明边界 | 新增 1 项“命令不回复则按 5s 失败”回归；服务端全量通过 |
| N25 | P1 / 可靠性 | 八个 checkpoint 槽位被慢任务占满时，其他房间的 `room.update()` 也被同一个信号量挡住；自动换片、准备轮兜底和周期同步一起停滞 | 把内存 tick 与 DB/Redis checkpoint 拆成两个单飞队列：tick 完成后再调度 checkpoint，checkpoint 只占用自己的 8 个槽；tick 不再等待旧 checkpoint。更新隔离回归改为验证“8 个 checkpoint 卡住时所有房间仍每秒 tick” | `room-update-isolation` 6 项通过，覆盖全槽占用、卸载丢弃和失败重试 |
| N26 | P1 / 内存 | HLS 的 `maxBufferSize` 不是硬上限：hls.js 计算 `max(maxBufferLength, 8*size/bitrate)` 后再取 `maxMaxBufferLength`；默认 300s + 6 倍上限在高码率下仍可能占几百 MB，180s 回退缓冲也没有字节约束 | 新增 `hlsBufferBudget`：按当前档位码率把字节预算分成 60% 前向 / 35% 回退，`maxBufferLength` 与 `maxMaxBufferLength` 都取前向预算，`backBufferLength` 取回退预算；清单解析、切档、可见性变化时重算 | 新增 4 项 helper 回归；`MediaPlayers` 18 项更新后通过 |
| N27 | P2 / 网络 | 预取在 `fetch` 返回响应头后就把 `inFlight` 清空；随后 `reset()` 无法取消仍在传输的响应体，忽略 Range 的源站可能继续下载大文件 | 预取在响应体处理结束前保持 controller；只读最多 256 KiB，忽略 Range 返回 200 时提前取消；8s 截止；`reset()` 通过 signal 取消 reader/body | `next-media-prefetch` 19 项通过 |
| N28 | P2 / 播放 | 房间 sync 统一使用 `tolerateSmallDrift`，显式拖动/seek 的 2s 位置变更可能被本地变速吸收，其他观众没有立即跟随 | 服务端 `seekRaw` 增加单调 `seekId` 并随 sync 下发；客户端看到新 id 时走无容忍的 `room-seek`，普通位置 sync 仍走被动纠偏 | `room.spec` 显式 seek 回归；客户端全量通过 |
| N29 | P2 / 播放 | 开启等待缓冲模式时，后台标签页的 buffering 报告仍能暂停前台观众，即使最新 diagnostics 已标明 hidden | `evaluateBufferGate` 排除 90s 内 `hidden:true` 的观众（隐藏页心跳本身会被节流）；切回前台并上报 `hidden:false` 后恢复参与 | `buffer-gate` 30 项通过 |
| N30 | P2 / 网络 | HLS 启动带宽估计永久保存，没有时效或网络类型失效；弱网沿用快网估计会选过高档位 | 存储 `{value, at, network}`；7 天过期、数据节省模式忽略、网络从快变慢时失效；旧裸数字格式不再信任 | 新增 4 项回归；`MediaPlayers` 通过 |
| N31 | P2 / 首屏 | 手动分包把 Vimeo / PeerTube / Sortable 全部归入启动 vendor，虽然播放器是异步组件 | 这些可选依赖不再进入 vendor，留在对应异步 chunk；vendor 约 **931 → 852 KB**（未压缩），Room chunk 约 217 → 255 KB | 生产构建退出 0；Vimeo 39 KB、PeerTube 8 KB 独立异步 chunk |
| N32 | P3 / 性能 | 每个队列条目都注册 window resize 监听，只有 add-preview 需要测量播放器盒 | `isPreview === false` 的条目不再测量或监听，卸载时也只移除自己安装的监听 | 构建与客户端全量通过 |
| N33 | P2 / 内存（Rust） | Balancer 代理先把请求体 `collect()` 成 Bytes，没有显式大小上限 | 用 `http_body_util::Limited` 限制请求体 16 MiB，超限返回 413；响应体仍整体缓冲，流式转发保留为后续项 | `cargo fmt`、严格 clippy、非 harness 全量测试通过 |

## 对另一份审查的逐条核对

| 另一份审查条目 | 核实结论 | 本批处理 |
| --- | --- | --- |
| 1. HLS `maxBufferSize` 不是硬上限 | 成立。hls.js 源码里 `maxBufLen = max(8*maxBufferSize/bitrate, maxBufferLength)`，再由 `maxMaxBufferLength` 截断；回退缓冲另算 | 已修（N26）：按码率把字节预算换算成前向 / 回退秒数，并在清单解析、切档、可见性变化时重算 |
| 2. Redis 超时包装没覆盖常用命令 | 成立。node-redis v4 的命令方法走私有 `commandsExecutor`，不经过公开 `sendCommand` | 已修（N24）：命令方法注入 `AbortSignal`，multi 增加调用方截止；批量命令不能逐条取消，保留边界说明 |
| 3. 八个 checkpoint 占满后阻塞其他房间 tick | 成立。原实现的信号量同时包住 `update()` 与 `sync()` | 已修（N25）：内存 tick 与 checkpoint 分离，checkpoint 槽位只限持久化；回归覆盖全槽占用时所有房间仍 tick |
| 4. 预取收到响应头后取消失效 | 成立。原 `finally` 在响应体处理前清空 `inFlight` | 已修（N27）：保持到 body 读取/取消结束，读取上限 256 KiB，忽略 Range 的 200 也提前取消，8s 截止 |
| 5. 显式拖动与被动纠偏未区分 | 成立。所有位置 sync 都走 `tolerateSmallDrift` | 已修（N28）：服务端 `seekId` 区分显式 seek；新 id 立即硬定位，普通 sync 仍可微调 |
| 6. 后台观众仍可暂停前台 | 成立（默认关闭的等待模式除外） | 已修（N29）：15s 内 `hidden:true` 的 buffering 报告不参与等待；回前台后恢复 |
| 7. 启动带宽估计没有过期/网络处理 | 成立 | 已修（N30）：7 天过期、网络变慢失效、saveData 忽略、旧裸数字格式不信任 |
| 8. 可选播放器 SDK 进入启动 vendor | 成立。构建产物可见 Vimeo / PeerTube / Sortable 在 vendor | 已修（N31）：移入异步 chunk，vendor 约 931 → 852 KB；Room chunk 因 Sortable 增加，但不进首屏 |
| 9. 每个队列条目注册 resize 监听 | 成立 | 已修（N32）：只有 `isPreview` 条目测量/监听 |
| 10. Balancer 完整缓冲请求/响应体 | 请求体无上限成立；响应体全缓冲也成立。实际暴露面仅限启用 balancer 的 HTTP/API 代理 | 部分修（N33）：请求体 16 MiB 上限并返回 413；响应流式转发仍需改返回类型和背压，未在本批完成 |

## 运行验证

本机 Windows / Node 22.19.0 / Yarn 4.1.0，2026-11-23。

| 检查 | 结果 |
| --- | --- |
| `yarn lint-ci` | 退出 0；Biome / Prettier / `tsc --noEmit` / ESLint 0 error，26 条既有 warning |
| `yarn build` | 退出 0；包含客户端、服务端、Edge dry-run、两个 Grafana 插件 |
| `yarn test` | 退出 0；合计 **2573 通过 / 24 跳过** |
| 客户端 | 107 个文件通过、3 个跳过；1164 通过 / 24 跳过 |
| common | 12 个文件，103 通过；类型无错误 |
| 服务端 | 83 个文件，1237 通过；类型无错误 |
| ott-edge | 31 通过（`node --test`） |
| ott-vis / datasource / panel | 2 / 6 / 30 通过 |
| Rust | `cargo fmt --check`、`cargo clippy --workspace --no-deps --all-features --all-targets --locked -- -D warnings`、`cargo test --workspace --exclude harness --exclude harness-tests --all-features --locked` 全部退出 0；balancer 24、协议 / collector / common 共 17、doc test 1 |

构建产物对照使用同一 `vite build`，不含 gzip。旧数值取 `docs/archive/project-review-2026-11-17.zh-CN.md`
记录的 1119 KB；本轮实测新 `vendor` 为 931 KB。两者都不是压缩后传输字节，也不代表首屏没有其它
chunk 成本。

## 未解决或未验证

1. **真实浏览器 / 设备**：没有验证生产页面的 Vuetify 组件是否全部由 SFC 改写覆盖，也没有重跑
   Chrome / Firefox / 手机 / Safari / 低端 GPU 矩阵。构建体积与组件测试不能替代真机。
2. **CORS 判定的开发环境差异**：`appOriginFromHostname` 仍固定 `https://`。本地 `http://localhost:8080`
   页面的实际 `Origin` 与此不同，真实源站若只允许开发源，探针可能给出错误判定；生产 HTTPS 不受影响。
3. **R01 出站 DNS 闭环**：`assertPublicMediaUrl` 的校验与实际连接仍未固定同一解析地址；ffprobe 后续
   读取、重定向与嵌套资源没有统一固定出口。本轮未改。
4. **R02 / R03 / R05**：GPU 完成观测、纹理预算、暂停 / seek 的全队列写放大仍未实现。本轮只修了
   N04 的建房回滚，没有把持久化拆成队列内容与播放位置两条 checkpoint。
5. **R08 依赖**：没有重新跑镜像安装树公告清点；Zod / TOML 跨主版本迁移仍未做。
6. **R13 / R14 / R15**：起播时钟仍用 `Date.now()` 与固定 +1 s；被动漂移的两个阈值未统一；Bilibili
   iframe 仍只能粗同步。本轮没有改同步策略。
7. **R18 locale**：除 en / zh-CN 外的 locale 仍缺大量键，回退到英文；本轮只修了同语言比较，没有
   补齐翻译或加缺键预算。
8. **R19 / R20**：Rust collector / balancer 的入站鉴权、CORS 与流式 body 仍未处理；`Room.vue` 仍约
   3050 行，未拆分。
9. **跨实例建房回滚**：N04 只清理本次进程内确认由本实例写入的行 / 键；多实例同名临时房的竞态
   没有分布式锁或数据库唯一约束兜底。
10. **harness**：`cargo test --workspace --all-features --locked` 仍会在 harness 用例长期等待；本轮
    沿用 2026-11-19 的排除方式，未把 harness 当作已验证。
11. **HLS 预算切换的瞬时峰值**：切到更高码率后，hls.js 不会立即清掉已经缓冲的高码率分片；
    新的时间预算只约束之后的追加与回退保留。真实设备内存峰值仍未测量。
12. **Redis 批量命令**：`multi().exec()` 的调用方有 5s 截止，但已经入队的批量命令没有逐条 signal；
    连接卡住时仍可能占用队列，只是不再无限阻塞调用方。
13. **Balancer 响应体**：请求体上限已加；响应仍整体缓冲，流式转发和客户端断连取消未实现。

## 复验命令

```bash
yarn lint-ci
yarn build
yarn test

cargo fmt --all -- --check
cargo clippy --workspace --no-deps --all-features --all-targets --locked -- -D warnings
cargo test --workspace --exclude harness --exclude harness-tests --all-features --locked
```

服务端测试需要可用的 SQLite 测试库；客户端测试中的 24 项 skip 没有计入通过数。
