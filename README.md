# Zhi Flow

Zhi Flow 是一个按里程碑推进的单用户 AI 聊天与 RAG 学习项目。当前完成到里程碑 02：除 Next.js 项目骨架外，已建立可重复重建的本地 Supabase、核心关系模型、1024 维 pgvector、私有 Document Storage、种子数据和服务端数据访问边界；尚未实现聊天 API 或业务 UI。

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

`.env.example` 只包含占位值。请在 `.env.local` 中替换它们，并且不要提交真实密钥。所有模型与供应商配置都使用不带 `NEXT_PUBLIC_` 前缀的服务端变量。

## 配置校验

启动与生产构建都会校验以下变量：

- `ZHI_FLOW_CHAT_API_KEY`
- `ZHI_FLOW_CHAT_BASE_URL`，必须是 HTTP(S) URL
- `ZHI_FLOW_CHAT_MODEL`
- `ZHI_FLOW_SUPABASE_URL`，必须是 HTTP(S) URL
- `ZHI_FLOW_SUPABASE_SECRET_KEY`，只能由服务端读取

任何必需配置缺失或无效时，进程会在服务就绪前退出。错误只列出变量名，不打印配置值。

## 质量命令

```bash
npm run format        # 写入 Prettier 格式
npm run format:check  # 检查格式
npm run lint          # ESLint 静态检查
npm run typecheck     # TypeScript 类型检查
npm test              # HTTP 与启动行为验收测试
npm run db:test       # 数据库约束、删除语义、种子和权限集成测试
npm run db:lint       # PostgreSQL 函数与迁移静态检查
npm run build         # Next.js 生产构建
npm run test:production-startup # 验证生产入口缺失配置时安全退出
npm run test:storage-boundary # 验证私有对象只能由服务端读取
npm run check         # 顺序运行全部检查、数据库测试、构建与边界验证
```

运行 `npm run check` 前需要先启动本地 Supabase，并在 `.env.local` 中提供全部服务端配置。`npm run test:client-boundary` 会检查生产构建中可下发给浏览器的静态产物和预渲染产物，确保它们不包含聊天或 Supabase 的服务端配置。

## 数据库迁移与观察

```bash
npm run db:reset # 删除本地数据库，重放全部迁移，再加载 seed.sql
npm run db:clean # 删除本地数据库，重放迁移但不加载样例数据
npm run db:reset # 恢复可观察的最小种子数据
npm run db:stop  # 停止本项目的本地 Supabase 容器
```

核心关系是：Knowledge Base 级联拥有 Document，Document 级联拥有 Document Chunk；Conversation 拥有 Message；RAG Run 将同一 Conversation 的用户 Message 与助手 Message 配对；Citation 同时绑定 RAG Run、助手 Message 和同一 Knowledge Base 的真实 Document Chunk。删除 Document 会同步移除 Chunk、向量和 Citation，但保留 RAG Run 调试记录；删除用户 Message 会级联其助手尝试与 RAG Run；确认删除 Knowledge Base 后，其 Document、Chunk、绑定的 Conversation、Message、RAG Run 和 Citation 会一并删除。

`supabase/seed.sql` 提供一组固定 UUID 的完整关系样例和全零 1024 维向量，只用于观察关系，不连接真实模型。`documents` Storage bucket 由迁移创建，限制为 20 MiB 的 PDF、Markdown 或 TXT，保持私有且不向客户端角色授予策略。

## 运行边界

- `src/components/browser-runtime-status.tsx` 是 Client Component，只在浏览器激活后把状态更新为“已连接”。
- `src/app/api/health/route.ts` 是服务端 Route Handler，通过 HTTP 返回最小健康状态。
- `src/server/config-definition.ts` 是唯一配置定义与校验入口；`next.config.ts` 在启动阶段调用它，`src/server/config.ts` 为后续服务端业务提供只读配置。
- `src/server/supabase.ts` 是服务端特权数据客户端入口；禁用会话持久化，不提供浏览器端 Supabase 客户端。
- `.env.local`、`src/server/` 和模型配置不会成为客户端 API；前端只消费稳定的产品概念与 HTTP 协议。
