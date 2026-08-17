import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

/**
 * Drain one mux stream to completion. The count must stay above the queue's
 * compaction scale so a backlog drain crosses the consumed-prefix compaction
 * boundary while frames keep flowing.
 * @param api - the real proxy, with one subscribed session.
 * @param abort - controller closing the stream after the drain.
 * @returns every frame the stream delivered, in delivery order.
 */
async function collectMux(api: ApiProxy, abort: AbortController): Promise<RpcRequest<MuxFrame>[]> {
  const frames: RpcRequest<MuxFrame>[] = []
  for await (const envelope of api.events.mux({ rpcId: RpcId('mux-backlog'), payload: {} }, abort.signal)) {
    frames.push(envelope)
  }
  return frames
}

describe('mux downlink backlog drain', () => {
  it('delivers a stalled backlog in event order across the compaction boundary', async () => {
    const { ctx, api } = await harness()
    const session = ctx.sessions.create()
    const abort = new AbortController()

    // Open the stream, then stall the consumer while the producer buffers a
    // chunk-rate backlog: every appended event lands in the queue unpulled.
    const drained = collectMux(api, abort)
    const count = 5000
    for (let i = 0; i < count; i++) session.append('turn/start', { turn: i + 1 })
    abort.abort()

    const frames = await drained
    const events = frames.filter(frame => frame.payload.type === 'session/event')
    expect(events).toHaveLength(count)
    let previous = -1
    for (const frame of events) {
      const seq = (frame.payload as { event: { seq: number } }).event.seq
      expect(seq).toBeGreaterThan(previous)
      previous = seq
    }
  })

  it('preserves event order when consumption interleaves with production', async () => {
    const { ctx, api } = await harness()
    const session = ctx.sessions.create()
    const abort = new AbortController()

    const iterator = api.events.mux({ rpcId: RpcId('mux-interleave'), payload: {} }, abort.signal)[Symbol.asyncIterator]()
    try {
      // The subscription baseline frame precedes every event frame.
      const baseline = await iterator.next()
      if (baseline.done) throw new Error('mux stream ended before the baseline')
      expect(baseline.value.payload.type).toBe('session/subscribed')
      for (let round = 0; round < 3; round++) {
        // Produce a batch, then consume exactly that batch before the next.
        for (let i = 0; i < 5; i++) session.append('turn/start', { turn: round * 5 + i + 1 })
        for (let i = 0; i < 5; i++) {
          const next = await iterator.next()
          if (next.done) throw new Error('mux stream ended early')
          expect(next.value.payload.type).toBe('session/event')
        }
      }
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })
})
