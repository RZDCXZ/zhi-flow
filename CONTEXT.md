# Zhi Flow

Zhi Flow 是围绕 Conversation、Message 与个人知识库组织 AI 对话的单用户应用。

## Language

**Conversation**:
按时间组织 User Message 与 Assistant Message 的独立对话。同一 Conversation 同一时刻最多有一个正在生成的 Assistant Message。
_Avoid_: Chat, session, thread

**Message**:
Conversation 中的一次发言，角色为用户或助手。
_Avoid_: Chat record, 对话记录

**User Message**:
用户在 Conversation 中提交的输入；一个 User Message 可以对应多个 Assistant Message。
_Avoid_: Prompt, query

**Assistant Message**:
助手针对 User Message 给出的一次独立回答尝试。重新生成会创建新的 Assistant Message，并保留先前的 Assistant Message。
_Avoid_: Message Attempt, Response Attempt

**Cancelled Assistant Message**:
因用户显式停止而终止的 Assistant Message。网络断开或运行进程终止不属于取消。
_Avoid_: Disconnected Message

**Knowledge Base**:
按主题隔离私人 Document 的容器。删除 Knowledge Base 会显式确认，并级联删除其 Document 与相关数据。
_Avoid_: Library, corpus

**Document**:
用户上传到某个 Knowledge Base 的原始 PDF、Markdown 或 TXT 文件及其可追踪元数据。`uploaded` 表示文件已安全落入私有 Storage，但尚未进入摄取队列。
_Avoid_: Knowledge Document, file record
