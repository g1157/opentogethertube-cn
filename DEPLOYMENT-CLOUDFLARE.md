# Cloudflare 预览版部署（Workers / D1 / Durable Objects）

面向新手的完整分步部署文档。架构与功能范围见
[packages/ott-edge/README.md](packages/ott-edge/README.md)，免费额度与费用见
[docs/cloudflare-quotas.zh-CN.md](docs/cloudflare-quotas.zh-CN.md)，Docker / 自托管版见
[DEPLOYMENT.md](DEPLOYMENT.md)。

这份方案**不需要服务器**：页面、API、房间同步和持久化全部运行在 Cloudflare 上，
不需要腾讯云、Cloudflare Tunnel、常驻 Node.js、Redis、PostgreSQL 或 ffprobe。
只在构建和发布时需要一台开发机（Windows / macOS / Linux 均可），发布完成后可以关机。

## 开始前需要什么

| 需要 | 说明 |
| --- | --- |
| Cloudflare 账户 | Free 计划即可；无需域名，默认使用免费的 `workers.dev` 地址 |
| 开发机 | Node.js 24、Git；Yarn 使用仓库自带的 4.1.0，不需要单独安装 |
| 网络 | 能访问 GitHub（克隆仓库）和 Cloudflare API（Wrangler 发布） |
| 账户名额 | 1 个 Worker、1 个 D1 数据库、2 个 Durable Object 类，均在 Free 额度内 |
| 观众侧 | 浏览器能访问站点地址，并能直接访问、解码你提供的 HTTPS 视频直链 |

与 Docker 版的数据、身份、房间地址**相互独立**：可以两个都部署、互不影响，也没有自动同步或导入。
当前是预览版：无账号登录（身份跟随当前浏览器，30 天有效），无平台搜索或 YouTube 等解析，
DJ 模式、SponsorBlock、撤销等尚未迁移；完整差异见主 README 的“选择部署方式”表。

## 首次部署（约 15 分钟）

以下命令都在仓库根目录运行。

### 1. 克隆并安装依赖

```sh
git clone https://github.com/g1157/opentogethertube-cn.git
cd opentogethertube-cn
node .yarn/releases/yarn-4.1.0.cjs install --immutable
```

### 2. 登录 Wrangler（只需一次，浏览器授权）

```sh
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge exec wrangler login --scopes account:read user:read workers_scripts:write d1:write
```

浏览器会打开 Cloudflare 授权页。登录凭证保存在你的用户配置目录，不会写入仓库；
换一台开发机发布时需要重新登录。

### 3. 创建 D1 数据库

```sh
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge exec wrangler d1 create ott-edge-preview --location apac
```

命令会返回 `database_id`，复制备用。**已有数据库时不要重复创建**，直接复用原 ID。

### 4. 配置预览实例

```sh
cp packages/ott-edge/wrangler.jsonc packages/ott-edge/wrangler.preview.jsonc
```

编辑 `packages/ott-edge/wrangler.preview.jsonc`，填入两项：

- `account_id`：Cloudflare 控制台 → Workers & Pages → 右侧账户 ID（或 URL 中的那段）。
- `d1_databases[0].database_id`：第 3 步返回的 ID。

`wrangler.preview.jsonc` 已被 Git 忽略，只存在你的电脑上，不要把账户信息和 ID 提交到仓库。
Worker 名称、数据库名称和 `OTT_INSTANCE_ID` 应保持一致（默认都是 `ott-edge-preview`）。
不要修改 `wrangler.jsonc` 模板里的全零 ID，它只用于本地开发。

### 5. 应用数据库迁移

```sh
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge db:remote
```

这一步把表结构建到你的 D1 数据库，必须在发布之前执行。

### 6. 构建前端并生成源码包

```sh
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge build:client
git archive --format=tar.gz --output=client/dist/source-code.tar.gz HEAD
```

源码包必须在前端构建**之后**生成（构建会清空 `client/dist`）。它公开在
`/source-code.tar.gz`，页面上的“查看源码”指向该包（AGPL 许可证要求，见主 README）。
可选但推荐的自检：

```sh
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge lint-ci
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge test
```

### 7. 发布

```sh
node .yarn/releases/yarn-4.1.0.cjs workspace ott-edge deploy:preview
```

