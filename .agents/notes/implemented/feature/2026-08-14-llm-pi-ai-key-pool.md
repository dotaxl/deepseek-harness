# Agent Note: llm-pi-ai key pool with quota/rate-limit rotation and circuit breaking

Status: implemented

English | [中文](2026-08-14-llm-pi-ai-key-pool.zh.md)

## Problem

A single API key stops the whole run when the provider rate-limits it or bans it for quota (`insufficient_quota`). The trigger for this work was a live run that ended with a 429 `insufficient_quota` terminal error instead of continuing. The user wants the harness to keep going by switching to another key, including a multi-hour cooldown after a quota ban — a "5-hour circuit break".

The fix must stay config-driven with minimal source change: no new package, no new provider, and the existing single-key `apiKeyEnv` settings-UI contract preserved.

## Decision

Add a config-driven key pool and per-key circuit breaker to the existing `@deepseek-ai/dsh-llm-pi-ai` provider plugin.

- **Pool config.** A route may now declare `apiKeyEnvs: string[]` (zod role `credential-ref`) in addition to the existing `apiKeyEnv` (primary). `resolveProfiles` concatenates both into `apiKeyRefs: readonly CredentialRef[]`. `apiKeyEnv` is kept as the first ref so the settings UI, which reads a single string, is untouched.
- **Rotation loop.** `PiAiAdapter.stream()` now drives the provider call in a `for` attempt loop bounded by the pool size. `resolveApiKey` selects the active key from a per-route `KeyRotationState` (`key-rotation.ts`) instead of reading `apiKeyEnv` directly. When a stream terminates with a switchable failure — `RATE_LIMIT` or `QUOTA` (the code `classifyPiAiError` assigns to `insufficient_quota`) — the adapter swallows that terminal chunk, cools the rejected key down, and retries the *same request* with the next key. A single-key or keyless route still makes exactly one attempt.
- **Circuit breaking (cooldowns).** `coolDownKey` stamps `bannedUntil[index] = now + cooldownMs` and advances `index`. The cooldown length depends on the failure: `keyCooldownMs` (default `5 * 3600 * 1000`, i.e. 5h) after a `QUOTA` ban, `rateLimitCooldownMs` (default `60_000`, i.e. 60s) after a `RATE_LIMIT`. `selectActiveKey` skips keys whose cooldown has not elapsed; under a total outage (every key cooling) it falls back to the current index rather than returning `undefined` from a non-empty pool.
- **Why rotation lives in the adapter, not `dsh-llm-retry`.** `QUOTA` is not in `dsh-llm-retry`'s `DEFAULT_RETRYABLE_CODES`, so recovery there would stop the run on quota — the exact failure to avoid. Keeping failover inside `stream()` also lets the example set `retryPolicy: { mode: normal, maxRetries: 0 }`, so the recovery policy never re-runs the whole rotation loop for a rate-limit/quota.

The example `examples/sensenova-agent/cordis.yml` now declares the 8-key pool (`SENSENOVA_API_KEY` via `apiKeyEnv` plus `SENSENOVA_API_KEY_2..8` via `apiKeyEnvs`) on the `sensenova-deepseek` route. No real key is committed; only environment-variable names appear in source.

## Consequences

Bought: a long run now survives an individual key's rate-limit or quota ban by silently rotating to a healthy key, with a 5-hour cooldown after a quota ban and a 60-second cooldown after a 429. The state machine is pure Cordis-free logic in `key-rotation.ts`, unit-tested without a network.

Cost / limits:
- Rotation state is per-adapter-instance and in-memory. It is not shared across processes or restarted harness instances, so a restart resets every cooldown.
- Cooldowns are best-effort within one process; a key still cooling is skipped, but under total outage the current index is retried as a last resort and may surface a transient error.
- Failover occurs inside a single `stream()`; the agent loop still owns non-key failures (aborts, timeouts, content errors) via `dsh-llm-retry` exactly as before.

## Alternatives considered

- **Retry via `dsh-llm-retry`.** Rejected: `QUOTA` is not in its retryable set, so the run would still stop on `insufficient_quota`; and retry re-drives the full agent loop rather than swapping a key inside one stream.
- **A shared/external cooldown store (e.g. Redis).** Rejected: the harness has no such dependency at this boundary, and one long-running agent process is the deployment shape; in-memory per-instance state is sufficient.
- **A dedicated adapter package for SenseNova.** Rejected: duplicates the OpenAI-completions wire the harness already owns; a config pool is enough.
- **Widen `apiKeyEnv` to an array.** Rejected: the settings UI (`client/ui-settings-models`, `ui-settings-plugins`) reads `apiKeyEnv` as a single string; a separate `apiKeyEnvs` field preserves that contract without a UI change.

## Testing

- `packages/llm/llm-pi-ai/tests/key-rotation.spec.ts` — 3 unit tests for `selectActiveKey` / `coolDownKey` (ordered walk, wrap-around, empty-pool no-op).
- `packages/llm/llm-pi-ai/tests/failover.spec.ts` — 4 integration tests using `mockServer`: quota → rotate → answer (asserts `Bearer key-a` then `Bearer key-b`), 429 → rotate, exhaust-all-keys → surfaces `QUOTA`, single-key → no retry.
- The full `llm-pi-ai` suite (217 tests), `pnpm run typecheck`, and `pnpm run lint` pass.
