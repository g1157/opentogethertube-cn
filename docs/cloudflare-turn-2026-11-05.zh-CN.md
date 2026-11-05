# Cloudflare Realtime TURN 资源与接入评估（2026-11-05）

本文回答「启用 Cloudflare 中继需要多少资源、怎么接、花多少钱」。价格与限制来自 Cloudflare
官方文档（2026-11 可查）；成本按本项目 6 人、3 小时、每路 40 kbps 的口径估算，是估算而非账单。

## 结论

- **Cloudflare 侧只需要两样东西**：一个 **TURN Key ID** 和一个 **TURN Key API Token**。
  不需要 Workers、Durable Objects、D1、R2、Queues，也不需要新域名、Tunnel 或源站端口。
- **费用**：TURN 出向 $0.05/GB，每月 **1 TB 与 SFU 共享免费额度**；STUN 免费。当前项目的
  500 GB 月度刹车在免费额度以内，不会产生账单；想充分利用免费额度可提高到 900 GB。
- **服务器资源**：几乎为零。应用服务器只多一次出站 HTTPS 调用（生成短期凭据）和一小块
  内存缓存；媒体不经过源站，CPU/内存/带宽都不增加。
- **客户端**：不需要改代码，现有 `iceServers` 下发机制直接可用。
- **大陆网络**：Cloudflare 的 China Network 不参与 Realtime，TURN 流量会出境到境外节点；
  能连通但延迟/丢包需实测。要大陆低延迟，仍应评估自建 coturn 或腾讯云 TRTC。

## 一、Cloudflare 侧资源清单

| 资源 | 是否必需 | 说明 |
| --- | --- | --- |
| Cloudflare 账号 | 是 | 免费账号即可开始；Realtime TURN 按量计费 |
| TURN Key | 是 | 控制台或 API 创建；长期密钥，只放服务端 |
| TURN Key API Token | 是 | 创建 Key 时生成，用于签发短期凭据；只放服务端 |
| Workers / Durable Objects / D1 / R2 / Queues | 否 | TURN 不需要任何计算或存储产品 |
| 源站公网端口 | 否 | TURN 走 `turn.cloudflare.com`，与源站入口无关 |
| 域名 / Tunnel | 否 | 不改变现有 Cloudflare Tunnel 或裸 IP 入口 |
| 监控 | 建议 | Cloudflare Realtime 分析（约 30 秒延迟）+ `/api/status/voice` |

### TURN 地址与端口

| 协议 | 地址 | 端口 |
| --- | --- | --- |
| STUN/UDP | `stun.cloudflare.com` | 3478 |
| TURN/UDP | `turn.cloudflare.com` | 3478、443 |
| TURN/TCP | `turn.cloudflare.com` | 3478、80 |
| TURN/TLS | `turn.cloudflare.com` | 5349、443 |

- TURN/TLS 443 是穿透只放行 HTTPS 的网络的关键；UDP 被封锁时浏览器会回退到 TCP/TLS。
- 官方提示端口 53 会被浏览器拦截；如果响应里出现，服务端可以过滤掉。客户端已启用 trickle
  ICE，单个候选超时不会阻塞整条连接。

## 二、凭据怎么生成

TURN Key 本身不能直接作为 `username` / `credential` 使用，必须由后端签发带 TTL 的短期凭据：

```bash
curl -X POST \
  "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers" \
  -H "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ttl": 86400}'
```

返回的 `iceServers` 包含 STUN 和 6 个 TURN URL（UDP 3478/443、TCP 3478/80、TLS 5349/443）
以及本次生成的 `username` / `credential`。TTL 最长 **48 小时**；到期后凭据失效，连接会在短暂
延迟后断开。可以调用 `/credentials/{username}/revoke` 提前吊销。

**建议值**：本项目是看片房，单场通常 1–6 小时；用 **TTL 24 小时**，服务端每 12 小时刷新一次
缓存。这样一场长电影不会中途过期，凭证泄露的窗口也可控。若只想覆盖单场，可用 6 小时。

## 三、接进本仓库需要改什么

当前实现（v1.4.14）：

- `server/ott-config.ts` 的 `voice.turn_ice_servers` 是静态 JSON（`VOICE_TURN_ICE_SERVERS`），
  适合自建 coturn 的长效凭据。
- `server/voice.ts` 的 `getRelayIceServers()` 同步读取该配置；`getVoiceIceServers()` 把它拼到
  直连 STUN 列表后面。
- `server/clientmanager.ts` 的 `buildVoiceMessage()` 已经是 `async`，按预算决定是否下发中继。
- 客户端 `client/src/util/voice.ts` 直接使用服务端下发的 `iceServers`，**无需改动**。

建议的最小改动：

1. 配置新增（`server/ott-config.ts`）：
   - `VOICE_CLOUDFLARE_TURN_KEY_ID`（String，默认空）
   - `VOICE_CLOUDFLARE_TURN_API_TOKEN`（String，`sensitive`，默认空）
   - 两者都非空时优先使用 Cloudflare；否则回退到 `VOICE_TURN_ICE_SERVERS`。
2. `server/voice.ts` 增加 `ensureCloudflareIceServers()`：
   - 启动/首次使用时 POST 上面的接口，`ttl=86400`；
   - 解析并校验 `iceServers`，缓存到内存，记录过期时间；
   - 在 TTL 的 80% 处后台刷新；失败时保留旧值到过期，过期后回退为空（fail closed）；
   - 返回的列表里过滤端口 53；与现有 STUN 列表按 URL 去重；
   - 不抛异常：生成失败只记录日志，房间加入继续走 STUN-only。
