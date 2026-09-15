# 开源 Web 播放器播放策略技术清单（工程决策版）

调研日期：2026；方法：官方文档 + GitHub 源码（config/settings/source）+ 技术博客/论文。
覆盖：hls.js、dash.js、Shaka Player、video.js（VHS）、mpv（桌面参考）。

**本项目 = OpenTogetherTube（`opentogethertube-next`）**：Vue 3 同步观影，客户端已用
`hls.js@1.6.12`（`client/src/components/players/HlsPlayer.vue`）与 `dashjs@5.0.3`
（`client/src/components/players/DashPlayer.vue`），并有自定义恢复控制器
`client/src/util/media-recovery.ts`。默认 HLS 缓冲 `hlsBufferSeconds = 60`（可选 30/60/120）。
本清单所有“适用性判断”均针对这一同步观看场景。

> **核验修正（2026-09-15，对照本仓库实际安装的 hls.js@1.6.12 逐项 grep 验证）**
> 下文有三处配置项在本项目使用的 hls.js 版本中**不存在**，请勿照抄：
> - `errorPenaltyExpireMs`（主题 3.4）：1.6.12 无此项。该版本的级别错误处理是
>   `level.loadError` 计数：选级时跳过 `loadError > 0` 的档，但任一分片成功缓冲后会
>   `loadError = 0`（"Resetting level error count … on frag buffered"），不存在“整会话禁用”。
> - `skipBufferHolePadding`（主题 3.4）：不存在（`nudgeOnVideoHole` 存在，已含在默认行为）。
> - `appendTimeout`（主题 3.1）：不存在。
> 已核实**存在**的项：`capLevelToPlayerSize`、`startLevel`、`testBandwidth`、
> `bandwidthEstimate` setter（会重置 ABR 估计）、`abrEwmaDefaultEstimate`、`maxBufferSize`、
> `detectStallWithCurrentTimeMs`、`highBufferWatchdogPeriod`、`maxBufferHole`、
> `nudgeOffset`、`nudgeMaxRetry`、`nudgeOnVideoHole`。

---

## 主题 1：自适应码率（ABR）

### 1.1 hls.js 的 EWMA 带宽估算
- **机制说明**：每次分片下载产生一个吞吐样本。hls.js 同时维护 **fast** 与 **slow** 两条指数加权
  移动平均（EWMA），每条设一个“半衰期”；实际带宽估计取两者的**较小值**——因此下降快、上升慢
  （对网络变差更敏感、对变好更保守）。每个样本的权重还按样本时间戳做年龄衰减（adjusted EWMA）。
  ABR 判定：`abrBandWidthFactor * 估计带宽 > level.bitrate` 才允许保持/降到该级别；
  `abrBandWidthUpFactor * 估计带宽 > level.bitrate` 才允许**升**到该级别；升档门槛更严。
- **默认参数值**（`src/config.ts`，v1.x）：
  | 参数 | 默认 |
  |---|--|
  | `abrEwmaFastVoD` / `abrEwmaFastLive` | 3.0（秒，半衰期） |
  | `abrEwmaSlowVoD` / `abrEwmaSlowLive` | 9.0 |
  | `abrEwmaDefaultEstimate` | 500000 bps（500 kbps） |
  | `abrEwmaDefaultEstimateMax` | 5000000（5 Mbps，限制启动时取首个变体的估值） |
  | `abrBandWidthFactor` | 0.95（保持/降档） |
  | `abrBandWidthUpFactor` | 0.7（升档） |
  | `abrMaxWithRealBitrate` | false |
  | `abrSwitchInterval` | 0（不节流；手动切换永不节流） |
  | `maxStarvationDelay` | 4s（无级别可避免卡顿时，允许 ≤4s 缓冲） |
  | `maxLoadingDelay` | 4s（自动起始级别的首片加载时间上限） |
- **对本项目的适用性**：**保持默认半衰期**。不要为了“画质更快升”而调大 `abrBandWidthUpFactor`
  ——同步房间里反复升降档会让所有观众画面闪烁且加剧卡顿。可用 `abrEwmaDefaultEstimate` 做
  **跨会话缓存**：把上一次的 `hls.bandwidthEstimate` 存入 localStorage，下次实例化时作为
  `abrEwmaDefaultEstimate` 传入（`hls.bandwidthEstimate = x` 的 setter 会重置 EWMA 默认值），
  可省掉冷启动探测、提升首帧质量命中率；配合 `hlsBufferSeconds=60` 的深缓冲，起步级别可以更保守。

