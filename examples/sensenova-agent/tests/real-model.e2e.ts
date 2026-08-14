import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/sensenova-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const hasKey = Boolean(process.env.SENSENOVA_API_KEY)

describe.skipIf(!hasKey)('sensenova-agent with real model', () => {
  it('streams a real DeepSeek V4 Flash response with captured reasoning', async () => {
    const { stdout } = await runLoaderSmoke({
      label: 'sensenova-agent real model',
      tempDirPrefix: 'sensenova-agent-real-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'What is 2 + 2? Reply with only the number.'],
      tsconfigPath,
      processTimeoutMs: 120_000,
    })

    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const result = lines.at(-1) as Record<string, unknown>

    // The model answered the arithmetic question.
    expect(result?.['type']).toBe('result')
    expect((result?.['output'] as string | undefined) ?? '').toContain('4')

    // SenseNova returns thinking under `reasoning_content`; the adapter must
    // surface it as a reasoning block in the assistant message.
    expect(stdout).toContain('"type":"reasoning"')
  }, 135_000)
})
