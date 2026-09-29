# 画质增强诊断：影视档编译失败、暂停时露出原画、Firefox 超分路线（2026-09-29）

四个问题的根因、证据与修复。本文的实测环境：Chromium 153（headless，ANGLE）与
Firefox 142（macOS，headless 与有头各一次，`dom.webgpu.enabled=true`）；影视档与暂停行为
都在两边用**仓库里真实的渲染器代码**跑过（不是复刻实现）。

## 结论速览

1. **影视档跑不起来**与浏览器无关：clean 着色器把 `flat` 当变量名，而 `flat` 是 GLSL ES 3.00
   的插值限定符，编译必然失败——这个档位从落地起在任何浏览器上都没运行过，一直由回退逻辑
   悄悄降成「清晰化」。已修复并加了防回归测试。
2. **暂停/跳转时变回原画、以及偶发闪帧**是同一件事的三种表现：渲染器只在
   `requestVideoFrameCallback` 里绘制，暂停时该回调不再触发；暂停（或跳转、改倍率、尺寸稳定）
   触发的重建会让新画布永远没有内容。空画布在 Firefox 与 Windows Chrome 上会**透出底层
   video**（在 macOS 的 headless Chromium 上表现为纯黑）。已改成启动、暂停、seeked 都显式
   绘制一次，并加 `preserveDrawingBuffer`。
3. **暂停该保留哪一帧**：保留超分后的画面（见下文理由）。修复后暂停与播放看到的是同一张画布。
4. **Firefox 上的 Anime4K**：`navigator.gpu` 存在不等于能用——非 Windows 的稳定版
   Firefox 里 `requestAdapter()` 直接抛错。可落地的路线是 WebGL2（官方 GLSL 的移植），
   社区已有 Anime4K.js 这样的先例。
5. **与 mpv A+A 的差距**：现有两档其实用的是 `CNNVL/CNNx2VL/CNNM`（比 M 档更重），模型不再是
   短板；剩下的是最终缩放、像素预算、自动降档与 Firefox 支持。

## 一、影视档为什么跑不起来

**根因。** `client/src/util/upscale/film.ts` 的 clean 着色器第 35 行：

```glsl
float flat = 1.0 - smoothstep(0.02, 0.10, luma(mx) - luma(mn));
```

`flat` 是 GLSL ES 3.00 的插值限定符，不能作为标识符使用。真实报错（用仓库代码跑出来的原文）：

```
Shader compile failed: ERROR: 0:35: 'flat' : syntax error
```

**为什么表现为「已切换为清晰化」。** `startFilmRenderer()` 在同步启动阶段抛错，
`UpscaleLayer.vue` 的 catch 走 `failureFallback()`（`upscaleMode: "sharpen"`，
文案 `room.upscale.film-fallback`，即 `zh-CN.ts:228` 的那句）。同一段代码在 Chromium 与
Firefox 上行为一致：这不是浏览器特有缺陷，而是这个档位从未成功启动过。此前文档把它写成
已落地，但当时的验证只有 `planFilmPasses` 这类纯逻辑单测，没有让着色器上过 GPU。

**修复（已落地）。**

- `flat` 改名为 `flatness`，并导出 `CLEAN_FRAGMENT_SHADER` 供测试使用。
- 新增 `client/tests/unit/upscale-shaders.spec.ts`：把四段 GLSL 源码（顶点、锐化、EASU、
  clean）逐词扫一遍保留字表（`flat`、`common`、`partition`、`sample`、`filter`、`input`…），
  注释可以提这些词，代码里出现即失败。这类错误不必上 GPU 就能拦住。
- 验证：Chromium 153 与 Firefox 142（有头）都得到 `film start: OK`，并且真实出画
  （渲染器上报 `film · 1920×1080`）。

## 二、暂停时为什么变回原画

**机制。** 三个驱动（`cas.ts`、`film.ts`、`anime4k.ts`）都只在
`video.requestVideoFrameCallback` 的回调里绘制，而这个回调只在**有新帧呈现**时触发；
视频暂停后它就不再触发，画布内容全靠上一次绘制留在那里。这时任何「新建画布」的动作都会
留下空白，而空白画布在 Firefox 上会**透出底层的 `<video>`**——也就是「变回原画质」。

触发路径都在 `UpscaleLayer.vue`：切档（`watch(mode)`）、改渲染倍率（`watch(upscaleScale)`）、
进入/退出全屏或窗口尺寸稳定 250ms 后（`handleViewportChange`）都会 `start()`，而 `start()`
总是换一张新画布；如果此刻视频处于暂停状态，新画布就永远等不到第一次绘制。旧代码里的
`if (!video.paused)` 还会额外丢掉暂停瞬间的那一帧。

