# 全量审查：技术性与用户体验问题（`feat/upscale-quality`，2026-09-30）

对本分支（`main` 之上 56 个提交，覆盖 v1.1.7–v1.2.5）独立走查技术与体验问题。审查范围分三块：画质增强
（分支主线）、客户端非画质增强部分、服务端与安全；另附 Rust 负载均衡器的一处并发改动。每条给出
`文件:行号`、引用的代码、可复现的触发场景与严重级别；只列有确凿证据的问题，风格/格式类不入列。

方法：阅读变更与上下文代码为主；客户端单测全绿（`client` 套件 780 通过 / 24 跳过，退出码 0），
画质增强目标套件 69 项通过，因此测试通过不代表无缺陷。标「已实测」的条目由本次审查直接核对代码确认；
标「待复核」的条目来自子审查，未逐行复跑。

---

## 一、画质增强（本次分支主线）

### 1. 中 —「质量」档在 WebGPU 上改「渲染倍率」无效

`client/src/components/players/UpscaleLayer.vue:497-512` 的倍率监听只在 `props.mode === "anime4k"`
时重建，其余档位只调 `sizeCanvas()`：

```js
if (props.mode === "anime4k") {
    // The Anime4K pipeline captures its target size when it is built.
    void start();
    return;
}
sizeCanvas(video, canvas);
```

而 WebGPU 的 A+A（质量）档在构建时就把目标尺寸固化：`client/src/util/upscale/anime4k.ts:116`

```js
targetDimensions: { width: canvas.width, height: canvas.height },
```

`preset` 只建一次，之后 `drawFrame` 不再读 `canvas.width`（`anime4k.ts:183-218`），最终只把
`preset.getOutputTexture()` 全屏画到画布上。于是改倍率时画布被改尺寸、内容却是旧尺寸纹理被拉伸。

- 触发：设备有可用 WebGPU 且视频帧可上传（本分支的默认路线），选「AI 超分（质量）」，在「进阶 →渲染倍率」
  里从自动改成 3× 或 1.5× → 观感不变。
- 旁证：`anime4k.ts:213-215` 在首帧把 `渲染目标` 报成 `canvas.width×canvas.height`，倍率改动后这个读数会
  变成一个并不真实的尺寸。
- 对比：WebGL2 回退链（`anime4k-webgl.ts:335-345`）每帧读 `canvas.width` 并按尺寸重排计划，因此同一设置在
  WebGL2 上生效；`anime4k`（快速）档因为监听里会重建，也正常。**只有 WebGPU 上的「质量」档受影响。**

### 2. 中 —播放详情里的「渲染目标」永远为空

`UpscaleLayer.vue:456-458`：

```js
reportEnhancementError(null);
reportEnhancementTarget(null);
```

三个渲染器都是在**构造期同步**把目标报上去的（`film.ts:235`、`anime4k-webgl.ts:408`、`anime4k.ts:213`，均
在 `start()` 里那次同步首绘的 `frames === 0` 分支），而这两行在 `created` 返回**之后**执行，等于把渲染器刚
写好的值清掉。仅「清晰化」（`cas.ts`）根本不调用 `reportEnhancementTarget`。结果：播放详情的
「增强模式与渲染目标」一行在任何档位都不显示（「清晰化」也一直空）。`reportEnhancementError(null)` 是对的，
清 `Target` 属于把失败清理误写到了目标上。

### 3. 中 —自动降档把用户的显式选择写进 localStorage

`UpscaleLayer.vue:242` 的降档走 `store.commit("settings/UPDATE", step)`，而 settings 的每次 `UPDATE` 都会
整份落盘：`client/src/stores/settings.ts:187-194`。`pickDegradeStep` 返回的既可能是降档位（一路可到
`off`），也可能是把 `upscaleScale` 从 `"auto"` 改成固定倍率（`UpscaleLayer.vue:224-228`）。

- 触发：用户在较慢设备上选了「AI 超分（质量）」；自动降档（默认开启）逐级把它降到 `anime4k → film →
  sharpen → off` 并**持久化**；下次打开仍是降级后的档位，用户原来的选择不再保留。
- 影响：一次性能驱动的瞬态决定覆盖了用户的长期设置，且把「自动倍率」永久换成固定倍率后，auto 不再跟随
  显示盒。建议降档只影响本次会话（例如不落盘，或退出该视频后还原）。

