# 助手 Message 生成生命周期深化规格

Status: ready-for-agent

## Problem Statement

用户需要可靠地发送 User Message、观察 Assistant Message 流式生成、显式停止并在断线或刷新后恢复真实状态。当前实现虽然已覆盖基本多轮聊天、持久化、超时和取消，但一次 Assistant Message 的幂等创建、上下文读取、Chat Provider retry、计时、正文持久化、取消、错误映射、终态竞争和 SSE 顺序由 HTTP route 与多个细粒度持久化操作共同协调。

这种架构让传输状态与领域状态互相泄漏：网络断开会被误记为用户取消，重复幂等请求被统一视为失败，多个实例可能竞争终态，同一 Conversation 也缺少数据库保证的单活动生成约束。随着 RAG、长 Conversation、重新生成和 Eval 加入，继续在 caller 中复制这些规则会降低 locality，使行为更难测试，也让每次变更更容易破坏持久化状态与用户看到的事件。

## Solution

建立一个有状态、deep 的助手 Message 生成 module，让它拥有 Assistant Message 从创建到持久化终态的完整生命周期。用户继续通过现有聊天界面和 HTTP/SSE interface 发送、观察与停止生成，但数据库状态成为唯一事实来源；SSE 只订阅类型化生成事件，连接断开不会冒充用户取消。

该 module 集中处理领域校验、幂等语义、单 Conversation 并发约束、Chat Provider retry 与计时、合并持久化、显式取消、错误分类、原子终态和遗留恢复。HTTP adapter 只处理传输解析、协议元数据、SSE framing 与状态码映射。核心失败矩阵通过 module interface、本地 Supabase、Fake Chat Provider 和可控时间 adapter 验证，少量 HTTP/SSE acceptance test 继续证明公开 interface 的 wiring。

## User Stories

