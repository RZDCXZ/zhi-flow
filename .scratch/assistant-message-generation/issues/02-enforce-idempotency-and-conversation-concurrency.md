# 02 — 保证幂等提交与 Conversation 单活动生成

**What to build:** 让重复提交和并发提交得到可恢复、不会重复调用 Chat Provider 的结果。同一 Conversation 同时最多生成一个 Assistant Message；相同请求复用已有 Message，不同正文复用幂等键时明确拒绝。

**Blocked by:** 01 — 迁移现有 Assistant Message 生成纵切片

**Status:** ready-for-agent

- [ ] 数据库原子保证同一 Conversation 同一时刻最多一个正在生成的 Assistant Message，不依赖前端限制。
- [ ] 相同 Conversation、幂等键和正文的重复提交返回已有 User Message、Assistant Message 与持久化状态。
- [ ] 相同幂等键携带不同正文时返回 `IDEMPOTENCY_KEY_REUSED`，不改变已有 Message，也不返回旧正文。
- [ ] 已有活动生成时返回 `GENERATION_IN_PROGRESS` 和活动 Assistant Message ID，不排队也不取消已有生成。
- [ ] 相同提交的 HTTP 映射使用 `IDEMPOTENCY_REPLAY`，caller 能据此刷新 Conversation。
- [ ] 重复、键复用和活动生成冲突均不会再次调用 Chat Provider。
- [ ] 不同 Conversation 的生成可以并行完成。
- [ ] module interface test 覆盖首次提交、终态前后重复、键复用和并发竞争；保留一条公开 HTTP 恢复验证。
