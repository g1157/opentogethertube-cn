# 房间语音稳定化路线调查（2026-11-05）

本文回答一个问题：**在当前的「P2P mesh + 仅 STUN」之外，有没有更稳定的语音方式，代价是什么。**
先给结论，再给证据与测算。文中的价格、端口与区域限制均来自 2026-11 可查的官方文档；成本与
失败率是按本项目 6 人、3 小时、每路 40 kbps 的假设推算，属于估算而非账单。

## 结论

1. **当前不稳定的根因不是客户端少了重连，而是没有中继。** 本部署没有配置 TURN，直连被
   对称 NAT、运营商 CGNAT 或 UDP 封锁挡住时，媒体根本无法建立。8%–20% 的消费级连接需要
   TURN；mesh 的每一对 peer 都是一次独立尝试，6 人房有 15 对，按独立估算 **71%–96% 的房间
   至少有一对连不上**。这解释了「没有任何提示」的体感：以前失败是静默的。
2. **性价比最高的第一步：接 Cloudflare Realtime TURN，保留 mesh。** TURN over TLS 443 不需要
   源站开放任何端口，Cloudflare 边缘直接中转；$0.05/GB，每月 1 TB 与 SFU 共享免费额度。
   6 人 3 小时全中继约 1.62 GB，约 **$0.08**，远低于任何按分钟计费的 RTC。
3. **大陆网络要真正稳定，Cloudflare TURN 不是终点。** 官方明确：TURN 流量从中国大陆会连到
   境外 Cloudflare 节点（China Network 不参与 Realtime）。要低延迟与低丢包，二选一：
   在腾讯云自建 coturn（需开放 UDP/TCP 端口，约 **1.3 元/6 人·3 小时** 流量费），或直接用
   腾讯云 TRTC（无需端口，约 **7.56 元/6 人·3 小时**，含 3A/AEC 与弱网优化）。
4. **人数上去后 mesh 的上行与 CPU 会成为新瓶颈。** 6 人时每台设备要编 5 路、收 5 路；SFU 把
   上行降到 1 路，服务端承担分发。Cloudflare Realtime SFU 的成本与 TURN 同一量级；自建
   LiveKit 需要开放 7881/TCP 与 50000–60000/UDP，和当前「只开 443」的入口姿态冲突。
5. **推荐顺序**：先接 Cloudflare TURN + 已有的状态/重连 → 用遥测跑 2–4 周 → 若大陆用户占比高
   且延迟不可接受，再选自建 coturn 或 TRTC → 房间变大再上 SFU。不要先写 WebSocket 语音中继：
   它只能解决「连得上」，解决不了延迟、抖动和回声，还要自己实现 jitter buffer。

## 一、当前实现的实际瓶颈

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 服务端只下发 STUN，未配置 TURN | `docs/voice.zh-CN.md` 配置表；`server/voice.ts` | 对称 NAT / CGNAT 下的 peer 永远连不上 |
| mesh 全互联，每对 peer 一条连接 | `client/src/util/voice.ts` | 6 人 15 对，任一对失败即有一路没声音 |
| 失败以前只 `closePeer`，无 UI | 修复前 `voice.ts` 的 `onconnectionstatechange` | 用户只看到「加入成功」但没有声音 |
| 语音名单是进程内存态 | `server/clientmanager.ts` | 接 balancer 后跨实例看不到彼此 |
| 手机外放 AEC 余量有限 | 浏览器/设备 DSP | 高音量下残余回声在 mesh 中来回叠加 |

本次已修的部分：逐 peer 状态（直连/中继/已连接/连接中/失败）、10 秒超时、有界重连、外放
回声抑制、可折叠控制条。它们解决「看得见」和「回环」，但不解决「没有中继」。

## 二、为什么直连会失败

- **对称 NAT**：STUN 只能发现映射地址，不能预测端口；对端无法向该映射发包，必须 TURN。
- **运营商 CGNAT**：大量移动网络共享公网地址，入向连接基本不可达。
- **UDP 封锁**：企业/校园/部分酒店网络只放行 TCP 443；WebRTC 需要 TURN over TCP/TLS 443。
- **mesh 放大效应**：单对连接需要 TURN 的概率是 p，6 人房 15 对全部直连的概率是 `(1-p)^15`。
  按消费级 p=8%–20% 估算，至少一对需要中继的房间占 **71%–96%**（假设各对独立，实际因同网络
  相关，但方向不变）。

参考：行业数据普遍给出消费级 8%–20%、企业 60%–70% 的连接需要 TURN；这不是本项目的实测值，
接入后应以上报的 relay ratio 为准。

