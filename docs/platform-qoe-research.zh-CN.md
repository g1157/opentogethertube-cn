# 大厂 & 国内平台播放器 QoE 策略调研 —— 可移植技术清单

> 调研目标：为大厂/平台的公开播放体验（QoE）策略做一次系统性梳理，并**过滤掉专有基础设施**，只保留能被
> 一个小型自托管 Web 项目（Vue3 + 原生 `<video>` + hls.js + dash.js，例如本仓库的 `HlsPlayer.vue` /
> `DashPlayer.vue`）直接移植的做法。
>
> 输出格式：按平台组织，每条给出 **【具体做法】** / **【可测量的收益·指标】** / **【来源 URL】**。
> 文末附「按优先级排序的可落地清单」与「hls.js / dash.js 参数对照表」。
>
> 调研日期：2026（检索结果含 2026 年文章）。方法：web_search + web_fetch 公开资料。
>
> **诚实声明（假设与不确定项）**：
> - 大厂**内部播放器实现不公开**，YouTube/Netflix/Twitch 的多数细节来自官方文档、web.dev 案例、学术论文、
>   逆向观察与二手工程文章。文中对「官方一手」与「社区观察/二手」做了标注。
> - "Netflix Voyager" 作为**公开的 Web 播放器项目**并不存在（检索只命中 Netflix 上的《Star Trek: Voyager》
>   剧集）。Netflix 无公开的开源 Web 播放器；其开源在 <https://netflix.github.io/>。
> - "buffer is king" 是社区对 Netflix 缓冲观的一个提法，**未找到 Netflix 官方以此措辞的原文**；Netflix 有署名
>   的一手资料是 NANOG/ACM 的「Buffer Sizing and Video QoE Measurements at Netflix」论文（见 2.1）。

---

## 0. 先建立指标口径（贯穿所有平台）

大厂 QoE 系统（Mux Data / NPAW YOUBORA / Conviva / Bitmovin Analytics）基本收敛到同一套四大支柱：
**播放失败率、起播时间(VST)、卡顿(Rebuffering)、画质**；其余都是细分。

| 指标 | 定义 | 备注 |
| --- | --- | --- |
| VST / Time-to-First-Frame | 点击播放 → 首帧上屏 | 报 p50/p95，别只看均值 |
| EBVS（Exits Before Video Start） | 首帧渲染前就离开的会话占比 | 与 VST 强相关，贴近收入 |
| Video Start Failures (VSF) | 首帧前的失败（hls.js fatal error、403、DRM 拒绝、codec 不支持） | 需按 CDN/机型/内容分维度 |
| Rebuffering Ratio | 卡顿时长 ÷ 总观看时长 | 经验阈值：并发卡顿率 > 5–10% 即告警 |
| MTBR | 总播放时长 ÷ 卡顿次数 | YouTube 用它衡量 Media Capabilities 收益 |
| 平均码率 / 各档停留占比 / 码率切换次数 | 交付画质与稳定性 | 切换振荡比低画质更「可感知地差」 |
| Seek 成功率 / Seek 时延 | 拖动是否可播、多久出画面 | 国内字幕组常单列 |
| 播放成功率 | 起播 + 过程中不中断 | 国内口径常拆「起播成功率 + 卡顿率」 |

- 【来源】<https://www.abrstreaming.com/blog/qoe-metrics-that-matter>
- 【来源】<https://www.forasoft.com/learn/video-quality/articles-vqm/streaming-qoe-metrics>
- 【来源】国内三层口径（QoS → QoE → 业务数据：DAU/留存/完播率/投稿率）：<https://www.infoq.cn/article/YuA5hUImSpPPP46lpmG1>

**可移植做法**：在客户端挂一个 beacon SDK——监听 `playing`/`waiting`/`ratechange`/`error`/画质切换事件，
维护滚动会话记录（观看时长、起播、卡顿次数与时长、码率、错误），在心跳与 `pagehide`/`visibilitychange`
时用 `navigator.sendBeacon` 上报。这是本项目 `client/src/components/composables/player-stats.ts` 的天然落点。

---

## 1. YouTube

### 1.1 缓冲策略：只缓冲前方一小段 + buffer health
- **【具体做法】** YouTube 不会把一个视频整段缓冲，而是**只维持「前方有限时长」的缓冲**，并随网速动态调节。
  播放器持续观测 **buffer health（缓冲健康度 = 已缓冲但未播放的秒数）**、带宽、设备性能三个信号共同决策。
  网速好时缓冲可以更小（要时再拉），网速差时才拉长。`stats for nerds` 面板把这些暴露出来（buffer health / connection speed）。
- **【可测量的收益·指标】** 降低带宽成本与 CDN 压力、避免无谓预取；对用户体验表现为 buffer health 不长期贴 0。
- **【来源（二手/观察）】** <https://geekyelectronics.com/why-doesnt-youtube-1080p-load-ahead/> ；
  buffer health 释义 <https://www.reddit.com/r/youtubetv/comments/eepacy/a_little_help_understanding_youtube_tv_stats_for/> ；
  ABR 三信号描述 <https://www.linkedin.com/posts/vibhutirajput_system-design-software-activity-7479218244076216320-Hdmv>
- **【移植】** hls.js：`maxBufferLength` + `maxMaxBufferLength`（上限）+ `backBufferLength`（回退缓冲，省内存）。
  原生的「只缓冲前方」在 hls.js 里就是**限制 max buffer、允许上限随 ABR 放大**。dash.js 侧对应
  `streaming.buffer.*`（bufferToKeep / bufferTimeAtTopQuality 等）。

