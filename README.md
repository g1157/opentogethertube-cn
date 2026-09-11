# OpenTogetherTube 简体中文版本

[![license: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)
[![release](https://img.shields.io/github/v/tag/g1157/opentogethertube-cn?label=release&color=f38020)](https://github.com/g1157/opentogethertube-cn/tags)

和朋友同步看视频、聊天，并保存下次继续观看的房间。本仓库基于
[OpenTogetherTube v0.15.0](https://github.com/dyc3/opentogethertube/releases/tag/v0.15.0)，
提供 **Docker / Node.js 自托管版**和 **Cloudflare 无服务器预览版**，两者共用 Vue 播放器及公共协议。

两种后端放在**同一个 GitHub 仓库**维护。播放器修复、中文界面和协议改动可以一起验证；
后端分别构建和部署，不要求同时运行。Cloudflare 版的页面、API、WebSocket 房间及持久化均在
Cloudflare 上，**不需要腾讯云或其他自有服务器**。腾讯云可以作为开发、构建或测试机器，
不属于 Cloudflare 版的运行依赖。

## 快速开始

- **Cloudflare 预览版（不需要服务器，约 15 分钟）**：注册 Cloudflare 账户后，在开发机上按
  [Cloudflare 分步部署](DEPLOYMENT-CLOUDFLARE.md) 发布，使用免费的 `workers.dev` 地址，
  无需服务器运维。适合以 HTTPS 视频直链观看为主的小规模共同观看。
- **Docker / Node.js 自托管版**：按 [部署文档](DEPLOYMENT.md) 在任意 Linux 服务器部署；应用镜像已
  发布到 GHCR，`docker compose pull && up -d` 即可，无需在服务器上编译（建议 2 vCPU / 2 GiB 起步）。
  国内服务器没有开放 80/443 时可用
  [Cloudflare Tunnel 入口](DEPLOYMENT.md#可选cloudflare-tunnel-入口适合没有开放-80443-的服务器)。
  适合需要账号体系、平台解析或完整服务端能力的场景。

两版可以同时部署、互不影响，数据与身份相互独立；完整对比见下表。

## 选择部署方式

| 对比 | Docker / Node.js | Cloudflare 预览版 |
| --- | --- | --- |
| 后端代码 | `server/` | `packages/ott-edge/` |
| 运行环境 | 一台持续运行的 Linux 服务器或兼容容器平台 | Workers、Workers Static Assets、SQLite Durable Objects、D1 |
| 必需数据库 | 生产示例为 PostgreSQL 15 + Redis 7 | D1 + 每房间一个 SQLite Durable Object |
| 自有服务器 | 需要；腾讯云只是可选供应商 | 不需要；也不需要 Tunnel、Docker、Redis、PostgreSQL |
| 身份 | 访客和账号体系，按配置启用登录及服务 | 当前浏览器的访客身份；创建者为房主，暂不支持账号登录/找回/迁移 |
| 媒体 | 直链及原服务端支持的平台适配器，部分服务需要额外配置/API 凭据 | MP4/M4V/M4A、HLS、DASH、自定义媒体 JSON 直链；无平台搜索或 YouTube 等平台解析 |
| 同步与房间 | 播放、暂停、跳转、倍速、聊天、权限和队列 | 支持上述核心功能；DJ、SponsorBlock、撤销等尚未迁移 |
| 持久化 | PostgreSQL、Redis 数据卷，由部署者维护备份 | Durable Objects 保存房间快照；D1 保存身份、索引、缓存和限流数据 |
| 媒体处理 | 可运行 `ffprobe` 等原有服务端工具 | 有限量元信息探测；无常驻进程、视频转码或媒体代理 |
| 成本模型 | 服务器、磁盘、备份和网络费用 | 账户共享的请求、CPU、DO 执行时长、数据库读写与存储额度 |
| 适合场景 | 需要账号、平台适配或完整服务端能力，并愿意维护服务器 | 以直链点播为主，希望省去服务器运维的小规模共同观看 |
| 部署说明 | [Docker 分步部署、升级与回退](DEPLOYMENT.md) | [Cloudflare 分步部署](DEPLOYMENT-CLOUDFLARE.md)（[开发与架构](packages/ott-edge/README.md)） |

两版的数据、身份与房间地址相互独立，没有自动同步或导入。Cloudflare 仍是预览版，不能把
“无需服务器”理解成与原后端所有功能完全等价。浏览器仍需能直接访问、解码用户提供的有效片源。

## 资源消耗与免费额度

以下 Cloudflare 额度核对于 **2026-09-10**，来自官方文档；完整来源、实测、计算公式、付费价格及
监控步骤见 **[Cloudflare 免费额度与容量评估](docs/cloudflare-quotas.zh-CN.md)**。

| 资源 | Docker 示例 | Cloudflare Free |
| --- | --- | --- |
| CPU | 应用容器上限 1 CPU；数据库另用宿主机 CPU | Worker 每次调用 10 ms CPU；DO 有独立执行限制 |
| 内存 | 应用 512 MiB + PostgreSQL 384 MiB + Redis 192 MiB，上限合计 1,088 MiB | Worker isolate 128 MB；DO 执行时长按每对象 128 MB 计费 |
| 动态请求 | 受服务器性能、带宽及反向代理限制 | Workers 100,000 次/日；DO 100,000 计费请求/日，分别计算 |
| DO 执行时长 | 不适用 | 13,000 GB-s/日；符合休眠条件的空闲连接不持续计执行时长 |
| 数据库读写 | 受数据库配置与磁盘影响 | D1、DO SQLite 各自每日 500 万行读、10 万行写，不互相借用 |
| 数据存储 | 部署者配置磁盘、卷和备份 | D1 总计 5 GB，但 Free 单库最多 500 MB；DO SQLite 总计 5 GB |
| 页面/JS/CSS | 消耗服务器或所配 CDN 的网络资源 | 当前标准 Static Assets 请求免费，不占 Worker 动态请求额度 |
| 视频流量 | 默认由观众直接从原片源拉取 | 同样直连片源；本 Worker 不转发完整视频 |

Docker 初始配置建议 **2 vCPU / 2 GiB 内存**并预留磁盘、系统及备份空间；这是一项起步建议，
不是并发容量承诺。三个容器的内存限制不包含操作系统、Docker、Tunnel、构建过程及其他服务。
一次低负载采样约为应用 64.3 MiB、PostgreSQL 50.6 MiB、Redis 6.9 MiB，不能代替峰值评估。
详细的上限、实测和维护要求见 [Docker 资源配置](DEPLOYMENT.md#资源配置与容量)。

**Cloudflare 会有用超免费额度的可能。** Workers、D1、DO 的额度按整个账户共享。Free 超出相应额度时
会限制请求或数据库操作，不会因此自动升级扣费；主动开通 Workers Paid 后，相关产品的超额使用可产生费用。
域名和另行启用的 R2、Stream 等服务不包含在这里的成本结论中。

当前前端每个可见标签页最多约每小时 **120 次版本检查**；每个有观众且播放中的房间约每小时
**120 次播放检查点**，仅快照和 alarm 就约 **240 行 DO 写入**，另有用户操作、冷启动后的 D1 摘要更新等。
例如每天 6 人同看 3 小时，版本检查约 2,160 次；100 人连续看 8 小时，仅版本检查就约 96,000 次，
加上其他 API 和账户内其他项目，很容易触及免费上限。请按观众小时、房间小时和账户剩余额度预算。

## 主要功能与房间行为

- 默认简体中文，保留语言选择、聊天设置、快捷键、全屏和手机横竖屏控件。
- 播放、暂停、跳转和倍速遵循房间权限；长按可临时全房间 2 倍速。
- 永久房保存当前视频、播放位置及待播队列，不是全部已播历史归档。
- 最后一人离开后暂停。原生点播视频重入时，首位有权限的观众准备好保存位置并实际启动本机播放后，房间再继续。
- 手动暂停的房间保持暂停；真正的自动播放限制使用播放按钮解除。
- 当前帧数据就绪即可启动，不要求缓冲到固定百分比、若干秒或等待额外的画面回调。真实缺少数据、未完成跳转和媒体错误仍会显示对应提示。

操作及“已有画面却一直缓冲”的排查见 [播放器说明](docs/player-interactions.zh-CN.md)。
添加大 MP4 长时间转圈的原因、默认 `FFPROBE_STRATEGY=run`、Cloudflare 分段探测及等待边界见
[MP4 解析与排查](docs/media-parsing.zh-CN.md)。添加面板最多等待 45 秒，超时可重试；这与播放器缓冲是两个阶段。
Cloudflare 预览版 `0.1.1` 及更早已打开的页面需要先手动刷新一次；`0.1.2` 修复了预览版本号的自动更新检测。

## 构建与部署入口

开发和构建推荐 **Node.js 24**，使用仓库自带的 **Yarn 4.1.0**。根目录安装依赖会包含所有工作区，
但生产运行只启动选定的后端。Rust 负载均衡与 Grafana 工作区不是 Cloudflare 部署的前置服务。

```sh
node .yarn/releases/yarn-4.1.0.cjs install --immutable
```

Cloudflare 版按 [分步部署文档](DEPLOYMENT-CLOUDFLARE.md) 操作：登录 Wrangler、创建 D1、
配置绑定、应用迁移、构建前端并使用 Wrangler 发布；可使用免费 `workers.dev` 地址，
自定义域名可选。开发机器只在构建、发布或本地调试时使用，发布完成后无需保持在线。

Docker 版按 [部署文档](DEPLOYMENT.md) 拉取已发布镜像（`ghcr.io/g1157/opentogethertube-cn`）并建立
PostgreSQL、Redis 和应用容器，配置数据卷、密钥、域名与 HTTPS（国内服务器可用 Cloudflare Tunnel
作为入口）；升级时换镜像标签、原地重建应用容器并保留数据卷，先备份以便回退。需要自行编译时见
部署文档的“从源码构建镜像”。开发方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Docker / Node.js 部署、升级、回退与容量参考 |
| [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md) | Cloudflare 预览版分步部署、更新与回退 |
| [packages/ott-edge/README.md](packages/ott-edge/README.md) | Cloudflare 版架构、功能范围、限制与本地开发 |
| [docs/player-interactions.zh-CN.md](docs/player-interactions.zh-CN.md) | 播放器操作与“一直缓冲”排查 |
| [docs/media-parsing.zh-CN.md](docs/media-parsing.zh-CN.md) | 大 MP4 解析与 `FFPROBE_STRATEGY` 说明 |
| [docs/cloudflare-quotas.zh-CN.md](docs/cloudflare-quotas.zh-CN.md) | Cloudflare 免费额度、实测与费用评估 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境与贡献流程 |
| [UPSTREAM.md](UPSTREAM.md) | 上游来源与移植范围 |

## 版本与源码

版本以提交 SHA、Cloudflare revision 或镜像 revision 标签识别；历史版本见 Git 标签
（`v0.14.1`、`v0.15.0-cn2` 起）与 `archive/history` 分支。部分工作区的 `package.json` 保留
上游 `0.14.1`，不是部署版本的权威标识。当前构建标识为 Docker `v0.15.0-cn10` 与
Cloudflare `cloudflare-preview-0.1.2`。

部署步骤包含对应提交源码包的生成方法，页面的源码入口由 `VITE_SOURCE_URL` 指定。源码归档应来自
审查后的 Git 提交，不包含账号凭据、私有部署配置、依赖目录或数据库。

## 许可证与致谢

本项目及修改遵循 [AGPL-3.0-or-later](LICENSE)，保留原作者与贡献者的归属；上游为
[dyc3/opentogethertube](https://github.com/dyc3/opentogethertube)，来源与移植范围见
[UPSTREAM.md](UPSTREAM.md)，字体许可证见
[字体来源](client/src/assets/fonts/vendor/LICENSES.md)。

欢迎提交 Issue 和 Pull Request，开发方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
