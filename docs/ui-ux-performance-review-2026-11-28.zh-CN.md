# 2026-11-28 全项目审查：界面设计、用户体验与性能

本轮按用户要求复查全部代码，重点放在界面设计、用户体验与性能；后端、Edge Worker 与 Rust
只做与这三个维度相关的抽查。文中的问题默认**未修改代码**，只给出证据、影响与建议补丁。

## 范围与证据边界

-   基线：`b1785fd`（`release: v1.4.27 playback synchronisation rework`），工作区干净。
-   规模：`client/src` 43,241 行（82 个 `.vue`、104 个 `.ts`、10 个 `.scss`/`.css`），`server/` 41,470 行
    （`*.ts`/`*.js`，含测试，不含 `ts-out`、`coverage`；其中测试占 19,252 行）。
-   证据分三类：
    1.  **源码核实**：路径、行号、调用链确实存在；
    2.  **本机执行**：lint、生产构建、四套测试、`cargo check`/`cargo test`；
    3.  **数值测量**：WCAG 对比度、i18n 键差集、构建产物体积、lodash / Vue Query 的独立打包体积。
-   **未验证**：真实浏览器、真机、GPU、网络限速、Lighthouse/axe、生产流量与压测。本文不把静态
    测量外推成线上验收；凡涉及主观流畅度的地方都单独标注。

## 结论摘要

-   **没有发现 P0（阻断发布）问题**。构建、类型检查、lint 与四套测试全绿。
-   最值得先处理的是 **3 个浅色主题的对比度**（按钮文字 3.0–3.9:1）和 **音量控件与房间语音按钮的
    可访问名**；这两类都是明确、可复现、修复成本低的缺陷。
-   性能上首屏主要成本是 `vendor`（872 KB / 289 KB gzip）与 `Room` chunk（266 KB / 77.8 KB
    gzip）。其中 **Vue Query 仅 Account 页使用，却进了启动 vendor（约 19 KB gzip）**；
    **lodash 全量引入**（约 26.5 KB gzip，按需可降到 7.4 KB gzip）；**中英两个完整语言包
    都随首屏加载**（约 36 KB gzip，实际只显示一个）。
-   房间列表接口为了取 `prevQueue[0]`，会把每个公开房间的完整 `prevQueue` JSON 全部读出来；
    在 200 条队列上限下这是数量级可观的无效 DB IO，且列表无分页/服务端缓存。

| 编号 | 级别 | 结论 | 主要证据 |
| --- | --- | --- | --- |
| D1 | P1（可访问性） | light / strawberry / mint 三个主题的主色按钮、链接、warning 文字与 focus ring 未达 WCAG AA | 实测对比度表，`cinema.scss` + `vuetify.ts` |
| A1 | P1（可访问性） | 音量静音是裸 `<v-icon @click>`；音量滑块无可访问名 | `VolumeControl.vue:2-5` |
| A2 | P1（可访问性） | 房间语音的加入/静音、离开按钮只有 tooltip，没有可访问名 | `Room.vue:70-115` |
| U1 | P2（体验） | 默认 `zh-CN` 且不读取浏览器语言；非中文用户首次进入会看到中文 | `i18n.ts:9`、`settings.ts:383` |
| U2 | P2（体验） | 5 个可选语言包缺 64–73% 的键（pirate 93.7%）；虽有英文回退，但界面中英混杂 | i18n 键差集 |
| A3 | P2（可访问性） | 房间标题编辑 `ClickToEdit` 只能鼠标点击，无法用键盘进入 | `ClickToEdit.vue:17` |
| A4 | P2（可访问性） | 聊天新消息没有 live region，读屏用户不会被告知 | `Chat.vue:21` |
| A5 | P2（可访问性） | 队列排序只有拖拽手柄，没有键盘替代 | `VideoQueue.vue:51-61` |
| A6 | P2（可访问性） | 创建房间按钮用了无效的 `role="Submit"`；错误文本没有 `role="alert"` | `CreateRoomForm.vue:75,80` |
| A7 | P2（体验） | 登录/注册输入框缺少 `autocomplete`，密码管理器无法可靠填充 | `LogInForm.vue:38-55` |
| PF2 | P2（性能） | Vue Query 仅 Account 使用，却在启动 `vendor` 中 | 构建产物 + 独立打包 |
| PF3 | P2（性能） | 10 处 `import _ from "lodash"` 拉入全量 lodash | 10 个文件；独立打包对比 |
| PF4 | P2（性能） | en 与 zh-CN 两份完整语言包随首屏进入 | `i18n.ts:2-3`；index 同时 import 两个 chunk |
| PF5 | P2（体验/性能） | anime4k WebGPU 驱动 3.45 MB / 945 KB gzip，启用时无进度反馈 | `lib-*.js`、`UpscaleLayer.vue:578-596` |
| PF6 | P2（性能） | `/api/room/list` 读取全部公开房间的完整 `prevQueue`；无分页/服务端缓存 | `storage/room.ts:15-40` |
| U3 | P2（体验） | Account 页加载失败只在 toast 里说一句，页面空白且无重试 | `Account.vue:246-296` |
| D4 | P3（设计） | 主题色在 `cinema.scss` 与 `vuetify.ts` 两处重复，修对比度必须同步改 | 两份 10 主题定义 |
| U4 | P3（体验） | 浏览页没有搜索/筛选/分页；房间数增长后只能一直滚 | `RoomList.vue` |
| D2 | P3（设计） | `index.html` 硬编码中文与深色 `theme-color`，无 OG/Twitter 卡片 | `index.html` |
| A8 | P3（可访问性） | 队列容器与条目缺少列表语义 | `VideoQueue.vue`、`VideoQueueItem.vue` |
| PF7 | P3（性能） | 进度条每 250 ms 更新时用 `onUpdated` 查询 DOM 给滑块补 `aria-label` | `VideoProgressSlider.vue:64-80` |
| PF8 | P3（性能） | PeerTube 播放器注册事件后没有卸载清理 | `PeertubePlayer.vue:34-44` |
| PF9 | P3（构建） | 8 个 Roboto 字体文件在拉丁/中文页面基本不用，仍进构建 | `fonts.scss` |
| PF10 | P3（构建） | Vuetify 全量 CSS 仍以 `vuetify/styles` 引入 | `vendor-*.css` 148 KB / 20.5 KB gzip |
| Q1 | P3（维护） | `Room.vue` 3,333 行、20 个 ref、35 个 computed、54 个函数 | 文件统计 |
| Q2 | P3（维护） | 全局样式与 scoped 样式混用；`center-shit` 等命名；散落魔法数值 | 18 scoped / 27 global |

---

## 一、设计系统与主题

### D1 浅色主题对比度不足（P1）

