# OpenTogetherTube 中文版

和朋友同步看视频：一个房间、一条链接，播放、暂停、跳转、倍速对**全房间**生效。
默认简体中文、无需注册即可开房，支持 **Docker / Node.js 自托管**，也提供**无需服务器的
Cloudflare 预览版**。

[English](README.en.md) · [部署](DEPLOYMENT.md) · [Cloudflare 预览版](DEPLOYMENT-CLOUDFLARE.md) · [版本记录](docs/version-notes.zh-CN.md)

## 亮点

- **同步播放**：播放、暂停、跳转、倍速全房间一致，双人同步实测到 0.01 秒级；长按可临时全房间 2 倍速。
- **中文优先**：界面默认简体中文，可切换其他语言；无需注册，创建房间即可开始。
- **房间**：临时房用完即走；永久房保存当前视频、播放位置与待播队列，下次回来接着看。
- **一起聊**：实时聊天、**房间便签**（追加式共享笔记，谁都能加、能删，不能改）。
- **房间语音**：P2P 直连，服务器只转发信令、不承载媒体；未配置 TURN 时为「仅直连」。
- **精细权限**：房主 / 管理员 / 协管 / 受信任 / 注册 / 未注册，逐项权限可配置；支持投票跳过。
-   **片源**：公开直链（MP4 / HLS / DASH / 自定义媒体清单）以及上游平台适配器（YouTube、Vimeo、PeerTube 等，视部署配置）；添加直链后会自动探测相邻集数，给出「同剧集」一键加入队列。
- **看得舒服**：画质增强（清晰化 / Anime4K）、字幕、可选「缓冲时一起暂停」、手机横竖屏控件。

## 快速开始

**Docker / Node.js 自托管（功能完整，推荐）**——在任意 Linux 服务器上（建议 2 vCPU / 2 GiB 起步）：

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh          # 生成 compose.yml 与 .env
# 编辑 .env，把 OTT_PUBLIC_HOSTNAME 设为你的域名或 IP:端口
sudo docker compose up -d           # 自动拉取镜像、迁移数据库、启动应用
```

镜像由 GitHub Actions 发布到 GHCR，服务器只拉取、不编译。升级、回退、Cloudflare Tunnel 入口与
容量参考见 [部署文档](DEPLOYMENT.md)。

**Cloudflare 预览版（不需要服务器）**——按 [分步部署](DEPLOYMENT-CLOUDFLARE.md) 发布到
Cloudflare，使用免费的 `workers.dev` 地址；适合以视频直链观看为主的小规模共同观看。

两种方式的完整取舍见 [两版对照](docs/deployment-options.zh-CN.md)。

## 文档

| 想了解 | 看这里 |
| --- | --- |
| 部署、升级、回退 | [DEPLOYMENT.md](DEPLOYMENT.md) · [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md) · [两版对照与资源消耗](docs/deployment-options.zh-CN.md) |
| 房间语音（P2P、成本刹车） | [docs/voice.zh-CN.md](docs/voice.zh-CN.md) |
| 房间便签（追加式、权限与迁移） | [docs/room-notes.zh-CN.md](docs/room-notes.zh-CN.md) |
| 播放器操作与「一直缓冲」排查 | [docs/player-interactions.zh-CN.md](docs/player-interactions.zh-CN.md) |
| 同步与速率微调 | [docs/playback-sync.zh-CN.md](docs/playback-sync.zh-CN.md) |
| 缓冲联动（一起等待） | [docs/buffer-gate.zh-CN.md](docs/buffer-gate.zh-CN.md) |
| 画质增强与渲染倍率 | [docs/video-enhancement.zh-CN.md](docs/video-enhancement.zh-CN.md) |
| 播放详情（视频数据面板） | [docs/player-stats.zh-CN.md](docs/player-stats.zh-CN.md) |
| 大 MP4 解析与探测策略 | [docs/media-parsing.zh-CN.md](docs/media-parsing.zh-CN.md) |
| 安全响应头与 CSP | [docs/security-headers.zh-CN.md](docs/security-headers.zh-CN.md) |
| Cloudflare 额度与费用 | [docs/cloudflare-quotas.zh-CN.md](docs/cloudflare-quotas.zh-CN.md) |
| 各版本改了什么 | [docs/version-notes.zh-CN.md](docs/version-notes.zh-CN.md) |
| 开发与贡献 | [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |
| 上游来源与移植范围 | [UPSTREAM.md](UPSTREAM.md) |
| 用户体验与产品审查（2026-09-13） | [docs/ux-review-2026-09-13.zh-CN.md](docs/ux-review-2026-09-13.zh-CN.md) |

## 许可证与致谢

[AGPL-3.0-or-later](LICENSE)。本项目是 [OpenTogetherTube](https://github.com/dyc3/opentogethertube)
（v0.15.0）的简体中文版本，保留原作者与贡献者归属；上游来源与移植范围见
[UPSTREAM.md](UPSTREAM.md)，字体许可见
[字体来源](client/src/assets/fonts/vendor/LICENSES.md)。
