# 02 数据库基础模型

Type: task
Status: resolved
Blocked by: 01

## 学习目标

理解关系模型、枚举状态、外键、迁移、种子数据和服务端数据访问边界。

## 前置依赖

- 里程碑 1 已完成并获准继续。

## 最小实现

- 配置本地 Supabase 与迁移流程。
- 建立 Knowledge Base、Document、Document Chunk、Conversation、Message、RAG Run 和 Citation 的基础表、枚举、约束与必要索引。
- 启用 pgvector 并定义 1024 维向量列；创建私有 Document Storage bucket。
- 提供最小种子数据与清理方式，不连接真实模型。

## 运行观察

- 查看迁移前后结构、外键约束、级联删除和非法枚举写入的结果。
- 验证客户端不能直接读取私有 Storage 或使用服务端特权。

## 验证方法

- 从空数据库执行全部迁移，再回滚/重建一次。
- 通过数据库集成测试验证关键约束、删除语义和向量维度。

## 完成标准

- 空环境可重复建库；核心约束拒绝非法状态和错误关联；架构与规格一致。
- 展示数据关系与迁移结果，等待用户决定是否进入里程碑 3。

## 本阶段暂不处理

- Repository 过度抽象、复杂 RLS、性能调优、业务 API 和 UI。

## Comments