用标准 WCAG 2.x 相对亮度公式对本机 `cinema.scss` 的 10 套主题逐对计算（脚本只读文件，不改样式）。
7 套深色主题抽查的正文、弱化文字、主色按钮、链接均 ≥ 4.5:1；3 套浅色主题存在明确失败：

| 主题 | 组合 | 实测 | 阈值 4.5（正文/按钮文字），3.0（focus ring 等非文本） |
| --- | --- | --- | --- |
| light | `--primary-foreground`（#fff8ec）在 `--primary`（#d97706）上 | **3.02** | 失败 |
| light | `--primary` 文字在 `--background`（#f6efe1）上 | **2.78** | 失败 |
| light | `--primary` 文字在 `--card`（#fffdf8）上 | **3.13** | 失败 |
| light | `--signal` 链接在 `--background` 上（全局 `a` 用 signal） | **3.59** | 失败 |
| light | `--signal` 链接在 `--card` 上 | **4.05** | 失败 |
| light | `--warning` 文字在 `--card` 上 | **3.56** | 失败 |
| light | `--accent-foreground` 在 `--accent` 上（筛选/标签） | **4.26** | 失败 |
| light | focus ring（`--ring` = #d97706）在 `--background` 上 | **2.78** | 失败（< 3.0） |
| strawberry | `--signal` 链接在 `--background` 上 | **3.46** | 失败 |
| strawberry | `--signal` 链接在 `--card` 上 | **3.70** | 失败 |
| strawberry | `--primary` 文字在 `--background` 上 | **4.13** | 失败 |
| strawberry | `--primary` 文字在 `--card` 上 | **4.41** | 失败 |
| strawberry | `--warning` 文字在 `--card` 上 | **2.79** | 失败 |
| mint | `--primary-foreground` 在 `--primary` 上 | **3.90** | 失败 |
| mint | `--primary` 文字在 `--background` 上 | **3.68** | 失败 |
| mint | `--primary` 文字在 `--card` 上 | **3.98** | 失败 |
| mint | `--signal` 链接在 `--background` 上 | **4.07** | 失败 |
| mint | `--signal` 链接在 `--card` 上 | **4.41** | 失败 |
| mint | `--warning` 文字在 `--card` 上 | **3.59** | 失败 |

位置：`client/src/styles/cinema.scss` 的 `[data-theme="light"]`（64 行起）、`[data-theme="strawberry"]`
（222 行起）、`[data-theme="mint"]`（380 行起）。Vuetify 组件实际取的是
`client/src/plugins/vuetify.ts` 里同名 `ThemeDefinition`（light 25–43 行、mint 185–203 行等），
两套值目前一致，**改一处必须同时改另一处**，否则按钮与 CSS 变量会分叉。

影响：这三套主题下，主按钮（例如“创建房间”“添加视频”）、正文链接、警告提示文字、键盘焦点框
在浅色页面上都偏淡。默认主题是 `teal`（通过），所以不是所有人的首屏问题，但对主动选择浅色主题的
用户是持续性的可读性缺陷。

建议：保持色相，只压亮度。下列替换值已用同一脚本验证（括号内为最差组合的实测值）：

-   light：`--primary` `#d97706 → #a85800`（按钮 4.90，页面文字 4.52，卡片 5.09）；
    `--signal` `#0d8b8f → #0b6f73`（页面 5.19，卡片 5.84）；`--warning` `→ #8a5000`（卡片 6.40）；
    `--accent-foreground` `#a85906 → #8a5000`（accent 5.40）；`--ring` 跟随 `--primary`。
-   strawberry：`--primary` `#e8035f → #c40047`（按钮 6.11，页面 5.54，卡片 6.01）；
    `--signal` `#2f9457 → #1c6f3e`（页面 5.61，卡片 6.09）；`--warning` `→ #8a5000`（卡片 6.30）。
-   mint：`--primary` `#0e8f7a → #0a6f5f`（按钮 5.91，页面 5.57，卡片 6.03）；
    `--signal` `#2f7fa8 → #266d92`（页面 5.22，卡片 5.65）；`--warning` `→ #8a5000`（卡片 6.45）。

改色后需同步 `vuetify.ts`，并在浅色主题下人工确认 hero 渐变、glow、hover 态没有变得过暗。
可把对比度检查做成 `client/scripts/check-contrast.mjs` 加入 CI，避免以后新增主题再回归。

### D2 首屏元信息与分享卡片（P3）

`client/index.html` 固定了：

-   `<html lang="zh-CN">`（`i18n.ts` 初始化后会改，但首屏解析阶段仍是中文声明）；
-   `description` 为中文；
-   `<meta name="theme-color" content="#100d0a">` 固定为 dark 主题的背景色，而默认主题是 `teal`
    （#04191c），浅色主题下状态栏/地址栏颜色与页面不一致；
-   没有 `og:title` / `og:description` / `og:image` / `twitter:card`。

影响：分享链接（GitHub、Discord、聊天软件）展开时没有标题、描述与封面图；安装成 PWA 后顶部
状态栏颜色与页面主题不一致（尤其切到浅色主题时）。

建议：`theme-color` 跟随当前主题写入（切换主题时同步更新 meta）；至少补一张 1200×630 的静态 OG
图与基础 OG/Twitter 标签。房间级动态预览需要服务端渲染，可先不做。

### D4 设计 token 与样式边界（P3）

-   **主题色有两份真源**：`cinema.scss` 的 CSS 变量与 `plugins/vuetify.ts` 的 `ThemeDefinition`。
    两份都手写 10 套颜色，一旦只改一边，CSS 链接色与 Vuetify 按钮色就会不一致（D1 的修复尤其
    容易踩到）。
-   **同名 token 语义不同**：`--secondary` 在 CSS 里是浅色面（light 为 #ecdfc3），Vuetify 的
    `secondary` 却是青绿色（#0d8b8f，等于 `--signal`）。`Room.vue` 用 `var(--secondary)` 做底、
    `var(--secondary-foreground)` 做字，读代码时很容易误判。
-   **样式作用域混用**：82 个 `.vue` 中 18 个 `<style scoped>`、27 个全局 `<style>`。全局样式里
    `.disconnected`、`.video-controls`、`.not-found-btn` 这类通用类名有泄漏风险。
-   **零散数值**：24 处内联 `style="..."`，`Room.vue` 内 88 行含 `px` 字面量，`!important` 7 处。
    例如 `AddPreview.vue` 的 `style="margin: 8px 0; padding: 5px 20px"`。
-   **命名**：`common.scss` 的 `.center-shit`（被 `VideoQueue.vue`、`NotFound.vue` 使用）属于
    历史遗留，建议改为 `.center-fill` 之类中性名字；不影响功能，但会出现在每一次代码搜索里。

