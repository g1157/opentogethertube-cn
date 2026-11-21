# 画质增强、渲染倍率与运行边界

本文描述 `v1.4.20` 的实现，审查基线为 `v1.4.19`；发布提交与上线验证见对应 GitHub Release。实测方法、成本和完善清单见 [全项目审查](project-review-2026-11-17.zh-CN.md)，媒体工具与产品参考见 [机制对比](watch-party-comparison-2026-11-17.zh-CN.md)。历史数据的设备、版本和目标尺寸各不相同，不与本轮数据混算。

## 档位、片源与能力

| 档位 | 实际管线 | 适用边界 |
| --- | --- | --- |
| 关闭 `off` | 原生视频 | 默认不加载增强驱动或重型 GPU 库 |
| 清晰化 `sharpen` | WebGL2：放大时 FSR1 EASU → 自有邻域限幅锐化；目标不大于源时单遍锐化 | 低成本改善边缘；后段不是 AMD CAS 或官方 RCAS |
| 影视 `film` | WebGL2：源分辨率去噪 / 去带 / 抖动 → EASU → 0.6 系数锐化 | 针对压缩伪影；不能承诺所有素材均改善，也不能保证保留每处细纹理 |
| AI 超分 `anime4k` | 探测可用时 WebGPU Mode A；否则 WebGL2 Anime4K S | 放大段随目标尺寸和预设闸门变化 |
| AI 超分（质量） `anime4k-quality` | 探测可用时 WebGPU A+A；否则 WebGL2 A+A (HQ) | 比快速链更重；后端与尺寸影响成本 |
| AI 超分（极致） `anime4k-ultra` | WebGL2 A+A (HQ)，显式选择该后端 | 55 段生成 shader 定义，实际执行数由尺寸闸门决定；不是固定 55 次绘制 |

各档都保留在菜单中。真正能增强的是**可以读取视频纹理的原生片源**：Direct / HLS / DASH。iframe 播放器没有这种访问能力；Direct 无 CORS 回退后也不能读取像素。

`MediaPlayer.isVideoEnhancementSupported?()` 描述片源能力，与 GPU 后端探测分开。Direct 读取响应式的 `crossoriginEnabled`；即使回退保留原来的 video 元素，菜单也能更新。不支持时显示“当前片源不支持”，解释偏好已保留；除“关闭”外的增强档位、倍率、强度和自动降档控件禁用。切回支持的片源后继续使用同一份偏好，没有分叉为每个播放器设置。

GPU 能力通过真实探针判断，不能只看 `navigator.gpu` 存在。WebGPU 探针验证适配器、相关纹理读写与视频上传；不支持时选择 WebGL2，重型 `anime4k-webgpu` 在探针成功后才动态导入。WebGL2 也可能受驱动限制；启动或运行失败会报告原因并走降级路径，不保证每台设备都能运行每个档位。

## 渲染尺寸的唯一规则

`scale.ts:computeCanvasSize` 是渲染与预览共用的尺寸来源；图像保持源宽高比，`contain` 留边、`cover` 裁切。

| 设置 | 规则 |
| --- | --- |
| 自动，清晰化 / 影视 | 按显示框 × 有界 DPR 计算；正常源至少 1×，最大 3×，再受 3840×2160 像素预算约束 |
| 自动，CNN 档，精细指针设备 | 同样按显示框计算，增加 1.25× 下界以越过预设的放大闸门；不是强制 2× |
| 自动，触屏设备 | 不加 CNN 1.25× 下界，维持显示框、1× 与像素预算规则 |
| 显式倍率 | 按 0.25×–3× 的选择渲染，不受自动像素预算约束；高倍率会产生很高成本 |

显示比例在 `contain` 下取宽高比的较小者，在 `cover` 下取较大者。DPR 上限是 3。自动预算最后生效，因此源本身超过 4K 像素预算时，自动画布可以低于源分辨率；“自动至少 1×”不是无条件保证。