### 1.2 起播时间优化：initial bitrate + 预热 + 连接复用
- **【具体做法】** 起播用**保守但不至于太差的初始档位**起步，靠前几个分片快速探测可用带宽后阶跃上探；
  复用连接（keep-alive）、提前拉 manifest/init-segment。字节跳动公开数据：部分 Android 机型首帧 170ms → 100ms，
  带来 **0.6%** 的观看时长/留存类收益（属于「首帧→业务」的少有的公开数字）。
- **【可测量的收益·指标】** VST p50/p95 下降；首帧 → 留存/完播提升（有 A/B 公开数字）。
- **【来源】** 首帧 170→100ms / 0.6%：<https://zhuanlan.zhihu.com/p/667052247>
- **【移植】** hls.js：用 `abrEwmaDefaultEstimate`（设一个合理初值来「预置带宽估计」，比硬设 `startLevel` 更好，
  官方 issue 明确推荐）＋ `startLevel` 备选 ＋ `enableWorker`。dash.js 用 `abr.initialBitrate`。

### 1.3 画质切换逻辑（公开面）：Media Capabilities + 电池/性能感知
- **【具体做法】** YouTube 用 **Media Capabilities API** 让 ABR 不要去选「设备解不动/不省电」的档位，
  避免自动选到会掉帧的分辨率。Chrome 内该 API 用**历史播放指标**预测同 codec+分辨率是否顺滑。
- **【可测量的收益·指标（官方一手，量化）】** 实验组 **MTBR 提升 7.1%**，而平均交付分辨率只**下降 0.4%**
  ——即「用极小画质代价换掉一批用户的卡顿」。这是非常可移植的取舍模板。
- **【来源（官方）】** <https://web.dev/case-studies/youtube-media-capabilities>
- **【移植】** 见 §6.4。逻辑：对候选取档调 `navigator.mediaCapabilities.decodingInfo({...})`，
  过滤 `supported && smooth`，用 `powerEfficient` 做「电池感知」降档。

### 1.4 拖动进度条的预览缩略图（scrubbing thumbnails / storyboard）
- **【具体做法】** 预生成**雪碧图（sprite sheet / storyboard）＋ WebVTT 索引**：FFmpeg 抽帧拼网格，
  VTT cue 用 `#xywh` 指定「时间区间 → 网格坐标」。播放器在 hover/拖动时按时间查 cue、按坐标裁一张小图显示。
  YouTube 用的是同一套坐标偏移方案。工程要点：**大视频要拆多张 sprite**（VTT 每条 cue 可指向不同图片文件），
  单张控制在约 **≤ 2MB / ≤ ~500 帧**（否则预览图成本超过视频分片本身）。
- **【可测量的收益·指标】** 拖动命中率提升、无效 seek 减少、感知 seek 时延下降；减少拖动过程中发起真实 seek。
- **【来源】** 生成与漂移 <https://www.ffmpeg-micro.com/blog/your-video-thumbnail-sprite-sheet-is-fine-the-vtt-cues-drift> ；
  拆分多 sprite <https://www.nikodev1.medium.com/storyboard-thumbnails-the-scrub-bar-preview-your-players-missing-8ee4182ea5f4> ；
  FFmpeg+VTT 教程 <https://dev.to/masonwritescode/build-scrub-bar-thumbnail-previews-with-ffmpeg-and-an-webvtt-sprite-3ei2> ；
  规格建议 <https://github.com/rachitt/basic-vid-streaming/blob/main/specs/024-thumbnails-sprites.md> ；
  YouTube 同款坐标思路 <https://github.com/soorajsprakash/mpv-seekpeek>
- **【移植】** 纯前端即可：一个 `storyboard.vtt` + 一张/多张 `storyboard.jpg`，Vue 组件的进度条 hover 时
  `new Image()` 懒加载对应 sprite，再 `background-position` 裁切；WebVTT 也可直接给 `<track>`/自有解析。

### 1.5 "Up next" 预加载
- **【具体做法】** 播放当前视频时，后台**预热下一个要播的视频**（拉 manifest / 首段 / init-segment，乃至预解码首帧），
  切换时「零等待」。YouTube 的 related/"Up next" 预取属于此类策略。
- **【可测量的收益·指标】** 相邻视频切换的 VST 显著下降（切换体感"无感"）。
- **【来源（二手）】** Plex 论坛对 YouTube 式「buffer ahead / Up Next 预加载」的描述
  <https://forums.plex.tv/t/smartsync-preload-engine-for-up-next-and-expanded-buffering-control/202584>
- **【移植】** 本仓库已有「一起看」房间；可在 `next` 队列确定后，用一个**隐藏的 `<video>` 或第二个 hls.js 实例**，
  只 load 到 `canplay`/首帧即停（注意内存/线程，见 §5.1 爱奇艺「多实例 vs 预解码」的权衡）。

### 1.6 后台标签页降速
- **【具体做法】** 浏览器对后台/隐藏标签页有内建节流（`requestAnimationFrame` 停发、`setTimeout` 预算制节流），
  但**正在播音频的标签页被视为前台、不被节流**。因此一个视频页在后台会继续占资源。厂商做法是主动降载。
- **【可测量的收益·指标】** CPU/耗电下降；多标签页场景下前台页面掉帧减少。
- **【来源（官方）】** Page Visibility API & 后台节流策略：<https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API>
- **【移植】** 见 §6.3：用 `visibilitychange` 主动在隐藏时降码率/暂停/停掉 canvas 弹幕渲染循环。

---

## 2. Netflix

### 2.1 缓冲管理：「缓冲有大有小，两头都会变差」
- **【具体做法（官方一手，NANOG/ACM 论文）】** Netflix 在真实拥塞下调整**路由器缓冲**做实验，结论：
  缓冲**太小和太大都会恶化体验**——太小增加丢包，太大增加**起播延迟、卡顿中位数、低质量视频占比**。
  工程含义：客户端缓冲不能一味加大；Netflix 走的是「**留少量缓冲以便快速切码率**」的路线（社区常称
  "buffer is king"，即缓冲是决定 QoE 的核心变量）。