### 4. 中 —「影视」档的锐化强度滑块被禁用，但该档实际读取它

`client/src/components/controls/VideoSettings.vue:370`：

```html
:disabled="store.state.settings.upscaleMode !== 'sharpen'"
```

而影视档的着色器确实用了这个值：`client/src/util/upscale/film.ts:224`
`gl.uniform1f(sharpenAmount, options.getStrength() * FILM_SHARPEN_FACTOR)`。于是影视档下用户看到滑块变灰、
调不了，渲染实际用的强度却被冻结在默认值上；手机上默认强度是 `PHONE_UPSCALE_STRENGTH = 0.4`
（`settings.ts:51`），乘 0.6 只有 0.24，偏软且无法调高。影视档的说明文案「锐化强度按 0.6 计」也暗示它应当
可调。二选一：影视档也启用滑块，或影视档改用固定常量并同步文案。

### 5. 中 —文案与 v1.2.5 的新行为矛盾（陈旧 i18n）

- `client/src/locales/zh-CN.ts:250` 与 `en.ts:256`：`scale-auto` 仍写「自动（电脑 2× 源，触屏贴合显示）」
  / "Auto (2× source on a pointer device, display-fit on touch)"。v1.2.5 的核心改动恰恰是 auto 不再按 2×
  渲染、改为跟随显示盒。同处 `scale-hint`（zh:251-252 / en:257）仍写「电脑…会渲染到 2× 源再缩到屏幕」，
  同样已不成立（现在仅在显示盒 <1.25× 时才把 CNN 档抬到 1.25×）。
- `zh-CN.ts:243`：`intro-anime4k-quality` 仍建议「在 2× 及以上倍率使用」，与本次「2× 属于过量渲染」的结论相反。
- `zh-CN.ts:349`：帮助页 `help.enhance.text` 仍写「'AI 超分（Anime4K）'需要 WebGPU」——自 v1.1.9 起已有
  WebGL2 回退，该说法已过时。

用户可见文案直接与本次发布的主结论相左，建议随 v1.2.5 一并更新。

### 6. 低 —CNN 的倍率下限被套用到不需要它的档位

`client/src/util/upscale/scale.ts:48` 定义的 `CNN_MIN_UPSCALE = 1.25` 及其在 `computeCanvasSize`
（`scale.ts:110-114`）里的抬升，明确是为 Anime4K「放大段门槛（>1.2×）」服务的。但三处调用都无条件传
`cnnUpscale: canAffordCnnUpscale()`：

- `UpscaleLayer.vue:94`（画布实际尺寸）
- `client/src/components/composables/player-stats.ts:136`（详情读数）
- `client/src/components/VideoQueueItem.vue`（添加页预览）

于是指针设备上「清晰化」「影视」档在 auto 下也会被抬到至少 1.25×，渲染约 1.5 倍于显示盒需要的像素，而这两档
并不需要过 CNN 门槛（`film.ts` 自行放大、`cas.ts` 只做锐化）。功能正确但与常量注释的用途不符，属白付性能。
应改为「仅 AI 档且指针设备」才传 `true`。

### 7. 低 —统计面板的窄屏断点与共享常量不一致

`client/src/util/breakpoints.ts:2` 已是 `PHONE_MAX_QUERY = "(max-width: 800px)"`（v1.2.5 明确把紧凑断点从
760 提到 800），但 `client/src/components/PlayerStatsPanel.vue:133` 仍硬编码 `@media (max-width: 760px)`。

- 触发：761–800px 竖屏窗口。`VideoControls.vue:67`、`LayoutSwitcher.vue:59`、`Room.vue:1379` 都按 800px
  切到移动布局，而统计面板仍停在桌面端左上角（`PlayerStatsPanel.vue:52`），与移动端规则本要避开的
  「正在播放」栏重叠。

---

## 二、客户端（非画质增强部分）

### 1. 高 —`J` 键现在向前跳转，而非后退

`client/src/views/Room.vue:1631-1639`（已实测）：

```js
shortcuts.bind(
    ["ArrowLeft", "KeyJ", "KeyL"].map(code => ({ code, repeat: true })),
    (e: KeyboardEvent) => {
        if (granted("playback.seek")) {
            const step = store.state.settings.seekSeconds;
            seekDelta(e.code === "ArrowLeft" ? -step : step);
        }
    },
);
```