1. 作为用户，我想让每个 Assistant Message 表示一次独立回答尝试，以便重新生成时能够保留旧回答。
2. 作为用户，我想让一个 User Message 可以关联多个 Assistant Message，以便未来重新生成不会覆盖历史。
3. 作为用户，我想在提交 User Message 后先持久化用户与助手 Message，再开始接收正文，以便刷新时不会丢失这次生成。
4. 作为用户，我想让同一 Conversation 同时最多生成一个 Assistant Message，以便两个标签页不会基于同一份旧历史产生竞争回答。
5. 作为用户，我想让不同 Conversation 可以并行生成，以便一个较慢的回答不会阻塞其他独立对话。
6. 作为用户，我想在已有生成时收到明确冲突和活动 Assistant Message 身份，以便界面能够恢复现有状态而不是创建重复回答。
7. 作为用户，我想重复提交相同幂等键和相同正文时复用已有 Message，以便网络重试不会再次调用 Chat Provider。
8. 作为用户，我想在幂等键被不同正文复用时收到明确冲突，以便 caller bug 不会被静默当成安全重试。
9. 作为用户，我想让重复提交返回已有 User Message、Assistant Message 和持久化状态，以便客户端可以刷新 Conversation。
10. 作为用户，我想让重复提交永远不重放模型副作用，以便不会产生重复费用或不同回答。
11. 作为用户，我想通过 Assistant Message 身份停止生成，以便停止目标在不同进程和实例中仍然稳定。
12. 作为用户，我想让重复停止已取消的 Assistant Message 仍然成功，以便停止请求可以安全重试。
13. 作为用户，我想让停止已完成或已失败的 Assistant Message 返回真实终态冲突，以便历史不会被改写成取消。
14. 作为用户，我想让不存在或不是助手角色的 Message 停止请求返回未找到，以便错误目标不会产生假成功。
15. 作为用户，我想让只有显式停止才产生 Cancelled Assistant Message，以便数据库准确表达我的行为。
16. 作为用户，我想让浏览器网络断开不自动取消生成，以便短暂断线不会浪费已经开始的回答。
17. 作为用户，我想在断线后通过 Conversation 的持久化状态恢复，以便无需重放 SSE 或重新调用 Chat Provider。
18. 作为用户，我想让运行进程意外终止留下的 Assistant Message 最终变为可解释的失败，以便它不会永远显示为正在生成。
19. 作为用户，我想让正文持续流式显示而不被每个数据库写入阻塞，以便回答保持及时。
20. 作为用户，我想让流式正文在有限时间或大小范围内持久化，以便意外终止时只可能丢失有明确上限的尾段。
21. 作为用户，我想让完整正文在任何终态事件前持久化，以便刷新后的内容与我看到的终态一致。
22. 作为用户，我想让数据库无法提交终态时中断事件流，而不是发送无法被持久化证明的失败终态，以便数据库始终是事实来源。
23. 作为用户，我想让一次生成只有一个终态，以便完成、取消和失败不会互相覆盖。
24. 作为用户，我想让模型在首个正文前发生暂时错误时进行有限 retry，以便短暂限流或不可用不必立即失败。
25. 作为用户，我想让首个正文后的流中断不自动重新生成，以便已显示的正文不会重复或分叉。
26. 作为用户，我想让认证失败和无效响应不进行无意义 retry，以便错误快速、准确地暴露。
27. 作为用户，我想让总时限覆盖上下文构造、retry、退避、生成和持久化，以便一次 Assistant Message 的资源消耗有统一上限。
28. 作为用户，我想让首字节和空闲时限分别生效，以便无响应和流中断得到不同且可行动的结果。
29. 作为用户，我想让 Chat Provider 错误保存为稳定且脱敏的错误码，以便界面可以安全解释失败。
30. 作为用户，我想让 Conversation 已持久化的模式决定生成路径，以便前端字段不能绕过通用聊天或知识库聊天规则。
31. 作为用户，我想让当前未实现的 Conversation 模式得到明确不支持结果，以便系统不会隐式采用错误生成路径。
32. 作为维护者，我想在一个 deep module 中理解生成、取消和遗留恢复，以便生命周期知识具有 locality。
33. 作为维护者，我想让 HTTP route 只承担 adapter 角色，以便传输代码不再拥有领域规则。
34. 作为维护者，我想让助手 Message 生成 module 产生类型化事件而不是 SSE 字节，以便 HTTP、Eval 和未来 caller 可以共享 implementation。
35. 作为维护者，我想让 SSE requestId、sequence、时间戳和 framing 留在 HTTP adapter，以便传输协议可以独立演进。
36. 作为维护者，我想让 Chat Provider 通过已有真实与 Fake adapter seam 注入，以便供应商切换和确定性测试不改动生命周期规则。
37. 作为维护者，我想让 PostgreSQL 持久化留在 module implementation 内，以便不为唯一持久化 adapter 制造 hypothetical seam。
38. 作为维护者，我想让时间与调度成为可替换 seam，以便 timeout、批量刷新和遗留恢复测试无需真实等待。
39. 作为维护者，我想让生产环境拥有一个长期存在的 module 实例，以便活动任务、订阅者和本地取消信号有明确所有者。
40. 作为维护者，我想为每个测试创建隔离的 module 实例，以便全局活动任务不会造成测试相互污染。
41. 作为维护者，我想让数据库原子迁移裁决终态，以便不同实例同时完成或取消时只有一个结果获胜。
42. 作为维护者，我想让数据库事务保证单 Conversation 单活动生成，以便前端限制不是唯一防线。
43. 作为维护者，我想让生成任务独立于事件订阅者，以便 async iterator 的结束不会隐式取消 Chat Provider。
44. 作为维护者，我想在没有订阅者时仍能完成持久化，以便断线恢复不依赖原 HTTP 连接。
45. 作为维护者，我想通过数据库状态轮询和条件更新传播跨实例取消，以便无需引入 Realtime 或消息通道。
46. 作为维护者，我想让相同 Assistant Message 内的 Provider retry 不创建额外领域实体，以便 Message 历史只表达用户可观察的尝试。
47. 作为维护者，我想让 Conversation 读取保持纯查询，以便遗留恢复不会隐藏在读取 implementation 中。
48. 作为维护者，我想让遗留恢复成为生命周期 module 的明确能力，以便读取 adapter 和未来定时任务可以复用同一规则。
49. 作为维护者，我想保留现有最近十二条已完成 Message 的上下文行为，以便架构重构不改变多轮聊天结果。
50. 作为维护者，我想让核心失败矩阵直接测试 module interface，以便不必为每个分支启动完整 Web 进程。
51. 作为维护者，我想保留少量公开 HTTP/SSE acceptance test，以便 adapter wiring 和用户可观察协议继续得到验证。
52. 作为学习者，我想看到 deep module、真实 seam 和 adapter 的清晰示例，以便理解 depth、locality 与 leverage 如何改善测试性。

