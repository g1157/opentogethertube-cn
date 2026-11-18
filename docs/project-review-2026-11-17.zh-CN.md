# 全项目审查与完善清单（2026-11-17—18）

审查起点为 `e3c6e832` / `v1.4.19`。优先级由维护者确定：**性能、画质、浏览器兼容**；同时覆盖可用性、安全、同步、存储、测试与交付。本批修复用于 `v1.4.20`。发布提交、镜像摘要和部署验收数据以对应 GitHub Release 为准，历史标签不移动。

本报告记录当前证据与修复，不改写旧审查。竞品的详细源码对照见 [同步观看产品与媒体管线对比](watch-party-comparison-2026-11-17.zh-CN.md)，画质机制见 [video-enhancement](video-enhancement.zh-CN.md)，播放机制见 [playback-sync](playback-sync.zh-CN.md)。

## 1. 结论与证据口径

项目的主要优势是各观众独立解码原片、支持直链 / HLS / DASH，以及已有的速率微调、首帧准备轮次和客户端增强管线。继续提高可靠性、测量准确性和资源边界，比继续增加档位或播放器设置更有收益。

最高优先级的实际故障来自交付链和资源生命周期：红 CI 可以发镜像、生产依赖与当前锁文件脱节、匿名 DASH 解析无界、重认证绕过消息预算、慢连接发送无背压，以及暂停 / 切源后的增强资源和异步结果归属。它们已有本批代码修复和回归，不能把修复前结论继续当作当前代码状态。

画质方面，HQ 的成本远高于快速链。1280×720 → 1920×1080 的 WebGL HQ 中间纹理申请存储约 390.23 MiB；闲置回收后约 3.52 MiB。视频呈现回调约 24 fps、媒体管线掉帧 0，仍不能证明增强画布每帧按时完成。真正的 GPU 完成观测、在途提交与设备预算是下一阶段重点。

证据分为四类：**本轮实测**（测试 / 本地浏览器 / 隔离镜像）、**代码核实**（路径存在，未虚构利用）、**用户实测**（维护者明确提供的既有复现）、**覆盖缺口**（需要特定设备或平台）。同一条通告出现在多条依赖路径，不等于多条可利用漏洞；商业产品的公开宣传也不等于本次亲测。

## 2. 覆盖范围

起始清点为 914 个已跟踪文件、605 个代码文件、约 115,498 行。通过入口、跨模块调用、状态与资源归属、现有测试和有针对性的运行验证覆盖整个仓库。生成 GLSL 按生成源和实际执行链审查，协议生成物检查漂移；这不表示逐字人工阅读全部生成文件，也不表示所有外部网站和设备均已验收。

| 审查分片 | 范围 | 主要验证方式 |
| --- | --- | --- |
| 1. 增强与 GPU | 探针、后端选择、尺度、shader / program、纹理池、帧循环、降档 | Chrome / Firefox 同帧探针、生命周期与故障注入回归 |
| 2. 原生播放器 | Direct / HLS / DASH、CORS、缓冲、切源、字幕与错误恢复 | 组件测试、本地 MP4 / HLS / DASH、真实跨域回退 |
| 3. 平台播放器 | YouTube / Vimeo / PeerTube / Bilibili 控制边界 | API 接线与能力核实；外部平台端到端为覆盖缺口 |
| 4. 同步引擎 | 权威时钟、微调、seek、ready 轮次、缓冲门、恢复 | 状态机、首帧、未知时长 / live、竞争测试 |
| 5. 前端状态与界面 | Vuex 设置、全屏、移动布局、SW、音效 | 组件、真实盒测量、冷加载与离房资源验证 |
| 6. 媒体提取 | 13 个适配器、HTTP、DNS、ffprobe、清单与缓存 | 公网边界 mock、本机回环 HTTP、子进程生命周期 |
| 7. 认证与权限 | 会话轮换、缓存身份、密码、grants / revision | 撤销 token、身份替换失败、权限落盘回归 |
| 8. 房间与存储 | 装载、卸载、同名并发、Redis、SQL、迁移 | 并发注入、SQLite 与 PostgreSQL、迁移检查 |
| 9. WS 与语音 | 入房、重认证、消息预算、发送、心跳、座位 / relay 预算 | 早到 / 断开 / 单飞 / 慢连接、预算竞争测试 |
| 10. 共享协议与队列 | 消息校验、队列导出、字幕更新、服务类型 | 全服务导出和适配器 round trip、受控 tick 竞争 |
| 11. Edge | Worker / DO / D1、请求预算、媒体 probe | Miniflare、真实取消与有效 HLS 元数据保留 |
| 12. Rust 与 Grafana | balancer / collector / harness、可观测插件 | Rust fmt / clippy / doc / tests、Jest、取消与隐藏查询 |
| 13. CI 与运维文档 | 工作流、依赖锁、运行镜像、回滚与机制文档 | 精确 lint、typos 1.19.0、actionlint、构建、镜像清点 |

