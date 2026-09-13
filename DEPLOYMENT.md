# 简体中文分支部署（Docker / Node.js）

> Cloudflare 版部署见 [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md)，架构与限制见
> [packages/ott-edge/README.md](packages/ott-edge/README.md)；本文只适用于 Docker / Node.js 实例。

本分支基于官方 `v0.15.0`（工作区 `package.json` 保留上游的 `0.14.1`），采用单一生产环境部署：
应用镜像由 GitHub Actions 在打标签时自动构建并发布到 GHCR（见
[.github/workflows/publish-image.yml](.github/workflows/publish-image.yml)），**服务器只需拉取
镜像，不需要安装 Node.js，也不需要编译源码**。升级时原地重建应用容器，保留 `.env`、
项目名称、Cookie 名称与数据卷。示例中的 `YOUR_HOST`、仓库地址需要替换为自己的值。

仓库按单版本发布：`main` 只含最新版本；历史版本见 Git 标签（`v0.14.1`、`v0.15.0-cn2` 起）
和 `archive/history` 分支，各版本改动与迁移记录见 [版本记录](docs/version-notes.zh-CN.md)。

## 运行环境

需要 Docker Engine、Compose v2 和 Git（只用来取部署文件）。发布镜像是 **linux/amd64**，适配常见
云服务器；`docker compose pull` 从公开的 `ghcr.io/g1157/opentogethertube-cn` 拉取，不需要登录
（部分网络访问 ghcr.io 可能缓慢或超时；可配置可用代理，或在其他机器 `docker save` 后传输导入）。
镜像内的运行依赖沿用固定基础镜像：

```text
dyc3/opentogethertube@sha256:feec95f418e7d438b632bb05311bfa522d5e40f13d019e2146216a49e5b53d93
```

