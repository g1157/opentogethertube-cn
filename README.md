# OpenTogetherTube 简体中文体验版

和朋友同步看视频、聊天，并保留下次继续观看的房间。此分支基于
[OpenTogetherTube 官方 v0.15.0](https://github.com/dyc3/opentogethertube/releases/tag/v0.15.0)，
提供简体中文界面和面向手机的播放器交互。当前分支版本为 `v0.15.0-cn3`。

-   **永久房间续播**：最后一人离开后暂停，保存当前视频、播放位置和待播列表；再次进入时恢复。公开的永久房间在无人在线时仍可从列表进入。
-   **默认简体中文**：首次加载 cn3 时把旧浏览器保存的语言统一设为简体中文，保留其他设置；之后仍可自行选择语言。
-   **播放器全屏**：仅播放器和控件进入全屏，锁定背景滚动；不支持原生全屏时使用网页内全屏。
-   **手机操作**：点击画面显示或收起控件；打开聊天不自动弹出键盘；长按约 500 毫秒临时以 2 倍速同步播放，松手恢复；左右滑动跳转 5、10 或 30 秒。
-   **桌面操作**：双击画面切换全屏，支持空格、方向键、J/L、M、F、T 等快捷键，按 `?` 查看帮助。
-   **观看信息**：显示当前标题；从明确的标题或文件名识别集数；“改名”按钮标明其修改用户名或访客昵称的用途。

长按倍速和播放进度改变会同步到整个房间，需要对应的房间权限。永久房间保留的是
**当前视频和待播列表**，不会归档所有已经播放完的链接。集数识别也不会自动搜索或添加下一集。

从 cn3 起，页面会定期检查服务器版本，发现更新后自动重新加载；正在输入时延后处理，并防止反复刷新。
已经打开的 cn2 或更早页面没有这段检测代码，此次仍需先手动刷新或重新打开一次，后续更新才会自动检查。

参阅 [播放器使用说明](docs/player-interactions.zh-CN.md) 和
[此分支的构建、部署与回退步骤](DEPLOYMENT.md)。可先使用独立的 `18080` 端口验收，再将新实例切换到 `8080`；新旧实例的数据不会自动合并。

项目没有默认的全站管理员账号。房主及房间管理员管理各自房间，运维 API 使用单独的密钥。
本次未修改链接解析兼容性，也未实现连续剧资源自动探测。

源码基线与镜像版本使用 `v0.15.0-cn3` 标识；`package.json` 仍保留上游的 `0.14.1`。
部署镜像继承 Dockerfile 中固定摘要的 Linux 基础镜像及其运行依赖，不能视为所有生产依赖均已升级。
自托管时，可用 `VITE_SOURCE_URL` 指定“查看源码”的地址；部署文档提供生成当前提交源码包的方法。
代码继续遵循 [AGPL-3.0-or-later](LICENSE)，原项目及其贡献者的归属信息保留如下。

## Upstream README

# OpenTogetherTube

[![CI/CD](https://github.com/dyc3/opentogethertube/actions/workflows/main.yml/badge.svg)](https://github.com/dyc3/opentogethertube/actions/workflows/main.yml)
[![codecov](https://codecov.io/gh/dyc3/opentogethertube/branch/master/graph/badge.svg)](https://codecov.io/gh/dyc3/opentogethertube)
[![Docker size](https://img.shields.io/docker/image-size/dyc3/opentogethertube)](https://hub.docker.com/r/dyc3/opentogethertube)

The easy way to watch videos with your friends.

Try it here: https://opentogethertube.com/

# Features

-   Real-time video synchronization
    -   No account registration required
-   Bookmarkable rooms with custom URLs for easy sharing
-   Text chat
-   SponsorBlock integration
-   Plays videos from:
    -   YouTube
    -   Vimeo
    -   `.mp4` files served over HTTP
    -   HLS VOD streams
    -   DASH VOD streams
    -   [Custom media manifests](docs/custom-media-format.md)
    -   [...and some others.](https://github.com/dyc3/opentogethertube/tree/master/server/services)
-   Vote mode: Vote on what to watch next
-   Vote to skip
-   DJ mode: Good for D&D background music
-   Room permissions
-   Multiple UI themes

# Deployment

See the [deployment docs](docs/how-to-deploy.md).

# Contributing

Contributions are welcome! Check out issues that have the "good first issue" label. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for more information.
