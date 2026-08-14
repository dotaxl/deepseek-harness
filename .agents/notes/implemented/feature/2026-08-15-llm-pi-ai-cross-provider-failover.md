# Agent Note: llm-pi-ai cross-provider failover and AUTH rotation

Status: implemented

English | [中文](2026-08-15-llm-pi-ai-cross-provider-failover.zh.md)

## Problem

The key-pool rotation from `2026-08-14-llm-pi-ai-key-pool` keeps a run alive when *one* key is rejected, but a live SenseNova run still stopped mid-task. The session log showed three distinct keys all hitting the same "5 小时使用上限" (5-hour usage limit) on a single turn: the ten `SENSENOVA_API_KEY_*` references share **one** account, so an account-level cap rejects every key at once, and rotating within the route only replays the same denial until the pool is exhausted and the turn ends. The user's ten keys are not independent accounts — they are one account with ten credentials — so key rotation alone cannot recover from an account-level failure.

The trigger was the same family of failures that the key pool already handles (`RATE_LIMIT`, `QUOTA`) plus a 403 `AUTH` denial (e.g. an unpurchased model), all of which are account-level: once the whole account is capped, no key on that route helps. The only recovery is a *different* account, which in practice means a different provider route serving the same model.

The fix must stay config-driven and minimal, layered on the existing key pool: no new package, no new provider, and the single-key `apiKeyEnv` settings-UI contract preserved.

## Decision

Add two things to the existing `@deepseek-ai/dsh-llm-pi-ai` provider plugin:

- **Per-model `failover` to backup routes (cross-vendor recovery).** A model entry may now declare `failover: PiAiFailoverTarget[]`, each target naming another route that also serves the model, with an optional `model` remap for the wire id when the backup spells the same model differently. `resolveRouteModels` collects the declared targets per model; `resolveProfiles` runs a second pass that refuses any target naming its own route, an unknown route, or a route that does not serve the (remapped) model — so a typo fails load (`settings-rejected`, naming the route and model) rather than silently abandoning a request to an unserviceable backup mid-turn.
- **`AUTH` (403) joins the switchable failure set.** `SWITCHABLE_FAILURE_CODES` now contains `RATE_LIMIT`, `QUOTA`, and `AUTH`. A 403 account denial rotates the key pool exactly like a 429, and once the pool is spent hands off to the backup route.

`PiAiAdapter.stream()` is refactored into an outer loop driving a `failoverChain` (the selected route, then its declared backups in order) and an inner `streamOnProvider` that owns one route's key-pool rotation. Inside `streamOnProvider`, after capturing a switchable failure, the behavior depends on position in the chain: when a backup route remains (`!isLast`) it returns the captured failure immediately so the caller can abandon this route for the backup instead of burning the remaining keys here; on the last route it rotates to the next key while one remains, then surfaces the failure once the pool is exhausted. Each exhausted non-last route is cooled via `onKeyFailure` so the next request starts on a fresher key. The chain is built from the **selected** model's `failover` only — a backup route's own `failover` is ignored unless that backup is itself the selected route — so there is no recursion and no ping-pong between two routes that list each other. A fully exhausted chain still ends the turn with a terminal `finish {kind:'error'}`, so failover only ever *adds* routes; it never loops or softens a genuine dead end.

The live `$DSH_HOME/settings.yaml` now wires this end to end: `sensenova-deepseek/deepseek-v4-flash` lists `failover: [{ provider: qwen-token-plan, model: deepseek-v4-flash-0731 }]`, `qwen-token-plan/deepseek-v4-flash-0731` carries matching `reasoningEfforts` and a reverse `failover` back to SenseNova, and `agent-default-model` is restored to SenseNova. (The settings document lives outside the repo and is not committed.)

## Consequences

Bought: a long run now survives an account-level failure (rate limit, quota/ban, or 403 on a model the account is not entitled to) by failing over to a different vendor's account after the route's own key pool is exhausted — the only recovery when the keys share one account. A 403 now rotates keys and, failing that, fails over, instead of ending the turn.

Cost / limits:
- The two mechanisms compose deliberately: the key pool is **intra-account** rotation (one key for another on the same vendor); `failover` is **cross-account / cross-vendor** rotation (one vendor for another). A single-key route with a `failover` skips straight to the backup on the first account-level rejection; a multi-key route exhausts its own pool first.
- Failover is config-declared and fails loud at the second `resolveProfiles` pass; a target that names a route not serving the model is rejected where written, not mid-request.
- Both mechanisms live inside one `stream()` call, so `retryPolicy` should still avoid retrying the same switchable codes (or set `maxRetries: 0`), or the agent-level retry re-runs the whole chain.
- As before, rotation/failover state is per-adapter-instance and in-memory; a restart resets cooldowns.

## Alternatives considered

- **More keys on the same account.** Rejected by the live evidence: the ten keys are one account, so an account cap exhausts them together; adding keys would not change the failure mode.
- **Make `AUTH` a hard stop (out of the switchable set).** Rejected: a 403 denial of an unpurchased model is account-level, exactly the case failover should recover, and key rotation already proves the key-pool path handles it.
- **Recursive failover (follow each backup's own `failover`).** Rejected: it invites ping-pong between two routes that list each other and obscures which route a request actually tried; the chain is built from the selected model only.
- **Global failover list per route rather than per model.** Rejected: the remap (`model` on the target) is inherently per-(model, route); a route-level list would mis-route models the backup does not serve.

## Testing

- `packages/llm/llm-pi-ai/tests/cross-provider-failover.spec.ts` — 7 tests: fail over to the backup after the primary is rejected (asserts `Bearer key-a` then `Bearer key-b` and a `finish {kind:'stop'}`), surface the failure after every route is exhausted, remap the wire model id to the backup's spelling, rotate the key pool on a 403 `AUTH`, and three config-validation cases (unknown route, route not serving the remapped model, self-route).
- The full `llm-pi-ai` suite (224 tests), `pnpm run typecheck`, and `pnpm run lint` pass. `gen-config-catalog` / `verify-config-catalog` confirm the new `failover` field is in the generated `docs/config-catalog.md`.
