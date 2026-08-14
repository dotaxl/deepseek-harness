import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/sensenova-keyless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('sensenova-agent keyless smoke', () => {
  it('boots the real Loader tree and resolves the sensenova-deepseek route', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'sensenova-agent keyless',
      tempDirPrefix: 'sensenova-agent-keyless-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath],
      tsconfigPath,
    })
    expect(stderr).toBe('')
    const line = stdout.trim().split('\n').at(-1)
    expect(line).toBeDefined()
    const resolved = JSON.parse(line!) as {
      ok: boolean
      provider: string
      id: string
      contextWindow: number | undefined
    }
    expect(resolved.ok).toBe(true)
    expect(resolved.provider).toBe('sensenova-deepseek')
    expect(resolved.id).toBe('deepseek-v4-flash')
    expect(resolved.contextWindow).toBe(128000)
  })
})