- **【可测量的收益·指标（官方量化）】** 过大缓冲导致：起播延迟按**秒级**恶化、交付画质**下降 5–10%**、
  卡顿中位数**上升约 50%**。
- **【来源（官方一手）】** 论文 PDF <https://yuba.stanford.edu/~nickm/papers/buffer-qoe-netflix2019.pdf> 与
  <https://brucespang.com/papers/netflix-buffer-sizing.pdf> ；摘要 <https://dl.acm.org/doi/abs/10.1145/3375235.3375241> ；
  综述 <https://nanog.org/news-stories/nanog-tv/tv-page/>
- **【移植】** 对自托管的意义：**别把 buffer 调到最大**。走「buffer + 带宽」混合、给小缓冲留出快速 Down-switch 空间。

### 2.2 ABR 混合策略的公开演进：throughput → buffer(BBA/BOLA) → hybrid
- **【具体做法】** 演进路径在公开文献里清晰：
  1. **Throughput-based**（经典）：EWMA/调和平均测速 × 安全系数（0.7–0.8）选最高可承载档；
     缺点是对抖动敏感、易「向下螺旋」。
  2. **Buffer-based（BBA / BOLA）**：以**缓冲水位**为主信号——缓冲是过去吞吐的「积分」，天然更平滑；
     低水位保守、健康水位上探。BOLA 把它形式化为「最大化 log(bitrate) 效用 − 卡顿惩罚」。
     缺点：起播时无信号，需要吞吐法做冷启动。
  3. **Hybrid（生产用）**：吞吐估计给上界、缓冲模型保稳定、切换惩罚抑制抖动；MPC 做短视界优化。
- **【可测量的收益·指标】** 缓冲法降低码率振荡（切换次数）、降低卡顿；起播阶段交给吞吐法保住 VST。
- **【来源】** 缓冲法学术起点（Stanford SIGCOMM，Netflix 会话数据）：
  <https://yuba.stanford.edu/~huangty/sigc040-huang.pdf> ；玩家级 ABR 三派系与 hls.js/dash.js 实现：
  <https://www.abrstreaming.com/blog/adaptive-bitrate-abr>
- **【移植】** **直接用官方实现，别自研**：
  - hls.js：内建 EWMA（快慢双 EWMA）带宽估计 + `abrBandWidthFactor`/`abrBandWidthUpFactor`，
    可「下载中提前 abort 并降码率重试」；BOLA 类缓冲逻辑可选。
  - dash.js：内建 **Throughput 规则 / BOLA 规则 / `ABRDynamic`**（稳态用 BOLA，起播与低缓冲用吞吐），
    另有低延迟专用 LoL+ / L2A。
  - 起步配置见文末参数表。

### 2.3 起播与「秒开」工程（公开面）
- **【具体做法】** 服务侧：**Open Connect**（把内容预置进 ISP 局端，缩短 RTT）；编码侧：**Per-Title Encode
  Optimization / Dynamic Optimizer**（按片源复杂度裁码率阶梯，用 VMAF 做感知优化）——间接降低同等画质所需带宽，
  等于更快的起播与更少的卡顿。客户端侧无公开一手细节。
- **【可测量的收益·指标】** Per-title 宣称在同画质下显著码率节省（Netflix 官方多篇）；起播/卡顿随码率阶梯优化而改善。
- **【来源（官方一手）】** Per-Title <https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2> ；
  Dynamic Optimizer（shot-based + VMAF）<https://www.engineering.fyi/article/dynamic-optimizer-a-perceptual-video-encoding-optimization-framework> ；
  HTML5 播放器演进（MSE/EME）<https://netflixtechblog.com/html5-video-at-netflix-721d1f143979> ；
  Open Connect（二手）<https://thecybersecguru.com/glossary/netflix-open-connect/>
- **【移植】** Open Connect 不可移植；**Per-Title 的部分思想可移植**：用 VMAF 给每个片源单独生成码率阶梯
  （FFmpeg `libvmaf` 可做），而非全局固定阶梯。

### 2.4 开源 & 公开播放器技术博客
- **【事实】** Netflix 开源中心 <https://netflix.github.io/>；GitHub <https://github.com/netflix>。**没有公开的
  Web 播放器开源项目，也没有叫 "Voyager" 的公开播放器**。公开的播放器技术文章主要是：
  - 「HTML5 Video at Netflix」（从 Silverlight 转向 MSE/EME）<https://netflixtechblog.com/html5-video-at-netflix-721d1f143979>
  - 「Per-Title Encode Optimization」<https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2>
- **【移植】** 直接借鉴其**工程思想**（小缓冲快速切档、按片源裁阶梯），而非代码。

---

## 3. Twitch（低延迟与卡顿权衡）

### 3.1 延迟模式：Normal vs Low Latency
- **【具体做法】** Twitch 提供 **Low Latency mode**（创作者后台开关）。开启后**观众侧缓冲从默认的约 10–15s
  降到约 2–4s**，代价是抗抖动冗余变少、在弱网下更容易卡顿。底层是缩短分片/允许分块传输（CMAF chunk，
  即 LL-HLS/LL-DASH 思路：分片未完成即可取到 moof/mdat）。
- **【可测量的收益·指标】** 端到端延迟从 10–15s → 2–4s（对聊天互动/主播回应速度）；代价指标是卡顿率上升。
- **【来源】** 官方帮助页 <https://help.twitch.tv/s/article/low-latency-video> ；
  2–4s vs 10–15s 与权衡 <https://stream-rise.com/blog/twitch-low-latency-video> ；
  LL-HLS 分块原理 <https://codezup.com/how-twitch-cuts-live-stream-delay-low-latency-hls/>

