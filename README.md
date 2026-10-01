# OpenTogetherTube 中文版

和朋友同步看视频：一个房间、多个链接，播放、暂停、跳转、倍速对**全房间**生效。默认简体中文、
免注册开房；低延迟、聊天、语音、视频超分（Anime4K）；可 Docker / Node.js 自托管，也有
**不需要服务器**的 Cloudflare 预览版。

[English](README.en.md) · [部署](DEPLOYMENT.md) · [Cloudflare 预览版](DEPLOYMENT-CLOUDFLARE.md) · [版本记录](docs/version-notes.zh-CN.md)

## 这个版本特别在哪

### 同步不是「差不多」：换片、卡顿、掉线的边界都处理过

- **换片先等首帧。** 自动下一集、跳过、立即播放都会先停在新视频的片头，等首位观众的画面
  准备好才启动房间时钟——不会一开播就跳掉开头十几秒；外嵌播放器与直播源仍立即开始。
- **空房恢复与暂停意图。** 最后一人离开后暂停，回来时先加载保存的位置、本机就绪后再开始计时；
  从数据库恢复的房间保持暂停，进入房间不会自动开播。
- **缓冲联动（可选）。** 有人明确上报正在缓冲时全房间一起等：15 秒上限、30 秒冷却、后台标签页
  不算等待方；「缓冲时一起暂停」由房间设置控制。
- **漂移用速率收敛，而不是反复跳。** ±8% 的速率在 8–30 秒内拉回，超期才硬跳；seek 有冷却，
  键盘与手势共用同一个跳转间隔，长按 → 临时全房间 2 倍速。
- **出问题时看得见。** 播放详情面板给出分辨率、缓冲前瞻、丢帧、实测帧率、与房间偏差、画质增强
  状态与 WebGPU 设备，数据每秒刷新且不打断播放。

### 浏览器内的画质增强：四档，分别面向不同内容

| 档位 | 面向 | 做法 |
| --- | --- | --- |
| 清晰化 | 通用、最省电 | FSR1 的 EASU 多抽头放大 + CAS 对比自适应锐化（WebGL2） |
| **影视（去噪去带）** | **真人剧集与电影** | 保边去噪去块、按邻域跨度压平色带并加抖动 → EASU 放大 → 0.6 倍强度锐化 |
| AI 超分 / AI 超分（质量） | 动画片 | Anime4K Mode A / A+A（WebGPU），质量档约为快速档两倍开销 |
| **AI 超分（极致）** | 动画片；没有 WebGPU 的设备 | 把 mpv 的 A+A (HQ) 链原样跑在 WebGL2 上：官方 v4.0.1 GLSL 权重逐字不变，统计在链首、clamp 在链尾，2× 目标下每帧 46 个 pass |

自动档在电脑（指针设备）上按 **2× 源分辨率**渲染再缩到屏幕，AI 超分的放大阶段因此才真正生效；
触屏设备贴合显示尺寸以省电。设备吃不消时按档位逐级降档，仍不行再降渲染倍率。
拿不到 WebGPU 的浏览器（Windows 之外的 Firefox、Safari 26 之前、被驱动黑名单挡住的机器）会改用
WebGL2 跑同一套 Anime4K 网络，极致档只在那些设备上出现，「质量」档在 WebGPU 上就是同一条链。
整条链路都在客户端，**服务器不需要 GPU**。

### 片源吃得广，防盗链有兜底

- 直链 MP4 / HLS / DASH / 自定义媒体清单；添加直链后自动探测相邻集数，一键加入「同剧集」。
- **只拦站外 Referer 的源会自动重试**：先用本应用 origin 的 Referer 探测，被拒再试不带 Referer，
  实测可用才记下策略；必须站内来源或需要 Cookie 的源会在添加时就明确提示，不再「添加成功、播放报错」。
- 上游平台适配器（YouTube、Bilibili、Vimeo、PeerTube、Odysee 等，取决于部署配置）。

### 一起聊、一起记、一起说

- **聊天**：实时消息、表情面板、手机端发送按钮与输入法兼容（中文输入法选词不会误发送）。
- **房间便签**：追加式共享笔记，房间内谁都能加、能删，不能改。
- **房间语音**：P2P 直连，服务器只转发信令、不承载媒体；未配置 TURN 时明确提示「仅直连」。

### 中文优先，手机端做过细节

- 界面默认简体中文（可切换），免注册即可开房；权限分房主 / 管理员 / 协管 / 受信任 / 注册 / 未注册，
  逐项可配置，支持投票跳过。
- 手机竖屏控件精简（音量与倍速收进设置菜单），单击显隐控件、双击暂停，横屏或全屏展开完整控件；
  滑动跳转步长可选；聊天在触屏设备上发送后保持展开，不会收起键盘。

### 自托管省心

- GitHub Actions 在打标签时构建并推送镜像到 GHCR，**服务器只拉取、不编译**；
  `deploy/init.sh` 生成 `compose.yml` 与 `.env`，升级只需改一行 `OTT_IMAGE`。
- 另有 **Cloudflare 预览版**：不需要服务器，适合以视频直链观看为主的小规模共同观看；
  两种方式的取舍、额度与费用见对照文档。

## 快速开始

