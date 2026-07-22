# 07 — 收缩旧生命周期路径并完成公开 interface 验证

**What to build:** 完成 expand–contract 的收缩阶段，让生产环境只剩一个 Assistant Message 生命周期 implementation。用户继续获得相同或已明确改进的 HTTP/SSE、停止与刷新行为，维护者不再需要在 route、读取和细粒度回调之间追踪规则。

**Blocked by:** 02 — 保证幂等提交与 Conversation 单活动生成；06 — 确定性实现 Provider retry 与三类时限

**Status:** ready-for-agent

- [ ] 删除旧的 route 内 Provider 编排、活动任务全局状态和持久化回调路径，生产调用只穿过 deep module。
- [ ] 删除 requestId 取消兼容路径，所有停止 caller 与测试都使用 Assistant Message ID。
- [ ] 删除 Conversation 读取中的遗留恢复副作用以及不再需要的细粒度 lifecycle interface。
- [ ] HTTP route 只保留传输解析、module 结果映射、协议元数据、SSE framing 和注释心跳。
- [ ] 重复的完整进程 acceptance case 被 module interface test 替换，只保留高价值 HTTP/SSE wiring、停止和刷新验证。
- [ ] Chat Provider adapter 合约测试和浏览器 SSE 解码测试继续通过，不锁定 deep module 私有 implementation。
- [ ] 全部测试证明数据库是唯一终态事实来源，竞争失败方不能覆盖已存在终态。
- [ ] 完整自动验证通过，且没有遗留 caller 引用旧 lifecycle interface。
