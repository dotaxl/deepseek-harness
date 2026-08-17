# Agent Note: Agent-loop terminal bounds for runaway runs

Status: implemented

English | [中文](2026-08-15-agent-loop-runaway-loop-bounds.zh.md)

## Problem

A run that never converges — a model looping without reaching a terminal answer, or a persistently failing endpoint such as an account cap returning `429` — spun on the single Node event loop without end. `dsh --profile web` co-locates the web UI and every agent session on that one event loop, so a runaway run starved the UI: diagnosis showed a session at turn 42 / step 11 / 270k events and ~10MB, 1630 `429` strings in one session, the process at 96% CPU, and load average climbing to ~7. The loop had no turn cap, no step cap, and no cap on consecutive failed requests, so the in-step retry `while (true)` in `step()` and the `while (await this.turn())` driver in `kick()` never exited.

## Decision

`AgentLoop` exposes two validated `Config` fields, both changeable from `cordis.yml`:

- `maxTurns` — a run-wide turn ceiling. `turn()` returns `false` (graceful run stop) once `turn > maxTurns`, ending the driver without throwing.
- `maxConsecutiveRequestFailures` — a cap on consecutive failed LLM requests inside one turn. In `step()`, each failed request increments `consecutiveRequestFailures`; once it reaches the cap the in-step retry loop throws instead of `continue`-ing. A successful step resets the counter, and a fresh turn resets it.
- `maxSteps` — a run-wide step ceiling. One step is one model round-trip, so an unbounded chatty run (e.g. a code-building agent emitting hundreds of `run_code` calls) would otherwise balloon the session log without limit and, co-located on one Node loop, pin the web UI. `turn()` checks `totalSteps` at the top of its step loop and returns `false` (graceful run stop) once `totalSteps >= maxSteps`, ending the driver without throwing. `totalSteps` is a per-run counter reset to `0` when the driver opens a new run, so resuming a long session starts a fresh budget and is never blocked by prior history. The `turn/end` reason is `max-steps` — a budget outcome, not a failure.

Defaults come from `constants.ts`: `DEFAULT_MAX_TURNS = 200`, `DEFAULT_MAX_CONSECUTIVE_REQUEST_FAILURES = 8`, and `DEFAULT_MAX_STEPS = 500`, all exported. `ResolvedConfig` carries all three as required numbers, and the `static Config` zod schema validates them with `min(1)`, so a `≤ 0` value fails at load. These are terminal guards inside the existing loop; they do not change loop structure or the documented agent-loop extension points.

The key-rotation mechanism the user actually wanted — cycling among the 10 SenseNova keys on a `429` — already lives in `dsh-llm-pi-ai` (`apiKeyEnv`/`apiKeyEnvs` pool plus `rateLimitCooldownMs`), and is untouched. Key rotation is not cross-vendor failover.

A wholesale key-pool exhaustion now ends the run instead of churning the pool. `dsh-llm-pi-ai` surfaces `KEY_POOL_EXHAUSTED` (preserving the underlying failure message) once every key in a multi-key route has been tried and rejected with a key-specific failure — rate limit, quota, or account auth. The agent loop treats that code as terminal: it throws and ends the run even when a recovery listener returns `retry`, so a fully rate-limited pool stops after one attempt rather than re-exercising every cooled-down key until the `rateLimitCooldownMs` (default 60s) cooldown elapses. A single-key route keeps its original per-key code, because pool exhaustion is meaningless for one key.

## Alternatives considered

**Cross-vendor `failover`.** The `failover` field is per-model, cross-vendor/cross-account, meant for hard outages. Wiring it between `sensenova` and `qwen-token-plan` ping-ponged the two vendors and triggered a `400` (`developer` role not supported by `qwen-token-plan`), because the pi-ai SDK defaults `supportsDeveloperRole` to `true` when the model profile omits `compat`. It was the wrong layer for key rotation and was removed; `qwen-token-plan` now sets `compat.supportsDeveloperRole: false` in `settings.yaml`.

**`retryPolicy` `always`.** That mode already exists for genuine transient retries, but it keeps retrying and therefore does not bound a persistently failing endpoint. The consecutive-failure cap is the correct layer to end the turn.

**External watchdog / process kill.** Killing the process loses the durable session and in-flight work and hides the root cause. Terminal guards end the run cleanly while keeping the session intact.

**Low `maxTurns` (e.g. 20).** Would cut legitimate long agent runs. `200` is a safety ceiling, not a normal operating bound.

## Verification

`packages/core/agent-loop/tests/loop-bounds.spec.ts` covers the new branches: the default consecutive-failure cap stops the run after 8 attempts; a configured cap (3) stops it after 3; exceeding `maxTurns` stops the run at turn 1 while leaving a later queued input unprocessed; a failure followed by a success resets the counter and completes the run; a chatty run exceeding `maxSteps` stops with `turn/end` reason `max-steps`; a configured `maxSteps` (2) stops after two steps; and the documented defaults `maxTurns` / `maxSteps` are wired through `ctx.agentLoop.config`. Existing `request-error.spec.ts` keeps owning the retry / non-retry waterfall paths.

## Consequences

A runaway or persistently failing run now ends instead of saturating the event loop and starving the web UI. Legitimate runs under 200 turns and under 8 consecutive failures are unaffected. All three bounds are tunable from `cordis.yml`; a `≤ 0` value fails load rather than disabling the guard. The bounds end the run but do not fabricate a success: a cap-tripped run ends with `turn/end` reason `error` (turn/failure cap) or `max-steps` (step cap), preserving the outcome in the session log.

The step cap closes the gap the turn cap left open: a run can stay under the 200-turn ceiling yet still emit hundreds of steps (one run reached 688 steps / 1336 `run_code` calls / ~60k events / ~12MB) because each turn carries many model round-trips. That volume is what made the co-located web tab unresponsive — the UI re-renders the whole transcript on every streaming token. `maxSteps` (default 500) bounds total session growth per run, so a chatty run stops gracefully instead of ballooning. The cap is per-run, so resuming a long session is never blocked; raising `maxSteps` in `cordis.yml` permits longer single runs when a task needs them.

A fully rate-limited pool now ends the run after a single attempt instead of burning requests across the cooled-down keys until the 60s cooldown elapses. The distinct `KEY_POOL_EXHAUSTED` code lets the web UI and session log show *why* the run stopped (every key was tried) rather than a generic per-key `RATE_LIMIT` that a recovery policy might otherwise keep retrying. Total outage recovery still waits on the cooldown: once the run stops, the cooled keys rejoin after `rateLimitCooldownMs`.
