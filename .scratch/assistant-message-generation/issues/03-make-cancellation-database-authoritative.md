# 03 — 让显式取消由数据库终态裁决

**What to build:** 让用户只通过 Assistant Message 身份显式停止生成，并让数据库原子状态决定取消是否成功。同实例可以立即停止 Provider，其他实例也能在有限时间内发现取消，重复停止不会制造假失败。

**Blocked by:** 01 — 迁移现有 Assistant Message 生成纵切片

**Status:** ready-for-agent

- [ ] 停止 interface 只接受 Assistant Message ID；requestId 仅保留传输关联用途。
- [ ] 正在生成的 Assistant Message 可原子迁移为 `cancelled`，并在终态持久化后产生取消事件。
- [ ] 已取消的 Assistant Message 再次停止仍返回成功和现有状态。
- [ ] 已完成或已失败的 Assistant Message 返回稳定终态冲突，状态不被改写。
- [ ] 不存在或不是助手角色的 Message 返回未找到。
- [ ] 同一 module 实例收到停止请求时立即传播本地取消信号。
- [ ] 其他实例通过约 500 ms 的有上限状态轮询和条件更新发现取消，不引入新的远程协调基础设施。
- [ ] module interface test 覆盖同实例、跨实例、重复停止、未知目标和完成/失败/取消竞争；公开停止流程保持可验证。
