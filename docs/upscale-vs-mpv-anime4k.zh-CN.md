# 画质增强为何弱于 mpv + Anime4K（调查记录）

现象（维护者反馈）：同一台 Windows 机器上，浏览器「AI 超分（质量）」的效果不如 mpv + Anime4K，
GPU 占用也明显更低。本文记录代码走查得到的结论、证据与建议改动；只做调查，未改实现。

## 结论（一句话）

浏览器侧在最高档跑的是 Anime4K **中等档 Mode A+A**，且渲染目标被**钉在显示框尺寸**上，
再叠加 `3840×2160` 像素预算、`MAX_SCALE = 3`、`devicePixelRatio ≤ 2` 三重上限；1080p 源在
常见窗口里会退化到 **≈1×**，此时 Anime4K 的 Upscale 段实际上是空转，只剩 Restore。
mpv 侧是同一套着色器跑在 **2× 源分辨率的超级采样目标**上、并可用更重的 CNN 变体，所以
既更锐、也更吃 GPU。GPU 占用低不是玄学，是渲染的像素数和 pass 数都更少。

## 证据链

| 环节 | 现状 | 位置 |
| --- | --- | --- |
| 最高档预设 | `anime4k-quality` → 库的 `ModeAA`（`Restore → Upscale → Restore → Upscale`，4 pass），`anime4k` → `ModeA`（3 pass） | `client/src/util/upscale/anime4k.ts:95-113` |
| CNN 变体 | 只用官方 Mode A/A+A（“M”中等模型），未接 `CNNx2VL/CNNx2UL/GANx3L/GANx4UUL`、`CNNVL/CNNUL/GANUUL`、`DenoiseCNNx2VL`，也未用 Mode B/BB/C/CA | `anime4k.ts:106`（库的能力表见 `anime4k-webgpu/README.md`） |
| 渲染目标 | `computeCanvasSize()`：auto 档 `scale = min(框宽×dpr÷源宽, 框高×dpr÷源高)`，即**刚好铺满显示框**，不做超采样 | `client/src/util/upscale/scale.ts:49-76` |
| 像素预算 | `MAX_AUTO_PIXELS = 3840×2160`；由 `budgetScale = sqrt(预算/(w·h))` 再夹一次 | `scale.ts:31,62-64` |
| 放大上限 | `MAX_SCALE = 3`、`MIN_AUTO_SCALE = 1`（窗口小于源时夹到 1×，此时 target ≈ native，Upscale 段空转） | `scale.ts:13,21,61` |
| dpr 夹取 | `Math.min(devicePixelRatio, 2)`（渲染、统计、队列预览三处重复） | `UpscaleLayer.vue:73`、`player-stats.ts:134`、`VideoQueueItem.vue:305` |
| 自动降档（默认开） | fps < 18 且窗口 ≥24 帧 / 6s 时按 `quality → anime4k → sharpen → 倍率 rungs → off` 退档；观察到的“最高档”可能已经悄悄降成 `anime4k`（约半数成本） | `settings.ts:116`、`UpscaleLayer.vue:111-184` |
| 中间精度 | WebGL（清晰化档）中间目标为 RGBA8 | `client/src/util/upscale/cas.ts:326` |
| 合成 | 画布按 CSS 拉伸到视频框（`object-fit: contain`），画布小于框时由浏览器再缩一次，进一步变软 | `UpscaleLayer.vue:417-457` |
| 统计可见性 | 详情面板有 `render-target`（画布尺寸 × 倍率）、render-fps、WebGPU 适配器名；**没有** GPU 时间/pass 计数遥测 | `player-stats.ts:201-283`、`status.ts:14-22` |

按源分辨率的预算上限（auto 档）：720p → 3.0×，1080p → 2.0×，1440p → 1.5×，4K → 1.0×（完全不放大）。
再加上 dpr ≤ 2：150% 缩放的 Windows 桌面（dpr 1.5）与 200%（dpr 2）都会被限住。

## 与 mpv + Anime4K 的差异（按影响排序）

