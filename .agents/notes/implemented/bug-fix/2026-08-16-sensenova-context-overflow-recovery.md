# Agent Note: SenseNova context-window overflow recovery

Status: implemented

English | [中文](2026-08-16-sensenova-context-overflow-recovery.zh.md)

## Problem

SenseNova 6.8 Flash Lite (contextWindow 262144) rejected a 338k-token prompt with `400 {"message":"the input prompt token len 338297 + max_new_tokens 7657 > 262144","type":"invalid_request_error","code":"3"}`. The error was not classified as `CONTEXT_WINDOW_EXCEEDED`, so the compaction-basic overflow recovery (`agent/request-error` handler) did not fire — the turn failed with a raw 400.

The history accumulated under a 1M-context model (qwen3.7-plus or deepseek-v4-flash). When the user switched to 6.8 Flash Lite (262k), the pressure compaction at `agent/pre-step` read the stale request header (old model), measured against the old model's 1M context window, and did not compact. The 338k history was then sent directly to 6.8.

## Decision

Add SenseNova's overflow wording to the harness-level `isContextWindowExceededError` classifier in `packages/llm/llm/src/error.ts`. The error message pattern `"token len <number> ... > <number>"` is a numeric comparison that uniquely identifies a context-bound rejection.

The existing recovery pipeline handles the rest:
- `toStreamChunks` → `mapStopReason` → `harnessOverflow` is true → finish chunk carries `CONTEXT_WINDOW_EXCEEDED`
- `agent/request-error` → compaction-basic's handler fires → `compactIfNeeded` with `context-overflow` trigger → session compacted → `{ kind: 'retry' }` returned
- Agent loop retries the request with compacted history → success

No agent-loop changes were needed: the `request/header` is logged before the request is sent, so by the time `agent/request-error` fires, the header already reflects 6.8 and the recovery policy resolves correctly.

## Alternatives considered

**Proactive compaction on model switch.** Adding a pre-request context-window check in `buildRequest` would prevent the overflow entirely, avoiding the failed round-trip. But this would require either adding a dispatch event to the agent-loop or modifying the compaction-basic `routedTarget` to read the pending model selection — both cross-cutting changes that the existing recovery mechanism already handles acceptably. The user sees one failed request before recovery, which is consistent with other overflow scenarios.

**Extending pi-ai's `isContextOverflow` patterns.** The pi-ai library (`@earendil-works/pi-ai`) is a vendored dependency; its `OVERFLOW_PATTERNS` array is not ours to edit. The harness-level `isContextWindowExceededError` is the correct enforcement point.

## Verification

`packages/llm/llm/tests/service.spec.ts` gained positive tests for the SenseNova message and the minimal matching form `"token length 12345 > 6789"`, plus negative tests for messages without `>` comparison. All 760 tests pass across the three affected package suites.

## Consequences

SenseNova 6.8 Flash Lite context-overflow errors now trigger the compaction recovery mechanism, which compacts the session history and retries the request. The user sees one failed request before recovery, which is consistent with other overflow recovery flows. The `TOKEN_LEN_COMPARISON` pattern is broad enough to catch similar numeric overflow messages from other providers without being specific to any single vendor's wording.