## 三、方案对比

以「6 人、3 小时、每路 40 kbps、全中继」为统一测算口径；实际只有部分 peer 走中继。

| 方案 | 连通性 | 大陆体验 | 源站端口 | 6 人·3h 成本（估算） | 改动量 | 适合 |
| --- | --- | --- | --- | --- | --- | --- |
| 现状：STUN only | 仅直连，NAT 后失败 | 取决于 STUN/网络 | 无 | 0 | 已上线 | 2 人同网、临时 |
| **Cloudflare TURN** | 好；UDP/TCP/TLS 443 | 出境到境外节点，延迟/抖动不确定 | **无需** | **约 $0.08**（1 TB 内免费） | 小：服务端签发短期凭据 | 先修连通性 |
| 自建 coturn（腾讯云） | 好；可 TLS 443 | **本地转发，最低延迟** | 需开 3478/UDP、5349 或 443/TCP、relay 端口段 | **约 1.3 元** + CVM 带宽 | 中：部署、证书、配额、防滥用 | 大陆长期 |
| Cloudflare SFU | 好；组网更稳 | 同上，出境 | 无需 | 约 $0.08 起 + 集成 | 中：接 SFU SDK | 4 人以上 |
| 自建 LiveKit SFU | 好 | 本地转发 | 7880/WS（可走隧道）、7881/TCP、50000–60000/UDP、3478/UDP、5349/TCP | 服务器流量，约 1.3 元 + 运维 | 大 | 需要完全自控 |
| 腾讯云 TRTC | 很好；弱网优化 | **大陆节点** | 无 | **约 7.56 元** | 中：换 SDK/信令 | 大陆优先、省运维 |
| Agora | 很好 | 大陆有节点（Shengwang） | 无 | 约 $1.07 | 中 | 同上 |
| LiveKit Cloud | 很好 | 大陆节点未验证 | 无 | 约 $1.08 | 中 | 海外优先 |
| WebSocket 音频中继 | 好（走现有 WS） | 取决于隧道 | 无 | 约 1.3 元流量 + 服务器 CPU | 大：编码、抖动缓冲 | 最后手段 |

### 成本口径

- **mesh 全中继流量**：`N×(N−1)×40 kbps×3h` = 30×54 MB = **1.62 GB**。
- Cloudflare：$0.05/GB × 1.62 = **$0.081**；1 TB 免费额度约等于 **617 个这样的房间**。
- 腾讯云按流量：0.80 元/GB × 1.62 = **1.30 元**（不含 CVM/带宽包）。
- TRTC 音频：7.00 元/千分钟 ×（6×180 分钟）= **7.56 元**；套餐折算约 5.68 元/千分钟 → 6.13 元。
- Agora 音频：$0.99/千分钟 × 1,080 = **$1.07**。
- LiveKit Cloud：$0.0005/连接分钟 + 流量；按其估算 $0.001/分钟 → **$1.08**。

结论：**按流量计费的 TURN 比按人·分钟计费的 RTC 便宜一个数量级**，前提是能接受它的网络路径。
RTC 的钱买的是大陆节点、3A/AEC、弱网对抗和运维省心，不是带宽本身。

## 四、各方案落地要点

### 1. Cloudflare Realtime TURN（推荐第一步）

- 地址与端口：`turn.cloudflare.com`，UDP 3478/443、TCP 3478/80、TLS 5349/443；STUN 免费。
- 计费：$0.05/GB 出向，1 TB/月与 SFU 共享；只对 Cloudflare→TURN 客户端方向计费。
- 凭据：服务端调用 Cloudflare 的短期凭据接口，最长 48 小时；`iceServers` 里同时给
  `turn:…?transport=udp`、`turn:…?transport=tcp`、`turns:…?transport=tcp`，让浏览器按网络挑。
- 大陆：官方 FAQ 明确 China Network 不参与 Realtime，TURN 从大陆会连到境外节点。作为「先能通」
  可以，作为「大陆低延迟」不够。
- 代码改动：`server/voice.ts` 的 `getRelayIceServers()` 从静态配置改为「取缓存/签发凭据」；
  `client/src/util/voice.ts` 不需要改。现有的月度预算刹车可以原样保留，超额就不下发 TURN。
- 现成捷径：如果先用自建 coturn 的长效凭据，直接填 `VOICE_TURN_ICE_SERVERS` 环境变量即可，
  连服务端代码都不用改；Cloudflare 因为凭据有 TTL，才需要签发接口。

### 2. 自建 coturn（大陆长期方案）

