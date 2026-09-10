# OpenTogetherTube Cloudflare 预览版

当前 `feat/cloudflare` 分支开发独立的 `cloudflare-preview-0.1.0`，基于简体中文 cn8 的前端，
使用 **Cloudflare Workers + Workers Static Assets + SQLite Durable Objects + D1** 运行。
页面、API、房间同步和持久化均在 Cloudflare 上；不需要腾讯云服务器、Tunnel、Docker、Redis 或 PostgreSQL。
视频由浏览器直接从用户提供的片源加载，不经过腾讯云或本应用的媒体代理。

功能范围、本地运行、部署及源码包生成见 **[Cloudflare 开发与部署说明](packages/ott-edge/README.md)**。
此版本使用当前浏览器的访客身份，支持直链媒体；账号登录及平台视频解析尚未迁移。
仓库保留原 Node.js 服务端供参考，下面的历史说明及根目录 Docker 部署文档适用于原有分支。

## 原 Node.js 简体中文分支说明

和朋友同步看视频、聊天，并保留下次继续观看的房间。源码版本为 `v0.15.0-cn4`，
核心基于 [OpenTogetherTube v0.15.0](https://github.com/dyc3/opentogethertube/releases/tag/v0.15.0)。

cn4 选择性移植官方 [visual overhaul #2031](https://github.com/dyc3/opentogethertube/pull/2031)
的配色、字体、首页、导航和房间卡片，来源为 master 提交
[`4ea9029`](https://github.com/dyc3/opentogethertube/commit/4ea9029429a98561ba7c213c54c55ef0f0c56800)。
cn1–cn3 的房间保留、中文及播放器交互继续保留；这不代表整个项目升级到开发分支。

## 功能

-   永久房间在最后一人离开后暂停，保存当前视频、播放位置和待播队列，再次进入恢复。
-   默认简体中文，一次性迁移旧语言偏好后仍可自行选语言；页面支持检测新版本并自动刷新。
-   播放器全屏锁定背景滚动；点画面收起控件，聊天按钮不自动聚焦输入框。
-   长按约 500 毫秒临时全房间 2 倍速；左右滑动跳转 5、10 或 30 秒，遵循房间权限。
-   支持常用播放快捷键、当前标题/集数显示及清晰的改名说明。

永久房间保存**当前视频与待播队列**，不归档全部已播历史。房主及房间管理员管理各自房间，
没有默认的全站管理员网页登录账号；运维 API 使用独立密钥。
链接解析兼容性与连续集自动探测未包含在此次改动中。

操作详见 [播放器说明](docs/player-interactions.zh-CN.md)。已打开的 cn2 或更早页面需要先刷新或
重新打开一次，才会加载中文迁移和版本检测机制。

## 依赖与运行

开发推荐 Node.js 24，使用仓库自带的 Yarn 4.1.0；需要 Redis，生产部署使用 PostgreSQL。
源码包含前端、服务端、公共模块，以及保留的 Rust 负载均衡与 Grafana 工作区。

在仓库根目录安装依赖：

```sh
node .yarn/releases/yarn-4.1.0.cjs install --immutable
```

按 [开发说明](CONTRIBUTING.md) 配置数据库和 Redis 后，运行前后端开发服务：

```sh
node .yarn/releases/yarn-4.1.0.cjs dev
```

## 自托管部署

使用 Docker Engine 和 Compose v2，依照 [构建、部署与回退说明](DEPLOYMENT.md) 操作。
每次发布都先在独立的 18080 端口验收，再将同一个已验收镜像切换到 8080；已有实例更新时保留配置与数据卷。
新旧实例的数据不会自动合并，长期公开访问应配置域名和 HTTPS。

工作区 `package.json` 保留上游的 `0.14.1`；源码与镜像以分支版本及提交标识区分。
生产运行依赖沿用 Dockerfile 中固定摘要的 Linux 基础镜像，未进行全面依赖升级。

## 许可证与上游

本项目及修改遵循 [AGPL-3.0-or-later](LICENSE)，保留 OpenTogetherTube 原作者与贡献者的归属。
随附字体采用 SIL Open Font License 1.1，见 [字体来源与许可证](client/src/assets/fonts/vendor/LICENSES.md)。
来源和移植范围见 [UPSTREAM.md](UPSTREAM.md)。自托管时可通过 `VITE_SOURCE_URL` 指定对应源码地址，
部署文档也提供当前提交源码包的生成方法。
