# Zhi Flow

Zhi Flow 是一个按里程碑推进的单用户 AI 聊天与 RAG 学习项目。当前完成到里程碑 09：浏览器可以管理彼此隔离的通用 Conversation，也可以创建、重命名和确认删除 Knowledge Base，将 PDF、Markdown 与 TXT Document 安全上传到私有 Storage，并通过持久队列交给独立 Consumer。Consumer 展示租约、任务时限、幂等认领、退避重试、崩溃恢复和失败归档；当前占位处理器只证明状态流转，真正解析、Chunk、Embedding、重生成、摘要与 RAG 尚未实现。

## 本地启动

环境要求：Node.js 20.9 或更高版本、npm 11、Docker Desktop 或兼容的 Docker 运行时。

```bash
npm install
cp .env.example .env.local
npm run db:start
npm run db:reset
npm run dev
```

`npm run db:status` 会显示本地 Supabase 地址与开发密钥。将其中的 `API_URL` 和 `SECRET_KEY` 分别填入 `.env.local` 的 `ZHI_FLOW_SUPABASE_URL` 与 `ZHI_FLOW_SUPABASE_SECRET_KEY`。本地栈使用共享默认密钥且不具备生产安全加固，只能用于开发环境。

打开 [http://localhost:3000](http://localhost:3000)，或从命令行检查服务端路由：

```bash
curl http://localhost:3000/api/health
```

健康检查返回：

```json
{ "status": "ok", "service": "zhi-flow" }
```

先创建 Conversation：

```bash
curl http://localhost:3000/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"title":"向量检索学习"}'
```

再把返回的 Conversation ID 传给聊天接口；`clientIdempotencyKey` 在同一 Conversation 内标识一次提交，相同正文可以安全重放，不同正文不能复用：

```bash
curl http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"<conversation-id>","clientIdempotencyKey":"<client-generated-unique-key>","message":"用三句话解释向量检索。"}'
```

成功响应是 SSE v1：`message.created` 会给出用户与助手 Message ID，随后是正文增量、用量和唯一终态；响应不包含模型名、供应商地址或密钥。通过 `GET /api/conversations/<conversation-id>` 可读取刷新后的完整历史。

`.env.example` 只包含占位值。请在 `.env.local` 中替换它们，并且不要提交真实密钥。所有模型与供应商配置都使用不带 `NEXT_PUBLIC_` 前缀的服务端变量。

## 配置校验

启动与生产构建都会校验以下变量：

- `ZHI_FLOW_CHAT_API_KEY`
- `ZHI_FLOW_CHAT_BASE_URL`，必须是 HTTP(S) URL
- `ZHI_FLOW_CHAT_MODEL`
- `ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS`，默认 `15000`
- `ZHI_FLOW_CHAT_IDLE_TIMEOUT_MS`，默认 `30000`
- `ZHI_FLOW_CHAT_TOTAL_TIMEOUT_MS`，默认 `120000`
- `ZHI_FLOW_CHAT_HEARTBEAT_INTERVAL_MS`，默认 `10000`
- `ZHI_FLOW_CHAT_MAX_STREAM_ATTEMPTS`，默认 `3`
- `ZHI_FLOW_DOCUMENT_MAX_FILES`，默认 `10`
- `ZHI_FLOW_DOCUMENT_MAX_FILE_BYTES`，默认 `20971520`（20 MiB）
- `ZHI_FLOW_DOCUMENT_MAX_PDF_PAGES`，默认 `200`
- `ZHI_FLOW_DOCUMENT_MAX_PARSED_CHARACTERS`，默认 `2000000`
- `ZHI_FLOW_CONSUMER_PLACEHOLDER_MODE`，默认 `success`；仅用于本地故障实验
- `ZHI_FLOW_SUPABASE_URL`，必须是 HTTP(S) URL
- `ZHI_FLOW_SUPABASE_SECRET_KEY`，只能由服务端读取

任何必需配置缺失或无效时，进程会在服务就绪前退出。错误只列出变量名，不打印配置值。

## 质量命令

```bash
npm run format        # 写入 Prettier 格式
npm run format:check  # 检查格式
npm run lint          # ESLint 静态检查
npm run typecheck     # TypeScript 类型检查
npm test              # Provider 合约、聊天 HTTP 与启动行为测试
npm run consumer      # 编译并处理至多一条 Document 摄取消息
npm run consumer:once # 编译并处理至多一条 Document 摄取消息
npm run consumer:start # 编译并持续运行本地 Document Consumer
npm run db:test       # 数据库约束、删除语义、种子和权限集成测试
npm run db:lint       # PostgreSQL 函数与迁移静态检查
npm run build         # Next.js 生产构建
npm run test:production-startup # 验证生产入口缺失配置时安全退出
npm run test:storage-boundary # 验证私有对象只能由服务端读取
npm run check         # 顺序运行全部检查、数据库测试、构建与边界验证
```

运行 `npm run check` 前需要先启动本地 Supabase，并在 `.env.local` 中提供全部服务端配置。`npm run test:client-boundary` 会检查生产构建中可下发给浏览器的静态产物和预渲染产物，确保它们不包含聊天或 Supabase 的服务端配置。

## 持久化流式聊天调用链

```mermaid
flowchart LR
  Browser["浏览器 ChatPanel"] -->|"POST /api/chat<br/>{ Conversation, Message, 幂等键 }"| Route["服务端 Route Handler"]
  Route --> Context["加载同一通用 Conversation<br/>最近 11 条已完成历史"]
  Context --> Persist["原子创建当前用户 Message<br/>与 streaming 助手 Message"]
  Persist --> Provider["按角色顺序发送最多 12 条 Message"]
  Provider --> OpenAI["OpenAI-compatible /chat/completions"]
  OpenAI -->|"正文增量 + token 用量"| Provider
  Provider -->|"边流边更新 + 明确终态"| Persist
  Persist -->|"SSE v1"| Browser
```

公开 API 使用固定且脱敏的错误结构；流建立后的 Provider 错误通过 `message.failed` SSE 终态返回：

| 触发条件                       | 返回接缝             | 应用错误码                       | 可重试 |
| ------------------------------ | -------------------- | -------------------------------- | ------ |
| 空输入或请求结构无效           | HTTP 400             | `INVALID_INPUT`                  | 否     |
| 超过 4000 个字符               | HTTP 400             | `INPUT_TOO_LONG`                 | 否     |
| 相同正文重放客户端幂等键       | HTTP 409             | `IDEMPOTENCY_REPLAY`             | 否     |
| 不同正文复用客户端幂等键       | HTTP 409             | `IDEMPOTENCY_KEY_REUSED`         | 否     |
| Conversation 已有活动生成      | HTTP 409             | `GENERATION_IN_PROGRESS`         | 否     |
| 供应商超时                     | SSE `message.failed` | `PROVIDER_TIMEOUT`               | 是     |
| 供应商 401/403                 | SSE `message.failed` | `PROVIDER_AUTHENTICATION_FAILED` | 否     |
| 供应商 429                     | SSE `message.failed` | `RATE_LIMITED`                   | 是     |
| 供应商 5xx、网络失败或畸形响应 | SSE `message.failed` | `PROVIDER_UNAVAILABLE`           | 是     |

`FakeChatProvider` 通过相同的 `ChatProvider.stream({ messages, signal })` 合约返回可控增量并记录收到的请求，适合观察角色顺序、Conversation 隔离、取消和用量映射。自动测试还会启动本地假 OpenAI-compatible HTTP 上游，以覆盖真实适配器的请求体、Authorization 头、超时与错误映射；它不会访问真实模型。

真实 Provider 仅做显式手动 smoke：在 `.env.local` 填入真实的 base URL、API key 和模型后启动应用，通过页面或上述 `curl` 发送一条消息，再比较回答、延迟和 token 用量。不要把真实密钥、供应商响应正文或 smoke 结果提交到仓库。

## 数据库迁移与观察

```bash
npm run db:reset # 删除本地数据库，重放全部迁移，再加载 seed.sql
npm run db:clean # 删除本地数据库，重放迁移但不加载样例数据
npm run db:reset # 恢复可观察的最小种子数据
npm run db:stop  # 停止本项目的本地 Supabase 容器
```

核心关系是：Knowledge Base 级联拥有 Document，Document 级联拥有 Document Chunk；Conversation 拥有 Message；RAG Run 将同一 Conversation 的用户 Message 与助手 Message 配对；Citation 同时绑定 RAG Run、助手 Message 和同一 Knowledge Base 的真实 Document Chunk。删除 Document 会同步移除 Chunk、向量和 Citation，但保留 RAG Run 调试记录；删除用户 Message 会级联其助手尝试与 RAG Run；确认删除 Knowledge Base 后，其 Document、Chunk、绑定的 Conversation、Message、RAG Run 和 Citation 会一并删除。删除前会持久化私有对象清理作业；若 Storage 暂时失败，对象键仍可追踪，并在后续读取或删除 Knowledge Base 时重试。

`supabase/seed.sql` 提供一组固定 UUID 的完整关系样例和全零 1024 维向量，只用于观察关系，不连接真实模型。`documents` Storage bucket 由迁移创建，限制为 20 MiB 的 PDF、Markdown 或 TXT，保持私有且不向客户端角色授予策略。

## Document Consumer 与故障实验

Document 上传成功后，Producer 只把 Document ID、摄取版本、内容哈希和幂等键写入 `document_ingestion`。Consumer 每次租约一条消息，默认 visibility timeout 为 15 分钟、任务总时限为 10 分钟、最多尝试 5 次；短暂错误使用指数退避和抖动，永久错误或耗尽重试会同时更新 Document、归档原消息并写入 `document_ingestion_failed`。

处理一条消息或持续运行：

```bash
npm run consumer
npm run consumer:once
npm run consumer:start
```

在 `.env.local` 中临时设置 `ZHI_FLOW_CONSUMER_PLACEHOLDER_MODE` 可重复观察故障路径：

| 值          | 占位行为                        | 预期 Document 状态                |
| ----------- | ------------------------------- | --------------------------------- |
| `success`   | 立即完成                        | `ready / placeholder_completed`   |
| `transient` | 返回可重试错误                  | `queued / retry_wait`，最终失败   |
| `permanent` | 返回不可重试错误                | `failed` 并进入失败队列           |
| `timeout`   | 一直等待，直到 10 分钟任务时限  | 超时后退避重试                    |
| `crash`     | 认领后以退出码 70 终止 Consumer | 15 分钟租约过期后由新进程重新领取 |

可在本地数据库中观察 `documents.attempt_count/error_code/current_stage`、`pgmq.q_document_ingestion.vt/read_ct`、`pgmq.a_document_ingestion`、`public.document_ingestion_failures` 和 `pgmq.q_document_ingestion_failed`。同一 Document 版本只认 Producer 登记的活动消息 ID；每次重新认领还会生成唯一 claim ID，旧租约持有者不能提交完成、重试或失败终态。后续真实处理器写入 Chunk 等业务输出时，也必须在同一事务中校验该 claim ID。两个 Consumer 竞争时由 PGMQ 的租约锁保证只有一个领取者，重复 payload 会直接归档而不再次调用处理器。

## 运行边界

- `src/components/chat-panel.tsx` 是 Client Component，消费公开 Conversation HTTP 与聊天 SSE 协议；数据库和服务端凭据不进入浏览器。
- `src/app/api/health/route.ts` 是服务端 Route Handler，通过 HTTP 返回最小健康状态。
- `src/app/api/conversations/` 提供 Conversation 创建、列表、读取历史、重命名和删除。
- `src/app/api/knowledge-bases/` 提供 Knowledge Base 生命周期、后端上传策略和 Document 上传 HTTP 接缝。
- `src/app/api/chat/route.ts` 是 Assistant Message 生成的 HTTP adapter，只处理传输解析、module 结果映射、SSE 协议元数据、framing 和注释心跳。
- `src/server/knowledge-bases.ts` 负责 Knowledge Base 与 Document 列表持久化，并在确认删除后清理其私有 Storage 对象。
- `src/server/documents/document-upload.ts` 负责扩展名、MIME、内容特征、大小、PDF 页数和解析字符数的权威校验，以及 Storage/Document 一致落地与失败清理。
- `src/server/documents/document-ingestion-consumer.ts` 是 Consumer 高层接缝：领取一条租约消息、原子认领 Document 版本、执行可取消处理器，并裁决成功、重试、失败和重复交付。
- `scripts/document-ingestion-consumer.ts` 是独立 Node.js 进程入口，支持单条处理、持续轮询、优雅停止和可控占位故障模式。
- `src/server/conversations.ts` 只提供 Conversation CRUD 与纯历史读取，不拥有 Assistant Message 生成生命周期。
- `src/server/chat/assistant-message-generation.ts` 是生成 deep module：读取同一 Conversation 最近已完成的 Message，通过 `create_message_submission` RPC 原子裁决创建、幂等和单活动生成，并拥有正文持久化、取消、恢复与终态竞争。
- `src/server/chat/` 同时定义 Provider 合约、可控假 Provider 与 OpenAI-compatible 实现；供应商配置只从服务端配置进入真实实现。
- `src/server/config-definition.ts` 是唯一配置定义与校验入口；`next.config.ts` 在启动阶段调用它，`src/server/config.ts` 为后续服务端业务提供只读配置。
- `src/server/supabase.ts` 是服务端特权数据客户端入口；禁用会话持久化，不提供浏览器端 Supabase 客户端。
- `.env.local`、`src/server/` 和模型配置不会成为客户端 API；前端只消费稳定的产品概念与 HTTP 协议。
