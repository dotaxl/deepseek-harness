# Agent Note：SenseNova 上下文窗口溢出恢复

Status: implemented

[English](2026-08-16-sensenova-context-overflow-recovery.md) | 中文

## 问题

SenseNova 6.8 Flash Lite（contextWindow 262144）拒绝了 338k token 的 prompt，返回 `400 {"message":"the input prompt token len 338297 + max_new_tokens 7657 > 262144","type":"invalid_request_error","code":"3"}`。该错误未被归类为 `CONTEXT_WINDOW_EXCEEDED`，因此 compaction-basic 的溢出恢复（`agent/request-error` 处理器）未触发——轮次直接以原始 400 错误失败。

历史积累于 1M 上下文模型（qwen3.7-plus 或 deepseek-v4-flash）下。用户切换到 6.8 Flash Lite（262k）时，`agent/pre-step` 的压力压缩读取了过时的请求头（旧模型），以旧模型的 1M 上下文窗口衡量，未触发压缩。338k 的历史被直接发送给了 6.8。

## 决策

在 harness 级别的 `isContextWindowExceededError` 分类器（`packages/llm/llm/src/error.ts`）中添加 SenseNova 的溢出错误模式。错误消息模式 `"token len <number> ... > <number>"` 是一个唯一标识上下文边界拒绝的数值比较。

现有的恢复管道处理其余部分：
- `toStreamChunks` → `mapStopReason` → `harnessOverflow` 为 true → finish 分片携带 `CONTEXT_WINDOW_EXCEEDED`
- `agent/request-error` → compaction-basic 的处理器触发 → `compactIfNeeded` 以 `context-overflow` 为触发器 → 会话被压缩 → 返回 `{ kind: 'retry' }`
- Agent 循环以压缩后的历史重试请求 → 成功

无需修改 agent-loop：`request/header` 在请求发送前已记录，因此在 `agent/request-error` 触发时，请求头已反映 6.8，恢复策略正确解析。

## 考虑过的替代方案

**模型切换时主动压缩。** 在 `buildRequest` 中添加请求前上下文窗口检查可以完全防止溢出，避免一次失败的往返。但这需要要么在 agent-loop 中添加调度事件，要么修改 compaction-basic 的 `routedTarget` 以读取待定模型选择——两者都是跨领域变更，而现有恢复机制已足够胜任。用户会在恢复前看到一个失败的请求，这与其他溢出场景一致。

**扩展 pi-ai 的 `isContextOverflow` 模式。** pi-ai 库（`@earendil-works/pi-ai`）是待定依赖；其 `OVERFLOW_PATTERNS` 数组不属于我们编辑范围。harness 级别的 `isContextWindowExceededError` 是正确的执行点。

## 验证

`packages/llm/llm/tests/service.spec.ts` 增加了对 SenseNova 消息及最小匹配形式 `"token length 12345 > 6789"` 的正面测试，以及缺乏 `>` 比较的消息的负面测试。三个受影响包套件的全部 760 项测试通过。

## 后果

SenseNova 6.8 Flash Lite 上下文溢出错误现在触发压缩恢复机制，该机制压缩会话历史并重试请求。用户会在恢复前看到一个失败的请求，这与其他溢出恢复流程一致。`TOKEN_LEN_COMPARISON` 模式足够宽泛，可以捕获其他提供商的类似数值溢出消息，而不限于任何特定供应商的措辞。