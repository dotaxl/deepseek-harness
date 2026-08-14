# Agent Note（智能体记录）：llm-pi-ai 跨提供方故障转移与 AUTH 轮转

状态：已实现

[English](2026-08-15-llm-pi-ai-cross-provider-failover.md) | 中文

## 问题

`2026-08-14-llm-pi-ai-key-pool` 引入的密钥池轮转能在一个 key 被拒时保住一轮运行，但一次真实的 SenseNova 运行仍然在任务中途停了下来。会话日志显示，同一个轮次里三个不同的 key 都撞上了同一句「5 小时使用上限」：那十个 `SENSENOVA_API_KEY_*` 引用共享**同一个**账户，于是账户级上限会一次性拒绝所有 key，而在路由内轮转只是把同一个拒绝重放一遍，直到池被耗尽、轮次结束。用户的十个 key 并不是相互独立的账户——它们是同一账户下的十个凭据——因此仅靠密钥轮转无法从账户级失败中恢复。

触发的失败，与密钥池已经在处理的（`RATE_LIMIT`、`QUOTA`）属于同一族，外加一个 403 `AUTH` 拒绝（例如未购买的模型），全部都是账户级的：一旦整个账户被限，该路由上任何一个 key 都无济于事。唯一的恢复办法是一个*不同*的账户，落到实践里就是一条服务同一模型的不同提供方路由。

修复必须保持配置驱动、且最小，叠加在既有密钥池之上：不新增包、不新增提供方，单一 key 的 `apiKeyEnv` settings-UI 契约保持不变。

## 决策

在既有的 `@deepseek-ai/dsh-llm-pi-ai` 提供方插件上增加两件事：

- **按模型的 `failover` 备份路由（跨厂商恢复）。** 模型条目现在可以声明 `failover: PiAiFailoverTarget[]`，每个目标点名另一条同样服务该模型的路由，并可附带一个 `model` 改写在线路上用的 id——当备份以不同名称拼写同一模型时。`resolveRouteModels` 会按模型收集声明的目标；`resolveProfiles` 跑第二遍，拒绝任何点名自身路由、未知路由，或服务不了（改写的）模型的路由的目标——因此笔误会（点名路由与模型的）在加载时以 `settings-rejected` 失败，而不是在轮次中途把请求静默丢给一个不可服务的备份。
- **`AUTH`（403）进入可切换失败集合。** `SWITCHABLE_FAILURE_CODES` 现在包含 `RATE_LIMIT`、`QUOTA` 与 `AUTH`。403 账户拒绝会像 429 一样轮转密钥池，而池一旦耗尽就交给备份路由。

`PiAiAdapter.stream()` 被重构为一个外层循环驱动 `failoverChain`（被选中的路由，然后是其按序声明的备份）和一个内层 `streamOnProvider`（负责单条路由的密钥池轮转）。在 `streamOnProvider` 内部捕获到一个可切换失败后，行为取决于在链中的位置：当还存在备份路由（`!isLast`）时，它会立即返回捕获到的失败，让调用方放弃这条路由去用备份，而不是在这里烧掉剩余的 key；在最后一条路由上，则只要还有下一个 key 就轮转过去，池耗尽后再暴露该失败。每条非末位、已耗尽的路由都会经由 `onKeyFailure` 进入冷却，使下一次请求从更新的 key 起步。链只由**被选中的**模型的 `failover` 构建——备份路由自身的 `failover` 会被忽略，除非该备份本身就是被选中的路由——因此不存在递归，也不存在两条互列彼此的路由之间的乒乓。一条完全耗尽的链仍会以终止 `finish {kind:'error'}` 结束这一轮，因此故障转移永远只*追加*路由；它绝不循环，也绝不软化一个真正走投无路的终点。

真实的 `$DSH_HOME/settings.yaml` 现在把这套端到端接了起来：`sensenova-deepseek/deepseek-v4-flash` 列出 `failover: [{ provider: qwen-token-plan, model: deepseek-v4-flash-0731 }]`，`qwen-token-plan/deepseek-v4-flash-0731` 带上相匹配的 `reasoningEfforts` 以及一条指回 SenseNova 的反向 `failover`，`agent-default-model` 也已恢复为 SenseNova。（该设置文档位于仓库之外，不提交。）

## 后果

所得：长运行现在能在账户级失败（限流、配额/封禁，或账户无权使用某模型时的 403）下存活——其路由自身的密钥池耗尽后，会故障转移到另一家厂商的账户，这也是 key 共享同一账户时唯一的恢复手段。403 现在会轮转 key，若仍不行则故障转移，而不是结束这一轮。

代价 / 限制：
- 两种机制刻意组合：密钥池是**账户内**轮转（同一厂商上一个 key 换另一个）；`failover` 是**跨账户 / 跨厂商**轮转（一个厂商换另一个）。单 key 路由带 `failover` 会在第一次账户级拒绝时直接跳到备份；多 key 路由会先耗尽自身池。
- 故障转移由配置声明，并在第二遍 `resolveProfiles` 处失败得响亮；点名不服务该模型的路由的目标会在写入处被拒，而不是在请求中途。
- 两种机制都在一次 `stream()` 调用内部，因此 `retryPolicy` 仍应避免重试同样的那些可切换码（或设 `maxRetries: 0`），否则 agent 级重试会把整条链重跑一遍。
- 一如既往，轮转/故障转移状态是每适配器实例、内存内的；重启会重置冷却。

## 考虑过的替代方案

- **在同一账户上加更多 key。** 被真实证据否决：十个 key 属于同一账户，账户上限会把它们一起耗尽；加 key 改变不了失败模式。
- **让 `AUTH` 成为硬停止（移出可切换集合）。** 否决：未购买模型的 403 拒绝是账户级的，正是故障转移应当恢复的情形，而密钥轮转已经证明密钥池路径能处理它。
- **递归故障转移（顺着每个备份自身的 `failover` 走）。** 否决：它会引发两条互列彼此的路由之间的乒乓，并掩盖请求究竟试过哪条路由；链只由被选中的模型构建。
- **路由级而非模型级的全局故障转移列表。** 否决：目标上的 `model` 改写本质上是按（模型，路由）的；路由级列表会把请求错误地路由到备份不服务的模型。

## 测试

- `packages/llm/llm-pi-ai/tests/cross-provider-failover.spec.ts` —— 7 个测试：主路由被拒后故障转移到备份（断言先 `Bearer key-a` 再 `Bearer key-b` 以及 `finish {kind:'stop'}`）、所有路由耗尽后暴露失败、把线路模型 id 改写为备份的拼写、在 403 `AUTH` 下轮转密钥池，以及三个配置校验用例（未知路由、路由服务不了改写的模型、自身路由）。
- 完整的 `llm-pi-ai` 测试套件（224 个）、`pnpm run typecheck` 与 `pnpm run lint` 均通过。`gen-config-catalog` / `verify-config-catalog` 确认新的 `failover` 字段已落入生成的 `docs/config-catalog.md`。
