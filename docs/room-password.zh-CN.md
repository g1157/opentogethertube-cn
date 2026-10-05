# 房间密码（可选）

> 机制文档，与代码同提交维护（`feat(room): optional owner-set room password`）。相关背景：`docs/project-review-2026-10-05.zh-CN.md` 的 P1-2。

## 是什么

房主可以给房间设一个**可选密码**；不设时行为与之前完全一致：

- 设了密码后，**访客必须先出示密码**才能查看房间（REST）或加入房间（WS）；
- 房主本人不需要密码（以登录身份访问时自动放行）；
- 密码随时可改、可清；不清除则一直有效。

它与"可见性"（公开/不公开）相互独立。推荐组合是**密码 + 不公开**："只有拿到链接和口令的朋友能进"。

## 用户流程

1. **建房时设置**：创建永久房间表单里的"房间密码"（留空即不设）；
2. **进房**：打开房间链接 → 服务端拒绝并告知需要密码 → 弹出密码框 → 输对后自动重连进入；
3. **管理**：房主在房间设置底部"房间密码"区设置/修改/清除（该区仅房主可见；服务端同样只允许房主）。

## 机制

### 存储

- 只存 **argon2 哈希**：Postgres `Rooms.passwordHash`（迁移 `20261005140100-add-room-password-hash.js`），
  单列编码串（salt 内嵌）；明文永不落库、不落日志。
- **绝不进 Redis 房间快照，也绝不同步给客户端**（`serializeState` / `syncableProps` 均不含）；
  客户端只同步布尔 `hasPassword`（设置区显示"已设置/未设置"用）。
- 永久房间在服务重启后从 Redis 快照恢复时，`roommanager.getRoom` 会回查一次 DB 补齐哈希。

### 通行证（grant）

- 校验成功后给**该浏览器的 auth token** 发通行证：
  `room-password:<房间名>:<哈希版本>:<token>`，`setEx` 24 小时。
- 版本 = `sha256(passwordHash).slice(0,16)` → **改密/清密即自动失效**所有旧通行证，无需扫描删除。
- 房主旁路：`session.isLoggedIn && room.owner.id === session.user_id`。

### 校验点（统一收口）

| 入口 | 行为 |
| --- | --- |
| WS 加入（`clientmanager.joinAuthenticatedClient`） | 在首条 sync 之前检查；不通过 → 关闭码 `ROOM_PASSWORD_REQUIRED = 4006` |
| REST `GET /api/room/:name`、`PATCH /api/room/:name`、`POST/PATCH/DELETE /api/room/:name/queue` | 统一走 `api/room.ts` 的 `getRoomChecked()`；不通过 → `401 RoomPasswordRequired` |
| `POST /api/room/:name/password` | 校验密码并给当前 token 发通行证；`401 InvalidRoomPassword` |
| `PATCH /api/room/:name/password` | 设置（`{password}`）或清除（`{password: null}`）；**仅房主** |
| 管理端 | 正确 `apikey` 旁路 |

`vote` / `undo` 依赖已加入的 WS 连接（`getClientByToken`），被 WS 门自动覆盖。

### 防爆破与策略

专用限流（`rate-limiter-flexible`，模板同登录暴破防护）：按 `房间名 + IP`，10 次/分钟，超限封 5 分钟；
校验成功即清点；`rate_limit.enabled=false` 时跳过。密码策略：4–64 字符、无复杂度要求（共享口令语义）。

## 边界与已知限制

- **Cloudflare 预览版（ott-edge）不支持**房间密码（第二引擎，见 ai-handbook §4.5）；
- 无主房间（未认领）不能设置/修改密码；创建时可以直接带密码，之后需先登录认领才能管理；
- 取消密码框会回到"已断开"遮罩（原因显示"此房间需要密码"），可重连再输；
- 密码是**共享口令**：拿到密码的人转发给他人仍能进入（"邀请制白名单"未实现）。

## 测试

- `server/tests/unit/room-password.spec.ts`：哈希/校验/通行证/改密失效/清除；
- `server/tests/unit/api/room.spec.ts > room password`：房主设置、游客被挡（401）、错误密码、正确密码放行、清除后开放；
- `client/tests/unit/RoomPasswordDialog.component.spec.ts`：提交与错误提示。
