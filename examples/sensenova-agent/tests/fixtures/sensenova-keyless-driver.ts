#!/usr/bin/env node
/**
 * Keyless Loader driver: boot the real profile tree and resolve the
 * SenseNova route's model, proving the hand-declared `llm-pi-ai` route is
 * valid and registered without a key or any network call.
 */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'sensenova-keyless-driver'
const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error(`${NAME}: expected <config-path>`)
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const flash = await ctx.llm.resolveModelInfo('sensenova-deepseek', 'deepseek-v4-flash')
  const lite = await ctx.llm.resolveModelInfo('sensenova-deepseek', 'sensenova-6.8-flash-lite')
  process.stdout.write(`${JSON.stringify({
    ok: true,
    flash: { provider: flash.provider, id: flash.id, contextWindow: flash.context?.contextWindow },
    lite: {
      provider: lite.provider,
      id: lite.id,
      contextWindow: lite.context?.contextWindow,
      inputModalities: lite.inputModalities,
    },
  })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
