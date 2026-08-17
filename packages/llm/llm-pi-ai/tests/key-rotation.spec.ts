import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  clearSessionPin,
  coolDownKey,
  createKeyRotationState,
  selectActiveKey,
} from '../src/key-rotation.ts'

describe('key-rotation state machine', () => {
  it('walks the pool in order and skips cooled-down keys', () => {
    const refs = [credentialRef('A'), credentialRef('B'), credentialRef('C')]
    const state = createKeyRotationState(refs)

    expect(selectActiveKey(state, 0)).toBe(refs[0])

    coolDownKey(state, 1000, 0) // ban A
    expect(selectActiveKey(state, 0)).toBe(refs[1])
    expect(selectActiveKey(state, 0)).toBe(refs[1]) // idempotent until a miss

    coolDownKey(state, 1000, 0) // ban B
    expect(selectActiveKey(state, 0)).toBe(refs[2])

    coolDownKey(state, 1000, 0) // ban C, wraps to A (still banned)
    expect(selectActiveKey(state, 0)).toBe(refs[0]) // last resort under total outage

    // After every cooldown lapses, all keys rejoin; the balancer prefers the
    // least-loaded, so C (1 use) wins over A and B (2 each).
    expect(selectActiveKey(state, 1001)).toBe(refs[2])
  })

  it('wraps around the pool once every key is usable again', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs)
    expect(selectActiveKey(state, 0)).toBe(refs[0])
    coolDownKey(state, 1000, 0)
    expect(selectActiveKey(state, 0)).toBe(refs[1])
    coolDownKey(state, 1000, 0)
    // Both banned at t=0; A is the last resort.
    expect(selectActiveKey(state, 0)).toBe(refs[0])
    // Past both cooldowns the balancer resumes from the least-loaded key (B, used once vs A's twice).
    expect(selectActiveKey(state, 1001)).toBe(refs[1])
    // Cooling the now-current key (B) forces a move to the other available key.
    coolDownKey(state, 1000, 1001)
    expect(selectActiveKey(state, 1001)).toBe(refs[0])
  })

  it('returns undefined and is a no-op for an empty pool', () => {
    const state = createKeyRotationState([])
    expect(selectActiveKey(state, 0)).toBeUndefined()
    expect(() => { coolDownKey(state, 1000, 0) }).not.toThrow()
    expect(selectActiveKey(state, 0)).toBeUndefined()
  })
})

describe('key-rotation load balancing', () => {
  it('spreads load to the least-used available key when stickiness is off', () => {
    const refs = [credentialRef('A'), credentialRef('B'), credentialRef('C')]
    // stickyMs 0 forces a rebalance every call; windowMs large so counts persist.
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000 })
    // First call: all equal -> lowest index A.
    expect(selectActiveKey(state, 0)).toBe(refs[0])
    // A now leads; next least-loaded is B, then C, then back to A (now tied-lowest).
    expect(selectActiveKey(state, 0)).toBe(refs[1])
    expect(selectActiveKey(state, 0)).toBe(refs[2])
    expect(selectActiveKey(state, 0)).toBe(refs[0])
    expect(state.calls).toEqual([2, 1, 1])
  })

  it('keeps the pinned key across calls within the sticky window', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 5000, windowMs: 10_000 })
    expect(selectActiveKey(state, 0)).toBe(refs[0])
    // Still within the 5s pin: the same key stays selected, no rebalance.
    expect(selectActiveKey(state, 1000)).toBe(refs[0])
    expect(selectActiveKey(state, 4999)).toBe(refs[0])
    // Pin lapses exactly at 5000ms: the balancer re-evaluates and may move.
    expect(selectActiveKey(state, 5000)).toBe(refs[1])
    expect(state.calls).toEqual([3, 1])
  })

  it('rebalances away from a key and clears the pin when it is cooled down', () => {
    const refs = [credentialRef('A'), credentialRef('B'), credentialRef('C')]
    const state = createKeyRotationState(refs, { stickyMs: 5000, windowMs: 10_000 })
    expect(selectActiveKey(state, 0)).toBe(refs[0]) // A pinned for 5s
    expect(selectActiveKey(state, 1000)).toBe(refs[0]) // still pinned
    coolDownKey(state, 1000, 1000) // ban A until t=2000, clear pin
    // A is banned and the pin is gone, so the least-loaded available key wins (B).
    expect(selectActiveKey(state, 1000)).toBe(refs[1])
    // A rejoins after its cooldown; with stickiness it is now re-pinnable.
    expect(selectActiveKey(state, 2000)).toBe(refs[1])
  })

  it('resets usage counts when the rolling window elapses', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 1000 })
    expect(selectActiveKey(state, 0)).toBe(refs[0]) // A:1
    expect(selectActiveKey(state, 0)).toBe(refs[1]) // B:1 (tie -> B next lowest? A leads)
    // A leads 1:1 -> B chosen (calls A=1,B=1 tie, B lower leads? both 1, lowest index A)
    expect(state.calls).toEqual([1, 1])
    // Jump past the 1s window: counts reset, selection starts from the lowest index.
    expect(selectActiveKey(state, 1000)).toBe(refs[0])
    expect(state.calls).toEqual([1, 0])
  })

  it('still serves the last-resort key under a total outage', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000 })
    coolDownKey(state, 1000, 0) // ban A
    coolDownKey(state, 1000, 0) // ban B, index wraps to A (still banned)
    expect(state.bannedUntil).toEqual([1000, 1000])
    expect(selectActiveKey(state, 0)).toBe(refs[0]) // last resort, not undefined
    expect(selectActiveKey(state, 1001)).toBe(refs[1]) // both rejoined; balancer prefers the less-used B
  })
})

