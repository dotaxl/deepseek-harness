# Agent Note: llm-pi-ai 密钥池：配额/限流轮转与熔断

Status: implemented

[English](2026-08-14-llm-pi-ai-key-pool.md) | 中文

## 问题

当 provider 对单个 API key 限流或因为配额（`insufficient_quota`）封禁时，整个运行会停下来。本次工作的直接触发，是一次真实运行以 429 `insufficient_quota` 的终止错误结束，而不是继续。用户希望 harness 能够继续运行——切换到另一个 key，并且在配额封禁后加上数小时的冷却，即“5 小时熔断”。

这个修复必须保持配置驱动、尽量少的源码改动：不新增包，不新增 provider，并且保留现有的单 key `apiKeyEnv` 在设置 UI 中的契约。

## 决策

在现有的 `@deepseek-ai/dsh-llm-pi-ai` provider 插件上增加配置驱动的密钥池和按 key 熔断。

- **密钥池配置。** 路由现在除了现有的 `apiKeyEnv`（主 key）之外，还可以声明 `apiKeyEnvs: string[]`（zod 的 `credential-ref` 角色）。`resolveProfiles` 把两者拼接成 `apiKeyRefs: readonly CredentialRef[]`。`apiKeyEnv` 仍然保留为第一个 ref，这样只读取单个字符串的设置 UI 不受影响。
- **轮转循环。** `PiAiAdapter.stream()` 现在用受密钥池大小约束的 `for` 尝试循环来发起 provider 调用。`resolveApiKey` 从一个按路由划分的 `KeyRotationState`（`key-rotation.ts`）中选择当前 key，而不是直接读取 `apiKeyEnv`。当流以“可切换失败”终止时——`RATE_LIMIT` 或 `QUOTA`（`classifyPiAiError` 把 `insufficient_quota` 归为此类）——适配器吞掉这个终止 chunk，让被拒绝的 key 进入冷却，然后用下一个 key **重试同一个请求**。单 key 或无 key 的路由仍然只发起一次尝试。
- **熔断（冷却）。** `coolDownKey` 写入 `bannedUntil[index] = now + cooldownMs` 并前移 `index`。冷却时长取决于失败类型：`QUOTA` 封禁后使用 `keyCooldownMs`（默认 `5 * 3600 * 1000`，即 5 小时），`RATE_LIMIT` 后使用 `rateLimitCooldownMs`（默认 `60_000`，即 60 秒）。`selectActiveKey` 跳过冷却尚未结束的 key；在全面中断（所有 key 都在冷却）时回退到当前 `index`，而不是从一个非空的密钥池中返回 `undefined`。
- **为什么轮转放在适配器里而不是 `dsh-llm-retry`。** `QUOTA` 不在 `dsh-llm-retry` 的可重试集合 `DEFAULT_RETRYABLE_CODES` 中，所以在那里恢复会让运行在配额错误处停下——而这正是要避免的失败。把故障转移放在 `stream()` 内部，也让示例可以设置 `retryPolicy: { mode: normal, maxRetries: 0 }`，从而恢复策略不会因为限流/配额而重新跑整轮轮转。

示例 `examples/sensenova-agent/cordis.yml` 现在在 `sensenova-deepseek` 路由上声明了 8 key 的密钥池（`SENSENOVA_API_KEY` 通过 `apiKeyEnv`，`SENSENOVA_API_KEY_2..8` 通过 `apiKeyEnvs`）。源码中没有提交任何真实 key，只出现环境变量名。

## 后果

得到的收益：一次长时间运行现在能在单个 key 被限流或配额封禁时静默轮转到健康的 key，并在配额封禁后冷却 5 小时、在 429 后冷却 60 秒。状态机是 `key-rotation.ts` 中纯函数、与 Cordis 无关的逻辑，无需网络即可做单元测试。

代价 / 限制：
- 轮转状态是每个适配器实例私有的、内存中的。它不在进程之间或重启后的 harness 实例之间共享，所以重启会重置所有冷却。
- 冷却在单个进程内是尽力而为的：仍在冷却的 key 会被跳过，但在全面中断时当前 `index` 会作为最后的手段被重试，并可能暴露一个瞬时错误。
- 故障转移发生在单个 `stream()` 内部；agent 循环仍然像以前一样通过 `dsh-llm-retry` 负责非 key 的失败（中止、超时、内容错误）。

## 备选方案

- **通过 `dsh-llm-retry` 重试。** 否决：因为 `QUOTA` 不在它的可重试集合里，运行仍然会在 `insufficient_quota` 处停下；而且重试是重新驱动整个 agent 循环，而不是在一个流内部换 key。
- **共享/外部的冷却存储（例如 Redis）。** 否决：harness 在这个边界上没有这样的依赖，并且单进程长时间运行的 agent 才是部署形态；每个实例内存中的状态已经足够。
- **为 SenseNova 单独做一个适配器包。** 否决：会重复 harness 已经拥有的 OpenAI-completions 线网；配置密钥池已经足够。
- **把 `apiKeyEnv` 拓宽成数组。** 否决：设置 UI（`client/ui-settings-models`、`ui-settings-plugins`）把 `apiKeyEnv` 当作单个字符串读取；单独的 `apiKeyEnvs` 字段在不改动 UI 的前提下保留了那个契约。

## 测试

- `packages/llm/llm-pi-ai/tests/key-rotation.spec.ts` —— 3 个 `selectActiveKey` / `coolDownKey` 的单元测试（顺序遍历、回绕、空池无操作）。
- `packages/llm/llm-pi-ai/tests/failover.spec.ts` —— 4 个使用 `mockServer` 的集成测试：配额 → 轮转 → 应答（断言先 `Bearer key-a` 后 `Bearer key-b`）、429 → 轮转、所有 key 耗尽 → 暴露 `QUOTA`、单 key → 不重试。
- 完整的 `llm-pi-ai` 测试套件（217 个测试）、`pnpm run typecheck` 和 `pnpm run lint` 均通过。