### 3.2 Catch-up（追赶）：动态播放速率
- **【具体做法】** 观众延迟累积（落后直播越来越多）时，**轻微提高 `playbackRate`** 追回目标延迟，超过阈值再
  seek 回 live edge；缓冲告急时反而**降低**播放速率以免卡顿。Twitch 生态里有成熟脚本实现该「低延迟追赶」。
- **【可测量的收益·指标】** 维持稳定 live edge（延迟漂移小）、减少「延迟只增不减」。
- **【来源】** 追赶脚本 <https://greasyfork.org/en/scripts/550707-twitch-low-latency-catch-up> ；
  dash.js 的 catch-up（官方实现，见下）
- **【移植（强烈推荐，本项目直接可用）】** **dash.js 官方 catch-up**（`CatchupController`）：
  `streaming.delay.liveDelay`（目标延迟）、`streaming.liveCatchup.maxDrift`（超过就 seek 回 live）、
  `streaming.liveCatchup.playbackRate.{min,max}`（追赶速率范围）；其速率用**逻辑斯蒂函数**平滑逼近目标延迟，
  且对小变化不调速率以避免频繁换 rate。
  - 【来源（官方）】<https://dashif.org/dash.js/pages/usage/low-latency.html>
  - hls.js 侧：**没有内建 catch-up**（社区 issue 确认），需自行用 `liveSyncDuration` /
    `liveMaxLatencyDuration` 控制落后上限，必要时自己调 `video.playbackRate`。
    【来源】<https://github.com/video-dev/hls.js/issues/3077>
    - 注：本仓库「一起看」的同步逻辑本身就在调 `playbackRate` 纠偏，与 catch-up 天然同构，可复用。

---

## 4. Bilibili（Web 端公开技术点）

### 4.1 弹幕渲染（Canvas 分层 + 碰撞检测 + 密度控制）
- **【具体做法（公开工程共识）】**
  - **Canvas 单层统一绘制**，避免海量 DOM 节点；滚动弹幕与固定（顶部/底部）弹幕**分层**处理，固定弹幕仅在必要时重绘；
    **无弹幕时优雅暂停绘制**、出现时再恢复（省 CPU/电）。
  - **碰撞检测**：滚动弹幕按「轨道（track）」分配——为每条新弹幕找一条「不会被前一条追上/不重叠」的轨道，
    发车时间与速度决定是否碰撞；固定弹幕则做**区域占用**判断。
  - **密度控制**：限制同时屏上的弹幕数/单秒发射数（超限即丢弃或改为不渲染），是高并发下的关键限流。
  - 进阶：Canvas2D → **WebGPU**（B 站跨年晚会峰值约每秒数千条弹幕，Canvas2D 主线程被 `requestAnimationFrame` 拖垮）。
- **【可测量的收益·指标】** 帧率（15→55 FPS 类）；主线程占用/掉帧；功耗。
- **【来源】** Canvas2D→WebGPU 实战 <https://jishuzhan.net/article/2026871326179393537> ；
  10 个弹幕优化技巧（含密度/轨道）<https://blog.csdn.net/gitblog_00670/article/details/154274509> ；
  分层与「无弹幕暂停绘制」的实现参考 <https://github.com/Predidit/canvas_danmaku> ；
  弹幕引擎 DOM vs Canvas 双引擎对比 <https://blog.csdn.net/gitblog_01035/article/details/157369277>
- **【移植】** 本项目已有弹幕/一起看场景：用**单个 `<canvas>` 覆盖在 `<video>` 上**，`requestAnimationFrame`
  驱动，轨道数组做碰撞检测，`document.hidden` 或 `video.paused` 时停循环。**不要用每弹幕一个 DOM**。

### 4.2 进度条预览图
- **【具体做法】** 与 §1.4 完全同构：服务端预生成 sprite + VTT 坐标，前端按时间裁切显示。
- **【来源】** 同 §1.4（storyboard 通用方案）。
- **【移植】** 可直接复用 §1.4 的前端组件。

### 4.3 「一起看」产品与同步实现（公开资料）
- **【具体做法（自托管社区主流实现，高度可移植）】** 典型架构：
  1. 后端/信令：**WebSocket** 广播房间状态（`play`/`pause`/`seek`/`playbackRate`/换片）。
  2. 同步语义：任一用户的 `play/pause/seek` 触发事件 → 服务端广播 → 其他客户端对齐（部分实现采用
     **服务端权威时间轴**：以服务端时间为基准算目标 `currentTime`，避免漂移）。
  3. 常配合 `setInterval` 周期性对齐（对本仓库就是已有同步逻辑）。
  4. 开源案例：Bilibili-Sync（单房间、内存为中心、WebRTC 语音）、Bili-SyncPlay（扩展 + WebSocket 服务）、
     SyncTV（同步观影/直播/聊天）。
- **【可测量的收益·指标】** 房间内播放状态**漂移（drift）**控制在毫秒级；seek/暂停一致性；断线重连后可恢复。
- **【来源】** <https://github.com/longlongman/Bilibili-Sync> ；
  <https://github.com/Sky1wu/Bili-SyncPlay> ；
  SyncTV 介绍 <https://zhuanlan.zhihu.com/p/1935663117699903727>
- **【移植】** 本仓库已有房间同步（见 `docs/playback-sync.zh-CN.md` / `docs/synchronization.md`），
  上面的开源实现可作为「服务端权威时间轴 + 周期纠偏」的对照参考。

