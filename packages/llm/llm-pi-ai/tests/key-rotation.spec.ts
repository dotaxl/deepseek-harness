import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
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

    // After A's cooldown lapses it rejoins.
    expect(selectActiveKey(state, 1001)).toBe(refs[0])
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
    // Past both cooldowns the cycle resumes from A.
    expect(selectActiveKey(state, 1001)).toBe(refs[0])
    coolDownKey(state, 1000, 1001)
    expect(selectActiveKey(state, 1001)).toBe(refs[1])
  })

  it('returns undefined and is a no-op for an empty pool', () => {
    const state = createKeyRotationState([])
    expect(selectActiveKey(state, 0)).toBeUndefined()
    expect(() => { coolDownKey(state, 1000, 0) }).not.toThrow()
    expect(selectActiveKey(state, 0)).toBeUndefined()
  })
})
