# Docker / Node.js 部署与回退

> **Cloudflare 部署请使用 [Cloudflare 开发与部署说明](packages/ott-edge/README.md)。**
> 新预览版发布到独立的 Workers 地址，使用 D1 和 Durable Objects；下面的 Docker、Redis、
> PostgreSQL 与服务器端口操作只用于 Docker / Node.js 实例，不是 Cloudflare 版的发布步骤。

此文档适用于本仓库的 Docker / Node.js 后端；当前部署示例为 `v0.15.0-cn9`，新发布应使用自己的提交标识。每次发布都先在独立的 18080 端口验收，通过后将同一个已验收镜像
切换到正式 8080 端口。已有实例升级也遵循这一顺序，保留配置与数据卷；不直接在正式端口试新版本。
示例中的 `YOUR_HOST`、仓库地址和旧容器名称需要替换为自己的值。

## 版本与运行环境

源码基于官方 `v0.15.0`，工作区 `package.json` 保留上游的 `0.14.1`。Compose 的缺省镜像名为
`ott-next:0.15.0-cn9`；下面的独立验收示例显式使用 `ott-preview:0.15.0-cn9`，避免覆盖现有镜像标签。
镜像的 revision 标签记录构建所用提交。

cn4 选择性移植官方 master 提交 `4ea9029429a98561ba7c213c54c55ef0f0c56800` 的配色、字体、首页、
导航与房间卡片，兼容保留 cn1–cn3 的功能；核心仍以 v0.15.0 为基线，没有整体切换到开发分支。

cn5 增加消息与控件隐藏时长设置、全屏鼠标隐藏、手机双击播放/暂停、连接超时重试，
并为 MP4/HLS 增加有限的错误恢复和本机重新加载，减少缓冲时反复校正进度。cn4 到 cn5
没有新增数据库迁移。HLS 预缓冲设置仅适用于 hls.js，MP4 和浏览器原生 HLS 仍由浏览器管理缓存。

cn6 增加 Enter 打开聊天并自动聚焦，输入后再次 Enter 发送；新消息提示音默认关闭，
可以在本机设置或播放器观看偏好中开启。首次升级会应用关闭提示音的新默认值，之后保留用户选择。
同时修复离房重进时先加载旧片源、身份缓存导致重复等待、旧页面误清理新页面消息监听的问题。
首次房间同步完成后才启动当前视频。
此版本只调整客户端交互、偏好与房间生命周期，没有新增数据库迁移。

cn7 增加本机视频准备、跳转、缓冲及等待画面的提示，显示已等待时间和当前连续缓冲秒数，
长时间等待可仅重载自己的视频。支持时以实际视频帧确认画面就绪，兼容浏览器使用当前帧数据降级判断。
同时将临时房和永久房的空房时钟都暂停：离开前正在播放的原生点播视频，在首位有播放权限的观众
恢复保存位置并确认画面及本机播放后，再启动房间时钟；已有观众正在播放时，新加入者继续追赶。
原本手动暂停的房间保持暂停，重启后仅从 PostgreSQL 恢复的房间也保持暂停。
临时房沿用空闲自动回收，缺省无人约 5 分钟卸载并清除 Redis 快照，2 小时 Redis TTL 用于兜底；
有人观看时续期。新增准备状态不会把临时房变成永久房，也没有新增生产数据库迁移。

cn8 移除遮挡画面的自动播放提示，改用原有播放按钮启动本机；修复刷新后的播放状态竞态，
并用实际出帧计数补充视频帧回调，避免已有画面仍显示等待。跳转时立即暂停本机旧位置，
目标位置有可播放数据后恢复。手机竖屏采用精简控件，横屏或全屏展开；用户进出与跳转提醒
可分别调整为关闭或 1、2、3、5、10、20 秒，默认 3 秒。本轮没有服务端协议或数据库迁移。

cn9 进一步降低原生视频启动要求：只要当前帧数据可用就能尝试播放，不再强制等待额外的画面回调；
缓冲恢复和本机重载也会及时取消恢复超时。该播放器修复由两种后端共用，不涉及生产数据库迁移。
同时将 `FFPROBE_STRATEGY` 默认与部署值改为 `run`，通过 HTTP Range 读取 MP4 尾部索引，避免旧 `stream`
顺序下载大文件后超时。添加面板增加 45 秒请求上限、慢响应提示和重试；详见
[MP4 解析与排查](docs/media-parsing.zh-CN.md)。已有环境中显式设置的 `stream` 需改为 `run`，重建应用容器后才生效。