### 4.4 P2P / PCDN 争议
- **【事实】** B 站（及国内多家）被广泛报道使用 **P2P / PCDN**：借助用户上行带宽分发内容以降 CDN 成本，
  争议点是**占用用户上传带宽/流量、影响其他上网体验、隐蔽性**。公开一手资料稀少，多为媒体报道与社区讨论；
  有第三方 PCDN 厂商公开宣称其伙伴包含 Bilibili、腾讯、TikTok。
- **【可测量的收益·指标】** 平台侧 CDN 成本下降；用户侧上行占用、非视频流量干扰（负面）。
- **【来源（二手）】** <https://coinfomania.com/titan-network-accelerates-tencent-game-patches-by-60-with-decentralized-infrastructure/>
- **【移植】** ⚠️ **不建议**在小型自托管项目里做 PCDN（成本、隐私、合规都不划算）；若沿用，
  应**默认关闭、显式告知并限速**。

### 4.5 DLNA / 投屏
- **【事实】** B 站 Web 端有投屏/连接电视的能力。Web 侧可移植的等价物是 **Remote Playback API**
  （`video.remote.prompt()`，把当前媒体投到可发现的远端设备）与 **Presentation API**。
- **【移植】** 可作为「投屏」按钮的实现路径（浏览器支持有限，需降级隐藏）。

---

## 5. 国内工程博客（爱奇艺 / 字节 / 快手 / 抖音）与 QoE 体系

### 5.1 爱奇艺「300ms 背后的故事」：预解码绕过 Codec 创建
- **【具体做法（官方工程文，细节丰富，最值得借鉴）】**
  - 问题：瀑布流「滑动即播」需要"零秒开播"。APP 层用「**多播放器实例 + 预加载**」（空间换时间），
    但中低端机内存/线程暴增 → 卡顿。
  - 调查：本地播放耗时主要在**解码器创建+打开**：高端机 ~20ms，中低端机均值 ~350ms、个别 >500ms。
  - 方案权衡：多解码器（低端仍堪忧）/ 软解（20ms 内但 CPU、功耗爆炸）/ 直播架构单解码器（时间轴维护极复杂）。
  - **终解（内核 5.0）**：新增**「预解码」处理单元**，与播放实例**解耦**、对接已有「预加载」单元；
    每个播放实例起播时从预解码单元取「节目起始位置的一帧/多帧」直接渲染，**完全绕过最耗时的解码阶段**。
    该单元全生命周期只创建一次、优先硬解、失败软解兜底、用直播模式规避 PTS 复杂度。**中低端平均 350ms → 50ms 以内，高端 <20ms**。
- **【可测量的收益·指标】** 起播耗时 350ms → <50ms（中低端），高端 <20ms。
- **【来源（官方工程文）】** <https://www.sohu.com/a/591359250_121124377>
- **【移植（高价值，可降级移植）】** Web 端没有多解码器控制权，但可等价实现「**预解码首帧**」：
  对 next 视频用隐藏 `<video>` 或第二个 hls.js 实例 load 到 `canplay`/`loadeddata`，
  或对首帧抽成静态图（storyboard 的第 0 帧）做「**封面占位 → 秒切**」，用户体感即"零秒开播"。

### 5.2 爱奇艺 × 清华：以用户粘性为中心的自适应码率（RESA / ABS）
- **【具体做法】** 爱奇艺自研 **ABS 智能码率平台**，其**多算法实时演化系统 RESA**（ICME 2019）与
  与清华合作的「以用户粘性为中心的视频传输 QoE 建模与优化」（IWQoS 2021 最佳论文第二名）：
  把**用户粘性（engagement）**而非纯 QoS 作为优化目标来调 ABR。
- **【可测量的收益·指标】** 地铁等强波动场景下卡顿下降；用粘性/留存而非纯卡顿衡量。
- **【来源】** <https://lmtw.com/mzw/content/detail/id/203460> ；<https://tech.ifeng.com/c/87qDAApG9Yf> ；
  <https://www.donews.com/news/detail/4/3161766.html>
- **【移植】** 启示：ABR 目标函数里**给卡顿更高惩罚权重**、抑制切换振荡；本项目可用 dash.js 的
  `ABRDynamic` 获得近似效果。

### 5.3 字节 / 快手 / 抖音：QoS → QoE 客户端工程闭环
- **【具体做法】** 短视频 Feed 全链路优化：**预加载策略（滑动前预取下一个）、帧调度、帧率控制、任务分片、
  功耗降级、手势冲突**，并用 **A/B 实验**验证收益；把技术指标接到业务增长（完播/留存）。
- **【可测量的收益·指标】** 首帧下降、滑动不卡、功耗下降、完播/留存提升（A/B）。
- **【来源】** <https://juejin.cn/post/7649033490332073993> ；首帧 170→100ms/0.6%（§1.2）<https://zhuanlan.zhihu.com/p/667052247>
- **【移植】** 预加载下一个 + 功耗降级 + 用 A/B/埋点验证，都是纯客户端可做的。

### 5.4 QoE 指标体系（VMAF / rebuffering / startup / 切换频率）
- **【具体做法】**
  - **VMAF**：画质感知指标，用于码率阶梯优化（Netflix Per-Title 的底层），FFmpeg `libvmaf` 可算。
  - **Rebuffering ratio / count**：卡顿时长占比与次数（最重要的负面体验）。
  - **Startup time (VST)** 与 **EBVS**：起播与"开播前流失"。
  - **码率切换频率**：振荡 = 观感不稳定，需惩罚。
  - 组合成 **0–100 体验评分**做北极星。
- **【来源】** <https://www.abrstreaming.com/blog/qoe-metrics-that-matter> ；
  <https://www.headspin.io/blog/definitive-guide-media-qoe-metrics-streaming-platforms> ；
  VMAF/PSNR 对比 <https://www.abrstreaming.com/blog/video-quality-metrics-psnr-vmaf>