Rust 多实例组件不在当前生产 Compose 中；Edge 是独立能力子集。二者的问题不能直接写成当前 Node 生产实例的暴露面。

## 3. 已确认问题与本批修复

以下“已修”指代码和相应回归已纳入本批；部署生效以发布镜像和线上验收为准。S 表示通常一天以内的小修，M 表示约 1–3 个工程日，L 表示需要独立设计或更长验收；这是相对成本估计，不是排期承诺。

| 编号 / 优先级 | 证据与影响 | 最终修复 | 成本与验收 |
| --- | --- | --- | --- |
| F01 / P0 | 用户实测 10-31 起 8 次 CI 全红，v1.4.12–19 仍发布；代码确认 tag 工作流无门禁 | 拼写改正；镜像发布复用完整主干 CI 与 Rust 工作流，全部成功才构建 / 推送；并隔离两条复用工作流的并发组 | S；typos / actionlint、后续实际 tagged workflow |
| F02 / P1 | Room 无条件下载音效并创建 AudioContext，网络 / 解码失败产生未处理 rejection，关闭音效也占资源 | 首次启用后需要播放才加载；单飞、5 s 请求 / 取消、失败捕获、可重试；去掉入房预加载 | S；失败前回归 3 fail，修后相关 12 项通过，全量无 unhandled |
| F03 / P0 | 用户实测旧镜像 ws 7.5.10 / xmldom 0.6.0 / sequelize 6.32.0；Dockerfile 只覆盖源码，锁文件升级不到生产 | 从固定 Node 24 基础镜像重新 focus 安装本仓生产依赖；ws 7.5.14、sequelize 6.37.8、axios 1.21.1；旧 DASH / xmldom 移除；迁移 limiter patch 到 Yarn 锁文件路径；镜像内逐项校验版本 | M；linux/amd64 构建、非 root / 只读运行、迁移、健康与锁文件一致性 |
| F04 / P0 | 用户在隔离环境复现鉴权前 ws 已知内存耗尽；应用 auth 无法保护底层 HTTP / WS 握手 | 使用修复版本 ws；镜像检查另设最低版本防止锁文件回退 | S；依赖通告版本与实际镜像版本同时核对 |
| F05 / P0 | 用户隔离复现几十 KB 畸形 DASH 清单阻塞数十秒；旧完整 DOM 无网络 / 结构预算 | 共享清单请求 2 MiB、5 s 主动取消、禁自动跳转；saxes 严格提取元数据，深度 64、元素 20,000、属性 64、解析时间 500 ms，每 16 KiB 让出事件循环；Invidious 同步迁移 | M；超大响应、持续字节、畸形 XML、深度 / 元素 / 标题、event-loop 回归 |
| F06 / P1 | 代码与新增回归确认重认证在初始 auth 检查之前、绕过消息预算；并发 / 断开 / 失败可能留下不一致身份 | 重认证走普通路由和原预算，等待成员建立；单一在途身份变更；普通命令等待；候选身份校验后再替换；失败保留原身份，断开结果失效，异步监听器被等待 | M；未认证不查询存储、预算耗尽不查、竞争 / 失败 / 断开回归 |
| F07 / P1 | sendRaw 不检查状态或 bufferedAmount，慢连接可积压；写入 / heartbeat 错误可影响调用者 | UTF-8 消息加当前积压超过 8 MiB 前单独 terminate；关闭连接跳过，异步 send 和同步 ping 失败隔离；清 auth timer 并立即结束成员生命周期 | S；字节边界、重复终止、关闭 socket、写失败与健康观众隔离回归 |
| F08 / P1 | 同帧 callback 重跑 CNN，暂停 / seek / resize 缺重绘，后台仍可消耗 GPU | 所有驱动共用 video-render-loop：mediaTime 去重、显式 redraw、隐藏页跳过、fatal 释放 | M；回调、暂停黑帧、seek / resize、context lost、离房测试 |
| F09 / P1 | WebGPU 首帧等待与旧启动结果可能越过换源 / 切档，覆盖新实例 | 4 s 可取消等待；generation 和原 video 回调归属；device lost 交给明确降级 | M；迟到旧实例不能覆盖新实例、取消 / device lost 回归 |
| F10 / P1 | shader 链接后未释放；CNN 暂停仍保留高成本中间目标 | link 后释放 shader，按 context 缓存 program；闲置 15 s 释放目标纹理 / framebuffer，重绘再建 | M；HQ 390.23 → 3.52 MiB、FBO 28 → 0；stop 后纹理 / FBO 0 |
| F11 / P1 | iframe 或 Direct 无 CORS 回退时，保存的增强偏好仍可能表示可用 | 响应式片源能力探测，禁用不可用的非 off 操作并提示偏好保留；切回支持的源复用同一设置 | S；双浏览器 native / no-CORS、组件与 UI 回归 |
| F12 / P2 | cover 预览和渲染按不同几何规则，目标成本显示偏小 | 目标预览复用 computeCanvasSize 和 videoFillMode | S；精确 contain / cover 尺寸回归 |
| F13 / P1 | DASH 三种前向缓冲目标与单一偏好不即时一致 | normal / top-quality / long-form 同步更新，设置变化不重建播放器 | S；组件验证三个目标及实例复用 |
| F14 / P1 | 未知时长原生点播被跳过首帧准备，可能空跑房间时钟 | Direct / HLS / DASH 的未知时长点播仍准备，明确 isLive 的直播排除 | S；准备轮次 / live 与组件回归 |
| F15 / P1 | 大小写同名装载 / 建房 / 卸载竞争，失败实例可能被提前公开 | 小写名字 Mutex，操作归零释放；loadEpoch 成功后才公开；失败取消生命周期资源 | M；同名竞争、装载失败 / 重试回归 |
| F16 / P1 | 缓存成员可跳过已撤销 token；grants 与 revision 不在同一落盘检查点 | 先验证会话，再用 token 匹配的成员；权限与 revision 同一持久化 checkpoint | S；撤销后拒绝、限制权限重载不被回填 |
| F17 / P1 | 早到的一次性 ready 回执 / 断开可与 join 的身份查询竞争，留下断开的 preparer | 消息等待 pending join，异步密码校验后重核连接；disconnect 等待并清除迟到成员 | M；受控身份查询、早到状态、断开和第二位观众接续 |
| F18 / P1 | SponsorBlock 外部 I/O 阻塞全局 tick 或把旧结果落入新片源 | 脱离 tick、单飞；source / requestId 绑定；超时 timer 清理，卸载失效 | S；未完成外部请求时 tick 已返回，切源后无旧分段 |
| F19 / P1 | 语音预算检查和占位之间竞争；旧 relay 请求越过参与者轮次 | 同步预算判断 / reserve，校验 token 与 membership；relay 单飞绑定本次 Set | M；并发座位、预算、旧请求不覆盖新会话 |
| F20 / P1 | ffprobe 使用原始而非已验证最终 URI；spawn / 流 / timer / 临时文件清理不完整 | 使用 resolvedUri；DNS 5 s 边界；子进程 20 s、I/O 12 s；管道背压与失败清理 | M；URI、spawn、流错误、timer / 文件回归；后续 DNS 出站缺口见 R01 |
| F21 / P1 | 自定义 JSON 清单无界，live / HLS 分辨率元数据漂移 | 2 MiB / 5 s / 主动取消 / 严格 JSON / 不自动跳转；保留 live 标记；RESOLUTION 对象和字符串兼容 | S；元数据、URL 边界与失败测试 |
| F22 / P1 | Edge probe 超时仅结束等待，底层请求可能继续占资源 | AbortController 与剩余总预算取较小期限，finally 清 timer；超时仍保留有效 HLS 元数据 | S；真实挂起 fetch 被取消、live、全部 Edge 测试 |
| F23 / P2 | SW 缓存相互清理、无限增长、缓存写失败影响成功网络响应 | scope 隔离、只清自身旧缓存、最多 128 条、waitUntil、quota 失败隔离、base URL 注册正确 | S；cache scope / quota / entry cap / 注册回归 |
| F24 / P1 | 用户确认 DASH / Bilibili / PeerTube 等队列导出 Unknown service | 覆盖全部 13 个 VideoService，类型穷尽检查；保留实例端口、Bilibili 分 P、Pluto 剧集、HLS / DASH 实际 URL | S；common 全服务矩阵和 11 个适配器 round trip |
| F25 / P1 | 用户确认字幕 PATCH 与每秒 tick 竞争：队列条目提升为当前视频后返回 400，正在播放的源不能编辑字幕 | 更新在锁内定位队列或当前源；保留权限和 URL 防护，元数据变化不重置时钟 / 准备轮次 | S；DNS 受控等待期间显式 tick、当前源清空 / 更新 / 切源、内网解析拒绝 |
| F26 / P2 | Grafana 查询取消留下 timer / socket / HTTP 订阅；hidden 仍查询，坏 JSON 未隔离 | teardown 关闭资源、取消 HTTP 订阅、跳过 hidden、坏 JSON error；移除无测试也成功的选项 | S；6 项真实 datasource 生命周期测试，panel / core 检查 |
| F27 / P2 | 稳定文档写旧快照、旧门禁、旧 parser、笼统漂移阈值和“AMD CAS”等错误机制 | 同步更新手册、架构、媒体 / 播放 / 增强 / 部署文档；修 Rust rustdoc 链接，保留历史审查 | S；文档链接、数字、codegen、严格 rustdoc / lint |