需要 Docker Engine、Compose v2、Git 和 Node.js；构建推荐 Node.js 24，使用仓库自带的 Yarn 4.1.0。
第一次安装依赖可能需要 Python 和 C/C++ 编译工具。部署使用独立的 PostgreSQL、Redis、
数据卷、Compose 项目名称和登录 Cookie。

`deploy/next.Dockerfile` 将本地编译结果覆盖到以下固定基础镜像：

```text
dyc3/opentogethertube@sha256:feec95f418e7d438b632bb05311bfa522d5e40f13d019e2146216a49e5b53d93
```

生产运行依赖沿用该 Linux 镜像，未完成全面升级。构建机器上的 `node_modules` 不会复制入镜像；
仅更新 lockfile 不能证明生产运行依赖已更新。更换基础镜像、CPU 架构或依赖组合时应重新验收。

## 资源配置与容量

运行需要自有服务器或兼容的持续运行容器平台，腾讯云不是唯一选择。域名/CDN/Tunnel 只作为入口，
把 Node.js 站点放到 Cloudflare Tunnel 后面仍然需要服务器；与本文不同的纯 Cloudflare 运行方式见
[两版对照](README.md#选择部署方式)。

建议从 **2 vCPU / 2 GiB 内存**起步，并为操作系统、Docker、HTTPS 入口和其他服务留余量。
这不是并发保证，构建前端也可能需要比稳定运行更多的内存，可在开发机或 CI 构建后上传产物。

| 服务 | Compose 配置上限 | 2026-09-10 低负载采样 | 额外说明 |
| --- | --- | --- | --- |
| Node.js 应用 | 512 MiB、1 CPU，Node heap 上限 384 MiB | 64.31 MiB、0.46% CPU | 原生库、ffprobe 和缓冲区也占容器内存，不只有 JS heap |
| PostgreSQL 15 | 384 MiB，shared_buffers 64 MB，连接数最多 50 | 50.56 MiB、0.00% CPU | 数据卷随账号、永久房及索引增长；未单独设置 CPU 上限 |
| Redis 7 | 容器 192 MiB，数据 maxmemory 128 MB | 6.891 MiB、0.49% CPU | AOF 每秒刷盘、noeviction；达到数据限制会拒绝新写入，不能依靠自动淘汰 |
| 合计 | 内存上限 1,088 MiB（1.0625 GiB） | 约 121.8 MiB | 不含宿主机、Docker、Tunnel、其他容器及备份；不是预留内存或峰值实测 |

采样机器为 4 核、约 3.64 GiB 可见内存，只观察三个应用容器的一次低负载快照。
`docker stats` 的 CPU 百分比按 Docker 口径，不应误解为整台多核主机的固定比例。
媒体通常由浏览器从原片源加载，应用带宽主要用于页面、控制消息和元信息探测；平台解析、ffprobe、
代理配置及外部服务可能改变 CPU/网络消耗，应按实际启用能力测量。
`run` 在源站支持时使用 Range 跳读；它没有固定下载字节上限，不能当作所有片源恒定只读几 KiB。
单次网络读取超时为约 12 秒，探测进程总上限 35 秒，避免慢源长期占用子进程。

默认每个服务的 Docker 日志为 10 MB × 3 文件，三个服务约 90 MB 的日志轮转预算；它不限制数据库、
Redis AOF、镜像、源码包或备份占用。按实际数据和保留周期规划磁盘与备份，不要把容器内存上限当成磁盘上限。

```sh
sudo docker stats --no-stream
sudo docker system df
df -h
```

结合 PostgreSQL/Redis 数据量、连接数、应用响应时间以及双客户端同步延迟评估容量。
容器上限是保护宿主机的配置，达到上限可能出现 OOM、数据库写入失败或卡顿；公开开放前需要按目标负载验收。
Cloudflare 的日请求/数据库免费额度与此处的服务器 CPU、内存费用是不同的成本模型，见
[Cloudflare 容量评估](docs/cloudflare-quotas.zh-CN.md)。

## 首次建立独立实例

以下步骤用于新的空目录。更新已有实例时直接使用后面的更新步骤，保留已有 `.env` 和数据卷。

```sh
mkdir ott-preview
cd ott-preview
git clone https://github.com/YOUR_GITHUB_USER/opentogethertube-cn.git source
cp source/deploy/next-compose.yml compose.yml
cp source/deploy/next-backup.sh backup.sh
chmod 700 backup.sh
```

生成一次性的配置文件，密钥直接写入文件而不输出到终端；已有 `.env` 时此命令会拒绝覆盖：

```sh
node --input-type=module <<'NODE'
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
let config = readFileSync("source/deploy/.env.example", "utf8");
for (const [key, bytes] of [
  ["POSTGRES_PASSWORD", 32],
  ["SESSION_SECRET", 48],
  ["ADMIN_API_KEY", 32],
]) {
  config = config.replace(new RegExp(`^${key}=$`, "m"), `${key}=${randomBytes(bytes).toString("hex")}`);
}
writeFileSync(".env", config, { flag: "wx", mode: 0o600 });
NODE
```

编辑 `.env`，将 `OTT_PUBLIC_HOSTNAME` 设为 `YOUR_HOST:18080`，不带协议前缀或路径。
默认 `OTT_PUBLIC_PORT=18080` 对应宿主机端口，容器内部始终使用 `8080`。
`.env` 是 Compose 的配置文件；前端语言默认值由源码设为简体中文。

首次建立验收实例时，配置示例显式使用下面这组独立名称。同机已有 `ott-preview` 时，再改为
另一组未使用的名称；Compose 项目名隔离容器、网络和数据卷，Cookie 名称隔离同一主机不同端口的登录状态。

```dotenv
OTT_PROJECT_NAME=ott-preview
OTT_IMAGE=ott-preview:0.15.0-cn9
OTT_INSTANCE_ID=ott-preview
OTT_AUTH_COOKIE_NAME=ott_preview_token
OTT_SESSION_COOKIE_NAME=ott_preview_sid
```

升级已有正式实例时，保留其原有 `.env`、项目名、实例标识、Cookie 名称与密钥，不用上述预览配置覆盖它。
如果旧配置依赖 Compose 的 `ott-next` 等缺省值，应保留这些实际名称。另建预览实例完成验收后，
只将正式实例的 `OTT_IMAGE` 更新为记录的已验收镜像引用，继续使用正式数据卷。

在 `source` 目录安装依赖并编译。安装依赖会执行原生模块构建脚本。
构建前确认所有需要发布的源码改动已经审查并提交，下面的源码归档以该 `HEAD` 为准：

```sh
cd source
node .yarn/releases/yarn-4.1.0.cjs install --immutable
node .yarn/releases/yarn-4.1.0.cjs workspace ott-common build
node .yarn/releases/yarn-4.1.0.cjs workspace ott-server build
GIT_COMMIT=$(git rev-parse HEAD) VITE_SOURCE_URL=/source-code.tar.gz node .yarn/releases/yarn-4.1.0.cjs workspace ott-client build
git archive --format=tar.gz -o client/dist/source-code.tar.gz HEAD
cd ..
```

`VITE_SOURCE_URL` 是前端构建参数，用于设置首页“查看源码”的地址；未设置时指向上游项目。
示例让按钮下载当前部署的源码包，也可以改为自己的公开仓库 URL。修改此参数需要重新构建前端，
只修改运行中的 Compose 环境变量不会生效。

从 cn3 起，前端与服务端使用源码提交标识比较版本，镜像通过 `SOURCE_COMMIT` 设置服务端的
`OTT_CLIENT_REVISION`。发布构建推荐像上面一样显式传入 `GIT_COMMIT=$(git rev-parse HEAD)`，
并让 `SOURCE_COMMIT` 使用同一个完整的 40 位提交 SHA；cn4 发布验收按完整 SHA 核对两者。
未显式设置时，前端默认读取的短 SHA 仍兼容版本检测，但不用于这里的发布示例。
从不带 `.git` 的源码包构建时，也应将 `GIT_COMMIT` 与 `SOURCE_COMMIT` 显式设为同一个完整 SHA。

请在前端构建完成后生成归档，因为前端构建会清空 `client/dist`。`git archive` 只包含已审查
提交中的跟踪文件，不包含 Git 历史、未提交改动、部署 `.env`、数据库或备份；仓库中的空白
配置示例会正常保留。不要使用包含整个工作目录的归档替代它。
每次更新应重新生成与部署源码相符的归档，这样无需依赖代码托管平台登录也能提供对应源码。

也可以在另一台机器编译后传入源码及 `common/ts-out`、`server/ts-out`、`client/dist`。
不要把本地依赖目录、数据库、私有配置或审查证据打进镜像。

以下命令均在包含 `compose.yml` 的部署目录运行。PostgreSQL 和 Redis 配置使用
`pull_policy: never`，首次部署须先拉取镜像：

```sh
sudo docker pull postgres:15-bullseye
sudo docker pull redis:7-alpine
SOURCE_COMMIT=$(git -C source rev-parse HEAD) sudo --preserve-env=SOURCE_COMMIT docker compose -f compose.yml build ott
sudo docker compose -f compose.yml up -d postgres redis
```

确认数据库健康后，初始化新数据库的表结构，再启动应用：

```sh
sudo docker compose -f compose.yml ps
sudo docker compose -f compose.yml run --rm --no-deps ott node /app/node_modules/sequelize-cli/lib/sequelize db:migrate --config config/config.mjs
sudo docker compose -f compose.yml up -d --no-deps ott
curl --fail http://127.0.0.1:18080/api/status
```

应用镜像直接启动编译后的服务，不会代替这一步数据库迁移。新实例默认没有原实例的账号、
房间或播放列表；如需迁移，应先备份并做一次明确的数据迁移。不要向已有用户数据的新实例
重新导入初始快照。

如果已有其他实例，保持其目录、镜像、容器及数据卷完整。Compose 未设置项目名时会退回 `ott-next`；
使用上述显式预览配置，避免新验收实例误用已有项目。

## 验收与更新

上线前至少验证：健康接口与登录正常；两个客户端的播放、拖动和倍速保持同步；永久房间在
最后一人离开及应用重启后保留当前视频和待播列表；手机聊天按钮不自动聚焦输入框；
全屏、退出全屏、横竖屏切换、点击收控件和手势操作正常。实际浏览器测试应覆盖目标手机。
操作细节见 [播放器说明](docs/player-interactions.zh-CN.md)。

更新前保存当前源码提交、镜像标签、`compose.yml` 和私有 `.env`，并运行 `./backup.sh`。
在独立的 18080 验收实例中准备新源码和产物，构建镜像并重建应用服务：

```sh
SOURCE_COMMIT=$(git -C source rev-parse HEAD) sudo --preserve-env=SOURCE_COMMIT docker compose -f compose.yml build ott
sudo docker compose -f compose.yml up -d --no-deps ott
sudo docker compose -f compose.yml ps
```

验收实例使用独立项目、数据与 Cookie，避免测试影响正式房间。通过验收后记录镜像 ID、
源码提交和源码包校验值，再按下一节切换正式入口。切换阶段复用该镜像，不重新构建或更换提交；
保留实际用户数据，不用验收数据库覆盖已有正式数据库。

cn1 到 cn2 的播放器改动、cn2 到 cn3 的语言迁移与版本刷新没有新增数据库迁移。
其他版本更新应先审查迁移，再决定是否执行
`db:migrate`；不要默认旧镜像能够使用新版本已经迁移过的数据库。

从 cn3 起，首次加载会将本地保存的旧语言偏好迁移为 `zh-CN`，保留其他本地设置；迁移只执行一次，
之后用户可以自行选择并保存语言。它不会删除账号或房间数据。

HTML、源码下载包和 `/api/status/version` 使用 `Cache-Control: no-store`，只有文件名带内容哈希的
静态资源长期缓存。前端每 30 秒及页面恢复、网络恢复、重新可见时检查服务器 revision；
发现不同版本后通过带版本参数的 URL 重新加载，输入中延后，并限制同一目标版本的重复刷新。
反向代理或 CDN 应保留这些缓存规则，不能将 HTML 或版本接口改成长期缓存。

**cn2 及更早已打开的标签页没有版本检测代码，此次仍须先刷新或重新打开一次。自动更新检查从
成功加载 cn3 后生效。** 更新验收应同时检查版本接口、HTML 缓存头及页面实际加载的版本。

## 从 18080 切换到正式 8080

已有本分支实例运行在 8080 时，在其正式部署目录仅将 `OTT_IMAGE` 更新为已验收的镜像引用，再执行
`sudo docker compose -f compose.yml up -d --no-deps --no-build ott`；继续使用原有数据库服务及数据卷，
保留该正式实例的项目名、实例标识、Cookie 名称及私有密钥，不把验收实例的数据库替换进去。
优先使用已记录的镜像 ID 或不可变 digest，并核对启动后的镜像 ID。
下面的端口切换步骤用于首次接管旧应用的 8080 入口。

验收完成后，为新实例做一次备份，确认使用的镜像 ID 与 18080 验收记录一致，
记录当前占用 `8080` 的旧应用容器名称。
停止该旧应用容器以释放端口，保留它的数据库和所有数据卷：

```sh
sudo docker stop OLD_WEB_CONTAINER
```

在新实例 `.env` 中修改以下两项，然后只重建新应用容器；`--no-build` 保证复用已验收镜像：

```dotenv
OTT_PUBLIC_PORT=8080
OTT_PUBLIC_HOSTNAME=YOUR_HOST:8080
```

```sh
sudo docker compose -f compose.yml up -d --no-deps --no-build ott
curl --fail http://127.0.0.1:8080/api/status
```

外部访问、登录和双客户端同步也须重新检查。此配置将入口改为 `8080`，不会同时保留
`18080` 的端口映射。切换后的新旧实例仍各自保存数据；旧实例不会自动获得新实例新增的房间、
账号或播放进度。

如果需要恢复原实例，停止新应用容器释放 `8080`，再启动此前保留的旧应用容器：

```sh
sudo docker compose -f compose.yml stop ott
sudo docker start OLD_WEB_CONTAINER
curl --fail http://127.0.0.1:8080/api/status
```

这不会删除新实例数据。需要重新开放新实例供排查时，将其 `.env` 的端口与 hostname 改回
`18080` 再启动。仅回退新实例代码时，使用事先保留的镜像、Compose 配置和源码版本，
仍只重建 `ott` 服务；不要使用 `down -v`，它会删除该实例的数据卷。

## 账号、备份和 HTTPS

项目没有默认的全站管理员登录。登录账号后，可认领尚无房主且允许认领的永久房间；
房主可以管理房间并分配房间管理员。`ADMIN_API_KEY` 是独立的运维 API 密钥，
不是网页登录密码，应只保存在服务器私有配置中。

`./backup.sh` 使用 `pg_dump` 将账号、永久房间及其已保存状态写入 `backups/`，默认权限仅允许
部署用户读取。它需要该用户可以运行 `sudo -n docker`，且只备份 PostgreSQL，
不包含 Redis 中的临时房间或会话。完整恢复还需要保留 `.env`、镜像/源码及必要的 Redis 数据。
应定期把备份复制到服务器之外、设置保留策略，并在独立测试数据库验证恢复。

仓库附有 `deploy/ott-next-backup.service` 和 `.timer` 示例。安装前须按实际部署修改
`User`、`WorkingDirectory`、`ExecStart`；定时器按服务器本地时区在每天 03:30 附近运行。
创建这些文件或启动应用并不会自动启用 systemd 定时备份。

此 Compose 示例为直接 HTTP 端口访问而设，使用 `FORCE_INSECURE_COOKIES=true` 与
`TRUST_PROXY=0`。长期公开部署应配置域名、TLS 和支持 WebSocket 的反向代理，并在 Compose
环境配置中关闭强制不安全 Cookie、按实际代理层数设置 `TRUST_PROXY`。同时限制外部直接
访问后端端口，避免绕过代理。可参考 [上游 HTTPS 配置](docs/how-to-deploy.md#reverse-proxy)。

本次不包含外部解析器的部署或修复，也不包含自动探测连续剧资源。媒体链接本身必须仍然有效，
永久保存房间不会延长媒体授权或签名链接的有效期。
