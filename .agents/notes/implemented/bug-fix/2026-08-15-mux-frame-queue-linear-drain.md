# Agent Note: Linear drain for the mux frame queue

Status: implemented

English | [中文](2026-08-15-mux-frame-queue-linear-drain.zh.md)

## Problem

A `dsh --profile web` host co-locates the browser UI and every agent session on one Node event loop. While a long session streamed, the host sat at 80–90% CPU with ~1 GB RSS — and stayed there minutes after the session log's last append. `sample` showed ~90% of main-thread time in `AsyncGeneratorResumeNext → Builtin_ArrayShift → MoveElements/memmove` with one `writev` per element: `FrameQueue.iterate` in `dsh-host-apiproxy` drained its buffer with `while (buffer.length > 0) yield buffer.shift()`, and the per-connection WebSocket pump (`dsh-client-connection`'s `websocket-downlink.ts`) wrote one `socket.send` per frame. The mux queue receives one frame for every `session/event` of every session — chunk-rate during streaming — and is unbounded, so a downlink the browser could not keep up with buffered tens of thousands of frames; every `shift()` then memmoved the whole remainder, making the drain quadratic. This starved the event loop: user input reached the host late, which is the reported "I send a message and nothing shows up immediately."

The sibling bug on the production side — a chatty run emitting ~60k events per session — is bounded by the agent-loop terminal guards ([note](2026-08-15-agent-loop-runaway-loop-bounds.md)). This note fixes the distribution side, which stayed hot even with no new events because the backlog kept draining.

## Decision

Both the host-side queue and the browser-side inbox that mirror each other now consume through a head cursor instead of `shift()`:

- `FrameQueue` (`packages/host/apiproxy/src/api-proxy.ts`) advances `head` past consumed entries and yields `buffer[head++]`; `push`/`end`/waiter and abort/cleanup semantics are unchanged. Dequeue is O(1) amortized.
- `WebApiClient.readWebSocket`'s inbox (`packages/client/connection/src/client/web-api-client.ts`) gets the same cursor.
- Each drops the consumed prefix only when it dominates the live remainder (`head > 1024 && head * 2 > buffer.length` → `splice(0, head)`), so the array does not grow without bound while remaining mostly append-only. The 1024 floor keeps steady chunk-rate streams from thrashing on splices.

The test-fixture twin of the inbox (`fixture.ts` `drain`) keeps `shift()`: its backlog is bounded by scripted replay frames, never chunk-rate traffic, so the quadratic case is unreachable there.

The mux protocol is unchanged — no frame coalescing, no new backpressure. Socket-level backpressure already exists (the pump awaits each `send` callback); the defect was queue drain cost, not flow control. Coalescing chunk frames remains a follow-up if the wire itself becomes the bottleneck.

## Alternatives considered

**A bounded queue with drop/refresh semantics.** Dropping chunk frames from a saturated downlink would trade completeness for latency, but ordering vs. the `lastSeq` reconnect baseline and per-frame rpcIds make the refresh semantics a protocol redesign. The cursor removes the saturation cause (CPU) without touching the contract.

**`splice(0)` batching inside `iterate`.** Draining N buffered frames in one splice per wake is also linear, but it changes yield granularity and still pays O(remainder) per batch; the cursor is strictly simpler.

## Verification

`packages/host/apiproxy/tests/api-proxy-mux-backlog.spec.ts` drains a real `events.mux` stream against a 5000-event stalled backlog — large enough to cross the compaction boundary — asserting every frame arrives in strictly increasing seq order, plus an interleaved produce/consume round preserving order. Runtime check after the server restart: idle host CPU back under 10% (was 80–90%), and a `sample` of the restarted process shows no `ArrayShift`-dominated stack.

## Consequences

A downlink that falls behind an active agent's chunk rate now drains its backlog in linear time on both ends of the wire, so a slow browser tab costs its own rendering work, not the shared event loop. Backlogged frames are still delivered one `writev` each — latency under extreme backlog is bounded by the socket, not by quadratic array moves. The compaction threshold is a fixed queue-internal scale (like the 1024 floor), not deployment-tunable: it has no consumer-facing meaning.