建议：把主题定义收敛成一份 TS 数据，构建时同时生成 CSS 变量与 Vuetify 主题；给间距/圆角/字号
补 4–6 个 token；新增组件默认 `scoped`，全局样式只保留布局与主题层。

**落地（主题单一真源）**：`client/src/styles/theme-palettes.json` 成为唯一数据源；
`plugins/vuetify.ts` 直接由它构造 10 套 `ThemeDefinition`，`scripts/generate-theme-css.mjs`
从同一份数据生成 `_theme-vars.generated.scss`（`cinema.scss` 用 `@use` 引入）。Mapped token
（`primary`/`signal`/`background`/`card`/`foreground`/`warning`/`success`/`destructive`/`ring`/…）
由 Vuetify 语义色自动派生，不再手写两份；teal 的 `--signal` 保留显式覆盖，因为它与 Vuetify
`secondary` 有意不同。`lint-ci` 先跑生成器的 `--check`，生成文件漏更新会直接失败。

### 设计方面的优点（已核实）

-   10 套主题都走 `data-theme` + `color-scheme`，Vuetify 主题与之对应，切换即时且持久化。
-   全局 `:focus-visible` 轮廓（`cinema.scss:491-495`）与 `.skip-link`（`App.vue:3,558-569`）都在。
-   `prefers-reduced-motion` 在 `Room.vue`、`AppFooter`、`HeroShader`、`RoomCardSkeleton` 中都有处理；
    首页等离子效果还额外受 `IntersectionObserver` 与 `document.visibilityState` 控制
    （`Home.vue:214-226`），不可见时不跑。
-   Vuetify 的 `v-img` 用于缩略图时带 `aspect-ratio` 与占位图，避免布局跳动；全仓库唯一的原生
    `<img>`（logo）带 `width/height`。

---

## 二、用户体验

### U1 首次访问的语言不读浏览器偏好（P2）

`client/src/i18n.ts:9` 把 `locale` 默认设为 `zh-CN`，`client/src/stores/settings.ts:383` 的默认设置
同样是 `zh-CN`；全仓库没有 `navigator.language` / `navigator.languages` 的读取。对中国用户这是
合理默认，但对英文浏览器首次访问（尤其是从 GitHub / 分享链接进入）会直接落到中文界面。

影响：语言选择器在桌面顶栏、移动端抽屉里都能找到，所以不是“无法切换”，而是第一次印象问题；
叠加 U2 的部分翻译，非中文用户第一屏读到的会是“中文骨架 + 英文回退”的混合界面。

建议：没有已保存偏好时，用 `navigator.languages` 匹配受支持语言，匹配不到再回退 `zh-CN`
（对 `zh-*` 仍然默认中文）。`i18n.ts` 的初始值与 `settings.ts` 的默认值要走同一个判定函数，
否则会出现“界面已是英文、设置里仍写着中文”的分叉。

### U2 翻译覆盖率（P2）

把 8 个语言包按扁平键集合与 `en.ts` 对比（`en` 869 个键）：

| 语言 | 键数 | 缺失 | 占比 | 过期多余键 |
| --- | --- | --- | --- | --- |
| en | 869 | 0 | 0% | 0 |
| zh-CN | 869 | 0 | 0% | 0 |
| de | 322 | 559 | 64.3% | 12 |
| es | 303 | 578 | 66.5% | 12 |
| fr | 249 | 632 | 72.7% | 12 |
| pt-br | 306 | 575 | 66.2% | 12 |
| ru | 321 | 560 | 64.4% | 12 |
| pirate | 55 | 814 | 93.7% | 0 |

好消息：`fallbackLocale: "en"` 生效，缺键不会显示原始 key；语言菜单也会标注
`common.partial-translation`（`LocaleSelector.vue`），没有假装完整。问题是实际界面会中英/英德
混排，尤其在设置、播放器、房间权限这些长文案区域。

建议：短期接受回退，但把 5 个部分语言包中缺失最多的模块（可用 `i18n:report` 或同样的键差集脚本）
列成清单，优先补高频路径（首页、房间、播放器控件、错误提示）；同时删掉这 5 份各自 12 个过期键，
避免翻译者误以为还在用。

### U3 Account 失败态只有 toast（P2）

`client/src/views/Account.vue:246-296`：`useQuery` 设了 `retry: false`，401 会跳首页，其他错误
只 `toast.add(...)`（4 秒消失）。模板只有 `isLoading` 与 `v-else-if="account"`，因此非 401 失败
时页面是空白的，用户既看不到原因也没有“重试”。建议增加 `v-else` 错误面板（`role="alert"` +
重试按钮，调用 `accountQuery.refetch()`）。

### U4 浏览页没有搜索、筛选或分页（P3）

`client/src/views/RoomList.vue` 一次渲染 `/api/room/list` 返回的全部房间（`displayRooms` 只是
`rooms.value.map(toRoomCard)`），没有搜索框、人数/可见性筛选、排序选项或“加载更多”。房间数量
增长后只能一直向下滚，每次进入页面还会重新请求完整列表（性能侧见 PF6）。

建议：先加前端过滤（`v-text-field` + `computed`，按房间名/标题匹配）与按人数/名称排序；服务端
补 `limit` 游标后再做“加载更多”。纯前端部分改动很小，可随第一批一起发。

## 三、可访问性与交互

### A1 音量控件：静音图标不是按钮，滑块没有名字（P1）

`client/src/components/controls/VolumeControl.vue:2`：

```vue
<v-icon :icon="volumeIcon" @click="toggleMute" />
```

`<v-icon>` 渲染成 `<i>`，不可聚焦、没有 `role="button"`、没有 `aria-label`，键盘与读屏都无法
静音。紧接着的 `vue-slider`（第 5 行起）没有传 `aria-label`；`vue-slider-component` 自己会渲染
`role="slider"` 的手柄，因此读屏会读到“滑块，无名称”。同一套代码在进度条里专门用
`onMounted`/`onUpdated` 给手柄补了 `aria-label`（`VideoProgressSlider.vue:64-80`），音量条漏了。

建议：把图标换成 `<v-btn icon :aria-label="...">`；给音量 `vue-slider` 增加与进度条相同的
手柄标注（最好抽成共享 helper），并补 ``:aria-valuetext="`${volume}%`"``。这是本轮性价比最高的
修复之一。

### A2 房间语音按钮只有 tooltip（P1）

`client/src/views/Room.vue:70-115` 的两个图标按钮（加入/静音、离开）只有
`<v-tooltip activator="parent">`。tooltip 不是可访问名（即使通过 `aria-describedby` 关联，
按钮本身仍无名），所以 axe 会报 `button-name` / `aria-tooltip-name`。同文件第 133 行的语音条
按钮与 357 行之后的标签页都已经有 `:aria-label`，说明这是遗漏而不是风格。

