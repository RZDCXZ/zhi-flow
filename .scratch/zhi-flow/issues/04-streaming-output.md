# 04 流式输出

Type: task
Status: resolved
Blocked by: 03

## 学习目标

理解 SSE/ReadableStream、增量解码、心跳、终态、取消信号和流式请求在首增量前后的不同重试语义。

## 前置依赖

- 里程碑 3 已完成并获准继续。

## 最小实现

- 将聊天 API 改为版本化 SSE 协议，支持 `message.created`、`content.delta`、用量和三类终态事件。
- 客户端按序列增量渲染并去重；支持本次请求的停止按钮。
- 实现首字节、空闲和总时限；正文开始后不自动重启流。

## 运行观察

- 使用可控延迟的假 Provider 观察分块、心跳、停止、断线与终态顺序。
- 对比在首个正文增量前失败和之后失败的可恢复性。

## 验证方法

- 在公开 SSE 接缝断言事件版本、单调序列、唯一终态、取消和中断错误。
- 浏览器冒烟测试断言用户确实看到逐步文本和停止反馈。

## 完成标准

- 所有流路径都有且只有一个终态；重复帧不重复显示；停止能传播至 Provider。
- 展示协议事件时间线，等待用户决定是否进入里程碑 5。

## 本阶段暂不处理

- 消息持久化、刷新恢复、重生成和 RAG 事件。

## Comments

- 已实现 SSE 协议 v1、OpenAI-compatible 增量解码、注释心跳、首字节/空闲/总时限、正文前有限重试、正文后禁止自动重启，以及用量和 completed/cancelled/failed 三类终态。
- 正常时间线为 `message.created → content.delta → content.delta → usage.snapshot → message.completed`；所有事件携带同一 requestId、单调 sequence 和时间戳。
- 停止时间线为 `message.created → content.delta → message.cancelled`，浏览器保留已显示正文并提示“已停止生成”；假上游连接关闭，确认取消已传播至 Provider。
- 中断时间线为 `message.created → content.delta → message.failed(STREAM_INTERRUPTED)`，上游请求次数为 1；首个正文前超时则最多尝试 3 次，最终只产生一个 `message.failed(PROVIDER_TIMEOUT)`。
- 已通过 Provider/客户端增量解码单测、15 条公开 HTTP/SSE 验收路径、真实浏览器渐进显示与停止冒烟；里程碑 5 仍等待用户明确决定后再进入。
