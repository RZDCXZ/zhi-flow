# 10 PDF、Markdown、TXT 文档解析

Type: task
Status: resolved
Blocked by: 09

## 学习目标

理解不同文本文件的解析边界、页码/标题保留、编码、规范化和稳定错误分类。

## 前置依赖

- 里程碑 9 已完成并获准继续。

## 最小实现

- Consumer 从私有 Storage 读取 Document，分别解析文本型 PDF、Markdown 与 TXT。
- 输出统一的结构化段落，保留页码、标题层级、原文范围和顺序。
- 拒绝扫描/加密/损坏 PDF、空内容、错误编码和超过解析上限的内容。

## 运行观察

- 使用含多页、标题、空白、特殊字符和损坏内容的固定夹具预览解析结果。
- 对比格式规范化前后，确认定位信息仍能回溯原文。

## 验证方法

- 通过 Consumer 接缝运行三类文件夹具并断言结构化外部结果与 Document 状态。
- 对页码、标题路径和稳定错误码做少量确定性测试。

## 完成标准

- 支持格式可稳定解析且可定位；不支持内容产生可解释 `failed`，没有部分脏数据。
- 展示解析预览，等待用户决定是否进入里程碑 11。

## 本阶段暂不处理

- OCR、Office、网页、图片、Chunk 和语义清洗。

## Answer

Consumer 的默认成功处理器现会从私有 Storage 读取并校验当前 Document 内容，解析文本型 PDF、Markdown 与 UTF-8 TXT，再以当前 claim ID 原子替换版本化 `document_paragraphs`。统一段落保留顺序、类型、PDF 页码、Markdown 标题层级与路径、内容，以及可回溯的原文字符范围；成功进入 `ready / parsing_completed`。

空内容、错误编码、解析字符上限、PDF 页数上限、扫描件、加密或损坏 PDF 使用稳定不可重试错误码进入 `failed`，Storage 暂时不可读则保留既有退避重试语义。解析与 claim fencing 位于同一数据库事务边界，失败或旧租约不会提交部分有效输出。

## Comments

- 2026-07-23 完成 PDF、Markdown、TXT 真实解析与私有 Storage 接入；固定夹具覆盖多页、标题、空白、特殊字符、页码、标题路径和原文定位，失败矩阵覆盖错误 UTF-8、空内容、字符/页数上限、扫描件和损坏 PDF。README 提供按 Document ID 查询结构化段落的解析预览。
