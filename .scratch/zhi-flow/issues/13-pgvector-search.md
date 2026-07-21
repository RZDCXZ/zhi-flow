# 13 pgvector 入库与相似度查询

Type: task
Status: ready-for-agent
Blocked by: 12

## 学习目标

理解向量距离、数据库过滤、精确搜索基线和近似索引的正确性/性能取舍。

## 前置依赖

- 里程碑 12 已完成并获准继续。

## 最小实现

- 将有效向量事务性保存至 Document Chunk，并在完整成功后把 Document 置为 `ready`。
- 实现只在所选 Knowledge Base 与 `ready` Document 中查询的相似度函数。
- 先保留精确搜索基线，再建立适合数据量的 pgvector 索引并记录配置。

## 运行观察

- 对固定查询查看距离、排序、Knowledge Base 过滤和删除传播。
- 在小/较大夹具上比较精确与近似查询计划、延迟和结果差异。

## 验证方法

- 数据库/Consumer 接缝验证维度、状态门槛、隔离、排序和删除后不可检索。
- 固定向量夹具断言已知最近邻结果。

## 完成标准

- 相同查询与配置可重复得到正确候选；非就绪或其他 Knowledge Base 内容永不出现。
- 展示查询与执行计划，等待用户决定是否进入里程碑 14。

## 本阶段暂不处理

- Reranker、答案生成、Hybrid Search 和大规模索引调优。

## Comments
