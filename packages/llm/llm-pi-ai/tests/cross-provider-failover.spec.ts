import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
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
const AUTH_BODY = JSON.stringify({
  error: { message: '403 AccessDenied: model not purchased for this account', type: 'auth', code: 'auth' },
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

/** Mount two routes against one mock server so the script queue is shared across them. */
async function dualHarness(
  baseURL: string,
  primaryModel: PiAiModelProfile = { id: 'deepseek-v4-flash' },
  backupModel: PiAiModelProfile = { id: 'deepseek-v4-flash' },
): Promise<Context> {
  vi.stubEnv('PI_KEY_A', 'key-a')
  vi.stubEnv('PI_KEY_B', 'key-b')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      primary: { apiKeyEnv: 'PI_KEY_A', api: 'openai-completions', baseURL, models: [primaryModel] },
      backup: { apiKeyEnv: 'PI_KEY_B', api: 'openai-completions', baseURL, models: [backupModel] },
    },
  })
  return ctx
}

/** Mount one route with an optional key pool. */
async function singleHarness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  vi.stubEnv('PI_KEY_A', 'key-a')
  vi.stubEnv('PI_KEY_B', 'key-b')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { route: { apiKeyEnv: 'PI_KEY_A', api: 'openai-completions', baseURL, models: [{ id: 'deepseek-v4-flash' }], ...overrides } },
  })
  return ctx
}

const messages = [createUserMessage({
  content: [{ type: 'text', text: 'hi' }],
  source: { kind: 'plugin', plugin: 'test' },
})]

describe('pi-ai cross-provider failover', () => {
  it('fails over to the backup route after the primary is rejected', async () => {
    const server = await mockServer([
      { status: 429, body: RATE_LIMIT_BODY },
      { events: textEvents },
    ])
    const ctx = await dualHarness(server.url, { id: 'deepseek-v4-flash', failover: [{ provider: 'backup' }] })
    const result = await assemble(ctx, { provider: 'primary', model: 'deepseek-v4-flash', messages })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
  })

  it('surfaces the failure after every route in the chain is exhausted', async () => {
    const server = await mockServer([
      { status: 429, body: RATE_LIMIT_BODY },
      { status: 429, body: RATE_LIMIT_BODY },
    ])
    const ctx = await dualHarness(server.url, { id: 'deepseek-v4-flash', failover: [{ provider: 'backup' }] })
    const result = await assemble(ctx, { provider: 'primary', model: 'deepseek-v4-flash', messages })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind === 'error') expect(result.finish.failure.code).toBe('RATE_LIMIT')
    expect(server.headers).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
  })

  it('remaps the wire model id when failing over to a route that names it differently', async () => {
    const server = await mockServer([
      { status: 429, body: QUOTA_BODY },
      { events: textEvents },
    ])
    // Backup serves the model under a different id; the remap must reach the wire.
    const ctx = await dualHarness(
      server.url,
      { id: 'deepseek-v4-flash', failover: [{ provider: 'backup', model: 'deepseek-v4-flash-0731' }] },
      { id: 'deepseek-v4-flash-0731' },
    )
    const result = await assemble(ctx, { provider: 'primary', model: 'deepseek-v4-flash', messages })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers).toHaveLength(2)
    // The backup request must carry the remapped id on the wire.
    expect(JSON.stringify(server.requests[1])).toContain('deepseek-v4-flash-0731')
  })
})

describe('pi-ai key-pool rotation on AUTH', () => {
  it('rotates to the next key after a 403 AUTH rejection and still returns the answer', async () => {
    const server = await mockServer([
      { status: 403, body: AUTH_BODY },
      { events: textEvents },
    ])
    const ctx = await singleHarness(server.url, { apiKeyEnv: 'PI_KEY_A', apiKeyEnvs: ['PI_KEY_B'] })
    const result = await assemble(ctx, { provider: 'route', model: 'deepseek-v4-flash', messages })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
  })
})

describe('pi-ai failover config validation', () => {
  it('refuses a failover target that names an unknown route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmPiAi, {
      providers: {
        primary: {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'http://example.invalid',
          models: [{ id: 'deepseek-v4-flash', failover: [{ provider: 'ghost' }] }],
        },
      },
    })).rejects.toThrow(/failover names unknown route/)
  })

  it('refuses a failover target whose route does not serve the (remapped) model', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmPiAi, {
      providers: {
        primary: {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'http://example.invalid',
          models: [{ id: 'deepseek-v4-flash', failover: [{ provider: 'backup', model: 'absent-model' }] }],
        },
        backup: {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'http://example.invalid',
          models: [{ id: 'other-model' }],
        },
      },
    })).rejects.toThrow(/does not serve model/)
  })

  it('refuses a failover target that names its own route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmPiAi, {
      providers: {
        primary: {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'http://example.invalid',
          models: [{ id: 'deepseek-v4-flash', failover: [{ provider: 'primary' }] }],
        },
      },
    })).rejects.toThrow(/failover lists its own route/)
  })
})
