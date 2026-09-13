# 两种部署方式对照：Docker / Node.js 与 Cloudflare 预览版

本仓库有两条后端：功能完整的 **Docker / Node.js 自托管版**（`server/`）与无需服务器的
**Cloudflare 预览版**（`packages/ott-edge/`）。两者共用 Vue 播放器与公共协议，但分别构建、
分别部署，数据与身份相互独立，没有自动同步或导入。

| 对比 | Docker / Node.js | Cloudflare 预览版 |
| --- | --- | --- |
| 运行环境 | 一台持续运行的 Linux 服务器或兼容容器平台 | Workers、Workers Static Assets、SQLite Durable Objects、D1 |
| 必需数据库 | 生产示例为 PostgreSQL 15 + Redis 7 | D1 + 每房间一个 SQLite Durable Object |
| 自有服务器 | 需要；腾讯云只是可选供应商 | 不需要，也不需要 Tunnel、Docker、Redis、PostgreSQL |
| 身份 | 访客与账号体系，按配置启用登录 | 当前浏览器的访客身份；创建者为房主，暂不支持账号登录/找回/迁移 |
| 媒体 | 直链及上游平台适配器（部分需要额外配置或 API 凭据） | MP4/M4V/M4A、HLS、DASH、自定义媒体 JSON 直链；无平台搜索与解析 |
| 同步与房间 | 播放、暂停、跳转、倍速、聊天、便签、语音、权限、队列 | 核心播放与聊天；便签、语音、DJ、SponsorBlock、撤销等尚未迁移 |
| 持久化 | PostgreSQL 与 Redis 数据卷，由部署者维护备份 | Durable Objects 保存房间快照；D1 保存身份、索引、缓存与限流数据 |
| 媒体处理 | 可运行 `ffprobe` 等原有服务端工具 | 有限量元信息探测；无常驻进程、视频转码或媒体代理 |
| 成本模型 | 服务器、磁盘、备份与网络费用 | 账户共享的请求、CPU、DO 执行时长、数据库读写与存储额度 |
| 适合场景 | 需要账号、平台适配或完整服务端能力，并愿意维护服务器 | 以直链点播为主，希望省去服务器运维的小规模共同观看 |
| 部署文档 | [Docker 分步部署、升级与回退](../DEPLOYMENT.md) | [Cloudflare 分步部署](../DEPLOYMENT-CLOUDFLARE.md)（[架构与限制](../packages/ott-edge/README.md)） |

两版都不通过应用服务器转发视频：浏览器需要能直接访问并解码用户提供的有效片源。
“无需服务器”不等于与原后端所有功能等价，Cloudflare 版仍是预览版。

## 资源与免费额度

- **Docker / Node.js**：建议从 **2 vCPU / 2 GiB 内存**起步，并为系统、Docker、Tunnel、备份留余量；
  这不是并发容量承诺。示例 Compose 给应用 512 MiB、PostgreSQL 384 MiB、Redis 192 MiB 上限，
  合计约 1.06 GiB；一次低负载采样约为 64.3 / 50.6 / 6.9 MiB。详细上限、磁盘与日志预算见
  [部署文档的资源配置章节](../DEPLOYMENT.md#资源配置与容量)。
- **Cloudflare 免费额度**：Workers 10 万动态请求/日、DO 10 万计费请求/日、D1 与 DO SQLite
  各 500 万行读 / 10 万行写/日、D1 存储 5 GB（单库上限 500 MB）等，按**整个账户共享**。
  用超只会限流，不会自动扣费；主动开通 Paid 后超额可能计费。官方来源、实测用量、计算公式与
  监控步骤见 [Cloudflare 免费额度与容量评估](cloudflare-quotas.zh-CN.md)。

## 版本识别

版本以提交 SHA、镜像标签或 Cloudflare revision 识别；各版本改动与迁移见
[版本记录](version-notes.zh-CN.md)。
