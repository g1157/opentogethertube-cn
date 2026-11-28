# Emby 入口

房间的添加框里有一个 **Emby** 按钮：每位观众填写自己的 Emby 地址和账号，浏览器直接向
Emby 读媒体库、搜索并播放。OTT 服务器不代理视频，也不保存 Emby 密码；它只收到最终加入队列的
播放地址和展示用元数据（标题、时长、封面、分辨率、MIME）。

## 为什么是浏览器直连

家庭 Emby 通常在 NAT 或局域网里，服务器根本连不上；即使连得上，把整部电影经 OTT 服务器转发
也会把看片变成中继流量。因此这条路径刻意避开了服务端的 `ffprobe`：

1. 浏览器用 `POST /Users/AuthenticateByName` 登录，拿到 `AccessToken` 和 `UserId`。
2. 浏览器用 `GET /Users/{UserId}/Views` 列出媒体库，用 `GET /Users/{UserId}/Items` 搜索
   `Movie,Episode`（每页 60 条）。
3. 选中条目后，浏览器用 `POST /Items/{Id}/PlaybackInfo` 取 `DirectStreamUrl` 或
   `TranscodingUrl`，并判断容器是否能在浏览器里直接播放。
4. 浏览器把 `{service, id, metadata}` 加入队列。服务端只校验字段边界并保存；不会请求该地址。

`service` 由播放地址决定：`.m3u8` 用 `hls`，`.mpd` 用 `dash`，其余可播放容器用 `direct`。

## 凭据与隐私

- 密码只用于这一次登录，不写入任何存储，也不会发到 OTT 服务器。
- 服务器地址和用户名保存在浏览器 `localStorage`，方便下次打开；访问令牌只在当前页面内存里。
- **加入队列的播放地址必然包含本次 Emby 访问令牌**，房间成员都能看到并使用它。共享房间链接
  等于共享这个令牌；不再需要时，在 Emby 的「设备」里撤销该会话。
- 封面地址也带同一个令牌，否则浏览器无法取图。
- 服务端会拒绝带用户名/密码的 URL、非 http(s) URL、超过 2048 字符的 URL、未知 MIME 和
  `video/x-matroska` 等不能直接播放的类型。

## 浏览器要求

- 当前页面必须能访问 Emby 地址。HTTPS 页面不能播放 HTTP 源（混合内容），HTTP 页面可以。
- Emby 需要允许跨域请求。Emby 默认返回 `Access-Control-Allow-Origin` 与
  `Access-Control-Allow-Private-Network`，一般不用改；自建反代若剥掉了 CORS 头会报网络错误。
- 只能直接播放浏览器支持的容器：MP4 / M4V / WebM / OGG / MOV。MKV、AVI、FLV、WMV、原始 TS
  会显示「浏览器不能直接播放」，不会转交给 OTT 服务器。Emby 若返回 HLS 转码地址，会按 HLS 播放；
  转码负载在 Emby 上，不在 OTT 上。

## 已知限制

- 只列电影和单集（`Movie,Episode`），不展开剧集/季；剧集请从 Emby 选具体单集。
- 不支持 Emby 的收藏、继续观看、字幕轨、多版本手动切换；只取 PlaybackInfo 给出的第一个可用源。
- Emby 4.9 的 `/Users/Me` 在这台服务器上会 500，所以只实现用户名+密码登录，不支持 API Key 登录。
- 队列保存的是当时拿到的播放地址；令牌过期或被撤销后，需要重新从 Emby 添加。
- Cloudflare Edge 预览版使用同一份浏览器代码；它的 Durable Object 队列也接受 `metadata`，因此同样能直接播放局域网 Emby，不需要经过 Worker 探针。

## 排障

| 现象 | 检查 |
| --- | --- |
| 连接超时 / 网络错误 | 浏览器能否直接打开 `https://你的 Emby/System/Info/Public`；反代是否保留 CORS 头 |
| 403 | 站点防火墙或 Cloudflare 是否只放行浏览器 UA；换网络或关闭区域限制 |
| 401 | 用户名/密码；密码为空时也要确认 Emby 允许空密码 |
| 海报裂开 | 混合内容（HTTPS 页面 + HTTP Emby）；或图片接口需要令牌 |
| 能加队列但不能播 | 控制台看播放地址是否 403/404；确认不是 MKV；确认房间其他成员也能访问该 Emby |
