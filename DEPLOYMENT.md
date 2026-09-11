# 简体中文分支部署（Docker / Node.js）

> Cloudflare 版部署见 [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md)，架构与限制见
> [packages/ott-edge/README.md](packages/ott-edge/README.md)；本文只适用于 Docker / Node.js 实例。

本分支基于官方 `v0.15.0`（工作区 `package.json` 保留上游的 `0.14.1`），当前版本 `v0.15.0-cn9`，
采用单一生产环境部署：正式机器上只运行一个实例，升级时原地重建应用容器，保留 `.env`、
项目名称、Cookie 名称与数据卷。示例中的 `YOUR_HOST`、仓库地址需要替换为自己的值。

仓库按单版本发布：`main` 只含最新版本；历史版本见 Git 标签（`v0.14.1`、`v0.15.0-cn2` 起）
和 `archive/history` 分支，各版本改动与迁移记录见 [版本记录](docs/version-notes.zh-CN.md)。

## 运行环境

需要 Docker Engine、Compose v2、Git 和 Node.js；构建推荐 Node.js 24，使用仓库自带的 Yarn 4.1.0。
第一次安装依赖可能需要 Python 和 C/C++ 编译工具。前端在部署机器上编译，`deploy/next.Dockerfile`
将编译产物覆盖到以下固定基础镜像：

```text
dyc3/opentogethertube@sha256:feec95f418e7d438b632bb05311bfa522d5e40f13d019e2146216a49e5b53d93
```

生产运行依赖沿用该 Linux 镜像，未完成全面升级。构建机器上的 `node_modules` 不会复制入镜像；
仅更新 lockfile 不能证明生产运行依赖已更新。更换基础镜像、CPU 架构或依赖组合时应重新验收。

## 新机器部署

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
cp source/deploy/next-compose.yml compose.yml
cp source/deploy/next-backup.sh backup.sh
chmod 700 backup.sh
```

生成一次性配置文件，密钥直接写入文件而不输出到终端；已有 `.env` 时此命令会拒绝覆盖：

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

编辑 `.env`，将 `OTT_PUBLIC_HOSTNAME` 设为 `YOUR_HOST:8080`（不带协议和路径）；默认
`OTT_PUBLIC_PORT=8080` 为宿主机端口，容器内部始终使用 8080。PostgreSQL / Redis 镜像使用
`pull_policy: never`，首次先拉取：

```sh
sudo docker pull postgres:15-bullseye
sudo docker pull redis:7-alpine
```

编译前端与服务端（在 `source` 内；`GIT_COMMIT` 与下面的 `SOURCE_COMMIT` 使用同一个完整 SHA）：

```sh
cd source
node .yarn/releases/yarn-4.1.0.cjs install --immutable
node .yarn/releases/yarn-4.1.0.cjs workspace ott-common build
node .yarn/releases/yarn-4.1.0.cjs workspace ott-server build
GIT_COMMIT=$(git rev-parse HEAD) VITE_SOURCE_URL=/source-code.tar.gz node .yarn/releases/yarn-4.1.0.cjs workspace ott-client build
git archive --format=tar.gz -o client/dist/source-code.tar.gz HEAD
cd ..
```

`VITE_SOURCE_URL` 决定首页“查看源码”的地址；示例让按钮下载随镜像发布的源码包，改为自己的公开
仓库 URL 需要重新编译前端。归档必须在前端编译之后生成（前端编译会清空 `client/dist`），只包含
已提交的文件，不含 `.env`、数据库或未提交改动。

构建镜像、启动数据库并初始化表结构（新库必须执行一次迁移），再启动应用：

```sh
SOURCE_COMMIT=$(git -C source rev-parse HEAD) sudo --preserve-env=SOURCE_COMMIT docker compose build ott
sudo docker compose up -d postgres redis
sudo docker compose run --rm --no-deps ott node /app/node_modules/sequelize-cli/lib/sequelize db:migrate --config config/config.mjs
sudo docker compose up -d
curl --fail http://127.0.0.1:8080/api/status
```

## 升级

```sh
./backup.sh    # 先备份；记下当前镜像 ID（sudo docker images 中的 ott 镜像）
cd source && git pull && cd ..
# 重新编译（同“新机器部署”的编译步骤，含 yarn install）
SOURCE_COMMIT=$(git -C source rev-parse HEAD) sudo --preserve-env=SOURCE_COMMIT docker compose build ott
sudo docker compose up -d --no-deps ott
curl --fail http://127.0.0.1:8080/api/status
```

升级前先看 [版本记录](docs/version-notes.zh-CN.md) 是否包含数据库迁移；有迁移则先执行再启动
应用（命令同新机器部署）。不要使用 `down -v`，它会删除数据卷。升级后检查健康接口、双客户端
同步和手机全屏手势是否正常。

## 回退

把 `.env` 的 `OTT_IMAGE` 改回上一版镜像 ID，再只重建应用容器：

```sh
sudo docker compose up -d --no-deps --no-build ott
```

## 备份

`./backup.sh` 用 `pg_dump` 将账号、永久房及其保存状态写入 `backups/`（默认仅部署用户可读），
需要部署用户可以执行 `sudo -n docker`；它不包含 Redis 中的临时房和会话。完整恢复还需要
`.env`、镜像/源码和必要的 Redis 数据。应定期把备份复制到服务器之外、设置保留策略，并在
独立测试库验证恢复。仓库附 `deploy/ott-next-backup.service` / `.timer` 示例，按实际部署修改
`User`、`WorkingDirectory`、`ExecStart` 后自行安装启用。

## 账号与 HTTPS

项目没有默认的全站管理员；`ADMIN_API_KEY` 是独立的运维 API 密钥，不是网页登录密码，
只保存在服务器私有配置中。

Compose 示例按直接 HTTP 端口访问设计（`FORCE_INSECURE_COOKIES=true`、`TRUST_PROXY=0`）。
长期公开部署应配置域名、TLS 和支持 WebSocket 的反向代理，关闭强制不安全 Cookie、按实际
代理层数设置 `TRUST_PROXY`，并限制外部直接访问后端端口，避免绕过代理。参考
[上游 HTTPS 配置](docs/how-to-deploy.md#reverse-proxy)。

### 可选：Cloudflare Tunnel 入口（适合没有开放 80/443 的服务器）

本仓库的线上示例使用这种方式：应用只监听 8080，`cloudflared` 以出站连接接入 Cloudflare，
由 Cloudflare 把域名转发到 `http://localhost:8080`，不需要开放入站端口或本地 TLS 证书。

1. Cloudflare 控制台 → Zero Trust → Networks → Tunnels 创建 Tunnel（连接器选 cloudflared），
   在 Public Hostname 里把域名指向 `http://localhost:8080`，并复制 Tunnel token。
2. 在服务器安装 cloudflared 后执行 `sudo cloudflared service install <token>` 注册为系统服务
   （也可像线上示例一样手写 systemd 单元并用 `--token-file` 启动）。
3. `.env` 的 `OTT_PUBLIC_HOSTNAME` 改为该域名。线上配置保持
   `FORCE_INSECURE_COOKIES=true`、`TRUST_PROXY=0` 即可正常工作；若前面还有别的反向代理，
   再按代理层数调整 `TRUST_PROXY`。

HTML、源码包和 `/api/status/version` 使用 `Cache-Control: no-store`，前端每 30 秒及网络恢复、
重新可见时检查服务器 revision 并自动重载；反向代理 / CDN 必须保留这些缓存规则，不能将 HTML
或版本接口改为长期缓存。本次不包含外部解析器部署；媒体链接本身必须仍然有效。

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
