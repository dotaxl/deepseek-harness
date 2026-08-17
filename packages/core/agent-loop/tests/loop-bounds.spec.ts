/**
 * Terminal bounds for a runaway agent loop: a run-wide turn cap and a
 * consecutive-failed-request cap. Both end a loop that would otherwise spin
 * on one Node event loop and starve the co-located web UI.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { DEFAULT_MAX_CONSECUTIVE_REQUEST_FAILURES, DEFAULT_MAX_STEPS, DEFAULT_MAX_TURNS } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, KEY_POOL_EXHAUSTED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

type Config = {
  maxTurns?: number
  maxConsecutiveRequestFailures?: number
  maxSteps?: number
}

async function harness(adapter: MockAdapter, config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [], ...config })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Register a no-op `echo` tool so a scripted tool-call run can step repeatedly. */
function registerEcho(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo',
    parameters: { text: { type: 'string', required: true } },
    execute: async ({ text }) => [{ type: 'text', text }],
  }))
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('agent-loop terminal bounds', () => {
  it('stops a persistently failing endpoint at the default consecutive-failure cap', async () => {
    const adapter = new MockAdapter(Array.from({ length: DEFAULT_MAX_CONSECUTIVE_REQUEST_FAILURES }, () => fail('busy', 'RATE_LIMIT')))
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('bounds-default-cap'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    // One attempt per consecutive failure, then the cap trips and the run ends.
    expect(adapter.requests).toHaveLength(DEFAULT_MAX_CONSECUTIVE_REQUEST_FAILURES)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })

  it('honors a configured consecutive-failure cap', async () => {
    const cap = 3
    const adapter = new MockAdapter(Array.from({ length: cap }, () => fail('busy', 'RATE_LIMIT')))
    const ctx = await harness(adapter, { maxConsecutiveRequestFailures: cap })
    const agent = ctx.agentLoop.create(SessionId('bounds-configured-cap'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(cap)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })

  it('stops a run that exceeds maxTurns, leaving later input unprocessed', async () => {
    const adapter = new MockAdapter([textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter, { maxTurns: 1 })
    const agent = ctx.agentLoop.create(SessionId('bounds-max-turns'), { provider: 'mock', model: 'mock' })

    agent.followup(userMessage('first'))
    agent.followup(userMessage('second'))
    await agent.whenIdle()

    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    // Only the first message was consumed; the second stays queued.
    expect(adapter.requests).toHaveLength(1)
    expect(agent.status).toBe('idle')
  })

  it('resets the consecutive-failure counter on a successful step', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('bounds-reset'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    // One failure, then success — the cap (8) is not reached and the run completes.
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('ends the run on a key-pool exhaustion even when a recovery listener asks to retry', async () => {
    const adapter = new MockAdapter([fail('all keys rate-limited', KEY_POOL_EXHAUSTED_CODE)])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('bounds-pool-exhausted'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    // A wholesale pool exhaustion is terminal: the run stops after one attempt
    // instead of retrying through the cooled-down pool.
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })

  it('uses the documented default turn cap when unconfigured', async () => {
    const adapter = new MockAdapter([textResponse('a')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('bounds-default-turns'), { provider: 'mock', model: 'mock' })

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    expect(ctx.agentLoop.config.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(agent.status).toBe('idle')
  })

  it('stops a chatty run that exceeds maxSteps, ending the turn with reason max-steps', async () => {
    // Five scripted tool calls but a cap of three: the run stops on its budget
    // before the fourth model round-trip, instead of ballooning the session.
    const adapter = new MockAdapter(Array.from({ length: 5 }, () => toolCallResponse('c1', 'echo', { text: 'x' })))
    const ctx = await harness(adapter, { maxSteps: 3 })
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('bounds-max-steps'), { provider: 'mock', model: 'mock' })

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'max-steps' } },
    })
    expect(agent.status).toBe('idle')
  })

  it('honors a configured maxSteps cap', async () => {
    const adapter = new MockAdapter(Array.from({ length: 4 }, () => toolCallResponse('c1', 'echo', { text: 'x' })))
    const ctx = await harness(adapter, { maxSteps: 2 })
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('bounds-max-steps-configured'), { provider: 'mock', model: 'mock' })

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'max-steps' } },
    })
  })

  it('uses the documented default step cap when unconfigured', async () => {
    const adapter = new MockAdapter([textResponse('a')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('bounds-default-steps'), { provider: 'mock', model: 'mock' })

    agent.followup(userMessage('go'))
    await agent.whenIdle()

    expect(ctx.agentLoop.config.maxSteps).toBe(DEFAULT_MAX_STEPS)
    expect(agent.status).toBe('idle')
  })
})