### 1.2 hls.js 启动级别与带宽测试
- **机制**：`startLevel` 默认 `undefined` → 取清单中**第一个变体**（`firstLevel`）。只有
  `startLevel = -1` 且 `testBandwidth = true`（默认 true）时，才先下载一个**最低级别**分片估算带宽，
  再选首个自动级别；`hls.firstAutoLevel` 可读该结果。
- **默认值**：`startLevel = undefined`、`testBandwidth = true`、`autoStartLoad = true`、
  `startPosition = -1`、`startFragPrefetch = false`。
- **对本项目的适用性**：本项目用 `autoStartLoad:false` + `startLoad(room 位置)`（很好的优化）。
  但**未设 `startLevel`**，因此实际从清单第一个变体起步、**不做带宽探测**。若源清单把高档放前面，
  会先拉高码率再回退。建议要么 `startLevel = -1`（多一次低级别探测，牺牲约 1 个分片启动延迟），
  要么用 1.1 的 localStorage 估算法跳过探测。同步场景更推荐后者（省一次往返）。

### 1.3 dash.js 的 BOLA / ThroughputRule 混合
- **机制**：dash.js 默认同时启用**吞吐规则**（`throughputRule`）与**基于缓冲的规则**（`bolaRule`）。
  两者都开时进入**动态模式**：缓冲未达标时用 ThroughputRule，达到 `hybridSwitchBufferTime` 后切到 BOLA。
  另有若干并行规则（默认部分开启）用于纠偏。
- **默认参数值**（`src/core/Settings.js`，v5.x）：
  | 规则 | 默认 active | 参数 |
  |---|--|--|
  | `throughputRule` | true | — |
  | `bolaRule` | true | — |
  | `insufficientBufferRule` | true | `throughputSafetyFactor:0.7`, `segmentIgnoreCount:2` |
  | `switchHistoryRule` | true | `sampleSize:8`, `switchPercentageThreshold:0.075` |
  | `droppedFramesRule` | **false** | `minimumSampleSize:375`, `droppedFramesPercentageThreshold:0.15` |
  | `abandonRequestsRule` | true | `abandonDurationMultiplier:1.8`, `minSegmentDownloadTimeThresholdInMs:500`, `minThroughputSamplesThreshold:6` |
  | `l2ARule` / `loLPRule` | false | 低延迟专用 |

  吞吐计算：`averageCalculationMode = EWMA`、`bandwidthSafetyFactor = 0.9`、`useDeadTimeLatency = true`、
  `ewma.throughputSlowHalfLifeSeconds = 8`、`throughputFastHalfLifeSeconds = 3`、`sampleSettings.vod = 4`。
  `hybridSwitchBufferTime = 12`（秒）。`initialBitrate/minBitrate/maxBitrate` 均 `-1`（不限制）。
- **对本项目的适用性**：**保持默认双规则**。同步观看要“稳”，BOLA/缓冲规则能在缓冲健康时守住高质量、
  缓冲不足时果断降档，正好契合 60s 深缓冲。可选：把 `droppedFramesRule` 置 `true`，在弱解码设备上
  主动降档（避免掉帧观感差）；把 `initialBitrate.video` 设为约 1500–2000 kbps，避免 dash 冷启动直冲高档。

### 1.4 Shaka 的 SimpleAbrManager（升级/降级阈值）
- **机制**：基于 EWMA 吞吐估计，选“估计带宽能支撑的**最高**变体”。对候选级别 `item` 与其上一档 `next`：
  `minBandwidth = itemBandwidth / bandwidthDowngradeTarget`，
  `maxBandwidth = nextBandwidth / bandwidthUpgradeTarget`，当估计值落在区间内才选 `item`。
  因此**升档门槛 ≈ 下一档码率 / 0.85 ≈ 1.18×**，**保持门槛 ≈ 当前码率 / 0.95 ≈ 1.05×**。
  有启动期：需 `hasGoodEstimate()` 通过且离开 `switchInterval` 才切换；每 `switchInterval` 最多切换一次。
- **默认参数值**（`lib/util/player_configuration.js` / `lib/abr/simple_abr_manager.js`）：`defaultBandwidthEstimate = 1e6`（1 Mbps）、
  `switchInterval = 8`s、`bandwidthUpgradeTarget = 0.85`、`bandwidthDowngradeTarget = 0.95`、
  `minTimeToSwitch = 0`、`cacheLoadThreshold = 5`、`minTotalBytes = 128e3`、`minBytes = 16e3`、
  `fastHalfLife = 2`、`slowHalfLife = 5`。开启 `connection.saveData` 时默认 `maxHeight = 360p`。
