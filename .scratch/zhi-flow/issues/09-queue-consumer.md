# 09 队列 Consumer

Type: task
Status: resolved
Blocked by: 08

## 学习目标

理解消息租约、visibility timeout、幂等、重试、崩溃恢复和失败归档。

## 前置依赖

- 里程碑 8 已完成并获准继续。

## 最小实现

- 建立可在本地持续运行的 Node.js Consumer，以及“处理一条租约消息”的测试入口。
- 实现 15 分钟 visibility timeout、10 分钟任务时限、最多 5 次尝试、退避和失败队列。
- 以 Document 摄取版本保护幂等；本阶段用可控占位处理器证明状态流转。

## 运行观察

- 模拟成功、短暂错误、永久错误、租约过期、进程崩溃和重复消息。
- 查看 Document 尝试次数、错误码、队列可见性和失败归档。

## 验证方法

- 在 Consumer 高层接缝用真实队列与数据库断言所有状态路径。
- 两个 Consumer 竞争同一消息时只允许一个有效结果。

## 完成标准

- 消息最终成功或归档，不会静默丢失；重复交付不产生重复有效输出。
- 展示故障实验，等待用户决定是否进入里程碑 10。

## 本阶段暂不处理

- 真正解析、切块、Embedding、线上部署和吞吐优化。

## Answer

Consumer 以 PGMQ 单消息租约为入口，通过数据库原子函数认领 Document 当前摄取版本与唯一 claim generation；只有 Producer 登记的活动消息和最新 claim 能推进状态。成功会归档原消息并进入占位 `ready` 终态，短暂错误延后可见性，永久错误或第五次失败会原子写入 `document_ingestion_failed` 与失败登记。独立进程支持 `consumer:once`、`consumer:start` 和五种可控占位故障模式，后续里程碑可在同一处理器接缝替换真实解析逻辑。

## Comments

- 2026-07-23 完成独立 Node.js Document Consumer：单条/持续运行入口、15 分钟租约、10 分钟任务时限、最多 5 次尝试、带抖动退避、失败队列和 Document 摄取版本/claim generation 幂等保护；真实队列与数据库测试覆盖成功、短暂/永久错误、超时、耗尽重试、连续崩溃、租约过期、旧 claim fencing、竞争、重复和无效消息。