- **【移植】** 客户端 beacon 采集上表；服务端用 FFmpeg+libvmaf 做**片源级阶梯评估**（轻量版 per-title）。

---

## 6. Web 平台能力（可移植性最高的一节）

### 6.1 requestVideoFrameCallback（RVFC）：逐帧同步与统计
- **【具体做法（官方一手）】** 在**新帧上屏**时回调，携带 `metadata`：`presentationTime`、
  `expectedDisplayTime`、`mediaTime`（帧的 PTS）、`presentedFrames`（已提交合成帧数，可比对是否丢帧）、
  `processingDuration`（编码包→可呈现的解码耗时）。
  与 `requestAnimationFrame` 的区别：RVFC 绑定**视频实际帧率**（25fps 视频在 60Hz 浏览器以 25Hz 回调）。
- **【可测量的收益·指标】** 精确的**丢帧检测**（`presentedFrames` 跳变）、解码耗时、与画面**帧级同步**
  （画弹幕/字幕/外部音频到正确的帧）；顺带得到一个可靠的 FPS 统计。
- **【来源（官方）】** <https://web.dev/articles/requestvideoframecallback-rvfc> ；
  MDN <https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback>
- **【移植（本仓库直接可用）】**
  - 用 RVFC 替代 `requestAnimationFrame` 驱动**弹幕/覆盖层的绘制与对齐**，天然帧同步。
  - 用它做**播放质量统计**：数 `presentedFrames` 差 → 丢帧率；`processingDuration` → 解码性能；
    特征检测 `if ('requestVideoFrameCallback' in HTMLVideoElement.prototype)`。
  - ⚠️ 注意：主线程回调可能与合成差一个 vsync；用 `expectedDisplayTime` 判断是否已上屏。

### 6.2 Media Session / Picture-in-Picture / Document Picture-in-Picture
- **【具体做法·Media Session（官方）】** 设置 `navigator.mediaSession.metadata`（title/artist/artwork/chapterInfo）
  与 `setActionHandler`（play/pause/seekbackward/seekforward/seekto/nexttrack/…），并 `setPositionState`
  同步播放位置。让用户在**锁屏/媒体中心/耳机键**上控制播放。
- **【具体做法·PiP（官方）】** 旧 PiP：`video.requestPictureInPicture()`（只能放 `<video>`）；
  **Document PiP**：`documentPictureInPicture.requestWindow({width,height})` 后把整个播放器 DOM `append` 进窗口
  （可放**自定义控件、弹幕、播放列表**），关闭时 `pagehide` 把元素搬回。
- **【可测量的收益·指标·UX 价值】** 用户离开页面仍能看/控（会话不断、完播提升）；后台/多任务场景留存；
  Document PiP 让「一起看 + 弹幕 + 自定义控件」在浮窗里也一致。
- **【来源（官方）】** Media Session <https://web.dev/articles/media-session> ；
  PiP <https://web.dev/articles/media/picture-in-picture> ；
  Document PiP <https://developer.chrome.com/docs/web-platform/document-picture-in-picture/> ；
  MDN <https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API>
- **【移植】** 三者都纯前端、本仓库可直接接。特别注意：**Media Session 的 play/pause 要主动同步
  `navigator.mediaSession.playbackState`**（浏览器在 seek/loading 时可能把它判为非播放）。

### 6.3 Page Visibility / 后台节流对播放的影响
- **【具体做法】** `visibilitychange` + `document.hidden/visibilityState`。浏览器对隐藏页：
  停发 rAF、节流 `setTimeout`（预算制：Chrome 隐藏页约 10s 后节流，预算 10ms/s）；
  **例外：正在播音频的标签页被视为前台、不节流**。
- **【可测量的收益·指标】** 省 CPU/电；避免隐藏页的 rAF/弹幕循环空转；前台页面更顺。
- **【来源（官方）】** <https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API>
- **【移植】** 隐藏时：**停掉弹幕 rAF 循环、降码率或暂停、停止轮询**；可见时恢复。可选：像 MDN 示例那样
  「隐藏时 pause、可见且之前在播才 resume」。

### 6.4 Media Capabilities / Network Information / Battery Status（自适应信号）
- **【具体做法·Media Capabilities（官方）】** `navigator.mediaCapabilities.decodingInfo(config)` →
  `{supported, smooth, powerEfficient}`。用于在 ABR 里**剔除设备解不动/不省电的档位**（YouTube 用法，见 §1.3）。
- **【具体做法·Network Information API（官方）】** `navigator.connection` 的
  `effectiveType`（`slow-2g/2g/3g/4g`，由近期 RTT/downlink 综合）、`downlink`、`rtt`、`saveData`、
  `change` 事件 → 据此选初始档/是否省流。
- **【具体做法·Battery Status API（官方）】** `navigator.getBattery()` → `{level, charging}` + 事件
  → 低电量/未充电时**主动降档/降帧/关特效**。（注意隐私/支持面：Safari 已移除，Chrome 支持有限。）
- **【可测量的收益·指标】** 减少「解不动导致的掉帧/卡顿」（YouTube：MTBR +7.1%、画质仅 −0.4%）；
  弱网/saveData 下降低无效流量；低电量时降低功耗。
- **【来源（官方）】** Media Capabilities <https://developer.mozilla.org/en-US/docs/Web/API/Media_Capabilities_API/Using_the_Media_Capabilities_API> ；
  Network Information <https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API> ；
  Battery Status <https://developer.mozilla.org/en-US/docs/Web/API/Battery_Status_API> 与 <https://www.w3.org/TR/battery-status/>
- **【移植】** 组合成一个 **`AdaptivePolicy`** 模块：初始档 = f(`effectiveType`/`saveData`)；
  候选过滤 = f(`mediaCapabilities`)；运行时降档 = f(`battery.level/charging` + buffer + 卡顿历史)。