建议：给两个按钮加 `:aria-label`（静音时用“取消静音”而不是“静音”），`aria-pressed` 反映
当前静音状态。

### A3 播放器时间戳的手动跳转不可键盘操作（P2）

`client/src/components/ClickToEdit.vue:17`：

```vue
<div v-else @click="activate" class="editable" ref="display">...
```

`div` 没有 `tabindex`、`role="button"`，也没有 `keydown`（Enter/Space）处理。鼠标用户点击时间戳
即可输入并跳转，键盘/开关设备用户无法进入编辑态。建议改成 `<button type="button">` 或补
`role="button" tabindex="0" @keydown.enter.prevent="activate" @keydown.space.prevent="activate"`，
并在进入编辑后把焦点交给输入框（当前 `activate` 已有 `nextTick` 聚焦逻辑，可复用）。

### A4 聊天没有 live region（P2）

`client/src/components/Chat.vue:21` 的消息容器只有 `ref` 与 `@scroll`，没有
`role="log"` / `aria-live`。新消息通过 `transition-group` 插入，读屏不会主动播报。
建议给 `.messages` 加 `role="log" aria-live="polite" aria-relevant="additions"`，并在
`activated` 为 false（悬浮聊天）时移除 live 属性，避免后台房间刷屏打断用户。

### A5 队列排序没有键盘替代（P2）

`client/src/components/VideoQueue.vue:51-61` 使用 `Sortable`，`handle: '.drag-handle'`；
手柄在 `VideoQueueItem.vue:11-21` 渲染，且只有有 `manage-queue.order` 权限时才显示。
整个队列没有“上移/下移”按钮或快捷键。触屏拖拽能否工作取决于 Sortable 的 fallback 行为
（本轮未在真机验证），但键盘用户无论如何都无法调整顺序。

建议：在队列项的溢出菜单里补“上移/下移”（服务端已有 queue move 协议），或支持聚焦手柄后
`Alt+↑/↓`；同时把 `aria-grabbed`/位置播报交给一个 `role="list"` 容器。

### A6 创建房间表单的 ARIA 细节（P2）

`client/src/components/CreateRoomForm.vue`：

-   第 80 行 `<v-btn ... role="Submit">`：`Submit` 不是合法 ARIA role（也不是按钮 role），
    实际应使用 `type="submit"`，让表单的原生提交与回车行为一致；
-   第 75 行 `<div :key="error">{{ error }}</div>`：服务端错误既没有样式也没有 `role="alert"`，
    读屏不会播报。建议改成 `<v-alert v-if="error" type="error" role="alert">`。

### A7 登录/注册缺少 autocomplete（P2）

`client/src/components/LogInForm.vue:38-55` 的用户名/密码字段没有 `autocomplete`；注册区的
邮箱与两个密码字段（102–130 行）同样没有。移动端密码管理器与浏览器的“保存密码”体验会明显变差。
建议：登录用户名 `autocomplete="username"`、密码 `current-password`；注册邮箱 `email`、
密码 `new-password`；同时给邮箱字段补 `type="email"` / `inputmode="email"`。

### A8 队列缺少列表语义（P3）

`VideoQueue.vue` 外层是 `div`，`Sortable` 渲染的每项是 `v-sheet`（div），没有
`role="list"` / `role="listitem"`，读屏不会报告“共 N 项、第 M 项”。建议外层加
`role="list" :aria-label="$t('room.queue')"`，每项加 `role="listitem"`，成本很低。

### 交互方面的优点（已核实）

-   快捷键系统会避开输入框、`role="textbox"`、`role="slider"`、打开的对话框与菜单，并且允许
    “点过按钮后方向键仍可用”（`util/keyboard-shortcuts.ts:55-100`），边界考虑很细。
-   播放器手势完整：单击显隐控制、双击播放/暂停、全屏左右滑动调亮度/音量、`role="status"` +
    `aria-live="polite"` 的手势提示（`Room.vue:246-278, 2150-2200`）。
-   隐藏的控制条使用 `:inert="!controlsVisible"`，不会让 Tab 进入不可见按钮（`VideoControls.vue:7-8`）。
-   全屏有原生 API 失败时的 fallback（固定 body、恢复滚动、旋转），对 iOS Safari 的不支持路径
    有兜底（`util/player-fullscreen.ts:113-210`）。
-   断线提示有 10 秒宽限期，短暂重连不打扰用户（`RoomConnectionNotice.vue`）；断线遮罩按
    kick 原因决定是否给“重连”（`RoomDisconnected.vue`）。
-   移动端竖屏把播放器设置改成底部抽屉，调整设置时视频仍可见（`VideoSettings.vue:1-10`）。

---

## 四、性能

### 测量口径

-   生产构建：`yarn workspace ott-client run build`，2026-11-28，Rolldown/Vite 8，退出 0，
    构建耗时 12.93 s。
-   体积为 `client/dist/assets` 的实际字节数（十进制 KB，即 `字节 / 1000`）；gzip 用 `gzip -c <file> | wc -c`
    现算（不取构建日志里 Vite 自报的 gzip 值，两者相差约 1–2%）。
-   lodash / Vue Query 的对比体积用仓库自带 `esbuild` 独立打包（`--bundle --minify --format=esm`），
    仅用于估算它们在 bundle 中的下限，不是 bundle analyzer 的归因结果。

### PF1 启动 vendor 与路由 chunk（现状）

| 产物 | 原始 | gzip | 说明 |
| --- | --- | --- | --- |
| `vendor-*.js` | 872.05 KB | 289.21 KB | 首屏共享依赖 |
| `index-*.js` | 81.97 KB | 25.31 KB | 应用入口 |
| `Room-*.js` | 265.85 KB | 77.77 KB | 房间页（异步路由） |
| `vendor-*.css` | 148.13 KB | 20.50 KB | Vuetify 全量样式 |
| `DashPlayer-*.js` | 944.93 KB | 283.79 KB | 仅 DASH 源，异步 |
| `HlsPlayer-*.js` | 515.26 KB | 157.60 KB | 仅 HLS 源，异步 |
| `lib-*.js`（anime4k-webgpu） | 3,449.34 KB | 944.56 KB | 仅增强开启，异步 |
| `jassub-worker*.wasm`（2 个） | 2.18 MB / 2.11 MB | — | 仅 ASS 字幕，异步 |

分块策略本身是合理的：`vite.config.js:139-163` 把 hls.js、dashjs、three、anime4k-webgpu、jassub、
Vimeo、PeerTube、Sortable 都排除出启动 vendor；播放器用 `defineAsyncComponent`
（`OmniPlayer.vue:263-264`），DanmakuLayer 通过动态 `import()` 才拉 jassub。真正还能再省的是
下面几项。

