# 04 — 让生成生命周期独立于 SSE 订阅

**What to build:** 让浏览器断开只结束事件订阅，而不冒充用户取消。只要运行环境继续执行，Assistant Message 生成和持久化就继续；进程意外终止留下的状态通过明确恢复能力变为可解释失败。

**Blocked by:** 03 — 让显式取消由数据库终态裁决

**Status:** resolved

- [x] 事件订阅者断开或停止读取时，Chat Provider 不会因此收到取消信号。
- [x] 没有订阅者时，活动生成仍可继续持久化并到达数据库终态。
- [x] 显式停止仍是产生 Cancelled Assistant Message 的唯一方式。
- [x] 本次不实现事件回放、SSE 续传或重新附着到既有生成；caller 通过 Conversation 读取恢复。
- [x] 遗留的正在生成 Assistant Message 可通过 lifecycle module 的明确恢复能力变为 `failed`，并保存稳定流中断错误码。
- [x] Conversation 读取不再隐藏遗留状态写入副作用；读取 adapter 显式触发恢复后执行纯查询。
- [x] 迟到的 Provider 完成不能覆盖恢复或取消已经提交的终态。
- [x] module interface test 覆盖订阅断开、无订阅者继续、遗留恢复和恢复竞争；公开断线后刷新行为可验证。
