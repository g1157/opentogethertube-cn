# 旧设备（未开超分）画面与声音卡顿排查（2026-10-07）

起因：有旧设备反馈**没有开启画质增强**也会出现画面与声音卡顿。用户要求"顺便调查，没有把握的先放着"，
因此本文只做证据整理，**本版不改同步/缓冲代码**；每一项都给出最小改点与需要真机测量的量。

前置事实：超分关闭时增强层根本不挂载（`DirectPlayer.vue` / `HlsPlayer.vue` / `DashPlayer.vue` 里
`UpscaleLayer` 都是 `v-if="upscaleMode !== 'off'"`），自动降档监测、WebGPU 探针、250ms 字幕采样都不运行。
本仓库在正常机器上的实测也表明关闭增强时等同裸播（`docs/upscale-performance-2026-09-30.zh-CN.md` 第一节）。
所以问题只能来自**常驻路径**。

## 候选（按证据强度排序）

### 1. 速率弯曲以 4Hz 重写 `playbackRate`（代码可证）

`client/src/util/playback-sync.ts`（`writeRate` 与 `tick` 的弯曲计算、`RATE_WRITE_THRESHOLD = 0.002`）。
`video.currentTime` 只在出新帧时跳变（24fps 片源每秒 24 次、每次约 41.7ms），弯曲每 250ms 按
`drift / 0.5 × ceiling` 重算——漂移测量被帧间隔量化放大后，**每次 tick 的速率变化都超过 0.002 的阈值**，
也就是弯曲持续期间近乎每 250ms 写一次 `playbackRate`（测试 `playback-sync.spec.ts` 也固化了 3 tick 3 写的
节奏）。每次写入都会让浏览器以新速率重新安排帧呈现与音频时间伸缩（`preservesPitch` 保持默认 true）。
**最小改点**：给 `writeRate` 加写入最小间隔，或把阈值从"速率差"改成"漂移差 ≥ 一帧 + 20ms"。需要真机对照
（音乐内容对变速最敏感），本仓库文档已把该项列为"仍需实测音乐内容"。

### 2. 弯曲到期 → 硬 seek → 立刻重新弯曲（循环）（代码可证）

`playback-sync.ts` 的截止逻辑：8–30s（随追平量）仍不收敛则 `cancelBend()` + 硬 seek；硬 seek 是
"暂停元素 + 设 currentTime"，对用户是一次可闻的停顿/断音，之后冷却期结束又进入下一轮弯曲。弱机上
"元素追不上房间时钟"会长期处于这个循环。**最小改点**：连续 N 次截止后进入只 seek 的更长冷却（或暴露
次数计数供观测）。这正是文档里一直缺的"8 秒回退次数"指标。

### 3. 常驻 4Hz 主线程轮询（已知问题 P14）

`client/src/views/Room.vue` 的 250ms `timestampUpdate`：5 个 tick + 2 个响应式写 + 控制条重渲染，
页面隐藏时仍然运行（`docs/project-review-2026-10-05.zh-CN.md` P14 已记录并给出建议）。
**最小改点**：`document.hidden` 暂停该轮询并改由 `timeupdate`/rVFC 驱动；注意后台标签仍要正确应用
房间的播放/暂停状态（这是不能简单停掉的原因）。

### 4. HLS/DASH 深缓冲的内存余量

`HlsPlayer.vue`：`maxBufferSize` 150MB / 低内存设备 60MB，后者只认 Chromium 的 `deviceMemory`
（Firefox/Safari/旧内核拿不到 → 一律 150MB）；`maxBufferLength` 默认 120s（hls.js 默认 30）。
在 4Mbps 源下 150MB ≈ 300s 的 A/V 在 SourceBuffer 里。平台调研（`platform-qoe-research.zh-CN.md`）
引 Netflix 的结论是"缓冲别设太大"。**最小改点**：`deviceMemory` 不可得时不要抬到 150MB。
与"能多缓就多缓"的产品取舍冲突，需真机（低内存安卓）验证后再定。

### 5. 其他（证据较弱，仅记录）

-   缓冲（`buffering`）期间同步引擎仍会弯曲/写速率（`canObserve` 未排除 buffering），而此刻漂移测量
    对卡顿期没有意义；可作为第 1 项的一部分一起改。
-   `sfx` 在进入房间时就创建 `AudioContext` 并解码音频（即使 `sfxEnabled=false`）；音频增强管线默认
    不建图。两个空闲上下文的实际代价未测。
-   `progress` 事件驱动缓冲区间提交，旧设备上会反复触发滑块重算；可加节流，但与音画卡顿的关联未证。

## 需要真机做的事（建议顺序）

1. 在出问题的设备上打开「视频详情」，记录：**实测帧率、丢帧、与房间偏差**在卡顿时的数值与波动；
2. 在 `writeRate`/截止 seek 处加临时计数（或日志），统计 1 分钟内**速率写入次数**与**截止重试次数**；
3. 对照关闭速率弯曲（可临时把 `MAX_BEND` 置 0 或把 `BEND_START` 抬到很大）后的同一片段观感。

以上三项拿到数据后再改第 1、2 项；第 3 项（P14）与第 4 项各自独立评估。