### PF2 Vue Query 只服务 Account，却在启动 vendor（P2）

`@tanstack/vue-query` 仅在 `views/Account.vue` 使用（`useQuery` / `useMutation`，173 行起），
但产物里 `staleTime`、`queryCache`、`invalidateQueries` 都出现在 `vendor-*.js`。用 esbuild 单独
打包 `{ QueryClient, VueQueryPlugin, useQuery, useMutation, useQueryClient }` 为
**58.69 KB / 19.01 KB gzip**，因此每个首次访问者都为“可能永远不会打开的账号页”付了这部分下载与解析。

建议：把 Account 页改成 `defineAsyncComponent`（路由级懒加载已经隔离了 `Account-*.js`，但依赖仍
被 vendor 吸走），或在 `Account.vue` 内动态 `import("@tanstack/vue-query")`；更彻底的做法是
这个页面只有一个 GET + 三个 POST，直接用现有 axios + 局部 loading/error 状态，移除该依赖。

### PF3 全量 lodash（P2）

10 个源文件使用 `import _ from "lodash"`：

`views/Room.vue`、`stores/room.ts`、`stores/toast.ts`、`util/keyboard-shortcuts.ts`、
`components/AddPreview.vue`、`components/ClientSettingsDialog.vue`、`components/PermissionsEditor.vue`、
`components/RoomSettingsForm.vue`、`components/controls/BasicControls.vue`、
`components/WorkaroundPlaybackStatusUpdater.vue`。

实际用到的函数很少（`clamp` 5 次、`omit` 4 次、`debounce` 2 次、`isEqual` 2 次、`pick` 1 次、
`cloneDeep` 1 次）；`cloneDeep` 也只有一处。独立打包对比：

-   `import _ from "lodash"` + 使用 3 个函数：**73.80 KB / 26.51 KB gzip**；
-   `lodash/clamp`、`lodash/debounce`、`lodash/isEqual` 三个按需导入：**18.58 KB / 7.38 KB gzip**。

因此在最坏情况下，把 10 处改成按需导入（或 `lodash-es` 的具名导入）可省约 **55 KB 原始 /
19 KB gzip**。这是纯机械改动，风险低，建议优先做 `Room.vue` 与 `keyboard-shortcuts.ts` 两处
（它们最靠近首屏/房间路径）。

### PF4 en 与 zh-CN 两份完整语言包都随首屏加载（P2）

`client/src/i18n.ts:2-3` 静态导入 `en` 与 `zh-CN`，而 `dist/assets/index-*.js` 同时 import
`en-CqUj5v1v.js`（47.59 KB / 17.25 KB gzip）与 `zh-CN-BX9uRWGz.js`（45.50 KB / 18.56 KB gzip）。
不管用户实际显示哪一种语言，另一份也会被下载；两者合计 93.09 KB / **35.81 KB gzip**，其中约
18.6 KB gzip 是纯浪费。

建议：静态只保留 `en`（fallback 必需），把 `zh-CN` 改为动态导入并在 `main.ts` 挂载前
`await loadLanguageAsync(store.state.settings.locale)`；对默认中文用户可用
`<link rel="modulepreload">` 或在 `index.html` 里预取该 chunk，避免首屏闪一下英文。
`loadLanguageAsync` 已有缓存与 `loadedLanguages` 列表，改动很小。

### PF5 anime4k WebGPU 驱动的体积与反馈（P2）

`lib-*.js` 为 3,449 KB / 945 KB gzip，内容确认是 `anime4k-webgpu`（包含 GLSL 与权重）。
`UpscaleLayer.vue:578-596` 先用 `webgpu-probe` 探测，再动态导入驱动，避免在不支持 WebGPU 的
浏览器白下载——这是很好的设计。但启用 “Anime4K” 时没有任何下载/编译进度提示，网络慢或
GPU 管线编译慢时，用户只看到设置选中、画面短暂无变化。

建议：在设置项旁或播放器角标显示“准备中…”，至少在 `startAnime4KRenderer` 前后给出状态；
对移动网络或 `navigator.connection.saveData` 用户默认选更轻的 `anime4k-webgl` / `sharpen`。
同时保留“失败自动降级”的现有逻辑。

### PF6 房间列表接口读取完整 `prevQueue`（P2）

`server/storage/room.ts:15-40`：

```ts
const rooms = await DbRoomModel.findAll({
    where: includeUnlisted ? {} : { visibility: Visibility.Public },
    attributes: ["name", "title", "description", "visibility", "queueMode", "prevQueue", "passwordHash"],
});
...
currentSource: room.prevQueue?.[0] ?? null,
```

`prevQueue` 是 JSON 列，队列上限 `MAX_QUEUE_ITEMS = 200`（`common/constants.ts:81`），每项包含
标题、缩略图、service id 等元数据。为了拿第一项，接口把每个公开房间最多 200 项的 JSON 全部读出、
反序列化后丢弃其余 199 项。房间数越多，`/api/room/list` 的 DB 读取与内存分配越接近线性放大。
此外：

-   `server/api/room.ts:70-114` 没有分页/`limit`；`server/api.ts:27` 又给所有 API 统一加了
    `Cache-Control: no-store`，所以浏览器/共享缓存也不会兜底，每次进入浏览页都会完整重查；
-   `client/src/views/RoomList.vue` 没有搜索、筛选或“加载更多”，一次渲染全部房间。

Edge 版本反而有 `LIMIT 200`（`packages/ott-edge/src/index.ts:232-243`），主服务端没有。

建议：
1. 存储层只取第一项（SQL 方言不同，可用 `prevQueue->0` / `json_extract`，或新增
   `current_source_title` / `current_source_thumbnail` 冗余列并在换源时更新）；
2. 列表加 `limit` + 游标（按 `user_count DESC, name ASC`），客户端做“加载更多”；
3. 若房间数不大，至少加进程内 5 秒缓存；确需 HTTP 缓存时，只对公开列表单独覆盖
   `Cache-Control: public, max-age=5`，并确认密码房字段仍被剥离。

### PF7 进度条每次更新都查询 DOM（P3）

`VideoProgressSlider.vue:64-80` 在 `onUpdated` 里每次都 `querySelector(".vue-slider-dot")` 并
检查/设置 `aria-label`。房间时钟 250 ms 更新一次滑块（`Room.vue` 的 `timestampUpdate`），
因此每秒最多 4 次 DOM 查询；单次成本很小，但这是热路径上的无谓工作。

建议：在 `onMounted` 与语言切换时设置一次；若库重建了手柄，用 `watch` 监听 `effectiveLength`
或使用 `MutationObserver`，而不是每次更新都扫描。

