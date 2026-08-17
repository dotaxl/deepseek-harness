# Agent Note: Degrading image history for text-only model switches

Status: implemented

English | [中文](2026-08-16-text-only-model-image-degradation.zh.md)

## Problem

Once a session contained an image anywhere in its durable history, `session.selectModel` refused every switch to a model declaring text-only input, and a text-only route re-sent the image on each request to a provider that rejects it. The user was locked out of switching back: the image was already durable, no fork or new session should be required to change models, and the past analysis of the image — the assistant's textual answer — was still in history and useful. The gate also over-blocked: it rejected a switch even when the *next* request would carry no new image at all.

## Decision

Historical images degrade at the request boundary; only fresh input gates.

- `LlmRuntime` resolves the target model's input modalities as part of the existing exact-model lookup (`resolveCallFor` returns them beside the config; `prepareCall` carries them through its registration-bound stream). When the modalities are declared and exclude `image`, every image block in the request — including blocks nested in tool-result content, which `contentHasImage` already walks — is replaced with `[image omitted]` placeholder text before adapter dispatch. Only the request degrades: the session log keeps the original image and any prior assistant analysis of it, and the caller's message objects are untouched. Frozen requests stay frozen. Undeclared modalities leave the request untouched — the adapter remains the enforcement point for content it actually rejects.
- `session.selectModel` gates only on images queued in the agent inbox (`nextTurn`/`nextStep`): those would ship as fresh input the text-only route rejects, so refusing there names the model before the user queues more work. Durable history no longer gates a switch.
- `session.prompt` keeps refusing a prompt carrying a *new* image while the current model is text-only (`attachment-error`): silently degrading an image the user just attached would hide that it was never analyzed.

The SenseNova route's `sensenova-6.8-flash-lite` entry now declares `input: [text, image]` (gateway metadata confirms the model accepts images), so image admission accepts it and the earlier refusal naming 6.8 Flash Lite as image-incapable is gone.

## Alternatives considered

**Keep refusing the switch and require an image-capable model.** Leaves the session pinned to one route family because one historical image — the opposite of what model selection exists for.

**Strip images from the durable log on switch.** The log is the reconstruction source for every model-visible input; deleting durable content to satisfy one route destroys it for every future image-capable route too.

**Degrade fresh attachments as well.** A just-attached image the user expects to be analyzed, silently replaced by a placeholder, is a lie the send-time `attachment-error` prevents cheaply.

## Verification

`packages/llm/llm/tests/service.spec.ts` streams an image-bearing user message plus a tool-result-nested image to a text-only route and asserts the adapter receives placeholder text at both depths while the caller's messages keep their images and the request stays frozen; an undeclared-modality route receives the original message object. `packages/host/apiproxy/tests/api-proxy-models.spec.ts` covers the gate split: a text-only selection over image-bearing durable history succeeds, the same selection with a queued inbox image returns `model-unavailable`, and clearing the queue succeeds again. `examples/sensenova-agent/tests/keyless-smoke.e2e.ts` boots the real composition and asserts the lite model resolves with `inputModalities: ['text', 'image']`.

## Consequences

A session with image history can switch to any model at any time; text-only routes see `[image omitted]` placeholders instead of bytes they would reject, and the conversation's textual memory of the image survives intact. Over-claiming `image` on a model whose gateway rejects it still fails mid-turn (the modality declaration is not verified), but recovery is now one model switch rather than a fork or a new session. The placeholder text is model-visible verbatim and costed as input tokens like any text.
