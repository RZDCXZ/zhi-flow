# 05 消息持久化

Type: task
Status: resolved
Blocked by: 04

## 学习目标

理解先写用户 Message、再创建助手尝试、边流边更新与最终状态持久化之间的一致性取舍。

## 前置依赖

- 里程碑 4 已完成并获准继续。

## 最小实现

- 实现 Conversation 的创建、列表、读取、重命名和删除。
- 聊天开始前持久化用户 Message 与 `streaming` 助手 Message；完成、取消和失败时写入相应终态。
- 使用客户端幂等键阻止重复用户 Message；刷新后从数据库恢复历史。

## 运行观察

- 在流式中途刷新、断网和重复点击，观察数据库与 UI 的最终状态。
- 查看旧的 `streaming` Message 如何在恢复流程中变为可解释终态。

## 验证方法

- 通过 HTTP/SSE 接缝验证成功、取消、失败、重复幂等键和刷新读取。
- 数据库集成断言同一幂等键只有一个用户 Message。

## 完成标准

- Message 不因刷新丢失或重复；每个助手尝试有明确终态；Conversation 操作可用。
- 展示状态持久化结果，等待用户决定是否进入里程碑 6。

## 本阶段暂不处理

- 多轮上下文、滚动摘要、知识库和重生成。

## Answer

Message 不会因刷新丢失或因重复幂等键重复创建；每个助手尝试最终具有 `completed`、`cancelled` 或 `failed` 终态。Conversation 管理已通过公开 HTTP API 和浏览器界面可用。

## Comments

- 已实现 Conversation 创建、列表、读取历史、重命名和删除；浏览器可切换会话并在刷新后从数据库恢复 Message。
- 聊天写入通过 `create_message_attempt` RPC 原子持久化 `completed` 用户 Message 与 `streaming` 助手 Message；同一 Conversation 内重复客户端幂等键返回 `IDEMPOTENCY_REPLAY`，不会再次调用 Provider。
- 正常时间线持久化为 `streaming → completed`；停止为 `streaming → cancelled`；流中断或 Provider 错误为 `streaming → failed(error_code)`，均保留已生成正文。
- 读取 Conversation 时，超过聊天总时限仍为 `streaming` 的遗留助手 Message 会恢复为 `failed(STREAM_INTERRUPTED)`，避免把正在生成的合法请求误判为中断。
- 已通过 29 条 Vitest、49 条数据库断言、类型检查、lint、格式检查、数据库 lint、生产构建及生产启动/客户端密钥/私有 Storage 边界验证。里程碑 6 仍等待用户明确决定后再进入。
