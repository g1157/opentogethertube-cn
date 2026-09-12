# 安全响应头与 CSP 报告

应用和静态资源响应不再暴露 `X-Powered-By`，统一提供：

| 响应头 | 值 / 行为 |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | 禁用 camera、microphone、geolocation |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Strict-Transport-Security` | HTTPS 请求为 `max-age=31536000; includeSubDomains`；明文请求不发 |
| `Content-Security-Policy-Report-Only` | 观察跨源 base URL、object 和 frame ancestors；不设置 script 白名单 |

HTTPS 判定使用 Express 的 `req.secure`，遵循部署配置的可信代理层数。反代部署仍需正确设置
`TRUST_PROXY`；不直接相信任意请求携带的 `X-Forwarded-Proto`。Cookie 的既有配置保持适用。

本次只新增 CSP 报告策略，没有给业务页面增加强制 CSP。Express 自带错误页面原有的限制
不受影响。报告策略不是完整的 XSS 防护，也不能证明所有外部播放器都兼容更严格的策略。

`POST /api/csp-report` 在会话和通用 JSON 解析之前处理，不需要登录，也不创建新会话。
部署在子路径时，报告地址自动跟随 `base_url`。端点要求 `application/csp-report`，最大
16 KiB，不接受压缩请求；有效报告返回 204，格式错误 400，过大 413，错误类型 415。

请求使用既有限流器的独立 IP bucket，每次消耗 25 点，默认预算相当于每 IP 每小时最多
40 份报告。限制在解析和日志写入前执行，触发后返回 429。运维若关闭全局限流，也会关闭
这项限制。日志只记录指令名和 HTTP(S) origin，不记录用户名、密码、房间路径、查询参数、
片源签名、fragment、原始策略和脚本片段。解析失败时也不回显原始正文。

兼容性观察先在隔离预览实例进行。只有收集到足够的实际报告并逐项确认后，才另行考虑
收紧策略；不要把本次报告模式直接改成强制模式。
