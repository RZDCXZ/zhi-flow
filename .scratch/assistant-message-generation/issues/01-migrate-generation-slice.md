# 01 — 迁移现有 Assistant Message 生成纵切片

**What to build:** 在不改变现有用户行为的前提下，让一次通用聊天从 User Message 提交、上下文选择、Chat Provider 流式生成到 Assistant Message 持久化终态，都由一个有状态的 deep module 完成。公开 HTTP/SSE interface 继续可用，但 HTTP route 只负责传输解析、协议元数据和 SSE framing。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] User Message 与初始 Assistant Message 在调用 Chat Provider 前原子持久化。
- [x] 成功生成通过类型化事件依次产生 Message 创建、正文、用量和完成结果，并保存完整正文与 `completed` 终态。
- [x] 现有最近十二条已完成 Message 的上下文选择、Conversation 隔离和角色顺序保持不变。
- [x] 持久化的 Conversation 模式决定生成路径；`general` 正常工作，尚未实现的模式返回稳定不支持结果。
- [x] 生产环境通过 composition root 创建共享 module 实例，并注入现有 Chat Provider adapter。
- [x] 测试可创建隔离 module 实例并使用 Fake Chat Provider，不依赖 HTTP route 私有行为。
- [x] HTTP adapter 添加 requestId、单调 sequence、时间戳和 SSE framing，module 不产生 SSE 字节。
- [x] 现有成功路径、Provider 合约和公开 HTTP/SSE 验证保持通过。