---

## 7. 按优先级排序的「可落地清单」（针对本项目）

| 优先级 | 做法 | 落点 | 指标 |
| --- | --- | --- | --- |
| P0 | 客户端 QoE 埋点 + `sendBeacon` 上报（VST/卡顿/MTBR/切换/错误） | `player-stats.ts` | 建基线，一切优化的前提 |
| P0 | hls.js/dash.js ABR 参数调优（勿自研 ABR），小缓冲 + 抖动抑制 | `HlsPlayer.vue`/`DashPlayer.vue` | 卡顿率↓、切换次数↓ |
| P0 | 用 **Media Capabilities** 过滤不可顺滑解码的档位 | 自适应模块 | MTBR↑（YouTube +7.1%） |
| P1 | **RVFC** 驱动弹幕/覆盖层 + 丢帧统计 | 弹幕组件 | 帧同步、丢帧可见 |
| P1 | 进度条 **storyboard 预览图**（sprite+VTT） | 进度条组件 | 无效 seek↓、感知 seek 时延↓ |
| P1 | **Page Visibility** 隐藏降载（停弹幕循环/降档/暂停） | 全局 | CPU/耗电↓ |
| P1 | **Media Session** 元数据+动作；**PiP/Document PiP** | 播放器外壳 | 离开页面仍可控、完播↑ |
| P2 | **next 预加载**（隐藏 video/第二实例到 canplay） | 房间队列 | 连播 VST↓ |
| P2 | **dash.js catch-up**（`liveDelay`/`maxDrift`/`playbackRate`） | 直播房间 | 稳定 live edge |
| P2 | **Network Information / Battery** 作为自适应输入 | 自适应模块 | 弱网/省流/低电更优 |
| P2 | FFmpeg + **libvmaf** 生成片源级码率阶梯（轻量 per-title） | 服务端转码 | 同画质更省带宽 |
| P3 | Remote Playback/投屏；软字幕/章节（mediaSession chapterInfo） | 增强 | — |
| ⛔ | PCDN（占用用户上行） | **不做** | 隐私/合规/成本不划算 |

---

## 8. hls.js / dash.js 参数对照（★=移植关键）

### hls.js（`new Hls({...})`）
| 参数 | 含义 | 建议 |
| --- | --- | --- |
| ★ `maxBufferLength` | 目标最大缓冲秒数 | 别设太大（Netflix：过大会恶化起播/画质/卡顿） |
| ★ `maxMaxBufferLength` | 允许因带宽好而放大的上限 | 设一个硬上限 |
| ★ `backBufferLength` | 回退缓冲时长 | 设小（如 30–90s）省内存（直播默认 `Infinity` 注意） |
| ★ `abrEwmaDefaultEstimate` | 初始带宽估计（替代硬设 startLevel） | 官方推荐起播用这个 |
| `startLevel` | 首片档位（-1=自动） | 备选；`-1` 会先下最低档测速 |
| `abrBandWidthFactor` / `abrBandWidthUpFactor` | 下/上行安全系数 | 上调更保守 |
| `capLevelToPlayerSize` | 交付不超过播放器尺寸 | 移动端省流 |
| `enableWorker` | 解析/解封装放 worker | on |
| 低延迟 | `liveSyncDuration`、`liveMaxLatencyDuration` | 控制落后上限；**无内建 catch-up** |
- 【来源】<https://github.com/video-dev/hls.js/blob/master/docs/API.md> ；`startLevel`/`abrEwmaDefaultEstimate` 建议
  <https://github.com/video-dev/hls.js/issues/6172>

### dash.js（`player.updateSettings({...})`）
| 参数 | 含义 | 建议 |
| --- | --- | --- |
| `streaming.abr.ABRStrategy` | `abrThroughput` / `abrBola` / `abrDynamic` | 起步用 **`abrDynamic`**（混合） |
| `streaming.abr.initialBitrate` | 起播初始档 | 结合 `effectiveType` 设 |
| ★ `streaming.delay.liveDelay` | 目标延迟 | 低延迟直播调低（但更难建稳定缓冲） |
| ★ `streaming.liveCatchup.maxDrift` | 超此漂移就 seek 回 live | 设合理阈值 |
| ★ `streaming.liveCatchup.playbackRate.{min,max}` | 追赶速率范围 | 如 `{min:-0.5, max:1}` |
| `streaming.liveCatchup.mode` | `DEFAULT` / `LOLP` | LOLP 兼具缓冲保护 |
- 【来源】<https://dashif.org/dash.js/pages/usage/low-latency.html> ；
  玩家级 ABR 三派系与两款播放器实现 <https://www.abrstreaming.com/blog/adaptive-bitrate-abr>

---

## 9. 全部来源（按主题）