- **对本项目的适用性**：本项目**未使用 Shaka**，但其“升降阈值分离 + 最长 8s 切换间隔 + 半衰期 2/5”
  模型值得借用：如果自研或替换 hls.js 的 ABR，可用更短的 slow half-life（更贴合短视频/剧集切换）和
  明确的最小切换间隔，减少房间里频繁跳档。8s 间隔对同步观看偏长，可考虑 4–6s。

### 1.5 Media Capabilities API 在 ABR 中的应用
- **机制**：`navigator.mediaCapabilities.decodingInfo(config)` 返回 `{supported, smooth, powerEfficient}`，
  用于在选码率/选轨/选编码前过滤设备不支持或“解码不流畅/不省电”的组合。
- **各库默认**：hls.js `useMediaCapabilities = true`（用于 level/track/switch 过滤；
  可用 `hls.removeLevel()` 手动剔除误判级别）。dash.js `capabilities.useMediaCapabilitiesApi = true`
  （编码检测 + `filterVideoColorimetryEssentialProperties`/`filterHDRMetadataFormatEssentialProperties`）。
  Shaka 用 `decodingInfo` 做编解码支持判定与 `preferredDecodingAttributes` 偏好；`preferredVideo[].hdrLevel` 默认 `AUTO`。
- **对本项目的适用性**：**保持开启**（两库默认已开）。同步房间尤其重要：应阻止某位观众因选到设备不支持
  的编码而黑屏/卡死，拖累整房间同步。本项目两库均未改动此项，维持默认即可。

### 1.6 YouTube / Netflix 公开 ABR 要点
- **机制**：Netflix 与学界共同推动**基于缓冲（buffer-based, BBA）**：以当前缓冲占用 `B(t)` 直接映射码率，
  而非仅靠吞吐预测；论文《A Buffer-Based Approach to Rate Adaptation》(SIGCOMM 2014) 报告相对当时
  Netflix 默认算法**再卡顿率降低 10–20%**、平均码率相当、稳态码率更高。生产上多为**混合**：
  缓冲低时用吞吐、缓冲高时用缓冲（BOLA，INFOCOM 2016 用 Lyapunov 优化缓冲-码率映射）。
  YouTube 亦为吞吐+缓冲启发式（EWMA + 缓冲护栏）。
- **对本项目的适用性**：**采用混合思路**（dash.js 已内置；hls.js 是纯吞吐 EWMA + `maxStarvationDelay`
  兜底）。60s 深缓冲本身就是最好的“缓冲护栏”——只要 ABR 不在缓冲健康时过度保守即可。

---

## 主题 2：缓冲管理

### 2.1 hls.js 缓冲/驱逐参数
- **机制**：`maxBufferLength` 是**保证达到**的前向缓冲秒数（不足即拉新分片）；`maxMaxBufferLength`
  是硬上限秒数；`maxBufferSize` 是**字节上限**（默认 60MB），hls.js 优先按字节而非秒来模仿浏览器
  驱逐；`backBufferLength` 控制已播放回退缓冲的保留与驱逐；`frontBufferFlushThreshold` 控制前向
  非连续区段的主动驱逐。
- **默认参数值**（`src/config.ts`）：`maxBufferLength = 30`s、`maxMaxBufferLength = 600`s、
  `maxBufferSize = 60*1000*1000`（60MB）、`backBufferLength = Infinity`、`frontBufferFlushThreshold = Infinity`、
  `maxBufferHole = 0.1`s、`maxFragLookUpTolerance = 0.25`s、`appendErrorMaxRetry = 3`、`appendTimeout = Infinity`、
  `liveDurationInfinity = false`。
- **对本项目的适用性**：本项目把 `maxBufferLength = maxMaxBufferLength = hlsBufferSeconds(默认60)`、
  `backBufferLength = 30`。判断：**方向正确**。两点注意：
  1. `maxBufferSize` 仍为默认 60MB。对 1080p/5 Mbps 的源，60s ≈ 37.5MB，够用；但若源单档 > 8 Mbps，
     60s 会先撞到 60MB 字节上限，实际前向缓冲会低于 60s。若要保证 60s，需要相应提高 `maxBufferSize`
     （如 100–150MB）或接受按字节驱逐。
  2. `backBufferLength = 30` 对**同步观看的“回退/重看同一个点”**是加分项（不必重新下载）；可考虑
     提到 30–60s 与房间“跳转/回退”习惯匹配，代价是内存。

### 2.2 hls.js 启动优化
- **机制/默认值**：`autoStartLoad:true`、`startPosition:-1`、`startLevel:undefined`、
  `testBandwidth:true`、`startFragPrefetch:false`。`autoStartLoad:false` 时需显式
  `hls.startLoad(startPosition, skipSeekToStartPosition?)`。