`main` 上的写法是用 `if (e.code === "ArrowLeft" || e.code === "KeyJ") seekIncrement *= -1;` 选方向的，
所以 `J` 原本是**后退**。重写后只判断 `ArrowLeft`，`KeyJ` 与 `KeyL` 都变成前进。

- 触发：房间在 5:00，用户按 `J` 期望后退 → 跳到 5:10（默认 `seekSeconds` 10）。
- 与界面矛盾：快捷键弹窗 `PlayerShortcutsDialog.vue:38` 的行是 `["← / → · J / L", ...]`，文案也是
  「后退 / 前进」，都把 `J` 与 `←` 配对。`RoomInteraction.component.spec.ts` 只测了 `ArrowRight`，没有
  覆盖 `KeyJ`。

### 2. 中 —音量/静音持久化的 watcher 随首个组件卸载而失效

`client/src/components/composables/media-player.ts:17-56`（已实测）：

```js
let volumeWatchersBound = false;
function bindVolumeWatchers(store) {
    if (volumeWatchersBound) { return; }
    volumeWatchersBound = true;
    watch(volume, () => { ... store.commit("settings/UPDATE", { volume: volume.value }); });
    watch(isMuted, () => { ... store.commit("settings/UPDATE", { muted: isMuted.value }); });
}
export function useVolume() {
    const store = useStore();
    onMounted(() => { volume.value = store.state.settings.volume; isMuted.value = store.state.settings.muted; });
    bindVolumeWatchers(store);
    ...
}
```

`bindVolumeWatchers` 在 setup 内同步调用，`watch()` 因此绑定到该组件实例的 effect scope，组件卸载时被 Vue
停止；模块级标志却永不复位。首个调用者是 `Room.vue:574`。

- 触发：进房间 A 调音量（能持久化）→ 离开房间（Room 卸载，watcher 停止）→ 进房间 B，标志已为 true 不再
  绑定。此后拖动音量只改播放器音量、不再 `settings/UPDATE`；下次挂载 `onMounted` 又用陈旧的
  `settings.volume` 覆盖，改动丢失且永不写入 `localStorage`。无 `useVolume` 测试。

### 3. 中 —HLS/DASH 的 `end` 未转发，结束抑制机制对其失效

`client/src/components/players/OmniPlayer.vue:148` 只在 `DirectPlayer` 上接了 `@end="onEnd"`。
`HlsPlayer` 会发该事件（`HlsPlayer.vue:20`、`HlsPlayer.vue:526 emit("end")`），但 `<HlsPlayer>` 没有监听；
`DashPlayer` 根本不发 `end`。因此 `Room.vue:131` 的 `@end="onMediaEnded"` 只对 Direct 生效。

`Room.vue:1309-1317` 用 `mediaEndedRecently`（2.5s）来抑制 `timestampUpdate` 里新增的自愈逻辑
（`Room.vue:920-928`）。

- 触发：`.m3u8`/`.mpd` 播到结尾时，走的是元素的 `pause` → `onPlaybackChange(false)` → `applyIsPlaying()`，
  随后每 250ms 的自愈再次 `play()`（按 HTML 规范，对已结束元素 `play()` 会跳回 0 秒），因为该路径上
  `mediaEndedRecently` 从未置位。视频会可见地从 0 重播，直到服务器约 1s 的 tick 把 `isPlaying` 翻成 false。

### 4. 中 —`zh-CN` 缺少 `room.tabs.queue-pending`（默认语言）

`client/src/views/Room.vue:290` 渲染 `$t("room.tabs.queue-pending", { count })`；该键只存在于
`en.ts:295`，`zh-CN.ts` 的 `tabs` 块（zh:286-290）没有，而默认语言是 `zh-CN`
（`stores/settings.ts:118`、`i18n.ts:9`）（已实测）。

- 触发：默认语言用户打开任意房间，队列标签徽标显示英文回退文案「Up next 3」。本次测试运行产生 280 条
  `Not found 'room.tabs.queue-pending' key in 'zh-CN'` 告警。该键为本分支新增，属回归。

### 5. 低 —长按 `→` 在 500ms 判定窗口内重复发送房间 seek

`Room.vue:1621-1630`（已实测）：

```js
shortcuts.bind({ code: "ArrowRight", repeat: true }, () => {
    if (arrowHoldPlaying) { return; }
    if (granted("playback.seek")) { seekDelta(store.state.settings.seekSeconds); }
    armArrowHold();
});
```