3. `getRelayIceServers()` 改为返回缓存快照（或增加异步版本）；`getVoiceIceServers()` 在
   `includeRelay=false` 时仍然只返回直连 STUN。
4. 预算：现有 `VOICE_MONTHLY_RELAY_MB=500000`（500 GB）在 1 TB 免费额度内；可提高到
   `900000`（900 GB）留 10% 余量。硬刹车 `VOICE_MONTHLY_RELAY_MB_MAX` 仍建议保持 0（只降级，
   不拒绝加入）。
5. 测试：mock `fetch` 覆盖「成功 / 超时 / 非 200 / 空 iceServers / TTL 过期 / 预算关闭」；
   不需要真实 TURN 凭据。

改动量估计：服务端约 60–100 行 + 配置 + 测试，客户端 0 行；无数据库迁移、无新增依赖。

## 四、成本测算

### 单场（全中继，保守上界）

| 房间 | 时长 | 单向流数 | 数据量 | 费用 | 1 TB 可覆盖 |
| --- | --- | --- | --- | --- | --- |
| 2 人 | 1 小时 | 2 | 36 MB | $0.0018 | 约 27,700 场 |
| 6 人 | 1 小时 | 30 | 540 MB | $0.027 | 约 1,850 场 |
| 6 人 | 3 小时 | 30 | 1.62 GB | $0.081 | 约 617 场 |
| 6 人 | 6 小时 | 30 | 3.24 GB | $0.162 | 约 308 场 |

实际只有部分 peer 需要中继（消费级约 8%–20%，企业网可达 60%–70%）；把上表按实际 relay
比例折算即可。Cloudflare 只对「Cloudflare→TURN 客户端」方向计费，直连部分免费。

### 月度场景（6 人房，3 小时/场，30 天）

| 并发房间 | 场次/月 | 全中继流量 | 超出免费额度 | 估算账单 |
| --- | --- | --- | --- | --- |
| 10 | 300 | 486 GB | 0 | **$0** |
| 30 | 900 | 1.46 TB | 458 GB | 约 **$22.9** |
| 100 | 3,000 | 4.86 TB | 3.86 TB | 约 **$193** |

把「全中继」换成实际 10%–30% 的中继比例，账单大致除以 3–10。当前线上语音用量为 0，
`/api/status/voice` 显示 `relayConfigured:false`、`monthlyUsageMb:0`，接入后从这里观察真实比例。

### 与其它方案的单场对比

| 方案 | 6 人 3 小时 | 备注 |
| --- | --- | --- |
| Cloudflare TURN（全中继） | 约 $0.08 | 1 TB 内免费 |
| 自建 coturn | 约 1.3 元流量费 | 需开 UDP/relay 端口 |
| 腾讯云 TRTC | 约 7.56 元 | 无需端口，含 3A/弱网优化 |
| Agora | 约 $1.07 | 按参与者分钟 |

## 五、限制与风险

- **China Network 不参与**：官方 FAQ 明确 TURN 流量从中国大陆会连到境外 Cloudflare 节点。
  这意味着「能连上」但延迟/丢包不一定优于直连；上线后必须用大陆手机网络实测。
- **单 allocation 限速**：50–100 Mbps、5–10 kpps 包速率、每秒最多 5 个新 IP；本项目 6 人
  音频每客户端约 200 kbps，远低于限制。
- **IPv4 only**：TURN 不签发 IPv6 relay 地址；纯 IPv6 客户端可能无法使用中继。
- **不支持 RFC6062 TCP relay**：TURN over TCP/TLS 是传输方式，不是把 TCP 应用数据中继；
  本项目是 UDP 音频，没有影响。
- **凭据可被滥用**：拿到凭据的客户端在 TTL 内可以消耗中继流量。用短 TTL + 预算刹车 +
  必要时 revoke；TURN Key API Token 只放服务端，泄露后立即轮换。
- **API 故障**：生成失败时必须回退到 STUN-only，而不是阻塞加入；UI 会显示「直连失败
  （未启用中继）」或「中继」状态。
- **统计延迟**：Cloudflare Realtime 用量约 30 秒后才出现在分析里；`/api/status/voice` 是
  估算，用于对账，不是账单。

## 六、上线步骤（建议）

1. Cloudflare 控制台创建 TURN Key，保存 Key ID 与 API Token。
2. 在 `compose.override.yml` 增加两个环境变量（Token 用 secret 管理，不要进 Git）：
   ```yaml
   VOICE_CLOUDFLARE_TURN_KEY_ID: "<key-id>"
   VOICE_CLOUDFLARE_TURN_API_TOKEN: "<api-token>"
   ```
3. 实现并部署上面的服务端凭据缓存（当前尚未落地，v1.4.14 仍只支持静态 TURN 配置）。
4. 验证：
   - `/api/status/voice` 的 `relayConfigured` 变为 `true`；
   - 两个不同网络的客户端加入同一房间，界面显示「直连」或「中继」；
   - 在 UDP 被封锁的网络（手机热点/公司网）验证 TURN/TLS 443 能建立；
   - 观察 Cloudflare Realtime 用量与 `/api/status/voice` 的估算是否接近。
5. 先在 `VOICE_MONTHLY_RELAY_MB=500000` 下跑 1–2 周，记录 relay 比例与大陆 RTT/丢包，再决定
   是否提高到 900 GB、是否自建 coturn 或换 TRTC。

## 参考

- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
- [生成 TURN 凭据](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Cloudflare Realtime 定价](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
- [TURN FAQ（区域、计费、限制、ICE restart）](https://developers.cloudflare.com/realtime/turn/faq/)