旧镜像残留 202 个上游应用文件（含 33 个旧前端资源）的数量为维护者实测；已经排除残留迁移或运行模块。本报告不把“残留文件”夸大为旧运行代码被执行。新镜像运行层从干净 Node 层只复制本仓应用产物；镜像检查核实应用目录与测试产物边界。

## 4. 性能、画质与兼容实测

### 4.1 同源、同帧、同尺寸成本

Apple M5 / ANGLE Metal，Chrome 154、Firefox 157；H.264 BT.709，1280×720、t=1 s 的同一帧，输出 1920×1080；预热 3 次、采样 24 次。纹理数值按格式和尺寸推算申请存储，未包括全部 VRAM、驱动和浏览器开销。

| 路径 | pass 含呈现 | 纹理 MiB | Chrome 完成等待 p50 | Firefox 完成等待 p50 |
| --- | ---: | ---: | ---: | ---: |
| 清晰化 WebGL | 2 | 19.34 | 2.2 ms | 7 ms |
| 影视 WebGL | 3 | 26.37 | 1.6 ms | 7 ms |
| 快速 S WebGL | 10 | 59.77 | 3.7 ms | 11 ms |
| HQ WebGL | 47 | 390.23 | 59.1 ms | 116 ms |
| 快速 WebGPU | 未计数 | 未计数 | 43.5 ms | 本机不可用 |
| 质量 WebGPU | 未计数 | 未计数 | 62.7 ms | 本机不可用 |