**Docker / Node.js 自托管（功能完整，推荐）**——任意 Linux 服务器，建议 2 vCPU / 2 GiB 起步：

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh          # 生成 compose.yml 与 .env
# 编辑 .env，把 OTT_PUBLIC_HOSTNAME 设为你的域名或 IP:端口
sudo docker compose up -d           # 自动拉取镜像、迁移数据库、启动应用
```

升级、回退、Cloudflare Tunnel 入口与容量参考见[部署文档](DEPLOYMENT.md)。

**Cloudflare 预览版（不需要服务器）**——按[分步部署](DEPLOYMENT-CLOUDFLARE.md)发布到 Cloudflare，
使用免费的 `workers.dev` 地址。两种方式的完整取舍见[两版对照](docs/deployment-options.zh-CN.md)。

## 文档

| 想了解 | 看这里 |
| --- | --- |
| 架构总览（组件、同步引擎、数据流） | [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) |
| 播放器操作、聊天与「一直缓冲」排查 | [docs/player-interactions.zh-CN.md](docs/player-interactions.zh-CN.md) |
| 同步与速率微调 | [docs/playback-sync.zh-CN.md](docs/playback-sync.zh-CN.md) |
| 缓冲联动（一起等待） | [docs/buffer-gate.zh-CN.md](docs/buffer-gate.zh-CN.md) |
| 画质增强、渲染倍率与影视档 | [docs/video-enhancement.zh-CN.md](docs/video-enhancement.zh-CN.md) · [真人影视滤镜选型](docs/upscale-for-live-action.zh-CN.md) · [极致档与 mpv 的逐块对齐](docs/upscale-webgl2-mpv-parity.zh-CN.md) |
| 播放详情（视频数据面板） | [docs/player-stats.zh-CN.md](docs/player-stats.zh-CN.md) |
| 房间语音（P2P、成本刹车） | [docs/voice.zh-CN.md](docs/voice.zh-CN.md) |
| 房间便签（追加式、权限与迁移） | [docs/room-notes.zh-CN.md](docs/room-notes.zh-CN.md) |
| 大 MP4 解析与探测策略 | [docs/media-parsing.zh-CN.md](docs/media-parsing.zh-CN.md) |
| 部署、升级、回退与资源消耗 | [DEPLOYMENT.md](DEPLOYMENT.md) · [docs/deployment-options.zh-CN.md](docs/deployment-options.zh-CN.md) |
| 安全响应头与 CSP | [docs/security-headers.zh-CN.md](docs/security-headers.zh-CN.md) |
| 各版本改了什么 | [docs/version-notes.zh-CN.md](docs/version-notes.zh-CN.md) |
| 开发、测试与贡献 | [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |
| 上游来源与移植范围 | [UPSTREAM.md](UPSTREAM.md) |

## 许可证与致谢

[AGPL-3.0-or-later](LICENSE)。本项目是 [OpenTogetherTube](https://github.com/dyc3/opentogethertube)
（v0.15.0）的简体中文版本，保留原作者与贡献者归属；上游来源与移植范围见
[UPSTREAM.md](UPSTREAM.md)，字体许可见
[字体来源](client/src/assets/fonts/vendor/LICENSES.md)。

这个分支站在很多开源工作上面，特别感谢：

- **[Anime4K](https://github.com/bloc97/Anime4K)（bloc97 等）**——「AI 超分」各档用的就是它的
  Mode A / A+A 着色器链：WebGPU 侧调用现成移植库，WebGL2 侧从官方 v4.0.1 GLSL 生成（卷积权重
  逐字不变），本项目做的是驱动、档位与坐标语义的对齐。
- **[anime4k-webgpu](https://github.com/Anime4KWebBoost/anime4k-webgpu)**——Anime4K 的 WebGPU 移植，
  我们直接调用它导出的预设、修复与放大模型（`ModeA` / `ModeAA` 等）。
- **[AMD FidelityFX Super Resolution 1.0](https://github.com/GPUOpen-Effects/FidelityFX-FSR)**——
  「清晰化」与「影视」档的 EASU（12 抽头边缘自适应放大）与 CAS 锐化移植自 `ffx_fsr1.h`。
- **[hls.js](https://github.com/video-dev/hls.js) 与 [dash.js](https://github.com/Dash-Industry-Forum/dash.js)**——
  HLS / DASH 的播放、缓冲与码率自适应，缓冲策略就是在这两者的配置上做的。
- **[Vue 3](https://github.com/vuejs/core)、[Vuetify](https://github.com/vuetifyjs/vuetify)、
  [MDI](https://github.com/Templarian/MaterialDesign)**——界面、组件与图标。
- **[PostgreSQL](https://www.postgresql.org/)、[Redis](https://redis.io/)、[Caddy](https://caddyserver.com/)、
  [Docker](https://www.docker.com/)**——持久化、房间状态、HTTPS 入口与部署方式；
  以及 [sponsorblock-api](https://github.com/ajayyy/SponsorBlock)、
  [Vimeo](https://github.com/vimeo/player.js) / [PeerTube](https://github.com/Chocobozzz/PeerTube)
  嵌入 SDK 等上下游库。

各依赖的具体许可见各自的仓库与 `node_modules/*/LICENSE`。
