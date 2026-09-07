# 简体中文分支部署与回退

此文档适用于 `v0.15.0-cn3`。首次部署先在独立端口验收，通过后再接管正式端口；
已在 8080 运行 cn2 的实例可在备份、构建和验收后就地更新应用服务，保留现有数据库和端口配置。
示例中的 `YOUR_HOST`、仓库地址和旧容器名称需要替换为自己的值。

## 版本与运行环境

源码基于官方 `v0.15.0`，工作区 `package.json` 保留上游的 `0.14.1`。分支镜像名为
`ott-next:0.15.0-cn3`，镜像的 revision 标签记录构建所用提交。

需要 Docker Engine、Compose v2、Git 和 Node.js；构建推荐 Node.js 24，使用仓库自带的 Yarn 4.1.0。
第一次安装依赖可能需要 Python 和 C/C++ 编译工具。部署使用独立的 PostgreSQL、Redis、
数据卷、Compose 项目名称和登录 Cookie。

`deploy/next.Dockerfile` 将本地编译结果覆盖到以下固定基础镜像：

```text
dyc3/opentogethertube@sha256:feec95f418e7d438b632bb05311bfa522d5e40f13d019e2146216a49e5b53d93
```

生产运行依赖沿用该 Linux 镜像，未完成全面升级。构建机器上的 `node_modules` 不会复制入镜像；
仅更新 lockfile 不能证明生产运行依赖已更新。更换基础镜像、CPU 架构或依赖组合时应重新验收。

## 首次建立独立实例

以下步骤用于新的空目录。更新已有实例时直接使用后面的更新步骤，保留已有 `.env` 和数据卷。

```sh
mkdir ott-next
cd ott-next
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
`.env` 是 Compose 的配置文件，与 `source/client/.env` 中上游保留的语言设置无关。

在 `source` 目录安装依赖并编译。安装依赖会执行原生模块构建脚本。
构建前确认所有需要发布的源码改动已经审查并提交，下面的源码归档以该 `HEAD` 为准：

```sh
cd source
node .yarn/releases/yarn-4.1.0.cjs install --immutable
node .yarn/releases/yarn-4.1.0.cjs workspace ott-common build
node .yarn/releases/yarn-4.1.0.cjs workspace ott-server build
VITE_SOURCE_URL=/source-code.tar.gz node .yarn/releases/yarn-4.1.0.cjs workspace ott-client build
git archive --format=tar.gz -o client/dist/source-code.tar.gz HEAD
cd ..
```

`VITE_SOURCE_URL` 是前端构建参数，用于设置首页“查看源码”的地址；未设置时指向上游项目。
示例让按钮下载当前部署的源码包，也可以改为自己的公开仓库 URL。修改此参数需要重新构建前端，
只修改运行中的 Compose 环境变量不会生效。

cn3 的前端与服务端使用源码提交标识比较版本。前端构建默认从 Git 读取提交，镜像通过
`SOURCE_COMMIT` 设置服务端的 `OTT_CLIENT_REVISION`；两者必须对应同一提交。
从不带 `.git` 的源码包构建时，显式设置前端构建环境变量 `GIT_COMMIT` 为同一个提交标识。

请在前端构建完成后生成归档，因为前端构建会清空 `client/dist`。`git archive` 只包含已审查
提交中的跟踪文件，不包含 Git 历史、未提交改动、部署 `.env`、数据库或备份；仓库中的空白
配置示例及 `client/.env` 语言设置会正常保留。不要使用包含整个工作目录的归档替代它。
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

如果已有其他实例，保持其目录、镜像、容器及数据卷完整。默认 Compose 项目名为 `ott-next`；
同一机器需要多个此类实例时，显式指定不同项目名及 Cookie 名称。

## 验收与更新

上线前至少验证：健康接口与登录正常；两个客户端的播放、拖动和倍速保持同步；永久房间在
最后一人离开及应用重启后保留当前视频和待播列表；手机聊天按钮不自动聚焦输入框；
全屏、退出全屏、横竖屏切换、点击收控件和手势操作正常。实际浏览器测试应覆盖目标手机。
操作细节见 [播放器说明](docs/player-interactions.zh-CN.md)。

更新前保存当前源码提交、镜像标签、`compose.yml` 和私有 `.env`，并运行 `./backup.sh`。
源码与新产物准备好后构建新镜像，只重建应用服务：

```sh
SOURCE_COMMIT=$(git -C source rev-parse HEAD) sudo --preserve-env=SOURCE_COMMIT docker compose -f compose.yml build ott
sudo docker compose -f compose.yml up -d --no-deps ott
sudo docker compose -f compose.yml ps
```

cn1 到 cn2 的播放器改动、cn2 到 cn3 的语言迁移与版本刷新没有新增数据库迁移。
其他版本更新应先审查迁移，再决定是否执行
`db:migrate`；不要默认旧镜像能够使用新版本已经迁移过的数据库。

cn3 首次加载时会将旧 `localStorage.locale` 迁移为 `zh-CN`，保留其他本地设置；迁移只执行一次，
之后用户可以自行选择并保存语言。它不会删除账号或房间数据。

HTML、源码下载包和 `/api/status/version` 使用 `Cache-Control: no-store`，只有文件名带内容哈希的
静态资源长期缓存。前端每 30 秒及页面恢复、网络恢复、重新可见时检查服务器 revision；
发现不同版本后通过带版本参数的 URL 重新加载，输入中延后，并限制同一目标版本的重复刷新。
反向代理或 CDN 应保留这些缓存规则，不能将 HTML 或版本接口改成长期缓存。

**cn2 及更早已打开的标签页没有版本检测代码，此次仍须先刷新或重新打开一次。自动更新检查从
成功加载 cn3 后生效。** 更新验收应同时检查版本接口、HTML 缓存头及页面实际加载的版本。

## 从 18080 切换到正式 8080

验收完成后，为新实例做一次备份，记录当前占用 `8080` 的旧应用容器名称。
停止该旧应用容器以释放端口，保留它的数据库和所有数据卷：

```sh
sudo docker stop OLD_WEB_CONTAINER
```

在新实例 `.env` 中修改以下两项，然后只重建新应用容器：

```dotenv
OTT_PUBLIC_PORT=8080
OTT_PUBLIC_HOSTNAME=YOUR_HOST:8080
```

```sh
sudo docker compose -f compose.yml up -d --no-deps ott
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