绑定带 `repeat: true`，自动重复的 keydown 会进来；`arrowHoldPlaying` 要等 500ms 定时器触发才为 true
（`Room.vue:1601-1604`），之前的每次重复都会调 `seekDelta`。

- 触发：长按 `→`，系统重复延迟较短时多次重复落在 500ms 内，各发一次 `SeekRequest`（目标由 250ms 的
  `truePosition` 时钟重算，是近似重复而非累加）。影响是冗余 seek / 重复广播与反复取消准备，非大幅跳转。
  测试只在推进定时器前发一次 keydown（`RoomInteraction.component.spec.ts:798-806`），未覆盖。

### 6. 低 —统计面板手机端断点硬编码 760px

见「一、7」。

### 7. 低（待复核）—登录保存了新 token，但未对已打开的 socket 重新鉴权

`LogInForm.vue:266-271` 先 `LOGIN` 再 `SET_AUTH_TOKEN`，注释称「websocket auth（读 localStorage）会使用登录
后的身份」。但没有逻辑在 token 变化时重连/重鉴权已打开的 `WebSocket`；用户在房间内登录后，该 socket 在重连
前仍是访客身份。持久化改动本身是改进，仅该注释的结论不准确。

---

## 三、服务端与安全

### 1. 高 —Discord OAuth 回调的开放重定向（新守卫不完整）

`server/auth/index.ts:192-197`：

```js
let redirect = (req.session as MySession).postLoginRedirect ?? "/";
if (!redirect.startsWith("/") || redirect.startsWith("//")) {
    redirect = "/";
}
```

`req.query.redirect` 由攻击者控制并存入 session（`server/auth/index.ts:143`）。`/\evil.com` 同时躲过两个
判断：以 `/` 开头、不以 `//` 开头。Express 的 `res.redirect` 用 `encodeurl`，不转义反斜杠，而浏览器对特殊
协议会把 `\` 归一成 `/` ——`new URL("/\\evil.com", "https://ott.example/…")` 在 Node 里解析为
`https://evil.com/`。攻击者可发 `…/api/auth/discord?redirect=/%5Cevil.com`，受害者在 OAuth 往返后被送到
攻击者站点（钓鱼）。
次要问题：若 redirect 以数组形式到达（Express 默认 qs 解析 `?redirect=a&redirect=b`），`redirect.startsWith`
在无 try/catch 的 async 处理器里抛错 → 未处理拒绝/请求挂起。

### 2. 中高 —ffprobe 路径的 SSRF 守卫可被绕过（DNS 重绑定 + 重定向）

`server/ffprobe.ts:293` 的 `RunFfprobe.getFileInfo` 先 `assertPublicMediaUrl(uri)`（一次 `dns.lookup` 判定），
随后把同一个用户 URL 交给 ffprobe（`ffprobe.ts:320-327`）。ffprobe 会自己重新解析域名并跟随 HTTP 重定向，
所以「先解析到公网、随即重解析到 `169.254.169.254`/内网」的 DNS 重绑定，或「302 跳到内网地址」都能绕过
预检。`StreamFfprobe`（`ffprobe.ts:508`）与 `OnDiskPreviewFfprobe`（`ffprobe.ts:392`）用
`axios.get` 且默认 `maxRedirects: 5`，重定向到内网同样能过。本分支新增的探测反而都正确带了
`maxRedirects: 0`（`media-access.ts`、`cors-probe.ts`、`dash.ts`、`hls.ts`、`direct.ts`），但落到真正处理用户
媒体 URL 的 ffprobe 路径时没收口。代码注释（`ffprobe.ts:81`）已承认这个竞态。

- 触发：任一能添加视频的用户，可让服务器请求内网服务或云元数据地址。

### 3. 中 —b23.tv 短链支持是死代码，添加即失败

`server/services/bilibili.ts:117` 定义了 `resolveShortLink`，但全仓库没有任何调用点。`canHandleURL`
接受任意 `b23.tv` 链接（`bilibili.ts:73`），而 `infoextractor.ts` 直接调 `adapter.getVideoId(query)`；对
`https://b23.tv/abc123`，路径不匹配 `BILIBILI_VIDEO_PATH_REGEX`，`getVideoId` 抛
`InvalidVideoIdException`（`bilibili.ts:95-98`）。提交 66ff392 与两处语言文案都宣称支持短链，实际用户看到
的是报错。单测只断言 `canHandleURL("https://b23.tv/abc123") === true`，未覆盖添加流程，因而通过。