- **对本项目的适用性**：本项目 `autoStartLoad:false` + `startLoad(hlsStartPosition())`，
  代码注释已说明“直接从房间位置加载，避免先取 0 再 seek 的额外往返”——**这是最优的同步入场策略**，
  保留。可选加 `startFragPrefetch`（媒体未 attach 前预取首个分片）进一步压缩首帧，但对同步位置加载
  意义有限，优先级低。

### 2.3 其他库的缓冲目标（对照）
- **dash.js**：`bufferTimeDefault = 18`s、`bufferTimeAtTopQuality = 30`s、
  `bufferTimeAtTopQualityLongForm = 60`s、`longFormContentDurationThreshold = 600`s、
  `initialBufferLevel = NaN`、`bufferToKeep = 20`s、`bufferPruningInterval = 10`s、
  `stallThreshold = 0.3`、`useAppendWindow = true`。
- **Shaka**：`bufferingGoal = 10`s、`rebufferingGoal = 0`、`bufferBehind = 30`s、`evictionGoal = 1`、
  `startAtSegmentBoundary = false`、`segmentPrefetchLimit = 1`。
- **video.js/VHS**：`BUFFER_LOW_WATER_LINE = 0`、`BUFFER_HIGH_WATER_LINE = 30`。
- **mpv（桌面参考）**：不做客户端 ABR，靠**大读取缓存**：`cache=auto`、默认 `cache-secs = 36000`
  （10 小时，受 `demuxer-max-bytes` 限制）、`demuxer-max-bytes`（前向，默认 150MiB）、
  `demuxer-max-back-bytes`（回退，默认 75MiB）、可选 `cache-on-disk`。

### 2.4 为什么 60s 缓冲对 VOD 合理 / 推荐区间
- **机制说明**：VOD 无直播延迟约束，缓冲是“用内存换卡顿”的直接手段。缓冲越深，
  ABR 越可在缓冲高时敢于升档（混合策略的 BOLA 段），在网络抖动时也有更多回旋。
- **各库推荐区间**：dash.js 长内容顶点目标 30–60s；Shaka 默认较保守（10s），文档明确“默认非常保守、应按应用自定义”；
  hls.js 保证值 30s + 上限 600s；VHS 高水位 30s；mpv 直接按分钟/小时缓存。
- **对本项目的适用性**：**60s 默认是合适的**——同步观影对延迟不敏感、对“卡一下所有人都等”敏感。
  30s 选项适合移动网络/低内存设备，120s 适合稳定宽带的长片。项目已做成 30/60/120 三档，
  判断合理，无需改默认值。

---

## 主题 3：错误恢复 / 卡顿处理

### 3.1 hls.js 错误矩阵
- **机制**：所有错误经单一 `Hls.Events.ERROR` 抛出，含 `type`（`NETWORK_ERROR` / `MEDIA_ERROR` /
  `KEY_SYSTEM_ERROR` / `MUX_ERROR` / `OTHER_ERROR`）、`details`、`fatal`。
  非 fatal 由 hls.js 自行恢复；fatal 需应用介入。
- **重试策略（LoadPolicy，新式统一配置）**：
  | 资源 | maxLoadTimeMs | maxTimeToFirstByteMs | timeoutRetry(maxNumRetry) | errorRetry(maxNumRetry / retryDelayMs / maxRetryDelayMs) |
  |---|--|--|--|--|
  | `manifestLoadPolicy` | 20000 | Infinity | 2 | 1 / 1000 / 8000 |
  | `playlistLoadPolicy` | 20000 | 10000 | 2 | 2 / 1000 / 8000 |
  | `fragLoadPolicy` | **120000** | 10000 | 4 | **6** / 1000 / 8000 |
  | `keyLoadPolicy` | 20000 | 8000 | 1（linear） | 8 / 1000 / 20000（linear） |

  退避：`retryDelay = 2^retryCount * retryDelayMs`（指数）或 `retryCount * retryDelayMs`（线性），
  上限 `maxRetryDelayMs`。
- **媒体错误恢复**：`hls.recoverMediaError()` 重置 MediaSource 并从**上次播放位置**重启；
  文档明确“仅在媒体元素处于错误态时用，不要响应非 fatal 事件”。`hls.swapAudioCodec()` 已不推荐。
  关键 `details`：`BUFFER_STALLED_ERROR`、`BUFFER_SEEK_OVER_HOLE`、`BUFFER_NUDGE_ON_STALL`
  （前几次非 fatal，达 `nudgeMaxRetry` 仍卡则 fatal）、`BUFFER_FULL_ERROR`（自动减小最大缓冲恢复）、
  `MEDIA_SOURCE_REQUIRES_RESET`（重建 MediaSource）、`BUFFER_APPEND_NO_PROGRESS`（达 `appendErrorMaxRetry`
  后把分片标记为 gap 防循环）。
