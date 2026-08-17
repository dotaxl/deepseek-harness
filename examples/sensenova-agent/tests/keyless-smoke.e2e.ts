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
      flash: { provider: string; id: string; contextWindow: number | undefined }
      lite: { provider: string; id: string; contextWindow: number | undefined; inputModalities?: string[] }
    }
    expect(resolved.ok).toBe(true)
    expect(resolved.flash).toEqual({
      provider: 'sensenova-deepseek',
      id: 'deepseek-v4-flash',
      contextWindow: 1000000,
    })
    // The gateway declares text+image input; the declared route must surface it
    // so image admission treats the lite model as image-capable.
    expect(resolved.lite).toEqual({
      provider: 'sensenova-deepseek',
      id: 'sensenova-6.8-flash-lite',
      contextWindow: 262144,
      inputModalities: ['text', 'image'],
    })
  })
})
