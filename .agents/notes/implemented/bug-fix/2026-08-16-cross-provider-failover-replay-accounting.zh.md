# Agent Note：跨提供方故障转移的回放记账

Status: implemented

[English](2026-08-16-cross-provider-failover-replay-accounting.md) | 中文

## 问题

跨提供方 `failover` 特性允许 pi-ai 路由在账户级失败后由备份路由应答，但会话对同一条 assistant 消息保留的两份记录对「谁应答的」各执一词。agent loop 用*被请求的* provider/model 为 assistant source 盖戳，而 pi-ai 回放状态记录的是*实际*应答的路由。两者在普通请求上始终一致，恰好在故障转移触发时分裂。下一个请求随即在 `readReplayState` 校验中失败（`LlmError('INVALID_REPLAY_STATE')`，"provider does not match assistant source"），而这次过期配对已持久化在日志里，该会话之后的每一轮都以同样方式失败——会话被永久卡死。

证据：会话 `session-32a4fbfd…` 日志中连续八次 `INVALID_REPLAY_STATE` 失败；其最后一条 assistant 消息的 source 为 `sensenova-deepseek`/`deepseek-v4-flash`，而旁边的回放状态是在 `qwen-token-plan`/`deepseek-v4-flash-0731`（故障转移备份）上捕获的。

## 决策

消息 source 必须点名生成该消息的路由，因为旁边的回放状态记录的就是那条路由。

- 成功流的 finish 分片可携带 `answeredBy: { provider, model }`——实际应答的路由与模型。`StreamChunk` 声明它；`BlockAssembler` 在回放状态旁捕获它；pi-ai 适配器从响应自身的路由／模型设置它，即使跨提供方故障转移，那也是分派时的线路身份。
- agent loop 以 `assembler.answeredBy ?? { provider: request.provider, model: request.model }` 为已记录的 assistant source 盖戳，因此 source 与旁边的回放状态点名同一条路由。
- 回放状态记录的 provider 或 model 与消息 source 不一致时，降级为外来投影（`api: 'dsh-foreign'`）：内容保留，pi-ai signature 不保留。这是 finish 分片携带 `answeredBy` 之前写下的日志的迁移路径——那些日志的 source 点名被请求的路由，而故障转移在别处应答。让轮次失败会把这些会话永久困在一次过期配对上；无论哪种方式，内容都是持久的事实。结构性损坏——无效版本、格式错误元数据、内容／块不匹配——仍然抛出 `INVALID_REPLAY_STATE`。

## 考虑过的替代方案

**不匹配仍然抛错，转而修复旧日志。** 迁移需要触碰每一个历史会话工件，而产出这种配对的只有故障转移；漏掉任何一个日志，其会话依旧卡死。读取时降级无需迁移，且只损失 mismatch 本已证明不可信的 signature 连续性。

**把被请求的路由写进回放状态。** 回放状态的职责是恢复 pi-ai 响应连续性，它属于应答路由的 API。把被请求的路由写进去能让校验通过，却对 pi-ai 谎报应恢复哪个响应。

## 验证

`packages/core/agent-loop/tests/loop.spec.ts` 跑一轮 finish 分片携带 `answeredBy` 的对话与一轮普通后续对话：第一条 `assistant/message` 的 source 点名备份路由，第二条回退到被请求的路由。`packages/llm/llm-pi-ai/tests/cross-provider-failover.spec.ts` 通过真实故障转移脚本断言组装后的消息 source 点名应答路由（含线路 id 改写与不含两种）。`packages/llm/llm-pi-ai/tests/convert.spec.ts` 把 provider／model 不匹配用例翻转为降级契约：外来投影保留内容、丢弃 signature，而结构性损坏仍然失败。

## 后果

故障转移应答的响应以其真实生产者记录，回放校验在下一轮通过，pi-ai signature 连续性在路由变化后得以保留。此变更之前记录的会话把故障转移应答的消息作为外来内容回放而非失败；这些消息失去 pi-ai 响应 id 复用，但内容一字不丢。忽略 `answeredBy` 的直接 `ctx.llm.stream()` 消费方不受影响，请求路由回退保证其日志与从前完全一致。