- **gap / 卡顿参数默认**（`src/config.ts`；注意 `highBufferWatchdogPeriod` 源码为 **2**，API 文档正文写 3）：
  | 参数 | 默认 | 作用 |
  |---|--|--|
  | `detectStallWithCurrentTimeMs` | 1250ms | currentTime 不走且无 waiting 事件时的停顿时长 |
  | `highBufferWatchdogPeriod` | 2s（源码） | 预期播放却 2s 不前进且前方缓冲 > maxBufferHole 时，跳 gap 或 nudge |
  | `maxBufferHole` | 0.1s | 允许的分片间空洞容差 |
  | `nudgeOffset` | 0.1s | 每次 nudge 的步进 |
  | `nudgeMaxRetry` | 3 | 跳洞/ nudge 最大重试，超限分别报 fatal `BUFFER_SEEK_OVER_HOLE` / `BUFFER_STALLED_ERROR` |
  | `nudgeOnVideoHole` | true | 跨视频洞时 seek nudge 冲刷渲染管线 |
  | `skipBufferHolePadding` | 0.1s | 跳洞目标额外偏移，应对 Tizen/Xbox/旧 Edge 取整 |
  | `appendErrorMaxRetry` | 3 | append 重试上限（Quota 已满时等浏览器驱逐） |

### 3.2 Shaka 的 gap / 重试
- **gap**：`gapDetectionThreshold = 0.5`s、`gapPadding = 0`、`gapJumpTimerTime = 0.25`s；
  停顿时 `stallEnabled = true`、`stallThreshold = 1`s、`stallSkip = 0.1`s。
- **重试默认**（`docs/tutorials/network-and-buffering-config.md`）：`timeout = 30000ms`、
  `stallTimeout = 5000ms`、`connectionTimeout = 10000ms`、`maxAttempts = 2`、`baseDelay = 1000ms`、
  `backoffFactor = 2`、`fuzzFactor = 0.5`（±50% 抖动，避免惊群）。分别作用于
  `drm.retryParameters` / `manifest.retryParameters` / `streaming.retryParameters`。
  另有 `allowMediaSourceRecoveries = true`、`minTimeBetweenRecoveries = 5`s。
  （注：`jumpLargeGaps` 是 **dash.js** 的命名，Shaka 无同名项。）

### 3.3 dash.js 的 gap / 重试
- **gap 默认**：`jumpGaps = true`、`jumpLargeGaps = true`、`smallGapLimit = 1.5`s、
  `threshold = 0.3`s（`currentRangeEnd - currentTime < threshold` 触发跳洞）、`enableSeekFix = true`、
  `enableStallFix = false`、`stallSeek = 0.1`s、`seekOffset = 0`、`checkInterval = 250ms`。
- **重试默认**：`fragmentRequestTimeout = 20000ms`、`manifestRequestTimeout = 10000ms`；
  `retryIntervals`: MPD 500 / 媒体&init 1000 / license 1000，`lowLatencyReductionFactor = 10`；
  `retryAttempts`: MPD 3 / 媒体 3，`lowLatencyMultiplyFactor = 5`；
  错误恢复 `errors.recoverAttempts.mediaErrorDecode = 5`（重置 MSE 并跳过触发解码错误的分片，留下 gap 交给 GapController）。

### 3.4 各自的 stall recovery 实践 & 本项目现状
- **官方建议**：hls.js 对 fatal MEDIA_ERROR 调 `recoverMediaError()` 且**加时间窗限流**
  （示例用 5s 内不重复恢复），fatal NETWORK_ERROR **不要立即重启加载**（会形成加载循环），
  应调优 LoadPolicy；Shaka/dash.js 用“固定重试次数 + 指数退避 + 抖动”。
- **本项目现状（`media-recovery.ts`）**：已自研一整套，质量很高——网络重试延迟 `[1000,3000,6000]`、
  解码错误仅 1 次（延迟 1000ms）、恢复超时 30s 兜底、不可重试码 `[400,401,403,404,410]`；
  停用检测 `STALL_TRIGGER_MS = 8000`、间隔 1000ms；恢复阶梯：先 `onStallRefetch`（调
  `hls.recoverMediaError()` 重新拉取同一区段）→ 再 nudge `STALL_NUDGE_SECONDS = 0.3`（在房间 0.3s
  dead band 内，不可见）→ 最后 skip `STALL_SKIP_SECONDS = 3` 并 toast 告知；后台标签页不计卡顿。