WebGL 使用同步 readPixels，WebGPU 使用 queue.onSubmittedWorkDone，包含不同同步成本，不能据此排名后端或倒数换算播放 fps。Chrome 独立 GPU timer 口径 p50 为清晰化 2.452、影视 1.137、S 5.162、HQ 92.868 ms；同样不与前表混算。本机 Firefox WebGPU 被驱动 blocklist 阻止，WebGL2 回退可用；不推广成所有 Firefox 都不支持 WebGPU。

HQ 闲置 15 s 后纹理 390.23 → 3.52 MiB、framebuffer 28 → 0；S 为 59.77 → 3.52 MiB、5 → 0。stop 后纹理 / framebuffer 为 0，program 仍按 context 缓存，shader 已释放。修复前在清空画布后暂停画面未重绘；修后恢复到对应像素 `[128,192,63,255]`，context lost 明确报告 fatal。

### 4.2 持续播放与压力探针

- Chrome 45 s / 24 fps 测试片：off、清晰化、影视、S 各观察 12 s，video rVFC 约 23.95–23.97 fps，媒体管线掉帧 0。
- Chrome quality 正常观察 30.032 s：721 次回调、约 24.007 fps，媒体管线 721 帧、掉帧 0。该值观察 video，不是 canvas 完成率。
- 增加 submit / completion 插桩的压力探针：约 16.924 回调 fps、102 掉帧，完成 p50 / p95 175 / 249 ms、最多 5 项在途；约 19 s 后质量降为快速，持久化偏好仍为质量。插桩改变开销，不能当普通播放性能。
- Chrome HLS / DASH 各 6 s：约 23.796 / 23.982 回调 fps，掉帧 0。Firefox 有效 6 s 样本约 21.772 / 21.743 回调 fps；两者均 131 次回调、145 媒体帧，HLS 掉 4 帧、DASH 掉 0 帧。短样本不作为长期帧率保证。