成功后输出 `https://ott-edge-preview.<你的账户子域>.workers.dev`，这就是站点地址，
可以直接分享。**保存本次部署的版本 ID**（回退时用，见下文）。

### 8. 上线检查

- 打开站点：页面正常加载，能创建房间、添加视频并开始播放。
- 用两个浏览器（或一个正常窗口 + 一个隐身窗口）加入同一房间：播放、暂停、跳转保持同步；
  聊天、队列、权限正常；关掉一个再重进，能恢复到保存的位置。
- 测试用的房间结束后删除，避免留在房间列表里。

片源示例：`https://vjs.zencdn.net/v/oceans.mp4`。片源必须是浏览器能直接访问的 HTTPS
直链，且允许跨域（播放器带 `crossorigin="anonymous"`）；MP4 需要源站支持 Range 请求。

## 更新版本

代码更新后使用同一个 Worker、D1 和 Durable Objects 绑定，重跑第 6~7 步即可（先提交改动，
再构建、归档、发布）。每次发布需要把版本标识同步更新到**两个位置**：

- `packages/ott-edge/package.json` 里 `build:client` 的 `GIT_COMMIT`；
- `packages/ott-edge/wrangler.jsonc`（以及你的 `wrangler.preview.jsonc`）里 `vars` 的
  `OTT_CLIENT_REVISION`。

两处使用同一个新标识（例如新的日期或提交短 SHA），已打开的页面靠它检测新版本。
`cloudflare-preview-0.1.1` 及更早的已打开页面没有版本检测，需要先手动刷新一次。

可选变量（同一 `vars` 内）：`ROOM_IDLE_SECONDS`（默认 300 秒）控制临时房空闲回收；
`CHECKPOINT_SECONDS`（默认 30 秒，范围 15–600）控制播放中房间的检查点间隔，
调大可以减少 Durable Object 写入与 alarm 次数，代价是崩溃后恢复的播放进度粒度更粗。

## 回退

在 Cloudflare 控制台 → Workers & Pages → `ott-edge-preview` → Deployments，选择上一个
正常版本重新部署（也可以用 `wrangler rollback` 指定版本 ID）。注意：回退只回退 Worker 代码，
**不会回退 D1 / DO 中已写入的数据和已执行的迁移**；有表结构变化时，先确认旧 Worker 与
新数据结构兼容再回退。

## 自定义域名（可选）

不配置也能长期使用免费的 `workers.dev` 地址。需要自定义域名时：Cloudflare 控制台 →
Workers & Pages → `ott-edge-preview` → Settings → Domains & Routes → Add → Custom domain，
按提示绑定即可。不需要改动 DNS 里的其他记录，也不影响 Docker 版。

## 常见问题

- **页面能打开，但房间不同步 / API 报错**：静态资源和 API 必须由同一个 Worker 提供，
  请用 `deploy:preview` 完整重新发布；确认已执行第 5 步迁移。只部署静态页面不能提供房间服务。
- **视频一直转圈**：多为片源问题——必须 HTTPS、允许跨域、MP4 支持 Range；平台链接
  （YouTube 等）不支持。参见 [MP4 解析与排查](docs/media-parsing.zh-CN.md)。
- **页面不自动刷新新版本**：检查两处版本号是否已同步更新；更早的旧页面手动刷新一次。
- **免费额度用超**：Workers / D1 / DO 额度按整个账户共享，超限会限制服务、不会自动扣费；
  按观众小时和房间小时提前预算，见 [额度评估](docs/cloudflare-quotas.zh-CN.md)。
- **数据恢复**：Durable Object 是房间状态的权威来源，D1 保存身份、索引和缓存；删除房间后
  同名重建不会恢复旧房主和旧队列。当前没有面向预览版的备份/恢复工具，重要内容不要只保存在这里。

## 本地开发

在本地调试 Worker 和播放器的步骤见
[packages/ott-edge/README.md#本地开发](packages/ott-edge/README.md#本地开发)。

## 许可与来源

本项目遵循 AGPL-3.0-or-later，保留原作者归属；源码包由 `git archive` 从已提交内容生成，
不包含 Git 历史、OAuth 凭证、私有部署配置或数据库。上游来源见 [UPSTREAM.md](UPSTREAM.md)。