### PF8 PeerTube 播放器事件未清理（P3）

`PeertubePlayer.vue:34-44` 在 `onMounted` 注册 `player.addEventListener("playbackStatusChange", ...)`，
但没有 `onUnmounted` / `removeEventListener`。组件卸载时 iframe 会移除，但监听器仍持有组件闭包，
播放器对象若被 SDK 内部引用，会延长组件实例与响应式状态的寿命；多次挂载/卸载会累积回调。

建议：保存 `player` 引用与回调，在 `onUnmounted` 调用 `player.removeEventListener(...)` 并销毁
播放器（若 SDK 提供）。

### PF9 Roboto 字体（P3，构建重量）

`client/src/fonts.scss` 声明了 8 个 Roboto `@font-face`（latin/cyrillic，400/500/700 及 italic）。
正文字体是 `--font-body: "Hanken Grotesk", "Roboto", "PingFang SC", ...`，拉丁字符由 Hanken
覆盖，中文由系统字体覆盖，Roboto 基本只作为“Hanken 加载失败”的兜底；Vuetify 的
`.v-application` 也被覆盖为 `var(--font-body)`。拉丁与中文页面通常不会真正下载这些文件；
但俄语等 Hanken 缺少字形的语言会回退到 Roboto cyrillic，所以不能一律删除，需按语言确认。
它们会增加构建产物与字体清单，也容易让人误以为 Roboto 是主字体。

建议：先查清各语言的回退链（至少在 `ru` 下用 DevTools 的 Fonts 面板确认是否请求 Roboto），
再决定删除哪几个 `@font-face`；若只是兜底，保留 400 常规的 latin + cyrillic 两份即可。

**落地**：保留 400 的 latin + cyrillic 两份，删掉 italic/500/700 六份声明与六个 woff2 文件；
`dist` 里的 Roboto 从 8 个文件 104.3 KB 降到 2 个文件 25.4 KB。Hanken 覆盖拉丁 300–800，
CJK 走系统字体，只有 Hanken 加载失败或缺少西里尔字形时才会请求 Roboto；500/700 的西里尔
文本由浏览器合成粗体，与“兜底字体”的定位一致。

### PF10 Vuetify 全量 CSS（P3）

`vendor-*.css` 148 KB / 20.5 KB gzip。复核发现原判断需要更正：`import "vuetify/styles"` 只贡献
共享的 reset/base 层（在关闭 `$utilities` 与 `$color-pack` 后约 17.8 KB / 2.4 KB gzip）；
每个组件的 JS 自己 `import` 自己的 CSS，`vite-plugin-vuetify` 再把该导入按 `vuetify-settings.scss`
编译，所以组件样式本来就是按需的。全量 `vuetify/dist/vuetify.css` 是 598 KB / 73.7 KB gzip，
当前 vendor 是它的 25%（gzip 28%），且不含 `.v-data-table`/`.v-color-picker`/`.v-date-picker` 等
未使用组件，也没有 `.bg-red` 这类 utilities。

**落地**：不改样式入口（再拆 base 只能省约 2 KB gzip，却要自己维护 reset，风险大于收益）；
新增 `client/scripts/check-bundle-css.mjs` 并由 `build` 调用，断言 vendor CSS ≤ 170 KB /
24 KB gzip、未使用组件与 utilities 不出现，防止以后误引全量样式。

### 性能方面的优点（已核实）

-   Service Worker 只缓存带内容哈希的 `assets/`，导航、API、WebSocket、媒体全部走网络，
    部署后不会出现“旧页面”；缓存上限 128 条并有配额失败兜底（`client/public/sw.js`）。
-   `DanmakuLayer`、jassub worker、wasm、anime4k 都是按需加载；不支持 WebGPU 时不下载 3.4 MB。
-   聊天历史上限 200 条（`Chat.vue:222-226`），避免长会话 DOM 无限增长；队列上限 200 条。
-   首页等离子背景在页面不可见/标签页隐藏/reduced-motion 时停止（`Home.vue:214-226`）。
-   房间时钟 250 ms 一次是必要的播放同步成本；`timestampUpdate` 内已避免重复 `play()` 与
    无意义的预取重置（此前 N15 修复）。
-   生产构建会剥离应用代码中的 `console.log/info`（`vite.config.js:61-90`），只保留
    `console.debug/warn/error`；实测 `index`/`Room` chunk 中没有 `console.log`。

---

## 五、后端 / Edge / Rust 抽查

这一节只覆盖与 UI/UX/性能直接相关的点，不重复 2026-11-23 已完成的后端修复。

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 会话 Cookie | `httpOnly`、`sameSite=lax`、非明文部署时 `secure` | `server/usermanager.ts:358-360, 971-973` |
| 密码存储 | argon2（`$argon2id$`），并兼容历史上的空字节截断 | `server/usermanager.ts:3, 568-592` |
| API 缓存 | 全 API 默认 `no-store`；需要缓存的路由单独覆盖 | 2026-11-23 N06 |
| 房间列表隐私 | 未授权响应会把密码房的 `currentSource` 置空 | `server/api/room.ts:109-112` |
| 房间列表性能 | 见 PF6：全量 `prevQueue`、无分页/服务端缓存 | `server/storage/room.ts:15-40` |
| Edge 限流与上限 | `media` 预览 20 次预算、房间列表 `LIMIT 200`、创建房间每 owner 20 个 | `packages/ott-edge/src/index.ts:49-52, 232-243, 318` |
| Edge 维护 | 过期会话/媒体缓存/限流清理 + 过期房间实例清理 | `packages/ott-edge/src/maintenance-object.ts:20-45` |
| Rust 请求体 | 代理请求体限制 16 MiB | 2026-11-23 N33；`crates/ott-balancer` |
| Rust 编译 | `cargo check --workspace` 通过（14.95 s，2026-11-28） | 本机执行 |
| Rust 测试 | `cargo test --workspace` 进入 `harness` 包的 3 个依赖真实进程的用例后，超过 3 分钟仍未结束（另有 5 项已通过）；为避免悬挂进程手动终止，退出码 1，本轮不据此声称 Rust 测试全绿 | 本机执行，见“运行验证” |

`packages/ott-edge/migrations/0001_initial.sql` 的房间表已有 `visibility`、`expires_at`、`owner_id`
索引，列表查询条件与索引匹配；主服务端 `server/migrations/20261005140000-add-rooms-lower-name-index.js`
也为大小写不敏感的房间名查找建了索引。跨端的数据一致性不在本轮范围。

---

## 六、代码质量与可维护性

### Q1 `Room.vue` 体积（P3）

