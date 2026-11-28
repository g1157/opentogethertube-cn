# 🎬 OpenTogetherTube 中文版

**一个房间，一起看。** 播放、暂停、跳转、倍速对**全房间**生效。

简体中文默认 · 免注册开房 · 自托管或无服务器

![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)
![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)
![Node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-5FA04E?logo=nodedotjs&logoColor=white)
![Cloudflare](https://img.shields.io/badge/cloudflare-workers.dev-F38020?logo=cloudflare&logoColor=white)

[English](README.en.md) · [部署文档](DEPLOYMENT.md) · [Cloudflare 预览版](DEPLOYMENT-CLOUDFLARE.md) · [版本记录](docs/version-notes.zh-CN.md)

## ✨ 一眼看全

- 🔄 **同步**：首帧就绪才开钟 · 缓冲联动 · ±8% 速率收敛 · 漂移与丢帧可观测
- 📚 **片源**：直链 MP4/HLS/DASH/自定义清单 · **Emby 媒体库**（直连或服务端 HLS 转码）· 相邻集自动探测
- 🎞️ **画质**：四档增强 —— 清晰化 / 影视 / AI 超分 / AI 超分极致，**服务器不需要 GPU**
- 💬 **一起用**：聊天 · 追加式房间便签 · P2P 语音（可选 Cloudflare TURN 中继）
- 📱 **中文与手机**：中文输入法不误发送 · 竖屏精简控件 · 手势与长按 2×
- 🚀 **部署**：镜像在 GHCR 预构建 · `deploy/init.sh` 一条命令 · 升级只改一行

## 🚀 快速开始

### 🐳 方式一：Docker（推荐，功能完整）

任意 Linux 服务器，建议 **2 vCPU / 2 GiB** 起步：

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh          # 生成 compose.yml 与 .env
# 编辑 .env，把 OTT_PUBLIC_HOSTNAME 设为你的域名或 IP:端口
sudo docker compose up -d           # 拉取镜像、迁移数据库、启动应用
```

> 💡 镜像来自 `ghcr.io/g1157/opentogethertube-cn`，服务器只拉取、不编译。升级 = 改 `OTT_IMAGE`
> 里的版本号再 `docker compose pull && up -d`。

### ☁️ 方式二：Cloudflare 预览版（不需要服务器）

按[分步部署](DEPLOYMENT-CLOUDFLARE.md)发布到 Cloudflare，用免费的 `workers.dev` 地址。
适合以视频直链为主的小规模看片。两种方式的取舍、额度与费用见[两版对照](docs/deployment-options.zh-CN.md)。

> ⚠️ 本地 Emby 只在「页面能直接访问该地址」时可用；把 `192.168.x.x` 分享给外网朋友会一直缓冲。

---

## 🔄 同步：不是「差不多」

- **换片先等首帧。** 自动下一集、跳过、立即播放都先停在新片片头，首位观众有画面才启动房间时钟；外嵌播放器与直播源仍立即开始。
- **空房暂停，回来续上。** 最后一人离开即暂停；重新进入先加载保存位置，本机就绪后再计时；从数据库恢复的房间保持暂停，进房不会自动开播。
- **缓冲联动（房间设置）。** 有人明确上报缓冲时全房间一起等：15 秒上限、30 秒冷却、后台标签页不计入等待方。
- **漂移用速率拉回。** ±8% 在 8–30 秒内收敛，超期才硬跳；seek 有冷却，键盘与手势共用同一间隔；长按 = 全房间临时 2 倍速。
- **出问题看得见。** 播放详情面板：分辨率、缓冲前瞻、丢帧、实测帧率、与房间偏差、增强状态、WebGPU 设备，每秒刷新且不打断播放。

## 🎞️ 画质增强：四档，各管一类内容

| 档位 | 面向 | 做法 |
| --- | --- | --- |
| 清晰化 | 通用、最省电 | FSR1 的 EASU 多抽头放大 + CAS 对比自适应锐化（WebGL2） |
| **影视（去噪去带）** | **真人剧集与电影** | 保边去噪去块 → 压平色带并抖动 → EASU 放大 → 0.6 倍强度锐化 |
| AI 超分 / AI 超分（质量） | 动画片 | Anime4K Mode A / A+A（WebGPU），质量档约为快速档两倍开销 |
| **AI 超分（极致）** | 动画片；无 WebGPU 设备 | mpv 的 A+A (HQ) 链跑在 WebGL2 上：官方 v4.0.1 GLSL 权重逐字不变，2× 目标下每帧 46 个 pass |

指针设备按 **2× 源分辨率**渲染再缩到屏幕，AI 超分的放大阶段才真正生效；触屏贴合显示尺寸省电。
设备吃力时逐档降级，再降渲染倍率。

> 🖥️ 没有可用 WebGPU（Windows 之外的 Firefox、Safari 26 之前、驱动黑名单）时，同一套网络跑在
> WebGL2 上：「极致」只在那些设备出现，「质量」在 WebGPU 上就是同一条链。整条链在客户端，
> **服务器不需要 GPU**。

## 📚 片源：直链、Emby、防盗链

- **直链** MP4 / HLS / DASH / 自定义媒体清单；添加后探测相邻集数，一键加入「同剧集」。
- **防盗链兜底**：先试本应用 origin 的 Referer，再试不带 Referer，实测可用才记录策略；必须站内来源或要 Cookie 的源，在添加时就明确提示。
- **字幕**：WebVTT 与 ASS/SSA（浏览器内 libass 渲染），跨域字幕文件需带 `Access-Control-Allow-Origin`。

### 🎬 Emby：浏览器直连，服务端不碰视频

填地址、端口、账号即可浏览和搜索：

- 🔍 搜索直接搜到**剧集本身**，进入后按季/集排列，不再是一屏分不清的单集。
- 🏷️ 每张片卡标注**直接播放 / 需要转码 / 待检测 / 不支持**，附分辨率与编码；选中后再向 Emby 确认。
- 🔁 **MKV 不是死路**：Emby 给出转码地址时走它的 HLS 转码流（TS / H264 / AAC），转码负载在 Emby 上。
- 🔒 服务端不代理视频、不保存密码；只有播放地址和展示元数据进队列，**令牌随之可见**。

## 💬 一起用

- **聊天**：实时消息、表情面板、手机发送按钮；中文输入法选词不会误触发发送。
- **房间便签**：追加式共享笔记，谁都能加、能删，不能改。
- **房间语音**：P2P 直连，服务器只转发信令；界面显示每路实际是直连、中继、连接中还是失败；配置 Cloudflare TURN Key 后自动签发短期中继凭据。
- **中文与手机**：默认简体中文（可切换）；权限按房主 / 管理员 / 协管 / 受信任 / 注册 / 未注册逐项配置，支持投票跳过；竖屏把音量与倍速收进设置，单击显隐、双击暂停，横屏或全屏展开完整控件。

---

## 📖 文档

<details>
<summary>架构、排障、选型与部署细节（点开）</summary>

| 想了解 | 看这里 |
| --- | --- |
| 架构、同步引擎、数据流 | [architecture](docs/architecture.zh-CN.md) · [同步机制](docs/playback-sync.zh-CN.md) · [缓冲联动](docs/buffer-gate.zh-CN.md) |
| 播放器操作与「一直缓冲」排查 | [player-interactions](docs/player-interactions.zh-CN.md) · [播放详情](docs/player-stats.zh-CN.md) |
| 画质增强与选型 | [video-enhancement](docs/video-enhancement.zh-CN.md) · [真人影视滤镜](docs/upscale-for-live-action.zh-CN.md) · [极致档与 mpv 对齐](docs/upscale-webgl2-mpv-parity.zh-CN.md) |
| Emby 入口 | [emby](docs/emby.zh-CN.md) |
| 语音、便签、密码 | [voice](docs/voice.zh-CN.md) · [room-notes](docs/room-notes.zh-CN.md) · [room-password](docs/room-password.zh-CN.md) |
| 片源解析 | [media-parsing](docs/media-parsing.zh-CN.md) · [custom-media-format](docs/custom-media-format.md) |
| 部署与安全 | [DEPLOYMENT](DEPLOYMENT.md) · [两版对照](docs/deployment-options.zh-CN.md) · [安全响应头](docs/security-headers.zh-CN.md) |
| 开发与贡献 | [CONTRIBUTING](CONTRIBUTING.md) · [AI 工作手册](docs/ai-handbook.zh-CN.md) |
| 版本与索引 | [版本记录](docs/version-notes.zh-CN.md) · [docs/README](docs/README.md) · [归档](docs/archive/README.md) · [上游来源](UPSTREAM.md) |

</details>

## 📄 许可证与致谢

[AGPL-3.0-or-later](LICENSE)。本项目是 [OpenTogetherTube](https://github.com/dyc3/opentogethertube)
（v0.15.0）的简体中文版本，保留原作者与贡献者归属；来源与移植范围见 [UPSTREAM.md](UPSTREAM.md)，
字体许可见[字体来源](client/src/assets/fonts/vendor/LICENSES.md)。

- **[Anime4K](https://github.com/bloc97/Anime4K) / [anime4k-webgpu](https://github.com/Anime4KWebBoost/anime4k-webgpu)**
  ——「AI 超分」的 Mode A / A+A 链：WebGPU 侧调用现成移植，WebGL2 侧由官方 v4.0.1 GLSL 生成，
  卷积权重逐字不变；本项目做驱动、档位与坐标语义的对齐。
- **[AMD FidelityFX Super Resolution 1.0](https://github.com/GPUOpen-Effects/FidelityFX-FSR)**
  ——「清晰化」「影视」档的 EASU 与 CAS 移植自 `ffx_fsr1.h`。
- **[hls.js](https://github.com/video-dev/hls.js) / [dash.js](https://github.com/Dash-Industry-Forum/dash.js)**
  ——HLS / DASH 播放、缓冲与码率自适应。
- **[Vue 3](https://github.com/vuejs/core) / [Vuetify](https://github.com/vuetifyjs/vuetify) / [MDI](https://github.com/Templarian/MaterialDesign)**
  ——界面、组件与图标；以及 [PostgreSQL](https://www.postgresql.org/)、[Redis](https://redis.io/)、
  [Caddy](https://caddyserver.com/)、[Docker](https://www.docker.com/)、
  [sponsorblock-api](https://github.com/ajayyy/SponsorBlock)、
  [Vimeo](https://github.com/vimeo/player.js) / [PeerTube](https://github.com/Chocobozzz/PeerTube) SDK。

特别感谢 **[girigiri](https://girigirilove.com/)**：本项目开发与测试的视频源来自该站
（`ani.girigirilove.com` 及 `ana.` / `akua.` / `danmu.` 等子域，弹幕同样来自其公开接口）。
本项目与该站无隶属关系，只做客户端兼容，内容权利归原站与版权方。

各依赖许可见各自仓库与 `node_modules/*/LICENSE`。
