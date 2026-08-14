import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Mutable per-route state for rotating a pool of credential refs.
 *
 * `bannedUntil[i]` holds the epoch-millisecond timestamp (from `Date.now()`)
 * until which `refs[i]` must not be selected. A zero entry means the key is
 * available. The state is Cordis-free and side-effect free apart from the
 * mutations it applies to its own fields, so it is unit-testable in isolation.
 */
export interface KeyRotationState {
  readonly refs: readonly CredentialRef[]
  index: number
  bannedUntil: number[]
}

/**
 * Build rotation state for a pool.
 *
 * @param refs - The credential refs in selection-preference order; must already
 *   include the primary key plus any additional pooled keys.
 * @returns Rotation state seeded with every key available (no cooldowns).
 */
export function createKeyRotationState(refs: readonly CredentialRef[]): KeyRotationState {
  return { refs, index: 0, bannedUntil: Array.from({ length: refs.length }, () => 0) }
}

/**
 * Return the next available credential ref, advancing `index` to it.
 *
 * Walks the pool starting at the current `index` and returns the first ref
 * whose cooldown has elapsed. When every key is still cooling down (total
 * outage), falls back to the current `index` rather than returning `undefined`
 * from a non-empty pool, so the caller retries the least-recently-banned key.
 *
 * @param state - The per-route rotation state to read and advance.
 * @param now - Current epoch milliseconds (`Date.now()`).
 * @returns The next available credential ref, or `undefined` for an empty pool.
 */
export function selectActiveKey(state: KeyRotationState, now: number): CredentialRef | undefined {
  if (state.refs.length === 0) return undefined
  for (let i = 0; i < state.refs.length; i++) {
    const candidate = (state.index + i) % state.refs.length
    const ref = state.refs[candidate]
    if (ref === undefined) continue
    const cooldown = state.bannedUntil[candidate]
    if (cooldown === undefined || cooldown <= now) {
      state.index = candidate
      return ref
    }
  }
  return state.refs[state.index]
}

/**
 * Cool the currently selected key down for `cooldownMs` and move `index` past
 * it, so the next `selectActiveKey` chooses a different ref. No-op on an empty
 * pool.
 *
 * @param state - The per-route rotation state to mutate.
 * @param cooldownMs - Milliseconds the rejected key stays cooled.
 * @param now - Current epoch milliseconds (`Date.now()`).
 */
export function coolDownKey(state: KeyRotationState, cooldownMs: number, now: number): void {
  if (state.refs.length === 0) return
  state.bannedUntil[state.index] = now + cooldownMs
  state.index = (state.index + 1) % state.refs.length
}