`client/src/views/Room.vue` 3,333 行，包含 20 个 `ref`、35 个 `computed`、54 个函数，以及模板、
样式与手势/全屏/时钟/权限/通知逻辑。它不是“死代码”，但任何播放相关改动都要在同一个文件里
定位，冲突概率高，review 成本也高。

建议按现有 composable 风格继续拆分（仓库已有 `components/composables/`）：
`useRoomFullscreen`（`player-fullscreen` 调用与通知）、`useRoomClock`（`timestampUpdate` 与
滑块位置）、`useRoomGestures`（已有 `gestures` 雏形）、`useRoomNotices`（interaction/level 提示）。
目标不是追求行数，而是让播放同步、房间 UI、权限三块可以独立测试。

**落地**：四个 composable 已按上述边界拆出（`client/src/components/composables/room-{fullscreen,clock,notices,gestures}.ts`），
`Room.vue` 3,333 → 3,179 行；时钟、全屏宿主同步、提示计时与手势接线各有一份实现，
另补了 14 项 fake-timer 单测。`timestampUpdate` 仍走同一个 `clock.tick()`，
`getServerClockOffsetMs()` 在读数前执行；亮度只有一份 `usePlayerBrightness()` 实例，
由 scrim、滑动和读数共享。

### Q2 命名与历史包袱（P3）

-   `center-shit`（`common.scss:1`）建议改为 `center-fill`；
-   Safari 不支持 TS enum 的 hack 在 `Room.vue` 与 `VideoSettings.vue` 各写了一份字面量注释，
    可抽成 `common/models/types` 旁的只读映射，避免以后改协议时漏一处；
-   9 处 `console.debug` 会留在生产包中（`OmniPlayer` 换源/字幕、`YoutubePlayer` 轨道、
    `stores/events` 未处理事件、`playback-sync` 硬跳转、`Room` 播放器状态）。默认 devtools 不显示
    debug，问题不大；如果担心移动端日志开销，可改为受 `settings.debugLogging` 开关控制。

### Q3 测试与质量门禁（现状）

-   `yarn workspace ott-client run lint-ci`：退出 0（`tsc --noEmit` + ESLint，无输出）。
-   客户端测试：109 个文件通过 / 3 skip；1,264 项通过 / 24 skip（31.10 s）。
-   服务端测试：83 个文件；1,249 项通过（20.74 s）。
-   common：12 个文件；103 项通过。
-   Edge：31 项通过（21.34 s，`wrangler deploy --dry-run` + `node --test`）。
-   Rust：`cargo check --workspace` 通过；`cargo test --workspace` 先在 `harness` 包运行，8 项中
    5 项通过，`should_track_clients`、`should_track_rooms`、`should_reconnect_when_balancer_restarts`
    三项超过 3 分钟未结束，手动终止（退出码 1）。未观察到断言失败，但也没有完成，因此不把 Rust
    运行时测试计入本轮结论。
-   测试日志里有一条 jsdom 的 `HTMLCanvasElement.prototype.getContext` 未实现报错，来自
    `upscale-layer.component.spec.ts` 故意触发失败路径，不影响退出码。

测试覆盖不是本轮重点，但 UI 相关回归（`RoomInteraction`、`settings`、组件测试）比较完整；
`player-control-labels.component.spec.ts` 已经在检查播放器控件的可访问名，A1/A2 的修复可直接
在那里扩展。

---

## 七、建议的处理顺序

**第一批（低风险、明确缺陷，建议本周）**

1. 修 light / strawberry / mint 的对比度与 focus ring（D1），同步 `vuetify.ts`；加对比度 CI 脚本。
2. 音量静音改按钮 + 两个滑块补名称（A1），顺带补 component 测试。
3. 房间语音按钮补 `aria-label` + `aria-pressed`（A2）。
4. 登录/注册补 `autocomplete`（A7）；创建房间按钮改 `type="submit"`、错误改 `role="alert"`（A6）。
5. 房间列表接口只取 `prevQueue` 第一项（PF6 的 1），这是后端改动里收益最直接的一项。

**第二批（体验与可访问性）**

6. 聊天 live region（A4）、ClickToEdit 键盘（A3）、队列键盘排序（A5）、列表语义（A8）。
7. Account 错误态与重试（U3）。
8. 语言检测（U1）与首屏 `theme-color`（D2）；制定部分翻译补齐计划（U2）；浏览页前端过滤（U4）。

**第三批（性能与结构）**

9. Vue Query 移出启动 vendor（PF2）；lodash 改按需（PF3）；zh-CN 语言包改为动态加载（PF4）。
10. anime4k 启用时的准备状态与省流默认（PF5）。
11. `Room.vue` 拆分 composable（Q1）；主题单一真源（D4）；Roboto/全量 CSS 清理（PF9/PF10）。

**验收标准建议**

-   对比度：3 个浅色主题的所有正文/按钮/链接 ≥ 4.5:1，focus ring ≥ 3:1，CI 自动检查。
-   可访问性：对房间页、首页、登录/注册、创建房间跑 axe，`button-name`、`aria-input-field-name`、
    `aria-tooltip-name`、`color-contrast` 为 0；键盘可完成“跳转、静音、调整队列顺序”。
-   性能：首屏 `vendor` gzip ≤ 270 KB；`index` 首次加载不再同时请求 en 与 zh-CN（或明确预取）；
    `/api/room/list` 在 200 个满队列房间下响应体与 DB 读取量不随 `prevQueue` 长度线性增长。
-   回归：四套测试 + `cargo check` 保持全绿；新增修复各补 1–2 项测试。

---

## 八、运行验证与复现

| 命令 | 结果 |
| --- | --- |
| `yarn workspace ott-client run lint-ci` | 退出 0 |
| `yarn workspace ott-client run build` | 退出 0，23.10 s（本机有并发负载）；vendor CSS 148.1 KB / 20.5 KB gzip；Roboto 2 文件 25.4 KB |
| `yarn workspace ott-client run test` | 115 文件通过 / 3 skip；1,305 项通过 / 24 skip（本机同时有其它 Node 测试在跑，耗时约 231 s） |
| `yarn workspace ott-server run test` | 83 文件；1,249 项通过 |
| `yarn workspace ott-common run test` | 12 文件；103 项通过 |
| `yarn workspace ott-edge run test` | 31 项通过 |
| `cargo check --workspace` | 通过，14.95 s |
| `cargo test --workspace` | `harness` 包 5 项通过；3 项依赖真实进程的用例超过 3 分钟未结束，手动终止（退出 1），本轮不据此下结论 |

对比度复现：`client/src/styles/theme-palettes.json` 是唯一真源，
`node client/scripts/check-contrast.mjs --verbose` 会按 WCAG 相对亮度公式打印 10 套 × 13 对
`--primary-foreground/--primary`、`--signal/--background`、`--warning/--card` 等组合；
CI 中不带 `--verbose` 只打印汇总与失败行。