- **适用性判断（可直接落地的补强）**：
  1. hls.js **未设 gap 参数**，其中 `skipBufferHolePadding`/`nudgeOnVideoHole` 是**1.6.x 新增且有用**
     （对 Tizen/Xbox/旧 Edge 的取整问题）；建议保留默认，或针对报告取整设备的源把
     `skipBufferHolePadding` 提到 **≥ GOP 长度**。
  2. 建议显式设置 `fragLoadPolicy`（当前用默认 6 次重试 / maxLoadTimeMs 120s）。对**不稳定的直链第三方源**，
     更高重试有帮助；对**已确认的 4xx** 保持现状快速失败。
  3. hls.js `errorPenaltyExpireMs` 默认 `0`（出错级别在会话内被**永久排除**），其注释明确“瞬时错误会导致
     被钉在低画质直到 `stopLoad()`”。同步长片尤其危险——建议设为 **30000–60000**，让被罚级别可重新入选。
  4. dash.js 未设 gap/重试；默认 `jumpGaps/jumpLargeGaps=true` 已能跳过断点。可考虑
     `enableStallFix=true`（配合 `stallSeek=0.1`）作为 hls.js 恢复阶梯的等价物。

---

## 主题 4：前沿特性

### 4.1 MSE-in-Workers
- **机制/现状**：把 `MediaSource` 创建在 **DedicatedWorker**，通过 `MediaSourceHandle` `postMessage`
  给主线程 `<video>`；分片 append/缓冲在 worker，避免主线程繁忙时的“buffering jank”。
  浏览器支持：**仅 Chromium，Chrome 108+ 默认开启**（MDN / Chrome Platform Status
  `feature/5177263249162240`）。
- **各库支持**：hls.js 与 dash.js **目前未采用** MSE-in-Workers（hls.js 的 worker 仅用于 TS 解封装/
  MP4 重封装，MSE 仍在主线程）。收益：主线程卡顿（发消息、渲染、聊天）时更不易断流。
- **对本项目的适用性**：**暂不适用**（依赖库未支持，且非 Chrome 无此能力）。可关注 hls.js issue 跟进；
  一旦支持，对“同屏聊天+频繁房间消息”造成的卡顿会有实质改善。当前优先级：低。

### 4.2 WebCodecs 在播放器中的应用
- **机制/现状**：`WebCodecs` 提供 `VideoDecoder`/`AudioDecoder` 等逐帧 API，可绕开 MSE 直接
  解码+渲染（画布/WebGL），适合逐帧精确（帧精确 seek、trick-play、转码）。
  **Shaka** 的 WebCodecs 用途是 **HEVC 软件回退**：在无原生 HEVC 解码的浏览器（Firefox、Linux 上的 Chrome）
  上，通过 `@hevcjs/shaka-plugin` 用 WebCodecs 把 H.265 转码为 H.264——**需 MSE SourceBuffer + WebCodecs 同时可用**。
  Shaka 核心播放仍走 MSE/EME；Shaka 另有 `mediaSource.codecSwitchingStrategy`（默认 `RELOAD`，
  设备支持平滑切换时用 `SMOOTH`）。
- **对本项目的适用性**：**暂不适用**。本项目用 hls.js/dash.js，不走 WebCodecs 路径；且同步观看不需要帧精确。
  若未来要支持“仅 HEVC 的源 + 老设备”，可评估 Shaka + hevc 插件，或在服务端转码。当前优先级：低。

### 4.3 gap jumping / jumpLargeGaps 的实现差异
- **hls.js**：由 `gap-controller` 驱动，**基于 currentTime 不前进的时长** 判定停顿
  （`detectStallWithCurrentTimeMs` / `highBufferWatchdogPeriod`），在**缓冲空洞**上做 skip，
  在**缓冲区内但卡住**时做 nudge（`currentTime += nudgeRetries * nudgeOffset`），并有
  `skipBufferHolePadding` 处理取整；跳洞报 `BUFFER_SEEK_OVER_HOLE`、nudge 超限报 `BUFFER_NUDGE_ON_STALL`。
- **dash.js**：由 **GapController** 周期（`checkInterval=250ms`）**扫描 buffered 区间**，
  按 `threshold=0.3s` 触发；`smallGapLimit=1.5s` 区分“小/大 gap”，分别由 `jumpGaps` / `jumpLargeGaps` 控制；
  可 `seekOffset` 微调、`enableSeekFix` 修正 seek 到空洞。
- **Shaka**：`gap_jumping_controller.js`，`gapDetectionThreshold=0.5s` + 定时器 `gapJumpTimerTime=0.25s`；
  停顿另由 `stallThreshold/stallSkip` 处理。
