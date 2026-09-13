# 房间语音：P2P mesh 与中继成本刹车

本文件记录房间语音的实现：它如何工作、如何在服务端限制费用、如何验证，以及尚未完成的
部分。该实现随 `v0.15.0-cn18` 上线（与房间便签同批），默认开启入口；本部署未配置
TURN，因此当前为「仅直连」。

## 目标与明确不做的

目标：2–6 人在同一房间同步看片时能说话，且**服务端不承载媒体字节**。

不做的事项与理由：

- **不做屏幕捕获 / 转码转发**。重转发媒体的一律死掉或被征税（Groovy、Rythm 被连续 C&D），
  微光的投屏 + 分享模式在 2025 年二审被判赔 200 万元。
- **不做录制**。
- **不做自建 SFU / TURN**。本项目唯一入口是 Cloudflare Tunnel（HTTP / WebSocket / TCP），
  而 WebRTC 媒体是 SRTP/UDP，隧道载不了；自建需要对公网开放 `7881/TCP` 与
  `50000-60000/UDP`（LiveKit 默认），等于把已经收敛的源站入口重新打开，并让腾讯云按
  Mbps 持续计费。托管中继不改变入口拓扑。

## 架构

**媒体面**：客户端之间构建 mesh 直连；直连被 NAT 挡住时才经托管 TURN 中继。
服务器只做信令中继，**从不接触媒体**——这与现有「只同步指针、不转发媒体」的架构一致。

**控制面**：复用现有原生 `ws`（`server/websockets.ts` + `server/clientmanager.ts`）。
`server/client.ts` 的 `Client.send()` 已支持向单个客户端单播，因此定向中继无需改造广播层。

**延迟预期**：P2P 直连约 50–150 ms；经 TURN 中继约 150–300 ms。

## 协议

新增两类消息，定义在 `common/models/messages.ts`，服务端 Zod 校验在 `server/ws-schemas.ts`。

| 消息 | 方向 | 字段 |
| --- | --- | --- |
| `voice` | 服务端 → 客户端 | `participants: ClientId[]`、`iceServers: RtcIceServer[]`、`relay: boolean`、`denied?: VoiceDeniedReason` |
| `signal` | 服务端 → 客户端 | `from: ClientId`、`signal: VoiceSignalPayload` |
| `voice` | 客户端 → 服务端 | `joined: boolean` |
| `signal` | 客户端 → 服务端 | `to: ClientId`、`signal: VoiceSignalPayload` |

- `VoiceSignalPayload` 为 `offer` / `answer` / `candidate` 的判别联合；candidate 字段镜像
  `RTCIceCandidateInit`，避免共享代码依赖 DOM 类型。
- `VoiceDeniedReason` 为 `disabled` / `room-full` / `too-many-rooms` / `budget`。
- **服务端是名单的权威来源**：`participants` 不包含自己即表示未加入，客户端据此回滚本地状态，
  不依赖任何乐观更新。
- ICE 服务器**由服务端下发**，TURN 凭据因此不会进入前端产物。

## 服务端实现

| 文件 | 职责 |
| --- | --- |
| `server/voice.ts` | 能力开关；拆分直连（STUN）与中继（TURN）ICE 列表；`getVoiceIceServers(includeRelay)` |
| `server/voice-budget.ts` | 用量记账、预算判定、拒绝原因、对账快照 |
| `server/clientmanager.ts` | 房间级语音名单；信令定向中继；准入判定；断线/卸载清理；用量累计定时器 |
| `server/api/status.ts` | `GET /api/status/voice` 对账出口（本机或 apikey） |
| `server/security-headers.ts` | `Permissions-Policy` 放开 `microphone=(self)` |

信令中继只允许在**同一房间且双方都在语音中**的客户端之间转发，所以它不能当作任意消息总线
使用；SDP 与 candidate 都有长度上限，`ws` 的 `maxPayload` 仍是 256 KB。

## 客户端实现

`client/src/util/voice.ts` 的 `useVoice()`，在 `client/src/views/Room.vue` 中接入。

- `getUserMedia`：开启回声消除、降噪、自动增益（3A）。
- mesh：**clientId 较小的一方发起 offer**，确定性规则，避免双方同时 offer。
- ICE candidate 在远端描述之前到达时先入队，`setRemoteDescription` 之后再补入。
- 远端音频挂在带 `data-ott-voice` 标记的 `<audio>` 元素上。
- 说话探测：`AnalyserNode` 轮询本地麦克风的 RMS。
- **闪避**：本地说话时把除语音元素外的媒体音量降到 40%（约 −8 dB），说完恢复。