## Implementation Decisions

- 新增一个有状态的助手 Message 生成 module，拥有 Assistant Message 从原子创建到持久化终态的完整生命周期。它是本功能的 deep module，不把生命周期平移成一组 shallow module。
- module 的 caller interface 提供三类能力：启动生成并订阅类型化事件、按 Assistant Message 请求取消、恢复遗留的正在生成状态。Conversation 列表、读取、重命名和删除不进入该 interface。
- module 先保持一个高 locality 的主 implementation；计时、retry、事件顺序、持久化协作和终态裁决默认作为私有行为共处。只有真实变化的 adapter seam 保持独立。
- module 使用可构造的有状态实例。生产 composition root 创建共享实例；测试为每个场景创建隔离实例。活动生成任务、事件订阅者和本地取消信号由实例拥有，不再由 HTTP route 的全局状态拥有。
- Chat Provider 保留现有 interface，并以 OpenAI-compatible 和 Fake 两个 adapter 形成真实 seam。module 构造时接收 Chat Provider adapter。
- 时间与调度形成第二个真实 seam：生产 adapter 使用系统时钟和真实定时器，测试 adapter 可确定性推进时间。时间 adapter 只属于 module 构造，不进入每次生成请求。
- PostgreSQL 持久化留在 module implementation 内。生产与测试均使用同一种 Supabase 数据 adapter，测试连接本地数据库；不新增 repository interface。
- HTTP adapter 只解析 JSON、检查字段存在和基础类型，并把 module 结果映射为 HTTP 状态、JSON 或 SSE。正文非空与长度、Conversation 存在与模式、幂等语义和单活动生成属于 module 的领域校验。
- module 根据持久化的 Conversation 模式选择生成路径。本次仅执行 `general` 路径；未实现模式返回稳定的不支持结果。caller 不得通过额外字段覆盖模式。
- 当前通用聊天上下文选择保持不变：只使用同一 Conversation 最近十二条范围内的已完成 Message，并将当前 User Message 纳入 Provider 输入。本次把调用收进 lifecycle implementation，但不另建上下文 interface。
- module 产生类型化 Chat 事件并保证语义顺序和唯一终态。HTTP adapter 添加 requestId、单调 sequence、时间戳与 SSE framing；注释心跳也由 HTTP adapter 产生。
- 事件订阅与生成任务解耦。订阅者断开只移除该订阅，不触发 Chat Provider 取消；只要运行环境继续执行，生成和持久化就继续。若平台终止进程，由遗留恢复处理。
- 本次不支持 SSE 续传、事件回放或重新附着到既有生成任务。断线 caller 通过读取 Conversation 恢复持久化状态，绝不为了恢复重新调用 Chat Provider。
- 数据库是 Assistant Message 终态的唯一事实来源。所有从正在生成到 `completed`、`cancelled` 或 `failed` 的迁移使用原子条件更新，只有成功提交的一方获得终态。
- 同一 Conversation 同一时刻最多存在一个正在生成的 Assistant Message。该约束由数据库事务或约束保证，不依赖 UI；不同 Conversation 可并行生成。
- 已有活动生成时，新提交返回 `409 GENERATION_IN_PROGRESS`，并附当前活动 Assistant Message ID。系统不自动排队，也不取消已有生成。
- User Message 与初始 Assistant Message 必须在调用 Chat Provider 前原子创建。数据库创建操作需要返回新建、已有相同提交、键复用冲突和活动生成冲突等可区分结果。
- 幂等键在单个 Conversation 内生效。相同键与相同正文视为已有提交，返回已有 User Message、Assistant Message 与持久化状态；不调用 Chat Provider，也不重放 SSE。
- 相同幂等键携带不同正文时返回 `409 IDEMPOTENCY_KEY_REUSED`，附已有 User Message ID但不返回旧正文；不改变任何已有 Message。
- 相同幂等请求的 HTTP 映射继续使用 `409 IDEMPOTENCY_REPLAY`，附已有 Message 身份和状态。module 内部将其建模为已有提交而不是生成失败；`409` 表示 HTTP adapter 无法重建原事件流。
- 停止 interface 只接受 Assistant Message ID。requestId 仅用于传输关联，不再作为取消目标；旧的 requestId 取消兼容路径移除。
- 显式停止使用原子状态迁移。正在生成时转为 `cancelled`；已取消时重复请求仍成功；已完成或已失败时返回稳定终态冲突；不存在或不是助手角色时返回 `404`。
- 同一实例停止时立即触发本地 Chat Provider 取消。其他实例通过约 500 ms 的有上限数据库状态轮询和每次条件持久化发现取消；不引入 Supabase Realtime、队列或消息通道。
- 浏览器断开不产生 `cancelled`。运行环境允许时生成继续；进程终止留下的正在生成状态由恢复能力转为 `failed`，并使用稳定的流中断错误码。
- 遗留恢复从 Conversation 读取 implementation 中移出。Conversation GET adapter 在执行纯读取前可显式触发恢复；未来定时任务可以复用同一能力。
- 流式正文先产生事件，再按每 500 ms 或累计 1,024 个字符任一先到的规则合并持久化。该策略为服务端配置，不进入 caller interface。
- 任何 `completed`、`cancelled` 或 `failed` 事件产生前，module 必须强制持久化完整已知正文，并成功提交对应原子终态。
- 如果正文最终刷新或终态提交不可用，module 不产生无法由数据库证明的 `message.failed`。事件订阅以 transport interruption 结束，caller 刷新 Conversation，遗留恢复随后处理持久化状态。
- Chat Provider retry 仅允许发生在首个非空正文 delta 之前，并始终属于同一个 Assistant Message。可重试类别为限流、暂时不可用、首字节超时和未产生正文的流中断；认证失败和无效响应不重试。
- 首个正文 delta 之后的任何 Provider 中断都直接失败，绝不重新开始生成。retry 使用有上限的退避，最大尝试次数继续由服务端配置控制。
- 总时限从 Assistant Message 成功创建为正在生成开始，到数据库成功提交终态为止，覆盖上下文构造、Provider retry 与退避、流式生成和持久化。
- 首字节时限按每次 Provider 尝试计算；空闲时限由有效 Provider activity 重置。订阅者是否连接不影响任何生成时限。
- module 将 Chat Provider 的认证、限流、不可用、超时、流中断和无效响应映射为稳定、脱敏、可持久化的错误码与 retry 语义。HTTP adapter 只决定传输状态和编码。
- 现有公开 Chat Provider interface 继续要求流式正文事件、activity 与最终用量。缺失必需正文或最终用量仍属于无效响应。
- 本次实现遵守 ADR-0001：Assistant Message 生成生命周期独立于 SSE 订阅，数据库裁决终态，同一 Conversation 只有一个活动生成。