- **对本项目的适用性**：hls.js 是“**事件驱动 + 阈值**”，dash.js 是“**轮询扫描**”。本项目已有自研停用检测
  （8s 触发），与 hls.js 内建 gap-controller 并存不冲突（内建先小步 nudge，自研兜底重取/跳过）。
  建议：不要禁用 hls.js 的 `gapController`（默认启用），它是第一道防线。

### 4.4 预加载 / 预热下一条视频
- **机制/现状**：
  - **Shaka** 有完整 preload API：`player.preload(url, startTime?, mimeType?)` → `preloadManager`
    （加载清单 + 首批分片，数量由 `streaming.segmentPrefetchLimit` 控制，默认 1）；
    之后 `player.load(preloadManager)` 立即起播；`unloadAndSavePreload()` 保存清单、播放时间与
    **上次 ABR 估计**。队列相关：`queue.preloadNextUrlWindow = Infinity`、`queue.preloadPrevItem = true`、
    `queue.autoPlayNext = true`；流内 `streaming.preloadNextUrlWindow = 30`s。
  - **hls.js** 无“预加载下一条”API，但可**提前实例化/预取清单**：在播放到接近片尾时，另开一个
    （或复用）`Hls` 实例预拉下一条的 multivariant playlist + 首个分片，或用 `hls.createIFramePlayer()`
    预取；也可用普通 `fetch` 预取清单文本经自定义 `pLoader` 命中缓存。
  - **dash.js** 无独立 preload API，需自建（预拉 MPD）。
- **对本项目的适用性**：**高价值、可落地**。OTT 是**剧集自动连播**场景，片尾切下一条时的黑屏/等待最伤体验。
  建议：在剩余时长 < 15–30s 时，对队列下一项**预取清单**（hls.js `fetch` 清单 / dash 预取 MPD），
  并在安全时预取首个分片；切换时不重建整页。注意同步房间要等服务器统一换片，预取只缓存、不提前播放。

---

## 主题 5：画质切换的平滑性

### 5.1 dash.js `fastSwitchEnabled` 原理
- **机制**：质量切换时，dash.js 二选一：把新片段**追加到当前缓冲末尾**，或**替换当前缓冲的一部分**。
  `fastSwitchEnabled = true` 时，**升档**会把下一个（更高）片段请求并追加到**靠近当前播放点**
  （渲染更高画质的最长时间 ≈ `currentTime + 1.5 × 片段时长`）；而**降档**时仍追加到缓冲末尾，
  以**尽量保留已缓冲的高画质**不被立即替换。边界：缓冲不足一个片段时长、或处于“放弃(abandonment)”
  状态时，退化为追加到末尾。
- **默认值**：`fastSwitchEnabled = null`（对**非低延迟**播放自动启用，实际等效 true）；
  `flushBufferAtTrackSwitch = false`；`trackSwitchMode.video = NEVER_REPLACE`、`audio = ALWAYS_REPLACE`。
- **对本项目的适用性**：本项目**已显式 `fastSwitchEnabled: true`**（`DashPlayer.vue` 内有详细注释），
  判断**正确**——同步房间里追求“升档尽快可见、降档不打断”，正是该特性设计目标。保持。

### 5.2 hls.js nextLevel / currentLevel / autoLevelEnabled 与 flushBuffer
- **机制/区别**：
  - `hls.currentLevel = n`：**立即**切换——中止当前分片请求、**flush 整个缓冲**、从当前位置按新级别取片。
  - `hls.nextLevel = n`：为**下一个分片**切换，可能 flush **已缓冲的下一个分片**（不清空整个缓冲）。
  - `hls.loadLevel = n`：设置**下一个加载**分片的级别（不主动改已缓冲/已播放）。
  - `hls.nextLoadLevel = n`：仅强制**下一个分片**的加载级别，之后回到 `loadLevel`。
  - `hls.autoLevelEnabled`：自动选择是否启用；`autoLevelCapping` 限制自动上限；`-1` 表示自动。
  - hls.js **没有** dash.js 那样的“把升档片段插到播放点附近”的 fast-switch 机制；平滑性依赖选对
    setter（`nextLevel` 而非 `currentLevel`）。
- **对本项目的适用性**：本项目 `setVideoTrack()` **用 `hls.nextLevel = track`**（并在注释里解释了
  currentLevel/loadLevel/nextLevel 差异）——**完全正确**：同步房间绝不能因手动选档而 flush 整个缓冲导致
  全场卡顿。继续保持；**不要**改用 `currentLevel`。自动模式用 `-1`（`autoLevelEnabled`）切换。

