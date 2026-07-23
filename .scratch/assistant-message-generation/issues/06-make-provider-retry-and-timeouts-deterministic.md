# 06 — 确定性实现 Provider retry 与三类时限

**What to build:** 让暂时性 Chat Provider 故障在首个正文前进行有限、可测试的退避 retry，并让首字节、空闲和总时限具有明确范围。用户得到稳定、脱敏的错误状态，测试无需真实等待。

**Blocked by:** 05 — 合并正文持久化并保证终态耐久性

**Status:** resolved

- [x] module 构造时接收时间/调度 adapter，生产使用系统时间，测试使用可控时间。
- [x] 限流、暂时不可用、首字节超时和未产生正文的流中断只在首个正文前有限 retry。
- [x] 认证失败和无效响应不 retry；首个正文后的任何流中断也不重新生成。
- [x] retry 使用有上限的退避，并始终保留同一个 Assistant Message 身份。
- [x] 首字节时限按每次 Provider 尝试计算，空闲时限由有效 Provider activity 重置。
- [x] 总时限从 Assistant Message 创建到数据库终态提交，覆盖上下文构造、retry、退避、生成和持久化。
- [x] Chat Provider 错误在 module 内映射为稳定、脱敏、可持久化的错误码与 retry 语义。
- [x] module interface test 确定性覆盖 retry 分类、最大尝试次数、首字节/空闲/总时限和终态持久化；少量 HTTP/SSE 错误映射验证保持通过。
