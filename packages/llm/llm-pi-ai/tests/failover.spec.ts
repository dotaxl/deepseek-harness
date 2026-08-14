import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import { assemble } from './assemble.ts'

const QUOTA_BODY = JSON.stringify({
  error: {
    message: 'Allocated quota exceeded, please increase your quota limit. insufficient_quota',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
})
const RATE_LIMIT_BODY = JSON.stringify({
  message: 'Rate limit reached, please retry later.',
  type: 'rate_limit',
  code: 'rate_limit',
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL, ...overrides } },
  })
  return ctx
}

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

describe('pi-ai key-pool failover', () => {
  it('rotates to the next key after a quota rejection and still returns the answer', async () => {
    vi.stubEnv('PI_KEY_A', 'key-a')
    vi.stubEnv('PI_KEY_B', 'key-b')
    const server = await mockServer([
      { status: 429, body: QUOTA_BODY },
      { events: textEvents },
    ])
    const ctx = await harness(server.url, { apiKeyEnv: 'PI_KEY_A', apiKeyEnvs: ['PI_KEY_B'] })
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
  })

  it('rotates on a 429 rate-limit as well', async () => {
    vi.stubEnv('PI_KEY_A', 'key-a')
    vi.stubEnv('PI_KEY_B', 'key-b')
    const server = await mockServer([
      { status: 429, body: RATE_LIMIT_BODY },
      { events: textEvents },
    ])
    const ctx = await harness(server.url, { apiKeyEnv: 'PI_KEY_A', apiKeyEnvs: ['PI_KEY_B'] })
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
  })

  it('surfaces a quota failure after exhausting every key in the pool', async () => {
    vi.stubEnv('PI_KEY_A', 'key-a')
    vi.stubEnv('PI_KEY_B', 'key-b')
    const server = await mockServer([
      { status: 429, body: QUOTA_BODY },
      { status: 429, body: QUOTA_BODY },
    ])
    const ctx = await harness(server.url, { apiKeyEnv: 'PI_KEY_A', apiKeyEnvs: ['PI_KEY_B'] })
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind === 'error') expect(result.finish.failure.code).toBe('QUOTA')
    expect(server.headers).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
  })

  it('does not retry when only one key is configured', async () => {
    vi.stubEnv('PI_KEY_A', 'key-a')
    const server = await mockServer([{ status: 429, body: QUOTA_BODY }])
    const ctx = await harness(server.url, { apiKeyEnv: 'PI_KEY_A' })
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish.kind).toBe('error')
    expect(server.headers).toHaveLength(1)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
  })
})