## 成本刹车

Cloudflare 不提供硬性费用上限，账单告警发生在上量之后。因此刹车必须自己造。
这套实现把它分成三层。

### 1. 准入闸（精确、即时）

`decideVoiceJoin()` 在加入时判定：单房人数上限、并发语音房间数上限、以及预算硬阈值。
拒绝时向**请求方单发**一条带 `denied` 的 `voice` 消息。因为准入只有服务端控制，
这一层不依赖任何估算。

### 2. 降级而不是关闭

预算触及软阈值后，服务端**不再下发 TURN 服务器**（`relay: false`），文字界面显示「仅直连」。
直连免费，因此成本立刻停止增长，而能打通的用户继续说。这比一刀切关掉语音体验更好。

### 3. 对账

`GET /api/status/voice` 返回本地估算用量、软/硬预算与按 $0.05/GB 折算的费用估算。
它是**估算而非账单**，用于和 Cloudflare 后台比对，并据此调整预算。

### 记账单位与保守假设

用量按**估算的中继字节数**累计，这正是 Cloudflare 的计费维度，因此预算单位与账单一一对应。

- 每个房间携带 `N × (N − 1)` 条单向音频流（全 mesh）。
- 估算**假设全部流量都走中继**，而直连实际免费，所以估算偏保守：刹车会在真实账单之前触发。
- 累计只在**中继确实在下发**时进行；一旦降级，计数冻结，避免估算继续上涨后无意义地拒绝加入。

### 失败即关闭

读不到用量（例如 Redis 异常）时**停发中继**而不是视为无限额度。这一层的存在意义就是阻止
失控的中继费用，不确定的读数不应继续下发要花钱的候选地址；直连不受影响。

## 配置

全部位于 `voice` 段，环境变量前缀 `VOICE_`。

| 配置项 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `ENABLE_VOICE_CHAT` | `false` | 语音总开关 |
| `ice_servers` | `VOICE_ICE_SERVERS` | 空（内置公共 STUN） | 直连用 ICE 服务器，永不中继、不产生费用 |
| `turn_ice_servers` | `VOICE_TURN_ICE_SERVERS` | 空 | 中继服务器；预算耗尽后不再下发。留空则完全不提供中继 |
| `max_participants_per_room` | `VOICE_MAX_PARTICIPANTS_PER_ROOM` | `6` | 单房语音人数上限，`0` 不限 |
| `max_concurrent_rooms` | `VOICE_MAX_CONCURRENT_ROOMS` | `0` | 同时语音的房间数上限，`0` 不限 |
| `monthly_relay_mb` | `VOICE_MONTHLY_RELAY_MB` | `500000` | **主刹车**：月度中继预算（500 GB = Cloudflare 1 TB 共享免费额度的一半）。超过即停发中继 |
| `monthly_relay_mb_max` | `VOICE_MONTHLY_RELAY_MB_MAX` | `0` | 可选硬阈值：超过直接拒绝加入，而不是降级。默认关闭 |
| `audio_bitrate_kbps` | `VOICE_AUDIO_BITRATE_KBPS` | `40` | 仅用于估算的单流码率 |
| `usage_tick_seconds` | `VOICE_USAGE_TICK_SECONDS` | `15` | 用量累计周期 |

注意：配置系统只支持非负整数，所以预算以 MB 表示（`1 MB = 1e6` 字节），与内部字节记账单位对齐。

### 国内部署建议（STUN）

默认的内置 STUN 是 Google / Cloudflare，境内可达性不稳定；把发现的服务器换成国内节点能明显提高
「拿到公网映射、直连成功」的比例，且**不产生任何费用**。线上实测（2026-09-13，本地与腾讯云各测一次）：

| STUN | 结果 |
| --- | --- |
| `stun:stun.miwifi.com:3478` | 可用 |
| `stun:stun.chat.bilibili.com:3478` | 可用 |
| `stun:stun.hitv.com:3478` | 可用 |
| `stun:stun.qq.com:3478` | **已失效**（两处均超时） |
| `stun:stun.cloudflare.com:3478` | 可用（兜底） |

部署时在 compose override 里设置（数组形式会并发探测，单个失效不影响）：

```yaml
services:
  ott:
    environment:
      VOICE_ICE_SERVERS: '[{"urls":["stun:stun.miwifi.com:3478","stun:stun.chat.bilibili.com:3478","stun:stun.hitv.com:3478","stun:stun.cloudflare.com:3478"]}]'
```

这些公共 STUN 免费但**没有 SLA**（可能限速、丢包甚至停服，`stun.qq.com` 就是例子），只负责映射发现、
不中转流量。改完重启应用容器即可生效，无需重新构建镜像。