- 端口：3478/UDP+TCP（TURN/STUN）、5349/TCP（TURN/TLS）、49152–65535/UDP（relay，可收窄）；
  若想用 443/TCP，需要独立公网 IP 或在前置做 SNI 分流，不能和现有 HTTPS 抢同一监听。
- 带宽：按上面的口径，6 人房 3 小时约 1.3 元；真正成本是 CVM/带宽包和运维。
- 风险：开放 UDP 端口与 relay 端口段，等于重新打开源站入口；必须配长效凭据/TLS、配额与
  滥用监控，否则会被当作开放中继。Cloudflare Tunnel 不支持 UDP，也不能用 `cloudflared`
  把 coturn 的媒体面转出去（`cloudflared` 的 TCP 服务还需要客户端装 cloudflared）。
- 适合：用户主要在中国大陆、能接受「多开一个 UDP 入口」、希望成本随流量而非人数增长。

### 3. SFU（人数上去之后）

- **Cloudflare Realtime SFU**：与 TURN 同一套边缘和计费，$0.05/GB、1 TB 免费；每端只上行 1 路，
  服务端分发；不需要源站端口。适合 4 人以上或手机上行吃紧。大陆同样出境。
- **自建 LiveKit**：7880/WebSocket（可放隧道后面）、7881/TCP、50000–60000/UDP、3478/UDP、
  5349/TCP；官方明确这些端口要对外。适合要完全自控、且愿意维护媒体服务器。
- **LiveKit Cloud**：Build 免费含 5,000 WebRTC 分钟、100 并发；Ship $50/月含 150,000 分钟，
  超出 $0.0005/分钟。大陆节点未在公开文档中承诺，需实测。
- SFU 不会降低总出口流量（仍是 N×(N−1) 路），但把客户端上行从 N−1 路降到 1 路，显著降低
  手机发热、卡顿和「一个人网络差拖垮全房」的概率。

### 4. 托管 RTC（TRTC / Agora）

- **TRTC 音频**：7.00 元/千分钟（套餐约 5.68），按房间内每人在房时长计费；3A、弱网优化、
  大陆节点、Web/iOS/Android SDK 齐全。6 人 3 小时约 7.56 元，是 Cloudflare TURN 的约 90 倍，
  但省掉端口、TURN、NAT、回声调优和运维。
- **Agora**：$0.99/千音频分钟，自动/强制 UDP/强制 TCP 443 三种模式；Cloud Proxy 有最低月费，
  大陆走声网节点。适合海外或已有 Agora 账号的团队。
- 代价：信令/房间模型要接 SDK，供应商锁定；媒体经过第三方（WebRTC 端到端加密仍在，但元数据
  与路由由供应商掌握）。

### 5. WebSocket 音频中继（不建议作为主方案）

- 优点：复用现有 WebSocket 与 Cloudflare Tunnel，不需要 UDP/TURN，连通性最好。
- 缺点：TCP 队头阻塞、没有浏览器原生 jitter buffer、要自己做 Opus 编解码与播放调度；延迟通常
  比 WebRTC 高一个档，弱网下更容易累积延迟。6 人房服务端要转发 30 路、约 1.2 Mbps 持续出口，
  还要为每路维护缓冲。
- 如果只是「必须穿过隧道、且能接受 300–500 ms」，它可以作为降级通道；不值得作为默认语音。

## 五、回声与移动端稳定性

- 浏览器 AEC（AEC3）需要「远端参考信号」与「近端麦克风信号」对齐；外放音量越大、设备共振
  越强，残余回声越多。mesh 中每一路远端音频都是独立参考，手机 DSP 不一定能全部消掉。
- 本次加入的**半双工回声抑制**在检测到任一路远端有声时把本地麦克风置为静音，350 ms 后恢复；
  它能把「无限回声」变成「对方说话时我暂时不出声」，代价是快速插话会被截断。默认触屏开启、
  桌面关闭，可手动切换。
- 更稳的做法（按性价比排序）：
  1. **耳机提示/一键切换**：外放是回声的根因，耳机是最可靠的解法。
  2. **按住说话（PTT）**：在嘈杂环境或外放场景，PTT 比半双工更可控，也不会误压整段对话。
  3. **托管 RTC**：TRTC/Agora 在移动端通常使用系统 voice processing（iOS AVAudioSession
     voiceChat、Android AEC），路由与 3A 更完整；这是除了大陆节点之外的第二个理由。
  4. **输出设备选择**：支持 `setSinkId` 的浏览器可选扬声器/耳机；iOS 能力有限，别把它当唯一解。