**浏览器差异（实测，同一实验页、同一段代码）。**

| 观察 | Firefox 142 | Chromium 153 |
| --- | --- | --- |
| 暂停后画布是否保帧 | 是（三张截图 MD5 相同） | 是 |
| 从未绘制过的画布 | **透明，看见底层 video** | **纯黑，看不见 video** |
| 反转 `<video>` 的 CSS filter | 画面跟着变（说明看的是 video） | 画面不变（看的是黑画布） |

对照实验用的是绕过渲染器直接插入的空画布，所以它同时说明两件事：浏览器的这个行为没有变，
变的是我们不再留下空画布。

**修复（已落地）。**

- 三段渲染循环都拆出 `drawFrame()`，并在 `start()` 之后、`pause`、`seeked` 各显式绘制一次；
  上传条件从「未暂停」改为「有当前帧」（`readyState >= HAVE_CURRENT_DATA`）。
- WebGL2 上下文加 `preserveDrawingBuffer: true`，让画布内容在一次合成之后仍然保留。
- 验证：暂停状态下重建增强层，再反转 `<video>` 的 CSS：截图在 Chromium 与 Firefox
  **逐字节相同**（MD5 一致）——屏幕上是画布，不是原始 video。

**跳转与闪帧（补充实测）。** 用页内 `MediaRecorder` 录一段可 seek 的片源后：

| 场景 | Firefox 142 | Chromium 141（headless） |
| --- | --- | --- |
| 暂停后 seek，画布内容（8×8 采样均值） | 62.57 → 62.58 | 62.76 → 62.67 |
| 暂停后 seek，反转 video 的截图 | 与基准 MD5 相同 | — |
| 播放中重建层，之后 16 次采样 | 全部有内容（61.3–62.5） | 全部有内容（61.0–62.7） |
| 对照：一张从未绘制的画布 | 0（透出 video） | 0（黑） |

也就是说：修复前"重建 → 空白 → 下一帧才有内容"的窗口就是用户看到的"闪一两帧"，而暂停与
跳转时这个窗口不会自己关闭。修复后 16/16 次采样都有内容，窗口已经不存在。

**Windows 上的报告与机制一致。** 维护者在 Windows Chrome 上看到"跳转和暂停时恢复原画质、
偶尔闪一两帧"：前者是空画布窗口没有关闭，后者是该窗口在播放中被下一帧补上（1–2 帧）。
空画布在 Windows Chrome 上显然也是透出 video 而不是黑屏——这与 Firefox 的实测一致，
说明"空白即透明"是更普遍的行为，macOS headless Chromium 的黑色只是那一种环境的合成方式。

**保留哪一帧的建议：保留超分后的画面。** 理由：播放与暂停应当看到同一张图（否则暂停这个
动作本身就会让画面"跳"一下，正是这次报的现象）；暂停恰好是细看画质的时刻；截图也应当
和播放时一致。想看原画做对比，应该是显式的开关（例如「按住对比原画」），而不是一个隐式行为。

## 三、Firefox 上怎么实现 Anime4K

**先修一个判据错误。** `VideoSettings.vue` 用 `"gpu" in navigator` 决定是否展示 AI 两档，
但 Firefox 里这个接口存在并不代表能拿到设备。实测（Firefox 142，macOS）：

```
navigator.gpu: present
requestAdapter threw: WebGPU is only available on Windows, and in Nightly and Early Beta builds on other platforms.
```

于是出现「档位看得见、永远不生效」的最差组合。平台矩阵（gpuweb 实现状态页，2026-08）：

| 平台 | Firefox 的 WebGPU |
| --- | --- |
| Windows | 141+ 默认开启 |
| macOS（Apple Silicon） | 145+（macOS 26）/ 147+（全部 macOS） |
| macOS（Intel）、Linux | 仅 Nightly |
| Android | 需 flag |

**我们依赖的能力。** Anime4K 的 WebGPU 移植需要：compute pass、`rgba16float` 的**写存储纹理**、
以及把 `<video>` 帧送进纹理（`copyExternalImageToTexture`）。这些在 Firefox 的 wgpu 后端上
是否齐备，随版本变化；探针（本次为测试新写的）逐项报告这三点，便于定位是"没有设备"还是
"设备不给这项能力"。

