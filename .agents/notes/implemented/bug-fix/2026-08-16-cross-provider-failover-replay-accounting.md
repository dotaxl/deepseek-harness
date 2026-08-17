# Agent Note: Failover replay accounting through the answering route

Status: implemented

English | [中文](2026-08-16-cross-provider-failover-replay-accounting.zh.md)

## Problem

The cross-provider `failover` feature lets a pi-ai route answer on a backup route after an account-level failure, but the two records a session keeps of one assistant message disagreed about who answered. The agent loop stamped the assistant source with the *requested* provider/model, while the pi-ai replay state recorded the route that *actually* answered. The two agree on every ordinary request and diverge exactly when failover fires. The next request then failed `readReplayState` validation with `LlmError('INVALID_REPLAY_STATE')` ("provider does not match assistant source"), and because the stale pairing is durable in the log, every later turn of that session failed the same way — the session was permanently stuck.

Evidence: session `session-32a4fbfd…` logged eight consecutive `INVALID_REPLAY_STATE` failures; its last assistant message names source `sensenova-deepseek`/`deepseek-v4-flash` beside a replay state captured on `qwen-token-plan`/`deepseek-v4-flash-0731` (the failover backup).

## Decision

The message source must name the route that produced the message, because the replay state beside it records that route.

- The finish chunk of a successful stream may carry `answeredBy: { provider, model }` — the route and model that actually answered. `StreamChunk` declares it; `BlockAssembler` captures it beside the replay state; the pi-ai adapter sets it from the response's own route/model, which is the dispatching wire identity even under cross-provider failover.
- The agent loop stamps the logged assistant source from `assembler.answeredBy ?? { provider: request.provider, model: request.model }`, so the source and the replay state beside it name the same route.
- A replay state whose recorded provider or model disagrees with the message source degrades to a foreign projection (`api: 'dsh-foreign'`): content is kept, the pi-ai signature is not. This is the migration path for logs written before finish chunks carried `answeredBy`, where the source names the requested route and a failover answered elsewhere. Failing the turn would strand those sessions permanently on one stale pairing; the content is the durable truth either way. Structural corruption — invalid versions, malformed metadata, content/block mismatches — still throws `INVALID_REPLAY_STATE`.

## Alternatives considered

**Keep throwing on mismatch and repair old logs.** A migration would touch every historical session artifact for a pairing only failover produces, and any missed log keeps its session stuck. Degrading at read time needs no migration and loses only signature continuity, which the mismatch already proved untrustworthy.

**Record the requested route in the replay state.** The replay state's job is to restore pi-ai response continuity, which belongs to the answering route's API. Writing the requested route into it would make validation pass while lying to pi-ai about which response to resume.

## Verification

`packages/core/agent-loop/tests/loop.spec.ts` runs a turn whose finish chunk carries `answeredBy` and a plain follow-up turn: the first `assistant/message` source names the backup route, the second falls back to the requested route. `packages/llm/llm-pi-ai/tests/cross-provider-failover.spec.ts` asserts the assembled message source names the answering route (with and without a wire-id remap) through real failover scripts. `packages/llm/llm-pi-ai/tests/convert.spec.ts` flips the provider/model-mismatch case to the degradation contract: a foreign projection with content kept and signature dropped, while structural corruption still fails.

## Consequences

A failover-answered response is logged with its true producer, so replay validation passes on the next turn and pi-ai signature continuity survives route changes. Sessions logged before this change replay their failover-answered messages as foreign content rather than failing; they lose pi-ai response-id reuse for those messages but keep every token of content. `answeredBy` is absent for direct `ctx.llm.stream()` consumers that ignore it, and the requested-route fallback keeps their logs identical to before.