## Testing Decisions

- 好测试只断言 caller 或用户可观察的结果：类型化事件顺序、Chat Provider 请求、持久化 Message 内容与状态、稳定错误码、HTTP/SSE 响应和 Conversation 恢复结果。测试不得依赖私有函数、活动任务容器、文件拆分或 SQL 实现细节。
- 新的最高测试 seam 是助手 Message 生成 module 的 caller interface。核心行为测试通过该 interface 启动、取消或恢复，并断言事件与本地数据库最终状态。
- module 测试使用真实本地 Supabase、Fake Chat Provider adapter 和可控时间 adapter。PostgreSQL 使用 local-substitutable 测试方式，不引入 repository mock。
- 正常路径覆盖：User Message 与 Assistant Message 在 Provider 调用前已存在；事件按创建、正文、用量、完成顺序产生；最终正文和 `completed` 状态一致。
- 幂等矩阵覆盖：首次提交、相同键相同正文、相同键不同正文、重复请求发生在正在生成和已终态之后，并断言 Provider 只被调用一次。
- 并发矩阵覆盖：同一 Conversation 两次并发提交只有一个获准生成；冲突包含活动 Assistant Message ID；不同 Conversation 可以并行完成。
- 取消矩阵覆盖：同实例取消、跨实例取消、重复取消、完成与取消竞争、失败与取消竞争、停止未知 Message、停止用户角色 Message，以及终态不可逆。
- 订阅矩阵覆盖：订阅者正常读取、订阅者断开、无订阅者继续生成、慢订阅者不拥有任务生命周期，并断言断开不产生 `cancelled`。
- 持久化矩阵使用可控时间验证 500 ms 和 1,024 字符两个刷新阈值、终态强制刷新、部分正文后的 Provider 中断，以及持久化不可用时不产生伪终态。
- retry 矩阵覆盖各可重试与不可重试错误、首个正文前与后的差异、最大尝试次数、有上限退避，以及同一 Assistant Message 身份不变。
- timeout 矩阵使用可控时间分别验证首字节、空闲和总时限，并证明总时限包含上下文构造、retry、退避和持久化。
- 遗留恢复覆盖超时的正在生成 Assistant Message、仍在有效时限内的 Message、已终态 Message，以及恢复与迟到 Provider 完成之间的竞争。
- Conversation 模式覆盖 `general` 正常路径和未实现模式的稳定拒绝，确保 caller 不能通过请求字段覆盖持久化模式。
- 保留少量 HTTP/SSE acceptance test，验证 JSON 解析、module composition、requestId/sequence/timestamp、SSE framing、公开错误映射、显式停止和刷新恢复。核心失败矩阵不再重复通过完整 Next.js 进程运行。
- 现有 acceptance test 已提供公开 HTTP/SSE、Message 持久化、幂等、跨实例取消、遗留恢复、超时和 Provider 错误映射先例；重构时保留其用户可观察断言，并将重复的生命周期分支替换为 module interface test。
- 保留 Chat Provider adapter 合约测试，继续验证 OpenAI-compatible 和 Fake adapter 的流式正文、activity、用量、错误分类和取消信号。
- 保留浏览器 SSE 解码测试，验证 requestId、sequence、重复事件、终态和不完整流；本规格不新增浏览器交互 module 测试。
- 所有测试必须证明数据库是终态事实来源：只有成功提交终态后才能观察对应终态事件，竞争失败方不能覆盖已存在的终态。