尺寸、详情面板、队列预览都携带 `videoFillMode`，避免 cover 下预览仍按 contain 低估目标。全屏目标是 `.video-subcontainer`；增强画布和视频内叠层必须留在该元素中。

清晰化改变窗口后可以就地调尺寸并显式重绘。捕获目标尺寸的 WebGPU 管线需要重建；窗口 / 全屏变化先等待 250 ms 稳定，避免拖动窗口反复创建设备。**WebGL2 的三个档位（清晰化 / 影视 / S / HQ）一律就地调尺寸**：它们每帧按画布尺寸重新规划链路，重建只会无谓地重新 link 整条链（HQ 为 55 段）并重启帧循环。片源自带 `resize`（HLS / DASH 切档）同理：WebGL2 只调画布并重绘，只有捕获尺寸的 WebGPU 预设需要重建。档位、片源、退出时仍停止旧运行实例。

## 管线与画质口径

清晰化放大段移植 AMD FSR1 的 EASU（许可保留在代码中），后段是仓库自己的五邻域限幅锐化。影视档先在源分辨率清理，再放大与锐化，参数为 `FILM_DENOISE=0.5`、`FILM_DEBAND=0.6`、`FILM_SHARPEN_FACTOR=0.6`。可渲染的半浮点目标优先，缺少扩展或附件被拒时退回 8-bit。

WebGL S / HQ 的权重由官方 Anime4K v4.0.1 GLSL 脚本生成；不要手改 `anime4k-glsl.ts` 或 `anime4k-ultra-glsl.ts`。预设中的放大与 AutoDownscalePre 各有目标尺寸闸门。以本轮 1280×720 → 1920×1080 为例，S 实际 10 pass，HQ 实际 47 pass，均包含最终呈现。

以下判断不能单独用来宣称画质更好：pass 更多、CNN 名字更大、梯度 / 边缘能量增加、没有管线丢帧。锐化也可能放大振铃、噪声和字幕描边。应在同一片源、同一帧、同一目标尺寸、同一后端下做参考图和主观对比；HDR、广色域和 10-bit 素材尚未完成本轮公平验证。

## 共用帧调度与失败生命周期

`video-render-loop.ts` 为所有增强驱动提供一个生命周期：

- 正常绘制由 `requestVideoFrameCallback` 驱动，用 `mediaTime` 去重；同一媒体帧重复呈现不重复跑 CNN。
- 启动时已有解码帧则立即绘制；`pause`、`seeked`、设置 / 尺寸变化通过 `redraw()` 重绘暂停画面。
- 隐藏页跳过 GPU 绘制，回到前台重绘；浏览器仍可能给视频回调，这不等于后台持续增强。
- 显式重绘失败立即停下；正常帧绘制连续失败三次停止。`webglcontextlost` 和 WebGPU device lost 停止并报告，层级选择负责降级。**未捕获的 WebGPU 错误只记录原因**：一次校验报错不等于设备已停止绘制，停掉整个档位会把还能出画的管线换成更弱的档位；真正放弃由 `device.lost` 与连续绘制失败两条路径判定。
- 停止时取消属于原 video 元素的帧回调、监听器与资源，不把旧回调取消到新元素上。
- WebGPU 等待解码首帧最多 4 s，支持 AbortSignal；切档、换源、退出使旧 generation 失效，迟到实例不能覆盖新 renderer。

WebGPU 与 WebGL2 使用不同 canvas，不能在同一 canvas 上换 context 类型。同一层内可复用对应 canvas 和 GL program，减少反复编译；发生 context lost 时后续降级使用新 canvas。

失败降级：质量 / 极致 → 快速；快速启动失败 → 清晰化；影视启动失败 → 清晰化；清晰化失败 → 关闭。运行错误写入“增强错误”，提示说明档位改变。设置改变使用 `UPDATE_TRANSIENT`，不覆写用户持久化偏好。

## 资源复用和闲置回收

