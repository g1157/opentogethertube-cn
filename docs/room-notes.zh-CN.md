# 房间便签（追加式）

永久房的一个共享便签面板：房间内所有人可以**追加**和**删除**，不能编辑已有内容。
它解决的是「今晚看什么、下次什么时候看」这类需要留在房间里的信息，而不是即时聊天。

## 目标与明确不做的

**做**：永久房在房间标签页中多一个「便签」页；每条便签带作者与时间；全房间实时同步；
刷新、重连、重启后仍在。

**不做**：

- 编辑已有便签、版本历史、软删除回收站。
- Markdown / 富文本渲染（会引入 sanitizer 与 XSS 面）。
- @提醒、通知推送、跨房间聚合。
- 临时房不提供该页（临时房空闲回收会清掉状态，没有可靠载体）。

## 数据模型

新表 `RoomNotes`，**按房间名关联**而不是房间 id：内存中的 `Room` 没有数据库 id，
`Room.name` 是唯一且受 `ROOM_NAME_REGEX` 约束的标识。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK autoincrement | |
| `roomName` | STRING，非空，索引 | 关联 `Room.name` |
| `authorName` | STRING，非空 | 展示用的显示名 |
| `authorId` | STRING，非空 | 写入时的 ClientId，仅用于审计/调试 |
| `text` | TEXT，非空 | 正文 |
| `createdAt` / `updatedAt` | DATE | Sequelize 时间戳 |

不建外键：删除永久房时在 `storage/room.ts` 的 `deleteRoom` 里显式调用 `deleteAllNotes`
清理（临时房在库里根本没有房间行）。

**上限（服务端强制）**：单条 1000 字，单房 200 条。条数上限是唯一的增长闸门；
超限分别抛 `NoteTooLongException` / `TooManyNotesException`，客户端按错误名映射中文文案。

## 权限

新增权限位 `configure-room.set-notes`（`1 << 27`），`defaultPermissions()` 里授予
`Role.UnregisteredUser`，继承机制会让它向上覆盖所有角色；房主/管理员恒为全部权限。
语义是「可追加 + 可删除任意便签」：`authorId` 是会话级 ClientId，重连后会变，
做「只能删自己的」反而制造困惑，小房间里「谁都能删」更简单。

**已有房间必须回填**：`storage/room.ts` 直接使用数据库里持久化的掩码，不会合并新默认值。
迁移 `20260913120100-backfill-notes-permission.js` 用 JS 读改写把该位 OR 进每一行的每个
角色掩码（`down` 对应 AND 掉）。不用 JSONB 原生操作符，否则 sqlite 环境迁移直接失败。

## 协议

`common/models/messages.ts`：

- `RoomRequestType.AddNoteRequest` / `DeleteNoteRequest` **追加在枚举末尾**——这是数字枚举，
  值直接上线，插在中间会让所有已有请求错位。
- `AddNoteRequest { text }`、`DeleteNoteRequest { noteId }`。
- `ServerMessageNotes { action: "notes", notes, maxNotes, maxLength }`，`RoomNote` 的
  `createdAt` 是 ISO 字符串，避免共享层引入 Date 序列化差异。
- **不进 `sync`**：sync 走 50 ms 防抖的房间热路径，便签是可变长列表；独立消息、变更时全量
  广播、加入时补发一次。

## 服务端

| 文件 | 改动 |
| --- | --- |
| `server/models/roomnote.ts` | 新模型（`tableName: "RoomNotes"`，`roomName` 索引） |
| `server/models/index.ts` | `buildModels()` 注册 |
| `server/storage/roomnote.ts` | `listNotes` / `countNotes` / `addNote` / `deleteNote` / `deleteAllNotes` |
| `server/storage.ts` | barrel 导出 |
| `server/storage/room.ts` | `deleteRoom` 时清理便签 |
| `server/room.ts` | 权限映射、handler 映射、`addNote` / `deleteNote` / `publishNotes` |
| `server/clientmanager.ts` | 请求白名单加两条；加入房间后补发一次便签 |
| `server/migrations/` | 建表 + 权限回填 |

行为细节：正文 `trim()` 后为空直接忽略；临时房请求被拒绝（客户端也不渲染入口）；
删除不存在的便签抛 `NoteNotFoundException`；追加与删除后广播**完整列表**（上限 200 条，
全量最简单且不会漂移）。

## 客户端

| 文件 | 改动 |
| --- | --- |
| `client/src/stores/notes.ts` | Vuex 模块：`notes` / `maxNotes` / `maxLength`，`CLEAR` 用于换房 |
| `client/src/components/RoomNotes.vue` | 输入框 + 追加按钮、列表（作者、时间、删除）、空状态、上限提示 |
| `client/src/views/Room.vue` | 第四个标签页（仅永久房且已同步时渲染）+ 条数徽标；新房间同步时清空旧便签 |
| `client/src/util/roomapi.ts` | `addNote` / `deleteNote` 走既有 `{action:"req"}` 通道 |
| `client/src/components/ServerMessageHandler.vue` | 注册 `notes` → `notes/notes` |

正文用 `{{ }}` 插值渲染，**绝不 `v-html`**：这是项目第一个自由文本入口，XSS 面必须在
渲染层就关掉。便签放在 store 而不是组件局部状态，因为标签页徽标在面板未打开时也要显示条数。

## 验证

- **单元**：`server/tests/unit/notes.spec.ts` 覆盖权限位与默认授予、掩码不撞位、两个新请求
  类型编号、追加/空文本/超长/超上限/临时房/无权限/删除不存在；`RoomNotes.component.spec.ts`
  覆盖空态、trim 后发送、纯文本渲染（断言不产生 `<b>` 元素）、删除与上限禁用。
- **迁移**：`NODE_ENV=test npx sequelize db:migrate` 在 sqlite 上跑通，并实测插入旧掩码行
  → 迁移后含 `1 << 27`，`down` 后恢复原值（已在本地验证）。
- **端到端**：两个浏览器进同一永久房，A 加一条 B 立即看到；B 删除 A 立即消失；刷新仍在；
  临时房没有该标签页；超限提示正确。

## 已知边界

- 房间改名功能目前不存在；将来若加入，需要一并迁移便签的 `roomName`。
- 公开房若被滥用，可收紧 `configure-room.set-notes`（房主可在权限编辑器里关掉）或后续加
  每客户端频率限制；当前只有每房 200 条与单条 1000 字的硬上限。