### 4. 中 —密码找回路径仍有会话固定（session fixation）

`server/usermanager.ts:882`（`accountRecoveryVerify` 内）：

```js
await tokens.setSessionInfo(req.token, { isLoggedIn: true, user_id: user.id });
```

它把调用者**已有的** token 提权，而不是新签一个。本分支已在 `/login`（`usermanager.ts:279-296`）、
`/register`（`:350-368`）、`/discord/callback`（`auth/index.ts:178-189`）做了轮换，正是为了避免被植入的
预认证 token 被提权，唯独漏了这条同类的找回路径。攻击者在受害者浏览器里种下一个 token 值、受害者完成邮件
重置后，该 token 即成完整登录态。

### 5. 低中 —用户缓存的唯一失效钩子可被客户端无限触发

`server/usermanager.ts:771-800` 把 `getUser` 缓存 60s，`onUserModified` 是唯一的失效点。
`server/clientmanager.ts:416-421` 允许任一已加入的客户端发 `{action:"notify", message:"usernameChanged"}`
→ `onUserModified(client.token)` → `userByIdCache.clear()`，且无限流。缓存本是为消除
`RoomUser.updateInfo` 每次状态心跳打 Postgres 的 O(N²) 查询（`room.ts:142`）；客户端刷 `notify` 可让缓存
长期失效，恢复该查询模式（每条还会触发 `clientmanager.ts:721-731` 的 userModified 扇出与一次房间事件）。

### 6. 低中 —负载均衡部署下应用层延迟探测收不到回复

`server/client.ts:173-176` 只在 `DirectClient.onData` 里回应 `{"action":"ping"}`。经 balancer 部署时客户端是
`BalancerClient`，消息走 `clientmanager.onClientMessage`，落到 `clientmanager.ts:422-424` 的 `else` 分支
（`Unknown client message`），永不回 `pong`。客户端的 `connection-latency.ts` 因此永远采不到样本，
`v1.1.0` 引入的单向延迟补偿失效（功能性，非安全）。另注 `sweepDeadClients`（`clientmanager.ts:759`）也只对
`DirectClient` ping 存活。

### 7. 低 —`corsFromHeaders` 把任何非空 ACAO 当作允许，且 3xx 被读成成功

`server/services/cors-probe.ts:5-11` 对任何非空 `Access-Control-Allow-Origin` 返回 `true`，包括指向另一个
源的（服务端探测没带 `Origin`，无法分辨）。客户端据 `cors !== false` 决定是否带 `crossOrigin`，于是返回
`ACAO: https://some-other-site` 的源会被误判、玩家发起注定失败的 CORS 尝试。相关：`media-access.ts:76` 接受
`status < 400`，于是（因 `maxRedirects: 0` 返回的）302 被当作「可访问的媒体响应」而非「重定向」。

### 8. 低 —ott-edge 的 `Probe.probe` 没有 fetch 超时

`packages/ott-edge/src/media.ts:185-207` 与 `read`（同文件 `:77-78` 会装 `AbortController`）不同，`probe`
只在**重定向之间**重查 `this.deadline`，`fetch` 本身没有 signal；接受连接后挂起的宿主可把 worker 请求拖到
平台上限。

### 9. 低 —定时安全比较不一致

`crates/ott-balancer/src/service.rs:492-500` 长度不等即返回，泄漏 API key 长度；JS 侧 `safeCompareApiKey`
（`server/admin.ts:24-36`）刻意跑了等量时间。仅为长度侧信道。

---

## 四、Rust 负载均衡器

### 1. 中 —配置的线程安全回退（移除了 `Once`）

`crates/ott-balancer/src/config.rs:25-45` 的 `ConfigCell::set` 把原先的 `Once::call_once` 换成无同步的
`slot.is_none()` 判断加 `UnsafeCell` 写入，`unsafe impl Sync`（`:20`）以「单线程启动」为前提声明安全。但
`BalancerConfig::init_default()` 被 `balancer.rs` 里多个 `#[test]` 调用（`:996`、`:1073`、`:1133`…），而 Rust
测试汇编器在同一进程内并行跑这些测试——并发 `set()` 是数据竞争（UB），原 `Once` 恰好挡住了它。另外
`BalancerConfig::get_mut()`（`:99`）现在是返回 `&'static mut` 的**安全**函数，基准
（`benches/joins.rs:153`）在迭代中改 `region`，而 worker 线程同时在读配置，`&mut` 与 `&` 别名。

