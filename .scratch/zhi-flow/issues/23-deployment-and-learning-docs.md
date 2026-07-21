# 23 Vercel、Supabase、Consumer 部署与学习文档

Type: task
Status: ready-for-agent
Blocked by: 22

## 学习目标

理解 Web、数据库/Storage/队列、长任务 Consumer 的不同部署边界，以及密钥、迁移、运行手册和验收门禁。

## 前置依赖

- 里程碑 22 已完成并获准继续。

## 最小实现

- 为本地完整开发、Vercel Web、Supabase 数据服务和独立 Node.js Consumer 编写可重复部署说明。
- 定义环境配置清单、密钥归属、迁移顺序、私有 Storage、队列初始化、健康检查与回滚步骤。
- Consumer 以独立进程持续消费；另提供受服务端密钥保护、限制批数的定时消费端点作为教学/兜底路径。
- 汇总 23 个里程碑的学习目标、运行命令、关键观察、常见故障和评测基线。

## 运行观察

- 从干净环境完成一次本地启动和一次目标环境部署，观察 Web 请求与长任务生命周期差异。
- 轮换一个测试密钥、运行迁移、处理一个 Document、执行一轮 Eval，再演练回滚。

## 验证方法

- 生产构建与全部自动测试、可靠性矩阵和 Eval 门槛通过。
- 部署后手动 smoke：创建 Conversation、上传 Document、等待 `ready`、知识库提问、核验 Citation/Trace、停止一次流。
- 检查客户端构建、日志和文档均不含真实密钥。

## 完成标准

- 新环境按文档可复现；Web、Supabase 和 Consumer 健康；核心 smoke 与基线通过；部署有访问保护和回滚路径。
- 展示最终系统与学习总结，由用户决定是否结束第一阶段或另立 Agent/Tool Calling 第二阶段规格。

## 本阶段暂不处理

- Agent、Tool Calling、SaaS 多租户、复杂 CI/CD、自动扩缩容、完整监控平台和 Embedding 迁移。

## Comments