低成本档位已经有可测收益和资源优势；高档主观画质应在相同片源、后端和输出尺寸上由维护者判断。本轮没有公平复测当前 mpv、HDR / 10-bit 或商业产品，不能宣称超越它们。

### 4.3 浏览器、全屏与冷加载

真实页面已验证 Chrome / Firefox 的原生全屏：设置与增强画布位于 `.video-subcontainer` 内，无横向溢出。Chrome 360×800 时增强面板为 360×429、纵坐标 371–800；390 px 也通过。Firefox 窄窗实际最低为 500 px，不能写成已经验证 Firefox 390 px 手机。

双浏览器的支持源为 crossOrigin anonymous、readyState 4、一个增强 canvas；无 CORS 回退源为 crossOrigin null、readyState 4、增强 canvas 0，非 off 控件禁用并解释原因，film 偏好保留；离房 video / canvas 均为 0。CORS 回退后原生能播放，不代表能读取像素。

最后生产构建的冷加载字节、镜像运行和发布验收记录在下节汇总。已保留动态 import 边界：hls.js、dash.js、three、Anime4K WebGPU、ASS worker / WASM；未启用的增强不能仅因入房下载重型库。SW 命中的解码字节不当作 HTTP 传输字节，gzip 使用同一 level 9 口径。

## 5. 验证记录

