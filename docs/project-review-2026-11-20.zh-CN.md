# 2026-11-20 分支合并与未解决项

## 范围与证据边界

-   本文记录 `origin/fix/project-review-2026-11-20`（远端 5 个提交）与本地 `main`
    （4 个提交）两条独立修复线的合并结果，以及合并后仍无法验证的项。
-   基线：远端 `a2a8a660`，本地 `main` 的 `0cf6fb61`。两者共同祖先为 `e5a6a8e4`。
-   合并产物在 `integrate/review-2026-11-20`，**尚未推送、尚未发布**。
-   不做真实浏览器、真实 Rust 编译、真实 OOM 或生产部署验证；本文不宣称这些结论。

## 两条线的差异与取舍

同一批缺陷被两边独立修复，取舍如下：

| 缺陷                | 远端实现                                                          | 本地实现                                  | 采用   |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------- | ------ |
| `mergeVideo` 丢假值 | `pickBy(x => !!x \|\| x === false \|\| x === 0)`                  | `omitBy(v => v === undefined \|\| v === null)` | 远端   |
| 批量缓存投毒        | 同时修身份泄漏、alias 改写 id 的相关性、不缓存适配器的全量请求、按请求顺序返回 | 仅堵身份泄漏                              | 远端   |
| `promoteUser` 落盘  | 补 `markDirty("userRoles")`，并扩展 `RoomDirtyProp` 类型          | 未发现                                    | 远端   |
| 登录限流            | 先预留再认证，含部分预留退款与配额键大小写归一                    | 仅核实位置，未改                          | 远端   |
| ffprobe 排队        | 队列上限 32、5 秒超时、槽位交接防抢占                             | 未涉及                                    | 远端   |
| 房间时钟/批量撤销/临时房密码/心跳广播 | 未涉及（为 `4f60d826` 之外的其他缺陷）          | 已修                                      | 本地   |
| girigiri 搜索与分集 | 未涉及                                                            | 迁移到站点 PHP JSON API 并区分"不可用"与"无结果" | 本地   |
| `trust_proxy` 默认值、崩溃恢复检查点、postgres 镜像、CI 缓存、ott-edge `ping`、均衡器 panic | 未涉及 | 已修                                          | 本地   |

`mergeVideo` 采用远端实现的原因：其 `metadata-merge.spec.ts:118` 明确要求空字符串必须
跳过、保留原值。本地的 `omitBy` 版本会保留 `""`，违反该契约——`""` 在元数据语义上是
"适配器没有报告"，与 `false`（"报告了否"）不同。只给远端函数补了 `export` 供本地回归测试引用。

## 合并后验证

-   `yarn lint-ci` 退出 0：**0 错误 / 28 警告**（28 为基线既有数量，`server/balancer.ts:370`
    等，非本次引入）。
-   `yarn build` 退出 0。
-   `yarn test`：服务端 **1218 通过**（含远端 5 个提交新增的 1300+ 行回归），客户端
    **1112 / 24 跳过**，common **103**，ott-vis **2**，ott-edge **31**。
-   交叉验证合并语义：`metadata-merge` 16 项、`batch-video-admission` 14 项、
    `room-pipeline-regressions` 5 项，合计 35 项通过，说明两边的断言互相兼容。
-   服务端内部类改动的两处共存已核实：远端的 `RoomDirtyProp` 与 `markDirty("userRoles")`
    仍在，本地的 `restoredFromStorage` 清零与 `additional.videos` 批量撤销仍在。

## 合并过程中的自我修正

首轮 cherry-pick 只挑了 `main` 的 3 个提交，漏掉 `6e5e1cee`（构建产物清理、ott-edge `ping`、
均衡器 panic、CI 缓存、备份 `.partial`）。发现方式：合并后单独核对 edge 测试数量，期望 31 项
却只有 30 项，追查到 `packages/ott-edge/src/room-object.ts` 里没有任何 `ping` 分支——之前一次
`grep -c "ping"` 的计数来自其他字符串，被误读为已包含。该提交随后补入，冲突仅在版本记录，
两边条目共存。教训：cherry-pick 后应按主题逐条核对功能是否真的在场，而不是按提交数量判断。

## 未解决或未验证

1. **`server/tests/unit/api/room.spec.ts` 的并发偶发失败**：
   `rejects a public-looking subtitle host that resolves to a private address` 在合并后的一次
   全量运行中失败，随后单文件连跑 3 次、全量连跑 5 次均通过（0 失败）。
   `room.spec.ts` 与 `adapters-network-boundaries.spec.ts` 都对 `node:dns/promises` 的同一个
   `lookup` 做 `vi.spyOn`，后者在每个用例后调用 `vi.restoreAllMocks()`，两者在
   `pool: "forks"` 下可能在同一进程内互相清除对方的 spy。根因未定位，**未修改**：无法
   稳定复现就无法证明修复有效。
2. **`crates/ott-balancer` 的改动未编译**：本机无 Rust 工具链，`join_client` 的 `unwrap()`
   改为可失败返回、以及 `Ordering::Greater` 分支的先校验后写入，只做了括号配平与结构核查，
   未跑 `cargo check` / `cargo test`。
3. **Vuetify 全量注册未移除**：重复已实测（首屏 `vendor` 1119 → 931 KB），但删除全局注册
   后 18 项组件测试因组件不再被注册而失败，已回滚。该改动需配合 `vite-plugin-vuetify` 的
   编译期行为并做真机 UI 验证。
4. **崩溃恢复与临时房密码**按存储语义测试，未做真实 OOM 击杀与进程重启演练。
5. **girigiri 迁移**已对真实上游验证搜索与单集弹幕，未验证其它线路的镜像完整性，
   也未验证海外出口（`ani.` 对 US / JP / 欧洲会跳转 `502.` 站）。

## 复验命令

```bash
NODE_ENV=test yarn workspace ott-server test
yarn workspace ott-client test
yarn workspace ott-common test
yarn workspace ott-edge test
yarn lint-ci
yarn build
```

`yarn test` 的偶发失败需按第 1 条单独复跑对应文件判断，不能以单次全量结果定论。