链接成功后 detach / delete shader，只保留按 GL context 缓存的 program。目标纹理按活跃期复用；WebGL CNN 暂停 / 闲置 15 s 后释放中间纹理池与 framebuffer，保留上传纹理和 program，重绘时重新创建目标。

本轮 HQ 探针中，纹理申请存储从约 **390.23 MiB → 3.52 MiB**，framebuffer 从 **28 → 0**；S 从 **59.77 → 3.52 MiB**，framebuffer 从 **5 → 0**。停止驱动后纹理与 framebuffer 均为 0，program 仍按 context 缓存。此数字按 texture 格式与尺寸推算，不是系统总 VRAM，也不代表整个浏览器内存。

少数 GL buffer / VAO 的早期启动失败路径尚需扩大故障注入；长期切档、4K 素材和系统驱动回收仍需真机持续验证。

## 自动降档的现行判据

6 s 为一个窗口，重建后的首窗口不评分；连续两个可评分窗口不合格才降一级。三个信号是：

1. 按媒体时间中位间隔推算节奏，缺帧比例超过 8%；
2. video 呈现回调低于 18 fps；
3. `getVideoPlaybackQuality` 的媒体管线丢帧比例超过 8%。

暂停、seek、缓冲、后台页和长回调空档重置评分，避免正常控制造成误降档。正常性能降级依次为 质量 / 极致 → 快速 → 影视 → 清晰化 → 倍率 → 关闭；倍率阶梯为 3、2.5、2、1.5、1、0.75、0.5、0.25，最低不越过 `min(1, 实际显示比例)`，越过前关闭增强。

这些信号观察的是**视频呈现与解码管线**，不是 GPU 已完成的增强帧率。正常 Chrome quality 播放中约 24 fps、媒体掉帧 0，不足以证明 canvas 每帧按时完成。下一阶段需要稀疏采样 GPU 完成时间、在途提交和 p95 截止失约，避免逐帧同步等待本身改变负载。

## 本轮实测与验证边界

同一 Apple M5 / ANGLE Metal 机器，Chrome 154 和 Firefox 157；片源为 1280×720、H.264、BT.709、t=1 s 的同一解码帧，输出 1920×1080，预热 3 次、重绘采样 24 次。

| 路径 | 实际 pass（含呈现） | 纹理申请存储 MiB | Chrome 完成等待 p50 | Firefox 完成等待 p50 |
| --- | ---: | ---: | ---: | ---: |
| 清晰化 WebGL | 2 | 19.34 | 2.2 ms | 7 ms |
| 影视 WebGL | 3 | 26.37 | 1.6 ms | 7 ms |
| S WebGL | 10 | 59.77 | 3.7 ms | 11 ms |
| HQ WebGL | 47 | 390.23 | 59.1 ms | 116 ms |
| 快速 WebGPU | 未计数 | 未计数 | 43.5 ms | 本机不可用 |
| 质量 WebGPU | 未计数 | 未计数 | 62.7 ms | 本机不可用 |

WebGL 完成等待使用同步像素读回，WebGPU 使用 queue.onSubmittedWorkDone；两者包含不同同步 / 读回成本，不能作为纯 GPU 时间排名或据此换算播放 fps。Chrome GPU timer 是另一个独立口径，原始结果在审查报告；本机 Firefox WebGPU 被驱动 blocklist 阻止，不推出所有 Firefox 都不能用 WebGPU。

真实本地房间验证覆盖 MP4 / HLS / DASH、无 CORS 回退、增强切换 / 暂停 / 跳转 / 离房、Chrome / Firefox 原生全屏、Chrome 360 / 390 px 视口。Firefox 窄窗实际最低 500 px，未完成 390 px 实测；Windows、Android、iOS / Safari、低端 GPU、蓝牙输出和长时间 HDR 播放不在本轮通过范围内。

历史图像对照见 [WebGL2 与 mpv 对齐](upscale-webgl2-mpv-parity.zh-CN.md)与 [早期增强诊断](upscale-diagnosis-2026-09-29.zh-CN.md)。最终主观画质结论由用户在真实片源、屏幕和设备上验收。
