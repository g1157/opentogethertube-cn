# 文档索引

这里放维护中的参考文档：当前实现、操作说明、部署与决策记录。带日期的审查、诊断和修复记录属于
版本快照，已移到 [归档目录](archive/README.md)，不再代表当前代码。

## 使用与机制

- [架构总览](architecture.zh-CN.md) — 进程、数据流、同步引擎、服务端与客户端结构
- [AI 工作手册](ai-handbook.zh-CN.md) — 改哪里、怎么跑、有哪些坑
- [播放器与房间使用说明](player-interactions.zh-CN.md) — 续播、换片、同步与常见困惑
- [播放同步与测量记录](playback-sync.zh-CN.md) — 时钟、纠偏、换片就绪与实测数据
- [缓冲时一起暂停](buffer-gate.zh-CN.md) — 单人/多人缓冲门控与超时
- [播放详情面板](player-stats.zh-CN.md) — 视频数据与统计项
- [画质增强、渲染倍率与运行边界](video-enhancement.zh-CN.md) — 档位、管线与设备边界
- [真人影视滤镜选型](upscale-for-live-action.zh-CN.md)
- [WebGL2 极致档与 mpv A+A 的逐块对齐](upscale-webgl2-mpv-parity.zh-CN.md)
- [MP4 直链解析与排查](media-parsing.zh-CN.md)
- [房间语音](voice.zh-CN.md) — P2P mesh、TURN 与成本刹车
- [房间便签](room-notes.zh-CN.md) — 追加式共享便签
- [房间密码](room-password.zh-CN.md)
- [自定义媒体格式](custom-media-format.md)
- [同步机制简述（上游）](synchronization.md)

## 部署、配置与运维

- [两种部署方式对照](deployment-options.zh-CN.md) — Docker/Node 与 Cloudflare 预览版
- [Cloudflare 免费额度与容量](cloudflare-quotas.zh-CN.md)
- [Cloudflare Realtime TURN 评估](cloudflare-turn-2026-11-05.zh-CN.md)
- [安全响应头与 CSP](security-headers.zh-CN.md)
- [配置说明](config.md) · [数据库](db.md) · [自托管部署](how-to-deploy.md) · [API](api.yaml)
- 根目录：[DEPLOYMENT.md](../DEPLOYMENT.md) · [DEPLOYMENT-CLOUDFLARE.md](../DEPLOYMENT-CLOUDFLARE.md)

## 研究、对照与版本

- [平台 QoE 策略调研](platform-qoe-research.zh-CN.md)
- [开源 Web 播放器策略清单](player-strategy-research.zh-CN.md)
- [同步观看产品与媒体管线对比](watch-party-comparison-2026-11-17.zh-CN.md)
- [房间语音稳定化路线](voice-stability-2026-11-05.zh-CN.md)
- [版本记录](version-notes.zh-CN.md)
- [画质增强调查：为何弱于 mpv + Anime4K](archive/upscale-vs-mpv-anime4k.zh-CN.md)（归档）

## 历史

- [审查与诊断归档](archive/README.md) — 2026-09 至 2026-11 的版本快照、证据与修复记录
