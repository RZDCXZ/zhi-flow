# 07 知识库与文件上传

Type: task
Status: resolved
Blocked by: 06

## 学习目标

理解私有对象存储、文件元数据、输入验证和 Document 生命周期如何形成摄取入口。

## 前置依赖

- 里程碑 6 已完成并获准继续。

## 最小实现

- 实现 Knowledge Base 的创建、列表、重命名和带确认删除。
- 上传 PDF、Markdown、TXT 至私有 Storage，创建 `uploaded` Document。
- 校验格式、20 MiB、PDF 200 页、解析后字符上限和单次最多 10 个文件，并在 UI 展示状态与错误。

## 运行观察

- 上传合法、空、过大、伪造 MIME、损坏和不支持文件，比较客户端预检与服务端权威校验。
- 验证私有对象不能通过公开 URL 读取。

## 验证方法

- HTTP 接缝覆盖 Knowledge Base 生命周期和上传矩阵。
- Storage/数据库集成断言对象与 Document 的一致状态及删除语义。

## 完成标准

- 支持的文件安全落地并产生可追踪 Document；非法文件无孤儿对象或敏感错误。
- 展示上传与状态 UI，等待用户决定是否进入里程碑 8。

## 本阶段暂不处理

- 入队、解析、Chunk、Embedding 和拖拽体验优化。

## Comments

- 2026-07-23 完成 Knowledge Base 生命周期、私有 Storage 上传、`uploaded` Document、客户端预检与服务端权威校验矩阵；完整检查覆盖 HTTP、Storage/数据库一致性、级联删除与私有访问边界。