---

## 五、已检查、未发现问题

- **播放质量上报端点**：`metricServiceLabel`（`server/api/playback.ts:31-36`）把任意 `service` 归并到
  `"other"`，无 Prometheus 标签基数爆炸；schema 约束了每个数值字段；不存按人数据/片源地址。`lastReportAt`
  在众多不同 `req.ip` 下增长，但按 60s 窗口有界，不构成真实 DoS。
- **Redis 快照处理**：`roommanager.ts:154-175` 捕 `JSON.parse`/`redisStateToState` 失败、删坏键回退 DB；
  `unloadRoom` 按身份重新解析并在失败时抛错而非 splice `-1`（`:216-222`）；`update()` 遍历副本（`:79`）。
- **token 签发/校验**（`auth/tokens.ts`）：512 随机字节、Redis 键查找、过期时间正确；`safeCompareApiKey`
  在 key 未设置时正确拒绝，修掉了旧 `undefined === undefined` 的授权绕过。
- **部署文件**：`init.sh` 生成 `REDIS_PASSWORD`；compose 强制要求；回环绑定与 `cap_drop`/`no-new-privileges`
  合理；备份保留（`next-backup.sh:13-16`）正确。小注：Redis 密码经命令行传给 `redis-server`（`docker
  inspect` 可见），`.partial` 文件从不清理。
- **画质增强子项**：程序缓存（同上下文复用、跨上下文隔离、上下文丢失后重编）、渲染目标池（复用/按尺寸
  隔离/释放/超限回收/按计划推导上限）、WebGPU 探针（只有「拒绝视频来源」才排除 WebGPU、无关失败保留、
  视频无帧时不判定）、着色器保留字扫描、倍率与降档下界策略——均有单测覆盖并通过；`webgpu-probe.ts` 的
  `mapAsync` 竞速未吞未处理拒绝（已核对）。
- **客户端（非画质增强）**：`plugins/connection.ts` 延迟探测定时器在所有拆卸路径清理；`stores/users.ts`
  `pendingGrant` 无过期身份竞态；`util/token.ts` 重试与 `Room.vue` toast 重试循环在 `disposed` 时清理正确；
  `util/media-recovery.ts` 卡顿阶梯与后台标签页判定无缺陷；`stores/events.ts` toast 分级、
  `Notifier.vue` 全屏 teleport 与 `fullscreenNoticeHost`/`.player-fullscreen` 接线一致；
  `Chat.vue`/`ChatEmojiPanel.vue`/`util/chat-emoji.ts` 分组与语言键匹配、无重复发送；
  `BilibiliPlayer.vue` 粗同步与文档化降级一致；`vite.config.js` 的 `esbuild.pure` 调试日志裁剪无副作用误删；
  变更文件的事件监听 add/remove 均配对。

## 六、既有问题（非本分支引入，备注）

- `Room.vue:244`/`264` 引用 `$t("room.notes-collapse")`/`$t("room.notes-expand")`，但键只存在于
  `player.notes-collapse`/`player.notes-expand`（`en.ts:912-913`、`zh-CN.ts:876-877`），所有语言都缺失；
  `main` 上同样如此。

---

## 七、建议修复优先级

1. **安全**：Discord 回调开放重定向（三.1）；找回路径会话固定（三.4）；ffprobe SSRF（三.2）——
   前两者改动小、收益直接。
2. **明显功能错误**：`J` 后退变前进（二.1）；`zh-CN` 缺 `queue-pending`（二.4）；播放详情「渲染目标」
   永远为空（一.2）；「质量」档倍率无效（一.1）；HLS/DASH 播完自播一遍（二.3）。
3. **设置与文案**：降档不应持久化（一.3）；影视档锐化滑块（一.4）；`scale-auto`/`scale-hint`/帮助页文案
   同步（一.5）。
4. **其余**：音量持久化 watcher（二.2）、b23.tv 短链（三.3）、CNN 下限误用（一.6）、断点 760/800（一.7）、
   长按 `→` 重复 seek（二.5）、Rust `ConfigCell` 并发（四.1）。