- 编解码侧还可以做：Opus 单声道、`useinbandfec=1`、`usedtx=1`、`maxaveragebitrate≈32–48 kbps`、
  `ptime=20`，降低弱网下的断续；这些不解决回声，但能减少「听起来卡」。

## 六、推荐落地路径

### 第 1 步：Cloudflare TURN（先让失败的人能通）

- 服务端增加短期 TURN 凭据签发与缓存；`voice` 消息按现有预算开关决定是否下发。
- 客户端 `iceServers` 同时包含 UDP/TCP/TLS 三种 TURN URL。
- 验收：在「手机 4G + 家里 Wi-Fi + 公司/校园网」三组网络下，2/4/6 人房各测 10 次；
  连接成功率 ≥95%，5 秒内出首帧音频 ≥90%，relay ratio 与失败原因上报。
- 预期：NAT 失败基本消失；大陆延迟取决于出境线路，可能 100–300 ms，需实测。

### 第 2 步：按遥测决定是否上大陆本地中继

- 若大陆用户占比高、且 TURN RTT/丢包不可接受：
  - 能接受开端口 → 腾讯云自建 coturn（TURN/TLS 443 + UDP 3478 + 收窄 relay 段）。
  - 不想开端口/不想运维 → TRTC（7.56 元/6 人·3 小时）。
- 验收：同城/跨省/跨运营商三组，mouth-to-ear <300 ms，连续 30 分钟无重连；回声在最大外放
  音量下无可闻回环（回声抑制开启）。

### 第 3 步：SFU（人数或上行成为瓶颈时）

- 触发条件：4 人以上房间占比升高、手机发热/卡顿上报增多、或 relay ratio 高导致成本上升。
- 优先 Cloudflare Realtime SFU（与 TURN 同计费、无端口）；要大陆本地则自建 LiveKit 或 TRTC。
- 验收：6 人房每端上行 ≤1 路、客户端 CPU 明显下降、房间内任一人弱网不再拖垮其他人。

## 七、需要补的遥测（决定下一步的关键）

不采集音频内容，只采集连接元数据：

- 每 peer：`connectionState` 首次 connected 耗时、最终路径（direct/relay）、失败原因、重连次数。
- 每次加入：参与人数、iceServers 是否含 TURN、relay 预算是否触发。
- 质量：RTT、jitter、packet loss（`getStats()` 的 candidate-pair / inbound-rtp）、回声抑制触发时长。
- 聚合到服务端（按房间/地区/运营商匿名统计），用于回答「TURN 够不够」「要不要自建」。

## 八、已验证与推断

**已验证（官方文档）**：Cloudflare TURN 的端口、$0.05/GB、1 TB 共享免费、China Network 不参与
Realtime、凭据最长 48 小时、TURN over TLS 443；Cloudflare Tunnel 只列 HTTP/HTTPS/TCP/SSH 等，
没有 UDP；LiveKit 的端口清单；TRTC 音频 7 元/千分钟与纯音频计费示例；腾讯云大陆按流量
0.80 元/GB；Agora 音频 $0.99/千分钟；LiveKit Cloud 的 WebRTC 分钟价格。

**推断（需实测）**：6 人 3 小时 1.62 GB 的流量、各方案的人民币/美元成本、mesh 房间失败率
71%–96%、Cloudflare TURN 在大陆的实际 RTT/丢包、TRTC 在该房间规模下的真实账单、半双工回声
抑制对插话的影响。接入后以遥测与真实账单为准。

## 参考

- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
- [Cloudflare Realtime TURN FAQ（区域、计费、凭据、ICE restart）](https://developers.cloudflare.com/realtime/turn/faq/)
- [Cloudflare Realtime 定价](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
- [Cloudflare Tunnel 支持的应用协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)
- [LiveKit 自托管端口与防火墙](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit Cloud 定价](https://livekit.com/pricing)
- [腾讯云 TRTC 计费概述](https://cloud.tencent.com/document/product/647/17157)
- [腾讯云 TRTC 音视频时长计费说明](https://cloud.tencent.com/document/product/647/44248)
- [腾讯云公网网络费用（按流量 0.80 元/GB）](https://cloud.tencent.com/document/product/213/113026)
- [Agora Voice Calling 定价](https://www.agora.io/en/pricing/voice-calling/)
- [WebRTC TURN 真实需求比例（VideoSDK）](https://www.videosdk.live/developer-hub/webrtc/turn-server-for-webrtc)
- [WebRTC ICE/TURN 规模化问题（CallSphere）](https://callsphere.ai/blog/vw1e-webrtc-ice-turn-gotchas-scale)