i18n 复现：去掉语言包顶部的 `ott-common` import，为 `BehaviorOption`/`OttWebsocketError`/`Role`
提供 Proxy 占位，按扁平键集合与 `en.ts` 求差集。

体积复现：构建后 `ls -l client/dist/assets`，gzip 用 `gzip -c <file> | wc -c`；lodash / Vue Query
的对比用 `node_modules/.bin/esbuild` 对最小入口独立打包。Vuetify 全量样式为
`node_modules/vuetify/dist/vuetify.css`（598,328 B / 73,703 B gzip）。

## 九、未验证与边界

-   没有在真实浏览器中运行 axe/Lighthouse，也没有在 390 px 手机、iPhone Safari、低端 Android、
    真实 GPU 上复核；D1 的色值替换需要在浅色主题下做一次人工视觉确认。
-   没有做网络限速下的首屏测量，`vendor`/chunk 体积不等于 LCP/TTI；Vue Query、lodash、语言包
    的优化收益按“下载与解析量”估算，实际指标需用 Lighthouse 或 WebPageTest 验证。
-   anime4k 的 GPU 管线编译时间、移动端发热与掉帧未测；只确认了资源体积与按需加载路径。
-   `prevQueue` 的实际 JSON 大小取决于视频元数据；本文按 200 项上限推断量级，未在生产数据上
    统计平均值。
-   没有执行生产攻击性负载、部署镜像、真实 OAuth/Discord 回调或第三方媒体端到端。
-   Rust harness 集成测试未跑完（3 项悬挂后手动终止），因此不对 balancer/collector 的运行时行为
    下新结论；编译结论只来自 `cargo check --workspace`。

## 十、修复落地记录

本文的 1–11 项已全部实现，落地在 `b1785fd` 之后的提交里；上面各节描述的是修复前的基线，数字不要混用。

| 项 | 落地内容 | 验证 |
| --- | --- | --- |
| D1 | 三套浅色主题换色（light `#a85800`/`#0b6f73`、strawberry `#c40047`/`#1c6f3e`、mint `#0a6f5f`/`#266d92`，warning 与 accent-foreground 统一 `#8a5000`）；D4 后色值只在 `theme-palettes.json` 维护 | `client/scripts/check-contrast.mjs` 进 lint-ci，10 套主题 130 对全过；最差 4.5193（light） |
| A1–A8 / U3 / U4 | 静音按钮、两个滑块、房间语音按钮拿到可访问名与 `aria-pressed`；ClickToEdit 可键盘激活；聊天用 `role="log"` 且浮层不播报；队列可菜单/Alt+↑↓ 重排并有列表语义；建房/登录表单修正 role 与 autocomplete；Account 失败态有 `role="alert"` 面板与重试；浏览页加搜索、排序、加载更多 | 上述键盘与读屏路径都有组件测试；client 全绿（最终 1,305 项通过） |
| U1 / U2 / D2 | 首次访问按 `navigator.languages` 选语言（`zh-*` 仍落 `zh-CN`），挂载前 await 语言包；`theme-color` 跟随主题；补 OG/Twitter 基础标签；5 个部分语言包各删 12 个过期键 | 内置 `detect-locale` 单测；`main.ts` 在 mount 前加载 |
| PF2 / PF3 / PF4 | vue-query 与 lodash 全部改为按需；入口 chunk 只保留 `en`，其余语言按需加载 | vendor **872 KB → 796 KB（289 → 264 KB gzip）**；`index.html` 不再 preload `zh-CN` |
| PF5 / PF8 | AI 超分准备态提示（300 ms 后才出现，不假造百分比）、save-data 默认降级；PeerTube 卸载时移除监听并 `destroy()` | 新增组件测试；失败回退路径未改 |
| PF6 | 列表查询只取 `prevQueue[0]`（sqlite/mysql `json_extract`，pg `->0`，未知方言回退），加 `limit`/`offset` 与 5 s 缓存，保留密码房脱敏 | 服务端 1267 项测试通过（含新增 18 项） |

遗留的 Q1 / D4 / PF9 / PF10 也已落地，和上面的修复分开成两组提交：

| 项 | 落地内容 | 验证 |
| --- | --- | --- |
| Q1 | 拆出 `room-fullscreen`（46 行）、`room-clock`（65 行）、`room-notices`（96 行）、`room-gestures`（198 行）四个 composable；`Room.vue` 3,333 → 3,179 行；`timestampUpdate` 统一走 `clock.tick()`，`getServerClockOffsetMs()` 在读数前执行；亮度只有一份 `usePlayerBrightness()` | 新增 14 项 fake-timer 单测；`RoomInteraction`/`RoomLifecycle`/`player-gestures`/`player-fullscreen` 83 项通过；tsc/eslint/prettier 全绿 |
| D4 | `theme-palettes.json` 成为唯一真源；`vuetify.ts` 直接构造 10 套 `ThemeDefinition`；`generate-theme-css.mjs` 生成 `_theme-vars.generated.scss`（`cinema.scss` 用 `@use`），`lint-ci` 跑 `--check`；对比度脚本改为读同一份 JSON，默认只打印汇总 | 10 套主题、130 对对比度全过；生成文件与 JSON 同步检查通过 |
| PF9 | 删除 Roboto italic/500/700 六份 `@font-face` 与六个 woff2，只保留 400 latin + cyrillic | `dist` 中 Roboto 8 文件 104.3 KB → 2 文件 25.4 KB；构建通过 |
| PF10 | 复核确认 `vite-plugin-vuetify` 已按组件注入 CSS；保留共享 base 层，不改入口；新增 `check-bundle-css.mjs` 并挂到 `build`，断言 vendor CSS ≤ 170 KB / 24 KB gzip 且不出现未使用组件/utilities | vendor CSS 148.1 KB / 20.5 KB gzip（全量 598.3 KB / 73.7 KB gzip），无 `.v-data-table`/`.v-color-picker`/`.bg-red`；build 退出 0 |

顺带修掉的两个测试稳定性问题：`RoomDisconnected` 不再为了一个 `:roomId` 参数 lazy-load 整个
`Room.vue`（改用 stub route，单测 5.2 s → 0.09 s）；`EdgePreview` 的授权编辑用例在慢机器上
5 s 预算不够，显式放宽到 20 s。

顺带修掉的三个小问题：`client/src/plugins/vuetify.ts` 里 `VueQueryPlugin` 注册已随 PF2 移除；
`client/tests/setup.ts` 固定测试语言，使语言检测不影响既有断言；新代码全部过了根目录 `lint-ci`
（biome ci + prettier + 各 workspace tsc/eslint）与 `typos`。