## Out of Scope

- 不在本规格中深化 Conversation 上下文构造 module；继续使用现有最近十二条已完成 Message 行为。
- 不实现滚动摘要、Token 预算、问题改写、RAG 检索、Citation、RAG Run 或知识库生成路径。
- 不实现重新生成入口；只保留一个 User Message 可关联多个 Assistant Message 的领域关系。
- 不实现 SSE 续传、Last-Event-ID、事件日志、事件回放或附着到既有活动生成。
- 不为同一 Conversation 的并发提交建立队列；冲突请求直接返回活动生成信息。
- 不引入 Supabase Realtime、消息队列、分布式锁服务或新的远程协调基础设施。
- 不深化浏览器 Conversation/Message 交互 module，也不重新设计聊天 UI。
- 不深化共享 SSE framing module；HTTP adapter 继续使用现有 framing implementation。
- 不改变 Chat Provider 的供应商选择、模型配置或 OpenAI-compatible 协议。
- 不把 PostgreSQL 抽象为 repository interface，也不添加纯内存持久化 adapter。
- 不实现注册、登录、多用户协作、租户隔离或跨用户并发规则。
- 不在本规格中根据性能测量调整 500 ms、1,024 字符或约 500 ms 跨实例轮询的初始配置。

## Further Notes

- 本规格使用 `Conversation`、`Message`、`User Message`、`Assistant Message` 与 `Cancelled Assistant Message` 作为统一领域语言；每个 Assistant Message 本身就是一次回答尝试，不建立独立的 Message Attempt 领域实体。
- Chat Provider 内部 retry 是 implementation 细节，不产生新的 Assistant Message。
- 测试 seam 已在设计 grilling 中确认：module interface 承担核心行为矩阵，公开 HTTP/SSE interface 只保留高价值 wiring 验证，Chat Provider adapter 合约测试继续独立存在。
- 本规格是对现有聊天纵向切片的架构深化，不替代项目的总规格与 23 个教学里程碑；实现仍应尊重当前里程碑范围。
- ADR-0001 记录了数据库事实来源、单 Conversation 单活动生成和生成生命周期独立于 SSE 订阅的原因。若未来选择让断线自动取消或支持事件续传，应先显式重审该 ADR。
