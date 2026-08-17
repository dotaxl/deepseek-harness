# Agent Note: 针对失控运行的 agent-loop 终止边界

Status: implemented

[English](2026-08-15-agent-loop-runaway-loop-bounds.md) | 中文

## 问题

无法收敛的运行——模型持续循环而得不到终止答案，或者像账号额度返回 `429` 这样持续失败的端点——会在单个 Node 事件循环上无限运转。由于 `dsh --profile web` 把 Web UI 与所有 agent 会话共置在同一个事件循环上，失控的运行会饿死 UI：诊断显示某个会话达到 turn 42 / step 11 / 27 万事件、约 10MB，单个会话里有 1630 个 `429` 字符串，进程占用 96% CPU，负载均值升到约 7。该循环既没有 turn 上限，也没有 step 上限，更没有连续失败请求上限，于是 `step()` 中 `while (true)` 的步内重试循环和 `kick()` 里 `while (await this.turn())` 的驱动循环永远不会退出。

## 决策

`AgentLoop` 暴露两个经过校验的 `Config` 字段，均可从 `cordis.yml` 修改：

- `maxTurns` —— 运行级的 turn 上限。`turn()` 在 `turn > maxTurns` 时返回 `false`（优雅停止运行），从而结束驱动循环而不抛错。
- `maxConsecutiveRequestFailures` —— 单个 turn 内连续失败 LLM 请求的上限。在 `step()` 中，每次请求失败会使 `consecutiveRequestFailures` 加一；一旦达到上限，步内重试循环会抛错而非 `continue`。成功的 step 会重置计数器，新的 turn 也会重置。
- `maxSteps` —— 运行级的 step 上限。一个 step 就是一次模型往返，因此不受约束的啰嗦运行（例如一个不断发出上百次 `run_code` 调用的代码构建 agent）会无限制地撑大会话日志，并且由于共置在单个 Node 循环上，会卡死 Web UI。`turn()` 在其 step 循环顶部检查 `totalSteps`，一旦 `totalSteps >= maxSteps` 就返回 `false`（优雅停止运行），从而结束驱动循环而不抛错。`totalSteps` 是按运行计数的计数器，在驱动开启新运行时重置为 `0`，因此恢复一个长会话会开启一份新的预算，绝不会被历史阻塞。`turn/end` 的原因是 `max-steps`——这是预算耗尽的结果，而非失败。

默认值来自 `constants.ts`：`DEFAULT_MAX_TURNS = 200`、`DEFAULT_MAX_CONSECUTIVE_REQUEST_FAILURES = 8` 与 `DEFAULT_MAX_STEPS = 500`，三者均被导出。`ResolvedConfig` 把三者作为必需数字承载，`static Config` 的 zod 模式用 `min(1)` 校验，因此 `≤ 0` 的取值会在加载时失败。这些是现有循环内部的终止守卫，不改变循环结构，也不改动文档化的 agent-loop 扩展点。

用户真正想要的轮转机制——在 10 个 SenseNova key 之间因 `429` 轮转——本就位于 `dsh-llm-pi-ai`（`apiKeyEnv`/`apiKeyEnvs` 池加 `rateLimitCooldownMs`），本次未做改动。key 轮转不属于跨厂商故障转移。

整体 key 池耗尽现在会结束运行，而不是空转池子。`dsh-llm-pi-ai` 在某个多 key 路由的每个 key 都已被尝试并以 key 级失败（限流、配额或账号鉴权）拒绝后，抛出 `KEY_POOL_EXHAUSTED`（保留底层失败消息）。agent-loop 把该 code 视为终止：即使恢复监听器返回 `retry`，它也会抛错并结束运行，因此完全被限流的池只尝试一次就停下，而不是把每个已冷却的 key 重新试一遍，直到 `rateLimitCooldownMs`（默认 60s）冷却结束。单 key 路由保留其原始的 key 级 code，因为对一个 key 谈"池耗尽"没有意义。

## 考虑过的替代方案

**跨厂商 `failover`。** `failover` 字段是按模型、跨厂商/跨账号设计的，用于硬故障。把它接在 `sensenova` 与 `qwen-token-plan` 之间会让两者来回乒乓切换，并触发 `400`（`qwen-token-plan` 不支持 `developer` 角色），因为模型概要缺少 `compat` 时 pi-ai SDK 默认 `supportsDeveloperRole` 为 `true`。它不是 key 轮转的合适层，已被移除；`settings.yaml` 中 `qwen-token-plan` 现在设置了 `compat.supportsDeveloperRole: false`。

**`retryPolicy` 的 `always` 模式。** 该模式已存在，用于真正的瞬时重试，但它会持续重试，因此无法约束持续失败的端点。连续失败上限才是结束该 turn 的正确层次。

**外部看门狗 / 进程强杀。** 杀掉进程会丢失持久会话和进行中的工作，并掩盖根因。终止守卫能在保留会话完整的前提下干净地结束运行。

**较低的 `maxTurns`（例如 20）。** 会截断合法的长时间 agent 运行。`200` 是安全天花板，而非正常运作边界。

## 验证

`packages/core/agent-loop/tests/loop-bounds.spec.ts` 覆盖了新分支：默认连续失败上限在第 8 次尝试后停止运行；配置后的上限（3）在第 3 次后停止；超过 `maxTurns` 时运行在第 1 个 turn 停止，且之后排队的输入不被处理；失败之后成功的 step 会重置计数器并完成运行；超过 `maxSteps` 的啰嗦运行以 `turn/end` 原因 `max-steps` 停止；配置后的 `maxSteps`（2）在第 2 个 step 后停止；文档化的默认 `maxTurns` / `maxSteps` 均通过 `ctx.agentLoop.config` 接通。已有的 `request-error.spec.ts` 继续负责重试 / 不重试的瀑布路径。

## 后果

失控或持续失败的运行现在会终止，而不是占满事件循环并饿死 Web UI。低于 200 个 turn、且连续失败少于 8 次的合法运行不受影响。三个边界都可在 `cordis.yml` 中调参；`≤ 0` 的取值会在加载时失败，而非关闭守卫。边界会结束运行，但不会伪造成功：触发上限的运行以 `turn/end` 原因 `error`（turn / 连续失败上限）或 `max-steps`（step 上限）结束，把结果保留在会话日志中。

step 上限补上了 turn 上限留下的缺口：一个运行可以远低于 200 个 turn 上限，却因为每个 turn 包含大量模型往返而发出成百上千个 step（曾有一个运行达到 688 个 step / 1336 次 `run_code` 调用 / 约 6 万事件 / 约 12MB）。正是这个体量让共置的 Web 标签页失去响应——UI 在每个流式 token 上都会重渲染整段会话。`maxSteps`（默认 500）按运行约束会话的总增长，于是啰嗦的运行会优雅停止，而不是无限膨胀。该上限按运行计算，因此恢复长会话绝不会被阻塞；当某个任务确实需要更长的单运行时，在 `cordis.yml` 中调大 `maxSteps` 即可。

完全被限流的池现在只尝试一次就结束运行，而不是把请求烧在已冷却的 key 上直到 60s 冷却结束。独立的 `KEY_POOL_EXHAUSTED` code 让 Web UI 和会话日志能显示运行*为何*停下（每个 key 都试过了），而不是一个通用的 key 级 `RATE_LIMIT`——后者可能被恢复策略继续重试。全面故障的恢复仍依赖冷却：运行停下后，被冷却的 key 会在 `rateLimitCooldownMs` 之后重新加入。
