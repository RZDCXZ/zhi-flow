# Zhi Flow

Zhi Flow 是一个按里程碑推进的单用户 AI 聊天与 RAG 学习项目。当前仅完成里程碑 01：Next.js 项目骨架、后端配置边界、质量命令、首页与健康检查；尚未实现聊天或数据库业务。

## 本地启动

环境要求：Node.js 20.9 或更高版本、npm 11。

```bash
npm install
cp .env.example .env.local
npm run dev
```

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

任何必需配置缺失或无效时，进程会在服务就绪前退出。错误只列出变量名，不打印配置值。

## 质量命令

```bash
npm run format        # 写入 Prettier 格式
npm run format:check  # 检查格式
npm run lint          # ESLint 静态检查
npm run typecheck     # TypeScript 类型检查
npm test              # HTTP 与启动行为验收测试
npm run build         # Next.js 生产构建
npm run test:production-startup # 验证生产入口缺失配置时安全退出
npm run check         # 顺序运行全部检查、测试、构建与客户端边界验证
```

`npm run test:client-boundary` 会检查生产构建中可下发给浏览器的静态产物和预渲染产物，确保它们不包含聊天 API Key、Base URL 或模型配置。

## 运行边界

- `src/components/browser-runtime-status.tsx` 是 Client Component，只在浏览器激活后把状态更新为“已连接”。
- `src/app/api/health/route.ts` 是服务端 Route Handler，通过 HTTP 返回最小健康状态。
- `src/server/config-definition.ts` 是唯一配置定义与校验入口；`next.config.ts` 在启动阶段调用它，`src/server/config.ts` 为后续服务端业务提供只读配置。
- `.env.local`、`src/server/` 和模型配置不会成为客户端 API；前端只消费稳定的产品概念与 HTTP 协议。