审查代码已通过以下本地验证。最终提交仍按发布顺序执行 lint、全量测试与生产构建；最终镜像检查、冷加载字节和上线验收记录在 [v1.4.20 Release](https://github.com/g1157/opentogethertube-cn/releases/tag/v1.4.20)，以实际退出码、未处理错误和 revision / digest 一致性为准。验证日志和恢复的本轮测量摘要在维护者本地 `~/.commandcode/reviews/ott-2026-11-17/`，不包含公开部署凭据。

| 检查 | 已取得的结果 |
| --- | --- |
| `yarn lint-ci` | exit 0；Biome / Prettier / TypeScript / ESLint，0 error、25 既有 warning |
| 客户端 | 100 个运行 spec 通过，1094 passed / 24 skipped，无 unhandled |
| 服务端 SQLite | 66 个运行 / 类型 spec 通过，1089 passed，类型无错误，exit 0 |
| 服务端 PostgreSQL 15 | 同套 1089 passed，类型无错误，exit 0；27 个迁移已应用且重复执行无新变更 |
| common / Edge | 78 / 30 passed；common 类型无错误，Edge 包含真实 12 秒取消回归 |
| Grafana core / datasource / panel | 2 / 6 / 30 passed；不是 passWithNoTests |
| 工作流 / 拼写 | actionlint 1.7.7 三个发布相关工作流、CI 固定 typos 1.19.0 通过 |
| 字幕前端 / 房间竞争 | 换字幕不重新加载媒体、保留暂停 / 时钟 / 关闭偏好；DNS 等待期间显式 tick 的服务端回归通过 |

字幕测试收尾中另定位了两处夹具时序：前端在初始源尚未写入 src 时模拟 canplay，服务端在真实 tick 已提升队列后仍读取队列首项。前者等待初始异步加载，后者用稳定当前源保留队列；没有暂停真实 tick，也没有删除显式提升竞争回归。

Rust 既有严格验证为 fmt、check / clippy（warnings 为 error）、rustdoc、71 项单元 / harness 与 1 项 doc test，共 72 项通过；协议生成物无漂移。Rust 源码随后没有功能改动；标签发布仍复用 Rust 工作流检查对应提交。

## 6. 完善清单：剩余事项、成本与验收

这些是后续改善和覆盖缺口，不冒充本轮已经实现。优先级在同一条件下排序：P1 先解决持续资源、安全或播放可靠性；P2 改善成本、行为一致性和体验；未部署组件按启用前要求管理。

| 编号 / 优先级 / 状态 | 证据与影响 | 具体改善、成本 / 依赖 | 完成验收 |
| --- | --- | --- | --- |
| R01 / P1 / 代码风险 | ffprobe 及部分 HTTP 请求的检查与实际连接 DNS 独立；后续 redirect / nested HTTP 仍由子进程读取 | 统一固定解析地址的出站通道；ffprobe 隔离出口 / 验证每次后续读取；L，需要验证网络能力，不能仅加一次 URL regex | 隔离 DNS 换答、重定向和嵌套资源夹具全拒绝私网；公网 Range / HLS / DASH 不退化 |
| R02 / P1 / 测量缺口 | 现行降档看 video rVFC / 媒体掉帧，不证明增强完成截止 | 稀疏 GPU 完成 / fence / timer 采样、在途上限、合成截止；M，Chrome / Firefox 能力探测 | 同片持续播放记录完成 p50 / p95、排队高水位与失约；测量本身不造成持续同步等待 |
| R03 / P1 / 实测成本 | HQ 1.5× 已需约 390 MiB 目标存储，显式高倍率绕过自动像素预算 | 按设备 / 格式 / 档位约束目标与中间存储；扩大 buffer / VAO 启动失败注入；M | 4K、低端 GPU、百次切档和失败后资源高水位可控；偏好不被自动保护覆写 |
| R04 / P1 / 代码风险 | 全局 room tick 串行 await 每房 DB sync，慢房间可延迟其他房间 | 每房间单飞、有界并行 I/O 与持久化合并；M | 注入一间挂起 DB，其他房间 tick / pause / seek 仍达预算；恢复与卸载一致 |
| R05 / P1 / 代码成本 | pause / seek 等仍可写整条 prevQueue，长队列写放大 | 队列内容 checkpoint 与进度 / 设置分开，合并重复落盘；M | 200 项队列的 seek 写入字节与 SQL 次数明显下降；崩溃恢复仍暂停且队列不丢 |
| R06 / P1 / 代码风险 | 弹幕 server fetchText / client response.text 无字节上限；cache 只限条目、XML 无总评论预算 | 前后端流式字节 / 时间 / 条目预算、取消与 cache 字节上限；M | 超大 / 慢速 XML 有界拒绝，事件循环与内存可控；正常长片弹幕仍能加载 |
| R07 / P1 / 覆盖缺口 | 当前真实设备只有本机桌面；未完成 Windows、Android、iOS / Safari、低端 GPU、HDR、蓝牙 | 固定样片与双客户端时钟的真机矩阵；M，需要实际设备与有效片源 | 首帧、seek、CORS、全屏、字幕、增强失败 / 恢复、语音和长时间负载逐项记录 |
| R08 / P1 / 依赖风险 | 实际运行包仍可能有通告；工具链 / 配置解析 / 未使用 API 与匿名入口不同 | 按实际安装树、调用路径与修复线持续更新；Zod / TOML 跨主版本独立验证；M–L | 发布检查仍比较镜像与锁文件；新版输入校验、配置和 SQL 行为不漂移，通告逐条解释 |
| R09 / P2 / 实测成本 | 首屏 vendor 是主要下载成本，重库懒加载不能代替首屏优化 | 建立首页 / MP4 / HLS / DASH 冷加载预算，按路由 / 组件缩减 vendor；M | 相同 gzip 与 cache 口径量化前后，首屏更小，播放器启动和导航没有新瀑布 |
| R10 / P2 / 代码差异 | DASH 缺 HLS 对等字节 / 隐藏页预算；深缓冲与内存策略需兼顾 | 保持深时间目标，增加设备字节预算与可见性策略；M | 同码率长片 / 直播 / 后台恢复量化内存、重缓冲和 live-edge，不把目标误当硬上限 |
| R11 / P2 / 代码误报 | corsFromHeaders 仅判断非空 ACAO，未匹配实际 Origin | probe 发送正确 Origin、验证 wildcard / credentials / 3xx 语义；S | 错误源 Origin 不报支持，真实允许源不误拒绝；Direct 实际回退仍是最终能力依据 |
| R12 / P2 / 代码风险 | 建房 DB save 成功后 password / sync 失败，完整回滚尚未覆盖 | 事务 / 补偿删除与资源清理；M | 故障注入无 orphan DB / timer / rooms，重试与同名竞争稳定 |
| R13 / P2 / 设计项 | 多人未来起播固定 +1 s，内部等待用 Date.now | 有上下界的 RTT / 时钟不确定性预算；单调内部 deadline；L，参考 Jellyfin | 注入系统时钟跳变、丢包、后台和高 RTT；没有无限等待，起播差异以多机实测证明 |
| R14 / P2 / 代码差异 | tick 与收到 sync 的被动漂移阈值不同（不可 bend 为 1 s / 300 ms） | 共享被动策略和统计，主动 seek 保持直接；M | 暂停 / 直播 / 首次冷却 / 不可微调 / 关闭开关的阈值矩阵与音频连续性一致 |
| R15 / P2 / 平台边界 | Bilibili iframe 没有控制 JS API，位置为估算，pause 不保证内部播放器停止 | 当前源前置标注可控程度；对确有需求的站点研究扩展桥接；S / L | 用户能看出粗同步边界；不能用估算时钟证明平台精确同步 |
| R16 / P2 / 代码风险 | Grafana JSON 能解析但还没有完整结构校验 | 共享消息结构验证，畸形对象隔离 / 有界重试；S | 缺字段 / 大结构 / 关闭时查询不污染结果、不保留资源 |
| R17 / P2 / 代码预算 | SW 128 条是 entry cap，单条 / 总字节仍未设预算 | 静态资源按字节和大小分级缓存；S | 大资源 / quota 条件不扩大缓存、API 与成功网络响应不受影响 |
| R18 / P2 / 覆盖缺口 | 非中英文 locale 缺键；焦点 / a11y / 极矮屏部分路径仅代码检查 | 可见语言覆盖说明、焦点恢复与真实手机 / 键盘检查；M | 中英文案成对，回退诚实；屏幕阅读与焦点路径、触控盒尺寸可复测 |
| R19 / 启用前 P1 / 非生产 | Rust HTTP collect 整 body，collector state / stream 无入站鉴权，CORS wildcard + credentials 无效 | 有界流式代理、鉴权与明确允许 Origin；M–L | 生产启用前压测大 body、慢流、无授权访问、CORS；当前 Compose 不受其暴露面影响 |
| R20 / P2 / 维护成本 | Room.vue 约 3056 行，状态编排集中；E2E 非 CI 必经且有旧选择器 | 先加稳定跨浏览器 E2E，再按生命周期拆编排；L | pause / seek / ready / 字幕 / 全屏 / 离房同一测试行为不变；不只测内部函数镜像 |

执行顺序建议为 R01–R08，再做首屏与缓冲预算 R09–R11，最后安排同步策略、平台桥接和结构拆分。原有 rate bend、ready、generation、懒加载已经存在；完善它们的证据和边界，不另造第二套设置。

## 7. 从同类产品吸收的做法

详细对比涵盖 CyTube、Syncplay、Jellyfin SyncPlay、VideoTogether、Metastream 历史实现、Watch2Gether、Hyperbeam，以及 mpv / Anime4K、FSR1、hls.js、dash.js。固定提交和官方资料链接见 [对比文档](watch-party-comparison-2026-11-17.zh-CN.md)。

| 学习对象 | 值得学习的机制 | 本项目判断 |
| --- | --- | --- |
| CyTube | 队列有界串行、控制归属、源身份变化重载 | 已改善同名锁 / 异步归属；不同房间慢 I/O 隔离仍需做 |
| Syncplay | 主动 seek 与漂移分开、能力判断、迟滞与持续证据 | 保留现有速率微调；共享被动阈值、测真实音频连续性 |
| Jellyfin | Ready 的 playlistItemId / When 校验、单调截止、按 ping 安排未来起播 | 保留首帧轮次；RTT 预算与单调时钟独立设计 |
| VideoTogether / Metastream 历史 | 网页桥接、运行能力探测、自动播放受阻明确说明 | 本批落实片源增强能力与失败可见性；扩展桥接另作可选方案 |
| Watch2Gether | 创建、分享、开始的短流程，功能可发现性 | 当前片源控制 / CORS / 自动播放信息值得前置；未亲测其私有算法 |
| Hyperbeam | 共享云电脑解决不同网页播放器的控制差异 | 云算力、编码、输出流量成本高；不替换现有原片独立解码架构 |
| mpv / Anime4K / FSR1 | 同网络、同目标尺寸比图；准确区分 EASU、CAS / RCAS | 本批修正名称与 pass / 成本口径；主观画质由真实片源验收 |

## 8. 实际验收边界

匿名耗尽的既有复现均来自维护者本机回环或隔离容器；本轮没有对生产运行攻击性 payload。发布后的在线检查使用正常临时房间和小型媒体，不向其他房间发消息。生产替换保留数据库 / 环境 / 旧镜像的回滚资料。

桌面本机的通过结果不等同 Windows、手机、外部平台、HDR、DRM、蓝牙或语音端到端的通过结果；R07 保留这些明确验收任务。最终画质和真实片源体验由维护者的实际环境结果决定。