生产运行依赖沿用该 Linux 镜像，未完成全面升级。需要自行修改代码时见文末
[从源码构建镜像](#从源码构建镜像可选)。

## 新机器部署

```sh
git clone https://github.com/g1157/opentogethertube-cn.git source
bash source/deploy/init.sh   # 生成 compose.yml、backup.sh 和 .env（随机密钥；已有 .env 时拒绝覆盖）
# 编辑 .env：把 OTT_PUBLIC_HOSTNAME 设为 YOUR_HOST:8080（不带协议和路径）
sudo docker compose up -d    # 自动拉取缺失镜像、等待数据库、执行迁移、启动应用
curl --fail http://127.0.0.1:8080/api/status
```

`init.sh` 只负责一次性配置，之后所有操作都通过 `docker compose`。默认
`OTT_PUBLIC_PORT=8080` 为宿主机端口，容器内部始终使用 8080。数据库迁移由 `migrate` 服务在
应用启动前自动执行（幂等；迁移失败时应用不会启动），首次部署和升级都不需要手动迁移。

## 升级

```sh
./backup.sh
sudo docker compose pull      # 拉取新镜像
sudo docker compose up -d     # 先自动迁移，再重建应用容器
curl --fail http://127.0.0.1:8080/api/status
```

`.env` 的 `OTT_IMAGE` 默认指向 `ghcr.io/g1157/opentogethertube-cn:latest`；想固定版本就改成
具体的发布标签（如 `...:v0.15.0-cn10`）或镜像摘要（`@sha256:…`）。升级前仍建议看一眼
[版本记录](docs/version-notes.zh-CN.md) 确认迁移与行为变化。不要使用 `down -v`，它会删除
数据卷。升级后检查健康接口、双客户端同步和手机全屏手势是否正常。

> **从 cn17 及更早升级到 cn18+ 时注意**：便签的权限回填只更新数据库；Redis 里已存在的
> 房间快照仍带旧权限位，会让房间内除房主/管理员外的成员无法添加便签。受影响时先通过
> 管理接口卸载该房间（`curl -X DELETE -H "apikey: $ADMIN_API_KEY" …/api/room/<房间名>`），
> 再删除 `room:<房间名>` 键，让它从数据库重新加载。

## 回退

把 `.env` 的 `OTT_IMAGE` 改回上一版的发布标签或镜像 ID（`sudo docker images` 查看），再只重建
应用容器：

```sh
sudo docker compose up -d --no-deps --no-build ott
```

`--no-deps` 会跳过 `migrate` 服务——回退时不应自动执行迁移，请确认旧版本与当前数据库结构兼容。

## 从源码构建镜像（可选）

需要在自己的提交上部署时，可在有 **Node.js 24** 的机器上本地构建；发布镜像包含的编译步骤
与此一致（基础镜像内的运行依赖不会因本地 `node_modules` 改变，仅更新 lockfile 不能证明
生产依赖已更新）：

```sh
cd source
node .yarn/releases/yarn-4.1.0.cjs install --immutable
node .yarn/releases/yarn-4.1.0.cjs workspace ott-common build
node .yarn/releases/yarn-4.1.0.cjs workspace ott-server build
GIT_COMMIT=$(git rev-parse HEAD) VITE_SOURCE_URL=/source-code.tar.gz node .yarn/releases/yarn-4.1.0.cjs workspace ott-client build
git archive --format=tar.gz -o client/dist/source-code.tar.gz HEAD
docker build --platform linux/amd64 -f deploy/next.Dockerfile \
  --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) \
  -t ghcr.io/g1157/opentogethertube-cn:local .
cd ..
```

`VITE_SOURCE_URL` 决定首页“查看源码”的地址；源码包必须在前端编译之后生成（编译会清空
`client/dist`），只包含已提交的文件。把 `.env` 的 `OTT_IMAGE` 指向 `:local` 标签即可；
`--platform linux/amd64` 与发布镜像保持一致（Apple 芯片机器上必须加）。

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
3. `.env` 的 `OTT_PUBLIC_HOSTNAME` 改为该域名；`TRUST_PROXY` 设为 `1`，让限流按访客 IP 生效
   （经 Tunnel 时客户端 IP 由 `X-Forwarded-For` 提供；若前面还有别的代理层，按实际层数调整）。
   `FORCE_INSECURE_COOKIES` 要设为 `false`。`Secure` 属性约束的是浏览器到 Cloudflare 那一段，
   而浏览器看到的始终是 HTTPS，与 cloudflared 用什么协议回源无关；保持 `true` 只会让登录
   凭据在明文端口上同样可用。

### 可选：裸 IP 直连入口（国内网络不稳时的备用通道）

Cloudflare 免费版在国内经常被限速：实测同一台服务器，裸 IP 取首页约 50 ms，经 Cloudflare 边缘
要 3 s 以上，长连接（WebSocket）更容易直接建不起来——表现是页面能打开但一直「无法连接到房间」。
线上示例因此同时发布了裸 IP 的直连端口，作为 Cloudflare 之外的第二条通道。

1. 在 `compose.override.yml` 里给 `ott` 追加明文端口，并加一个只做 TLS 终结的 Caddy
   （不必改动仓库自带的 `compose.yml`，它保持只绑 `127.0.0.1` 的安全默认值）：

    ```yaml
    services:
        ott:
            ports:
                - "8082:8080"
        caddy:
            image: caddy:2-alpine
            restart: unless-stopped
            ports:
                - "443:443"
                - "8443:443"
            volumes:
                - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
                - ./caddy/ip.crt:/certs/ip.crt:ro
                - ./caddy/ip.key:/certs/ip.key:ro
            depends_on:
                - ott
    ```

    ```caddyfile
    {
    	admin off
    }

    :443, :8443 {
    	tls /certs/ip.crt /certs/ip.key
    	encode zstd gzip
    	reverse_proxy ott:8080
    }
    ```

2. 生成自签名证书（浏览器首次会提示证书不受信任，点「继续前往」即可）：

    ```sh
    openssl req -x509 -newkey rsa:2048 -nodes -days 1095 \
      -keyout caddy/ip.key -out caddy/ip.crt \
      -subj "/CN=<服务器 IP>" -addext "subjectAltName=IP:<服务器 IP>"
    ```

3. `sudo docker compose up -d` 后，访客用 `http://<服务器 IP>:8082` 看视频，用
   `https://<服务器 IP>`（备用 `:8443`）拿安全上下文以启用语音。记得在云厂商安全组放行这些端口，
   并确认没有其他进程占用。将来拿到正式证书，替换 `caddy/` 下两个文件并重启 Caddy 即可。

实测结论与限制（2026-09-13，腾讯云大陆机型，端口探测 + 抓包验证）：

-   **明文 HTTP 按 Host 头做备案拦截，裸 IP 不受影响**：带域名的 HTTP 请求（任意端口）都会被改写成
    `302 → https://dnspod.qcloud.com/static/webblock.html?d=<域名>`；`Host` 为裸 IP 时正常返回
    应用内容。所以明文入口要用 IP，不要用域名。
-   **HTTPS（443 + SNI）不被拦截**：用域名的 SNI 握手得到的是服务器自己的证书和响应，说明拦截只
    针对明文 HTTP；Let's Encrypt 不为裸 IP 签发证书，HTTP-01 又会撞上上面的拦截。用未备案域名 +
    TLS-ALPN-01 签证书在技术上可行，但那属于绕开备案要求，本仓库线上示例不走这条路：不碰域名，
    只用裸 IP + 自签名证书。
-   明文 HTTP 不是安全上下文，`navigator.mediaDevices` 不可用，语音会提示无法使用麦克风。语音需要
    `https://<服务器 IP>`：自签名证书实测同样能拿到安全上下文（`isSecureContext` 为真、
    `navigator.mediaDevices` 可用），只是浏览器首次会提示证书不受信任。
-   直连端口与 Cloudflare 入口是同一个应用实例，登录态、房间、便签、播放列表完全共享。

HTML、源码包和 `/api/status/version` 使用 `Cache-Control: no-store`，前端每 2 分钟及网络恢复、
重新可见时检查服务器 revision 并自动重载；反向代理 / CDN 必须保留这些缓存规则，不能将 HTML
或版本接口改为长期缓存。本次不包含外部解析器部署；媒体链接本身必须仍然有效。

## 资源配置与容量

运行需要自有服务器或兼容的持续运行容器平台，腾讯云不是唯一选择。域名/CDN/Tunnel 只作为入口，
把 Node.js 站点放到 Cloudflare Tunnel 后面仍然需要服务器；与本文不同的纯 Cloudflare 运行方式见
[两版对照](docs/deployment-options.zh-CN.md)。

建议从 **2 vCPU / 2 GiB 内存**起步，并为操作系统、Docker、HTTPS 入口和其他服务留余量。
这不是并发保证，构建前端也可能需要比稳定运行更多的内存，可在开发机或 CI 构建后上传产物。

| 服务          | Compose 配置上限                             | 2026-09-10 低负载采样 | 额外说明                                                             |
| ------------- | -------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| Node.js 应用  | 512 MiB、1 CPU，Node heap 上限 384 MiB       | 64.31 MiB、0.46% CPU  | 原生库、ffprobe 和缓冲区也占容器内存，不只有 JS heap                 |
| PostgreSQL 15 | 384 MiB，shared_buffers 64 MB，连接数最多 50 | 50.56 MiB、0.00% CPU  | 数据卷随账号、永久房及索引增长；未单独设置 CPU 上限                  |
| Redis 7       | 容器 192 MiB，数据 maxmemory 128 MB          | 6.891 MiB、0.49% CPU  | AOF 每秒刷盘、noeviction；达到数据限制会拒绝新写入，不能依靠自动淘汰 |
| 合计          | 内存上限 1,088 MiB（1.0625 GiB）             | 约 121.8 MiB          | 不含宿主机、Docker、Tunnel、其他容器及备份；不是预留内存或峰值实测   |

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