**YouTube**
- [How YouTube improved video performance with the Media Capabilities API (web.dev)](https://web.dev/case-studies/youtube-media-capabilities)
- [Why Doesn't YouTube 1080p Load Ahead?](https://geekyelectronics.com/why-doesnt-youtube-1080p-load-ahead/)
- [Reddit: 理解 YouTube TV stats for nerds（buffer health）](https://www.reddit.com/r/youtubetv/comments/eepacy/a_little_help_understanding_youtube_tv_stats_for/)
- [LinkedIn: YouTube ABR 三信号](https://www.linkedin.com/posts/vibhutirajput_system-design-software-activity-7479218244076216320-Hdmv)
- [Storyboard sprite+VTT（生成/拆分/规格）](https://www.ffmpeg-micro.com/blog/your-video-thumbnail-sprite-sheet-is-fine-the-vtt-cues-drift) ·
  [拆分多 sprite](https://www.nikodev1.medium.com/storyboard-thumbnails-the-scrub-bar-preview-your-players-missing-8ee4182ea5f4) ·
  [FFmpeg+VTT 教程](https://dev.to/masonwritescode/build-scrub-bar-thumbnail-previews-with-ffmpeg-and-an-webvtt-sprite-3ei2) ·
  [规格建议](https://github.com/rachitt/basic-vid-streaming/blob/main/specs/024-thumbnails-sprites.md) ·
  [YouTube 式坐标](https://github.com/soorajsprakash/mpv-seekpeek)

**Netflix**
- [Buffer Sizing and Video QoE Measurements at Netflix (PDF)](https://yuba.stanford.edu/~nickm/papers/buffer-qoe-netflix2019.pdf) ·
  [同文 PDF2](https://brucespang.com/papers/netflix-buffer-sizing.pdf) · [ACM](https://dl.acm.org/doi/abs/10.1145/3375235.3375241) ·
  [NANOG 综述](https://nanog.org/news-stories/nanog-tv/tv-page/)
- [A Buffer-Based Approach to Rate Adaptation (Stanford SIGCOMM)](https://yuba.stanford.edu/~huangty/sigc040-huang.pdf)
- [Netflix Per-Title Encode Optimization](https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2) ·
  [Dynamic Optimizer](https://www.engineering.fyi/article/dynamic-optimizer-a-perceptual-video-encoding-optimization-framework) ·
  [HTML5 Video at Netflix](https://netflixtechblog.com/html5-video-at-netflix-721d1f143979) · [Netflix OSS](https://netflix.github.io/) ·
  [Open Connect（二手）](https://thecybersecguru.com/glossary/netflix-open-connect/)

**Twitch**
- [Twitch 官方：Low Latency Video](https://help.twitch.tv/s/article/low-latency-video) ·
  [2–4s vs 10–15s 与权衡](https://stream-rise.com/blog/twitch-low-latency-video) ·
  [LL-HLS 分块原理](https://codezup.com/how-twitch-cuts-live-stream-delay-low-latency-hls/) ·
  [低延迟追赶脚本](https://greasyfork.org/en/scripts/550707-twitch-low-latency-catch-up)

**Bilibili**
- [高性能直播弹幕：Canvas2D → WebGPU](https://jishuzhan.net/article/2026871326179393537) ·
  [10 个弹幕优化技巧](https://blog.csdn.net/gitblog_00670/article/details/154274509) ·
  [canvas_danmaku（分层/无弹幕暂停）](https://github.com/Predidit/canvas_danmaku) ·
  [Danmaku DOM vs Canvas 双引擎](https://blog.csdn.net/gitblog_01035/article/details/157369277)
- 一起看同步：[Bilibili-Sync](https://github.com/longlongman/Bilibili-Sync) · [Bili-SyncPlay](https://github.com/Sky1wu/Bili-SyncPlay) ·
  [SyncTV](https://zhuanlan.zhihu.com/p/1935663117699903727)
- PCDN（二手）：[Titan/PCDN 伙伴含 Bilibili](https://coinfomania.com/titan-network-accelerates-tencent-game-patches-by-60-with-decentralized-infrastructure/)

**国内工程博客 / QoE 体系**
- [爱奇艺播放技术——300ms 背后的故事](https://www.sohu.com/a/591359250_121124377)
- [爱奇艺×清华 IWQoS 2021（粘性为中心的自适应码率）](https://lmtw.com/mzw/content/detail/id/203460) ·
  [凤凰](https://tech.ifeng.com/c/87qDAApG9Yf) · [DoNews](https://www.donews.com/news/detail/4/3161766.html)
- [爱奇艺知识播放体验优化（InfoQ）](https://www.infoq.cn/article/Xr0lleCNw0ZlyoGJo9oh) ·
  [「零耗时」首帧优化（InfoQ，QoS→QoE→业务）](https://www.infoq.cn/article/YuA5hUImSpPPP46lpmG1)
- [抖音/快手 QoS→QoE 客户端闭环](https://juejin.cn/post/7649033490332073993) ·
  [首帧 170→100ms / +0.6%](https://zhuanlan.zhihu.com/p/667052247)
- QoE 指标：[QoE Metrics That Matter](https://www.abrstreaming.com/blog/qoe-metrics-that-matter) ·
  [HeadSpin 指南](https://www.headspin.io/blog/definitive-guide-media-qoe-metrics-streaming-platforms) ·
  [VMAF/PSNR](https://www.abrstreaming.com/blog/video-quality-metrics-psnr-vmaf)

**Web 平台**
- RVFC：[web.dev](https://web.dev/articles/requestvideoframecallback-rvfc) · [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- Media Session：[web.dev](https://web.dev/articles/media-session)
- PiP：[web.dev](https://web.dev/articles/media/picture-in-picture) · Document PiP：[Chrome](https://developer.chrome.com/docs/web-platform/document-picture-in-picture/) ·
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)
- Page Visibility：[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- Media Capabilities：[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capabilities_API/Using_the_Media_Capabilities_API)
- Network Information：[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API)
- Battery Status：[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Battery_Status_API) · [W3C](https://www.w3.org/TR/battery-status/)
- ABR 玩家级实现：[家长级 ABR 四派系 + hls.js/dash.js](https://www.abrstreaming.com/blog/adaptive-bitrate-abr) ·
  [dash.js 低延迟](https://dashif.org/dash.js/pages/usage/low-latency.html) · [hls.js 无 catch-up](https://github.com/video-dev/hls.js/issues/3077) ·
  [hls.js API](https://github.com/video-dev/hls.js/blob/master/docs/API.md) · [hls.js startLevel/初始估计](https://github.com/video-dev/hls.js/issues/6172)
