# 06 基础多轮对话

Type: task
Status: resolved
Blocked by: 05

## 学习目标

理解 Message 历史如何变成模型上下文，以及角色顺序、已完成状态和上下文增长的影响。

## 前置依赖

- 里程碑 5 已完成并获准继续。

## 最小实现

- 通用聊天按顺序加载已完成 Message，构造多轮 Provider 请求。
- 排除失败、取消和未完成助手正文；设置暂时的最近消息上限并显示 Token 观察值。
- Conversation 模式固定为 `general`，不做检索。

## 运行观察

- 进行含代词和追问的短对话，查看发送给 Provider 的角色序列与 Token 增长。
- 注入失败 Message，确认其不会污染下一次上下文。

## 验证方法

- 使用记录输入的假 Provider 从公开 API 验证消息顺序、过滤和 Conversation 隔离。
- 浏览器冒烟测试短多轮对话与刷新续聊。

## 完成标准

- 短对话能正确引用前文；不同 Conversation 不串线；无效尝试不进入上下文。
- 展示上下文构造结果，等待用户决定是否进入里程碑 7。

## 本阶段暂不处理

- 摘要、长期 Token 预算、问题改写和 Knowledge Base。

## Comments

- 2026-07-22 浏览器冒烟：使用本地假 Provider 完成含代词的两轮对话；输入 Token 从 10 增长到 30，刷新后四条 Message 全部恢复并可继续输入。失败、取消和未完成助手正文的过滤由公开 HTTP/SSE 验收覆盖。
