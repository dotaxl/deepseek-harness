# Agent Note: SenseNova DeepSeek V4 Flash via hand-declared llm-pi-ai route

Status: implemented

English | [中文](2026-08-14-sensenova-deepseek-v4-flash-route.zh.md)

## Problem

We need to serve DeepSeek V4 Flash through SenseNova's platform. SenseNova exposes an OpenAI Chat Completions-compatible endpoint, but its thinking output arrives under `delta.reasoning` / `message.reasoning` rather than the `reasoning_content` field DeepSeek's own API uses, and it is not a built-in pi-ai catalog provider. A from-scratch adapter would duplicate the OpenAI-completions wire work the harness already owns.

## Decision

Add a hand-declared `openai-completions` route to the existing `@deepseek-ai/dsh-llm-pi-ai` plugin — no new package, no `packages/` source change. The route points `api: openai-completions` at `https://token.sensenova.cn/v1`, sets `apiKeyEnv: SENSENOVA_API_KEY`, and declares the `deepseek-v4-flash` model. pi-ai's `openai-completions` protocol already reads reasoning from `["reasoning_content", "reasoning", "reasoning_text"]` (`openai-completions.js`), so SenseNova's `reasoning` field streams through unchanged on the response side.

Because the SenseNova OpenAI endpoint does not document a `reasoning_effort` parameter, the route sets `compat.supportsReasoningEffort: false` together with `thinkingFormat: openai`. `openai` is not one of the special-cased thinking formats, so request building falls through to the generic OpenAI branch, which gates every thinking parameter on `supportsReasoningEffort` — with it false, **no** thinking parameter (`reasoning_effort`, `thinking`, `enable_thinking`, …) is ever sent. The model is still declared reasoning-capable (`reasoningEfforts: { off: , max: max }`) so the harness labels it and the endpoint's default thinking still surfaces in the response.

The composition lives in `examples/sensenova-agent/cordis.yml`, runnable and exercised by `examples/sensenova-agent/tests/keyless-smoke.e2e.ts` (boots the tree and resolves the route/model with no key) and `examples/sensenova-agent/tests/real-model.e2e.ts` (self-skips without `SENSENOVA_API_KEY`).

## What we gave up

- **No dedicated adapter package.** If SenseNova later needs a non-OpenAI wire quirk — custom required headers, a different `finish_reason` set, or encrypted reasoning — this route would have to become a sibling of `llm-deepseek` rather than a config entry.
- **No request-side thinking control.** Thinking effort is whatever SenseNova's endpoint applies by default; we deliberately do not send `reasoning_effort`.

## Reintroduction condition

If SenseNova documents a `reasoning_effort` (or `thinking`) parameter, flip `supportsReasoningEffort` to `true` and set the `reasoningEfforts` wire spellings in the route — no package addition required.

## Consequences

The route adds a vendor without touching `packages/` source or adding a package, so it stays within the harness's config-only extension model. It inherits the pi-ai `openai-completions` protocol's request/response handling (including reasoning passthrough) verbatim. The cost is the two limits above: no dedicated wire and no request-side thinking control.

## Alternatives considered

- **A dedicated `llm-sensenova` adapter package.** Rejected: SenseNova exposes a standard OpenAI Chat Completions endpoint and pi-ai already implements that protocol, so a sibling package would duplicate wire logic for no behavioral gain.
- **Send `reasoning_effort` unconditionally.** Rejected: SenseNova's endpoint does not document the parameter, and sending an unsupported field risks a 4xx; `supportsReasoningEffort: false` keeps the request clean while still labeling the model reasoning-capable.