### 5.3 切换时避免黑屏 / 卡顿的技巧（汇总）
- 手动选档：hls.js 用 `nextLevel`（不用 `currentLevel`）；dash.js 用
  `setRepresentationForTypeByIndex(type, idx, forceSwitch=false)` + `fastSwitchEnabled:true`
  （本项目已如此，注释说明“forceSwitch=true 会激进清缓冲导致重缓冲，故设 false”）。
- 保证有“切换余量”：前向缓冲 ≥ 1–2 个片段再切升档，避免刚切就断粮。
- dash.js 降档保留高画质缓冲（`NEVER_REPLACE` + 追加到末尾），升档才插入播放点——不要改动默认
  `trackSwitchMode`。
- 让 ABR 在缓冲健康时才有主动权：`abrSwitchInterval`/Shaka `switchInterval` 抑制频繁抖档；
  dash.js `switchBanditsHistoryRule`（`switchHistoryRule`）在频繁掉档时抑制切换。
- 编码边界（跨 codec 切换）会触发 MSE `changeType()`/重载：dash.js 有 `useChangeType=true`
  （不可用时回退），Shaka 用 `codecSwitchingStrategy`；混合编码清单应尽量让各档同 codec。

---

## 附：对本项目的落地优先级（建议）

| 优先级 | 动作 | 位置 | 依据 |
|---|---|---|---|
| P0 | 保持 dash.js `fastSwitchEnabled:true`、hls.js 用 `nextLevel` | 现有代码 | 主题 5 |
| P0 | 保持 60s 缓冲默认与 `autoStartLoad:false`+`startLoad(位置)` | 现有代码 | 主题 2 |
| P1 | 设 hls.js `errorPenaltyExpireMs ≈ 30000–60000` | `HlsPlayer.vue` | 主题 3（避免瞬时错误被钉在低画质） |
| P1 | 剧集下一项**预取清单**（片尾 15–30s 触发） | 新逻辑 | 主题 4.4 |
| P1 | 用 localStorage 缓存 `hls.bandwidthEstimate` 作下次 `abrEwmaDefaultEstimate` | `HlsPlayer.vue` | 主题 1.1 |
| P2 | 视源码率调整 hls.js `maxBufferSize`（保证 60s 不被 60MB 截断） | `HlsPlayer.vue` | 主题 2.1 |
| P2 | 对不稳定第三方源显式调优 `fragLoadPolicy`；对取整设备调 `skipBufferHolePadding` | `HlsPlayer.vue` | 主题 3.1 |
| P2 | dash.js 视情况开 `droppedFramesRule` / `enableStallFix` | `DashPlayer.vue` | 主题 1.3 / 3.4 |
| P3 | 关注 hls.js 对 MSE-in-Workers 的支持；WebCodecs 暂不引入 | — | 主题 4 |

---

## 来源

- hls.js 默认配置与参数：https://github.com/video-dev/hls.js/blob/master/src/config.ts ；https://github.com/video-dev/hls.js/blob/master/docs/API.md ；https://hlsjs.video-dev.org/api-docs/hls.js.abrcontrollerconfig
- hls.js 带宽估算原理（EWMA/半衰期）：https://redopop.com/posts/how-hlsjs-estimates-bandwidth/
- dash.js 默认配置：https://github.com/Dash-Industry-Forum/dash.js/blob/development/src/core/Settings.js ；ABR 文档：https://dashif.org/dash.js/pages/usage/abr/settings.html
- Shaka 默认配置：https://github.com/shaka-project/shaka-player/blob/main/lib/util/player_configuration.js ；SimpleAbrManager：https://github.com/shaka-project/shaka-player/blob/main/lib/abr/simple_abr_manager.js ；网络/缓冲教程：https://github.com/shaka-project/shaka-player/blob/main/docs/tutorials/network-and-buffering-config.md ；预加载：https://github.com/shaka-project/shaka-player/blob/main/docs/tutorials/preload.md ；平台支持/HEVC+WebCodecs：https://github.com/shaka-project/shaka-player/blob/main/README.md
- video.js / VHS ABR：https://deepwiki.com/videojs/http-streaming/6.1-adaptive-bitrate-streaming ；https://github.com/videojs/http-streaming
- Media Capabilities API：https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo
- MSE-in-Workers：https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API ；https://chromestatus.com/feature/5177263249162240 ；https://wolenetz.github.io/mse-in-workers-demo/
- WebCodecs：https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- Netflix/缓冲式 ABR 论文：https://web.stanford.edu/class/cs244/papers/sigcomm2014-video.pdf ；https://dl.acm.org/doi/10.1145/2619239.2626296
- mpv 缓存与 HLS 固定码率：https://github.com/mpv-player/mpv/issues/15158 ；https://trac.ffmpeg.org/ticket/2886 ；https://github.com/mpv-player/mpv/issues/6726
