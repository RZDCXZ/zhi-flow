# 16 单轮 RAG、引用和拒答

Type: task
Status: ready-for-agent
Blocked by: 15

## 学习目标

理解两步 RAG 的完整在线链路、证据上下文、Citation 校验和证据不足拒答。

## 前置依赖

- 里程碑 15 已完成并获准继续。

## 最小实现

- 增加 `knowledge_base` Conversation 模式并强制绑定 Knowledge Base。
- 按查询向量、召回 20、重排、Top-5、上下文组装和生成顺序执行单轮 RAG。
- 实现初始 0.35 重排门槛、确定性前置拒答、`[n]` Citation 解析与真实 Chunk/摘录校验。
- UI 显示引用卡片和安全的资料不足结果。

## 运行观察

- 运行可回答、边界相关、完全无关、提示注入式 Document 和伪造引用输出。
- 查看同一问题在通用与知识库模式下的差异。

## 验证方法

- HTTP/SSE 高层接缝使用假 Provider 覆盖完整顺序、Citation、阈值、拒答与失败。
- 浏览器冒烟验证 Citation 打开后可看到正确文档、页码/标题与精确摘录。

## 完成标准

- 知识库答案至少一个有效 Citation，所有 Citation 可回溯；无证据时不调用生成或明确拒答。
- 展示回答与拒答案例，等待用户决定是否进入里程碑 17。

## 本阶段暂不处理

- 多轮追问、滚动摘要、完整 RAG Trace 和阈值自动调参。

## Comments