## 资源与费用

以 6 人房间、每路音频 40 kbps 估算。

| 资源 | 消耗 |
| --- | --- |
| 应用服务器 CPU | 可忽略（只转发信令） |
| 应用服务器带宽 | 约为 0（媒体不经服务器） |
| 服务端内存 | 每房间一个 `Set<clientId>`，字节级 |
| Redis / 数据库 | 新增一个月度计数器键 |
| 入口端口 | **无改动** |
| 每客户端上下行 | 各约 200 kbps（5 路 × 40 kbps） |
| 每客户端 CPU | Opus 编解码 5 路 + 3A；低端安卓 6 人时注意发热 |

中继流量换算（最坏情况，全部走中继）：

```text
GB/小时 = N × (N − 1) × 码率(kbps) × 3600 ÷ 8 ÷ 1e9
6 人：30 × 40 × 3600 ÷ 8 ÷ 1e9 ≈ 0.54 GB/小时
```

- 一个 6 人房间 3 小时 ≈ **1.62 GB**，约合 **$0.081**
- 折算约 **0.09 GB / 人·小时**，即约 **$0.0045 / 人·小时**
- 默认 500 GB 预算 ≈ **5,500 人·小时**；Cloudflare 免费 1 TB ≈ 11,000 人·小时

Cloudflare Realtime 的计费事实：SFU 与 TURN 均为 **$0.05/GB 出向流量**，免费额度为
**1,000 GB 且两者共用一个池子**（不是各自 1 TB）；账单是一条合并项；SFU 只对
Cloudflare→客户端方向计费，推上去的流量免费；TURN 与 SFU 之间的流量不重复计费。
**超出免费额度是直接计费，不会停止服务**——这是本文件要解决的问题。

## 本地验证

```sh
# 依赖
docker run -d --rm -p 6379:6379 redis:7-alpine
docker run -d --rm -p 5432:5432 -e POSTGRES_USER=opentogethertube \
  -e POSTGRES_DB=opentogethertube -e POSTGRES_PASSWORD=postgres postgres:15-bullseye

ENABLE_VOICE_CHAT=true yarn dev

# 另一个终端：查看用量、预算与费用估算
curl -s localhost:8080/api/status/voice | jq
```

开两个浏览器进同一房间，点播放器左下角的麦克风按钮。**必须使用 `localhost`**：
`getUserMedia` 只在安全上下文可用，经局域网 IP 走 http 会被浏览器拒绝。

自动检查：

```sh
cd server && NODE_ENV=test npx vitest run tests/unit/voice.spec.ts tests/unit/voice-budget.spec.ts
```

覆盖：ICE 配置解析与降级、用量换算、软/硬预算与容量拒绝、无中继配置、读失败时关闭、
对账快照字段。

## 已知短板

- **未对接 Cloudflare TURN 凭据 API**。本实现的刹车是「不下发中继服务器」，在服务端签发
  ICE 列表这一步生效，不依赖外部 API。Cloudflare 支持带 TTL 的短期凭据与凭据吊销，
  可作为第二层保险（例如会话中途强制切断），但需要 TURN key 才能实机验证，因此未实现。
- **真实音频通路未验证**。本环境无法完成双端实测；AEC 行为需要用真机确认——媒体经由
  WebAudio 增强路径与经由 `<video>` 元素时的回声消除表现不同。
- **闪避是 DOM 级的**：直接改 `video` / `audio` 的 `volume`，会与播放器自身的音量控制冲突，
  上线前需要迁入 player store。
- **语音名单是进程内存态**，未走 Redis 或 balancer 同步；单实例可用，接负载均衡会失效。
- **mesh 仅适合 2–6 人音频**；更大规模需要 SFU，而那会改变入口拓扑。
- **前端界面只在播放器左下角提供开关**，没有单人音量、单独静音或他人说话指示。
- **估算不是账单**：`/api/status/voice` 的数字用于对账，不能替代 Cloudflare 后台。
- 未考虑中国大陆网络：内置 STUN 在大陆不可达，Cloudflare 无大陆节点。面向大陆用户时应
  直接评估腾讯 TRTC / Agora 一类有大陆节点的 RTC 服务。

## 与部署的关系

本次改动**没有触碰线上服务**，也没有改变任何入口：没有新增公网端口、没有新增常驻服务、
没有修改 Cloudflare Tunnel 配置。开启语音只需要设置 `ENABLE_VOICE_CHAT` 与
`VOICE_TURN_ICE_SERVERS` 两个环境变量并重建应用容器。
