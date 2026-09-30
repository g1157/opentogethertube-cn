# 画质增强的性能实测与三处修正（2026-09-30）

同一台机器（MacBook Air、Apple M5、8 核 GPU、无风扇、16 GB，内屏 2560×1664、dpr 2），同一段真实片源
（1080p H.264 High、23.976 fps、约 2.04 Mbps、硬解、下行实测 1.9–2.8 MB/s），用 Chrome 与 Safari 逐档测
10 秒的**呈现帧率**（`requestVideoFrameCallback` 计数）与丢帧，并逐次核对画布的**实际像素尺寸**。

## 结论速览

1. **机器与片源都没问题**：裸播（无应用、无增强）Chrome 23.86 fps、0 丢帧；应用内关闭增强 23.96 fps。
2. **真正的开销只有 AI 两档，且与画布像素成正比**：同一档位 1080p 画布 22.8 fps、4K 画布 15.3 fps（Safari）。
   auto 此前写死 2×，把 1080p 源渲染到 3840×2160，而窗口化时屏幕只能显示 2260×1372。
3. **"1 fps / 3-26 波动"主要是读数与重建造成的**：面板帧率是**最近 1 秒**；每次重建（切档、改倍率、进出全屏）
   都要新建 canvas 与 GL 上下文并把整条链重新 link（快速档 9 段、A+A 档 55 段）。
4. **降档阶梯此前会停在一个比原画更软的状态**：低于原片分辨率又低于显示盒时，画面由着色器的单点过滤决定，
   比浏览器的多抽头缩放更差——阶梯却会走到 0.75/0.5/0.25 并停在那里。

## 一、实测数据

| 配置（画布尺寸） | Safari 窗口 | Safari 全屏 | Chrome 窗口 |
| --- | --- | --- | --- |
| 裸播（无应用） | — | — | 23.86 fps，0 丢帧 |
| 应用 · 关闭增强 | 22.6 | — | 23.96，0 丢帧 |
| 清晰化（3840×2160） | 22.6 | — | 24 |
| 影视（3840×2160） | 22.3 | — | 24 |
| 快速 anime4k（3840×2160） | 22.4 | 21.5 | 19–21 |
| **质量 anime4k（3840×2160）** | **15.3** | **13.3**（丢帧 580/1663） | **16** |
| 质量 anime4k（1920×1080） | 22.8 | — | — |
| 质量 anime4k（2880×1620） | — | 16.4 | — |

补充：视频元素盒子窗口化 1130×686 CSS（2260×1372 设备像素）、全屏 1710×1074 CSS（3420×2148 设备像素）；
auto 的 2× 在窗口化时渲染了约 2.9 倍于屏幕能显示的像素。硬解与 GPU 均正常（`powerEfficient: true`、
ANGLE Metal / Apple M5、`EXT_color_buffer_float` 可用）。

## 二、三个机制

**1. 面板帧率的采样窗口。** 每秒重算一次、只统计最近 1 秒（`player-stats.ts`）。起播、加入房间、缓冲、
着色器编译都会在其中留下 1 秒级停顿：读数是 1–3 fps，恢复的下一秒是 25–26，"1-26 波动"由此而来。
每次新起播都能测到一次 1.1–1.2 秒的停顿（`readyState 2`），稳定后是 22.6–24。

**2. 重建即重链。** `UpscaleLayer` 在切档位、改倍率、`fullscreenchange` 与窗口尺寸稳定 250 ms 后都会
`start()`；此前每次都是新 canvas（a canvas 只认第一次取得的上下文类型）→ 新 GL 上下文 → 把该链的每个片段
着色器重新 `link()`。A+A 档是 55 段，官方记录首次编译约 0.29 s，WebKit 上更久。自动降档阶梯每降一级都会触发
一次这样的重建。

**3. 阶梯的倍率下界与反馈。** 判据是 6 秒窗口内 fps < 18（每窗口至少 24 帧）；顺序是 质量→快速→影视→清晰化→
再降倍率→关闭。它对"降完还比原画好吗"没有判断，于是会停在 0.75/0.5/0.25 这类既低于原片、又低于显示盒的值；
而它自身的每次降档又会制造一次重建停顿，供下一个窗口继续判断。

## 三、本次修正（v1.2.5）

| 位置 | 改动 |
| --- | --- |
| `client/src/util/upscale/scale.ts` | auto 跟随显示盒；仅当显示盒 < 1.2× 时抬到 1.25×（`CNN_MIN_UPSCALE`）。新增 `fitScale()` 与 `ladderFloorScale()` |
| `client/src/components/players/UpscaleLayer.vue` | 阶梯倍率下界 = `min(1, 显示盒倍率)`，到此改为关闭；重建后第一个监测窗口不判（`monitorSkipWindow`）；画布按上下文类型（WebGL2 / WebGPU）保留复用 |
| `client/src/util/upscale/cas.ts` | `link()` 按上下文缓存已链接程序（`WeakMap`，上下文丢失即清空）；清晰化驱动不再销毁上下文，改为删除本实例的 VAO/缓冲/纹理 |
| `client/src/util/upscale/{film,anime4k-webgl}.ts` | 同上：停用 `WEBGL_lose_context`，改为释放本实例对象 |
| `client/src/components/composables/player-stats.ts` | 帧率改为最近 4 个 1 秒采样的平均；暂停时清空（显示 "—"） |
| 测试 | 新增 `upscale-program-cache.spec.ts`；`upscale-scale.spec.ts` 覆盖新倍率策略与阶梯下界；`upscale-layer.component.spec.ts` 覆盖画布复用、跳过重建窗口、阶梯止步于显示盒 |

窗口化下渲染像素约为原先的 40%（1080p 源、1130×686 的盒子：3840×2160 → 2400×1350），实测同一档位
15.3 → 22.8 fps；显式选择 1.5×/2×/3× 的路径不变。

## 四、复测方法

在页面里挂一个 10 秒的呈现帧率计（`requestVideoFrameCallback`），并同时记录 `document.querySelectorAll('canvas')`
的尺寸与 `video.getVideoPlaybackQuality()`：

```js
const v = document.querySelector("video");
let frames = 0;
const t0 = performance.now();
const tick = now => {
	frames++;
	if (now - t0 < 10000) v.requestVideoFrameCallback(tick);
	else console.log("fps", frames / ((now - t0) / 1000));
};
v.requestVideoFrameCallback(tick);
```

Safari 可用 AppleScript 注入（`do JavaScript`，需要在 Safari 设置里允许「来自 Apple 事件的 JavaScript」）；
Chrome 用 DevTools 或 `agent-browser eval` 即可。比较时必须同时记录画布尺寸，否则不同倍率的数字不可比。