1. **没有超采样**：auto 只铺满显示框；mpv 用 Anime4K 的 2× 上采样再交给高质量缩放器下采样。
2. **像素预算 + MAX_SCALE + dpr 三重夹取**：1080p 源最高到 2×，1440p 到 1.5×，4K 到 1×；mpv 无这些限制。
3. **只用中等模型**：Mode A/A+A 是官方「M」档，mpv 配置常用 L/VL/UL/GAN 档（更锐、更贵）。
4. **小窗/嵌入播放器退化成 1×**：`MIN_AUTO_SCALE = 1` 让 Upscale 段空转，只剩 Restore。
5. **默认自动降档会先牺牲画质**：一次掉帧就可能把最高档换成 `anime4k`，用户看不出。
6. **最后一步由浏览器缩放**：画布小于框时再次软化。
7. **CORS 会静默关闭增强**：`DirectPlayer.vue:104-106` 在 `crossorigin` 关闭时强制 `off`（HLS/DASH 无此保护缺口记录在走查文档里）。

## 改动清单与落地情况

| 优先级 | 改动 | 位置 | 影响 |
| --- | --- | --- | --- |
| P1 ✅ | auto 档在指针设备上由「铺满显示框」改为**至少 2× 源**（触屏仍贴合显示框），让库的 Upscale 阶段真正运行 | `scale.ts`（`CNN_UPSCALE_SCALE`、`canAffordCnnUpscale`） | 1080p 源渲染 3840×2160 由屏幕下采样；GPU 占用与锐度同时提升 |
| P1 ◻ | 像素预算与 `MAX_SCALE` 变成可配置或按 GPU 能力探测（当前 4K 源仍不放大） | `scale.ts:13,31` | 让 4K 源也能吃到 CNN；需要先有 GPU 能力探测 |
| P2 ◻ | 质量档接入更重的变体（`CNNx2UL`/`CNNUL`/`GANx3L` 等，库已导出）作为「极致」档 | `anime4k.ts:95-113` | mpv 级别的档位；代价是发热与耗电 |
| P2 ✅ | dpr 夹取上限 2 → 3（`MAX_DPR`，渲染/详情/预览三处一致） | `UpscaleLayer.vue`、`player-stats.ts`、`VideoQueueItem.vue` | 高 DPI Windows 桌面不再被截断 |
| P2 ◻ | 自动降档默认改为「先降倍率、后降预设」，或在降档时给出可见提示（目前有 toast） | `UpscaleLayer.vue:161-184`、`settings.ts:116` | 用户不会误判「最高档就这效果」 |
| P3 ◻ | 清晰化档中间目标改 half-float，减少 8bit 精度损失 | `cas.ts:326` | 清晰化档细节更干净 |
| P3 ◻ | 加 GPU 时间 / pass 计数遥测，把「比 mpv 弱」变成可量化对比 | `player-stats.ts` | 后续调参有依据 |

### 已落地的部分（2026-09）

- 指针设备的自动档目标是 `max(显示框倍率, 2×)`，再受 1×–3× 与 3840×2160 预算约束；
  1080p 源因此正好渲染 3840×2160，1440p 源 1.5×，4K 源保持 1×。
- Anime4K 预设的内部条件（目标 >1.2× 当前尺寸才插入 `CNNx2VL`/`CNNx2M`）终于会被满足，
  最高档不再退化成「只有 Restore」。
- 触屏设备保持贴合显示框，`upscaleAutoDegrade` 仍是兜底；`MAX_DPR` 三处统一为 3。
- 覆盖测试：`client/tests/unit/upscale-scale.spec.ts` 的「CNN upscale target」一组。

## 参考

- 现有效果与限制记录：`docs/video-enhancement.zh-CN.md`（含 A+A 的 pass 数、像素预算、降档阶梯、
  “画布低于源分辨率反而更软”的旧管线教训）。
- 库能力表：`anime4k-webgpu` README（Restore / Upscale / Preset 全量清单）。

## 验证方式（改动后）

1. 详情面板的 `render-target` 应显示 2× 源分辨率（1080p → 3840×2160 的预算内），而非显示框尺寸；
2. 同一片段对比「超采样开/关」的截图与 GPU 占用（任务管理器或 `chrome://gpu` 的 GPU 时间线）；
3. 掉帧率不高于改动前（自动降档若触发，说明预算需要按设备下调）。