describe('key-rotation session affinity', () => {
  it('pins a session to one key across its requests', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000 })
    expect(selectActiveKey(state, 0, 'sess-1')).toBe(refs[0])
    // Same session keeps its pinned key, even past the sticky window.
    expect(selectActiveKey(state, 5000, 'sess-1')).toBe(refs[0])
    expect(selectActiveKey(state, 9000, 'sess-1')).toBe(refs[0])
    expect(state.sessionPins.get('sess-1')?.index).toBe(0)
  })

  it('spreads two concurrent sessions to different keys', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000 })
    const first = selectActiveKey(state, 0, 'sess-1') // pins A (lowest index)
    const second = selectActiveKey(state, 0, 'sess-2') // least-loaded -> B (A now leads)
    expect(first).toBe(refs[0])
    expect(second).toBe(refs[1])
    expect(state.calls).toEqual([1, 1])
    // Each session keeps its own key thereafter.
    expect(selectActiveKey(state, 100, 'sess-1')).toBe(refs[0])
    expect(selectActiveKey(state, 100, 'sess-2')).toBe(refs[1])
  })

  it('rebalances a session away from its cooled pin', () => {
    const refs = [credentialRef('A'), credentialRef('B'), credentialRef('C')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000 })
    expect(selectActiveKey(state, 0, 'sess-1')).toBe(refs[0]) // pins A
    clearSessionPin(state, 'sess-1')
    coolDownKey(state, 1000, 0, 0) // ban A specifically
    // The session re-chose a fresh key (B or C), not the banned A.
    expect(selectActiveKey(state, 0, 'sess-1')).toBe(refs[1])
    expect(state.sessionPins.get('sess-1')?.index).toBe(1)
  })

  it('clears an expired pin and re-choses', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000, sessionPinMs: 1000 })
    expect(selectActiveKey(state, 0, 'sess-1')).toBe(refs[0]) // pins A until t=1000
    // Past the pin lifetime the session re-choses; with A having the lead load
    // and stickiness off, the balancer may move it to B.
    const after = selectActiveKey(state, 1000, 'sess-1')
    expect(after).toBe(refs[1])
    expect(state.sessionPins.get('sess-1')?.index).toBe(1)
  })

  it('falls back to global selection when pinning is disabled', () => {
    const refs = [credentialRef('A'), credentialRef('B')]
    const state = createKeyRotationState(refs, { stickyMs: 0, windowMs: 10_000, pinBySession: false })
    // Session id is ignored: behaves like the global least-loaded selection.
    expect(selectActiveKey(state, 0, 'sess-1')).toBe(refs[0])
    expect(selectActiveKey(state, 0, 'sess-1')).toBe(refs[1])
    expect(state.sessionPins.size).toBe(0)
  })
})