**别人的方案。** [monyone/Anime4K.js](https://github.com/monyone/Anime4K.js) 是 Anime4K 4.0.1
GLSL 的 **WebGL** 移植，带 `VideoUpscaler.attachVideo(videoElement, canvas)` 与在线 demo——
证明这条路线能跑实时视频，且不需要 WebGPU。原理上也不玄：官方 shader 本身就是片元着色器，
mpv 的 `//!HOOK/SAVE/BIND` 体系改写成 uniform 与固定 pass 即可（本仓库移植 EASU/CAS 时已经
做过同类工作）。代价是权重体积与编译时间：

| 官方文件 | 体积 | 说明 |
| --- | --- | --- |
| `Anime4K_Restore_CNN_S/M/L/VL/UL` | 17 / 36 / 70 / 144 / 309 KB | 修复档，每上一档约翻倍耗时 |
| `Anime4K_Upscale_CNN_x2_S/M/L/VL/UL` | 19 / 38 / 73 / 147 / 290 KB | 放大档 |
| `Anime4K_Upscale_GAN_x3_VL` / `x4_UUL` | 426 KB / 1.09 MB | 终极档，编译与显存风险最高 |
| `Clamp_Highlights` / `AutoDownscalePre_x2` | 2.8 KB / 1.5 KB | 前后处理 |

**路线建议（B 已落地）。**

- **A（可选）**：AI 两档的可用性改成真正的 `requestAdapter()` 探针（结果缓存）。既然
  WebGPU 失败现在已经会自动改用 WebGL2（见下），这一步只剩"要不要提前告诉用户"的意义，
  不再是修复 Windows Firefox 的必要条件。
- **B（已落地，2026-09-29）**：新增 WebGL2 的 Anime4K 链路——WebGPU 拿不到设备或管线创建
  失败时，「AI 超分」两档自动改用它。着色器由 `scripts/anime4k-glsl-to-webgl2.mjs` 从官方
  v4.0.1 GLSL 生成（S 档：`Restore_CNN_S` 4 个 pass + `Upscale_CNN_x2_S` 5 个 pass，权重
  逐字不变，只把 mpv 的 `//!HOOK` 宏改写成 uniform 与固定 pass），生成物在
  `client/src/util/upscale/anime4k-glsl.ts`，驱动在 `anime4k-webgl.ts`。没有新依赖。
  实测：Firefox 142 与 Chromium 141 都出画（画布方向正确），同一显示尺寸下的平均梯度
  53.6 / 53.9 对原画 39.7 / 39.9，**锐约 35%**；暂停 / seek / 暂停中重建都保持增强画面
  （与第二节同一套 `drawFrame` 规则）。
- **C（长期）**：Firefox 各平台 WebGPU 就绪后，WebGPU 档继续作为"快档"保留；两条链路并存，
  按能力探测选择（届时可以做 A）。

## 四、与 mpv + Anime4K（A+A, HQ）的差距（复核）

**先更正一条旧结论。** `upscale-vs-mpv-anime4k.zh-CN.md` 写的「只用官方 Mode A/A+A 的中等
模型」不准确。读 `anime4k-webgpu` 的 preset 源码（`ModeA`/`ModeAA`）：

- Mode A ＝ `ClampHighlights → CNNVL → CNNx2VL（目标 >1.2× 时）→ [AutoDownscale] → CNNx2M（仍 >1.2× 时）`
- Mode A+A ＝ 上述之外再插一次 `CNNM`（在已经放大的分辨率上）

也就是说**第一段用的是 VL 档修复与 VL 档放大**，第二段才是 M 档——这正是官方建议的配法
（放大之后的 pass 成本 ×4，所以用低两档的模型抵消）。在 2× 目标下：快速档 3 pass、质量档
4 pass，与既有实测一致。官方对 A+A 的定义是 `Restore → Upscale → Restore → Upscale`，并建议
只在 ≥2× 时使用。模型档位不是我们的短板。

**剩下的差距（按可操作性排序）。** 其中「极致档」这一项已在同日落地并逐块对齐到 mpv——
结论与实测见 [《WebGL2 极致档与 mpv A+A (HQ) 的逐块对齐》](upscale-webgl2-mpv-parity.zh-CN.md)。

1. **最后一级缩放交给了浏览器。** 我们渲染 2× 画布后由合成器缩到显示框（Chromium/Firefox
   的合成缩放），而 ModeAA 的 `AutoDownscalePre` 只在 `1.2× < 目标 < 2.0×` 时才插入——恰好
   2× 时它不插，最终缩放完全由浏览器负责；mpv 则用自己的高质量缩放器和 Anime4K 的
   AutoDownscalePre 收尾。这是"花了大钱最后一步变软"的位置，收益最大。
2. **4K 源完全不放大。** 像素预算 `3840×2160` 让 4K 源的自动倍率变成 1×，此时 CNN 的放大段
   （>1.2× 才运行）整段空转，只剩修复。1440p 源 1.5×、1080p 源 2×。桌面独显值得给一个
   「预算/上限」开关（2×/3×）。
3. **自动降档默认开启且先降档位。** 6 秒窗口内低于 18fps 就降一级，顺序是
   质量 → 快速 → 影视 → 清晰化 → 倍率。用户很容易在不知不觉中停在低档位，误判"最高档就这效果"。
   要么默认先降倍率，要么在详情面板常驻显示**实际生效**的档位与倍率。
4. **没有更重的档。** 库已导出 `CNNx2UL`、`GANUUL`、`GANx3L`、`GANx4UUL`、`CNNx2VL` 等，
   可以做一个「极致」档（代价是发热与耗电）。
5. **Firefox 上的精度与可用性。** 修复前的 `createRenderTarget` 只探测
   `EXT_color_buffer_half_float`，而 Firefox 只实现 `EXT_color_buffer_float`，导致影视/清晰化
   档的中间目标在 Firefox 上退化成 8-bit（修复后实测 `halfFloat=true`）；AI 档则如上文所述
   完全没有 WebGPU。

## 五、本次改动

| 文件 | 改动 |
| --- | --- |
| `client/src/util/upscale/film.ts` | `flat` → `flatness`；导出 clean 着色器；暂停/启动显式绘制；`preserveDrawingBuffer` |
| `client/src/util/upscale/cas.ts` | 同上（清晰化档）；渲染目标同时接受 `EXT_color_buffer_float` |
| `client/src/util/upscale/anime4k.ts` | 暂停/启动显式绘制 |
| `client/src/util/upscale/anime4k-glsl.ts` | 新增（生成）：官方 Anime4K v4.0.1 S 档的 9 段 WebGL2 片元着色器 |
| `client/src/util/upscale/anime4k-webgl.ts` | 新增：WebGL2 版 Anime4K 驱动（restore → x2 upscale → 呈现） |
| `scripts/anime4k-glsl-to-webgl2.mjs` | 新增：从官方 GLSL 生成上面那个模块的转换脚本 |
| `client/src/components/players/UpscaleLayer.vue` | AI 两档：WebGPU 优先，失败自动改用 WebGL2 |
| `client/src/locales/{zh-CN,en}.ts` | 两档的说明补上 WebGL2 回退 |
| `client/tests/unit/upscale-shaders.spec.ts` | 新增：GLSL 保留字防回归（含生成的 9 段） |
| `client/tests/unit/upscale-anime4k-webgl.spec.ts` | 新增：链路编排（9/4 pass、阈值、接线） |
| `client/tests/unit/upscale-layer.component.spec.ts` | 新增：WebGPU 失败改用 WebGL2、无 WebGPU 时跳过尝试 |

验证：`yarn workspace ott-client` 单测全绿（含新增用例）、`tsc --noEmit` 无输出、
`biome check` 干净。真机实测（Chromium 141/153、Firefox 142，headless 与有头）：

- 影视档 `film start: OK` 并真实出画（`film · 1920×1080`）；
- 暂停中重建后，反转 `<video>` 的截图与基准截图 MD5 完全相同（画布在屏幕上）；
- 暂停后 seek：画布内容 62.57 → 62.58（Firefox）/ 62.76 → 62.67（Chromium），无空白；
- 播放中重建：之后 16 次采样全部有内容；对照的未绘制画布为 0；
- Firefox 的渲染目标从 8-bit 变为 16F（`halfFloat=true`）。

## 六、待决策

1. 第三节的 **A**（WebGPU 可用性探针）要不要立刻做？Windows 的 Firefox 有 WebGPU，
   所以那边 AI 档会正常出现；"完全无反应"更可能是当时选了影视档（修复前必然回退到清晰化）。
2. 第三节的 **B**（WebGL2 Anime4K 档）按哪个档位起步（S/M，还是直接 VL）？
3. 第四节第 1、2 条（最终缩放、4K 预算开关）要不要排进下一版？
4. 这次是三个独立缺陷（着色器保留字、空画布窗口、半浮点探测），改动都只在客户端；
   要不要按既有流程提交、构建镜像、上线并做一次真机走查（Windows Chrome + Windows Firefox）？

## 参考

- [gpuweb 实现状态页](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)（Firefox 的
  WebGPU 平台矩阵，2026-08 复核）
- [Anime4K 的 GLSL 高级用法](https://github.com/bloc97/Anime4K/blob/master/md/GLSL_Instructions_Advanced.md)
  （模式定义、S/M/L/VL/UL 的代价关系、A+A 仅建议 ≥2×）
- [monyone/Anime4K.js](https://github.com/monyone/Anime4K.js)（Anime4K 4.0.1 的 WebGL 移植与
  live demo）
- [Anime4KWebBoost/Anime4K-WebGPU](https://github.com/Anime4KWebBoost/Anime4K-WebGPU)（本项目
  AI 两档所用的库；ModeA/ModeAA 的组成见其源码）
