import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Default rolling window for per-key usage accounting. The balancer keeps a
 * rough count of how many requests each key served in the trailing window and
 * leans toward the least-used keys, so no single key is hammered ("sheared")
 * while others sit idle. Five hours matches the default quota cooldown
 * (`DEFAULT_KEY_COOLDOWN_MS`): a key banned for a multi-hour limit is also the
 * one the window should have moved traffic away from by the time it rejoins.
 */
export const DEFAULT_KEY_BALANCE_WINDOW_MS = 5 * 3600 * 1000

/**
 * Default stickiness: a chosen key stays pinned this long before the balancer
 * re-evaluates and may move to a different key. Pinning keeps a key in use for
 * a stretch so the provider's per-key prompt cache stays warm — switching keys
 * on every request would scatter the cache and drop its hit rate — while the
 * window still lets the balancer rebalance periodically rather than never.
 */
export const DEFAULT_KEY_STICKY_MS = 5 * 60 * 1000

/**
 * Default session affinity: when a request names a session, the balancer pins
 * that session to one key for the session's life so concurrent sessions spread
 * across the pool instead of all hammering one key (which is what trips a
 * single key's 429). `false` disables the pin and falls back to the global
 * least-loaded + sticky selection.
 */
export const DEFAULT_KEY_PIN_BY_SESSION = true

/**
 * Default session-pin lifetime (ms). A pin older than this is treated as
 * expired and re-chosen, which bounds the pin map for abandoned sessions and
 * lets a long-idle session rebalance to a quieter key. Thirty minutes is long
 * enough to keep a key stable across a normal session for cache locality.
 */
export const DEFAULT_KEY_SESSION_PIN_MS = 30 * 60 * 1000

/** Construction options for {@link createKeyRotationState}. */
export interface KeyRotationOptions {
  /** Rolling window length (ms) for approximate per-key call accounting. */
  windowMs?: number
  /** How long a selected key stays pinned before rebalancing (ms). */
  stickyMs?: number
  /** When a request names a session, pin that session to one key. */
  pinBySession?: boolean
  /** Session-pin lifetime (ms) before it expires and is re-chosen. */
  sessionPinMs?: number
}

/** A session's pinned key and the epoch ms at which the pin expires. */
interface SessionPin {
  index: number
  until: number
}

/**
 * Mutable per-route state for rotating a pool of credential refs.
 *
 * `bannedUntil[i]` holds the epoch-millisecond timestamp (from `Date.now()`)
 * until which `refs[i]` must not be selected. A zero entry means the key is
 * available. The state is Cordis-free and side-effect free apart from the
 * mutations it applies to its own fields, so it is unit-testable in isolation.
 *
 * Load balancing rides the same state: `calls[i]` is the approximate number of
 * requests served by `refs[i]` inside the trailing `windowMs` window, and
 * `stickyUntil` pins `index` for cache locality until it elapses. Session
 * affinity adds `sessionPins`, mapping a session id to the key it is pinned to.
 */
export interface KeyRotationState {
  readonly refs: readonly CredentialRef[]
  /** Index of the currently selected (or last selected) key. */
  index: number
  /** Epoch ms until which `refs[i]` must not be selected; zero means available. */
  bannedUntil: number[]
  /** Approximate request count served by `refs[i]` inside the current window. */
  calls: number[]
  /** Epoch ms when the current rolling window began; resets when it elapses. */
  windowStart: number
  /** Epoch ms until which `index` stays pinned (stickiness for cache locality). */
  stickyUntil: number
  /** Rolling window length (ms) for usage accounting. */
  readonly windowMs: number
  /** Stickiness length (ms): how long a key stays pinned before rebalancing. */
  readonly stickyMs: number
  /** Whether a request naming a session pins that session to one key. */
  readonly pinBySession: boolean
  /** Session-pin lifetime (ms) before it expires and is re-chosen. */
  readonly sessionPinMs: number
  /** session id -> pinned key index and expiry (session affinity). */
  sessionPins: Map<string, SessionPin>
}

/**
 * Build rotation state for a pool.
 *
 * @param refs - The credential refs in selection-preference order; must already
 *   include the primary key plus any additional pooled keys.
 * @param options - Balancer tuning: `windowMs` (usage window, default five
 *   hours), `stickyMs` (stickiness, default five minutes), `pinBySession`
 *   (session affinity, default on), and `sessionPinMs` (pin lifetime, default
 *   thirty minutes).
 * @returns Rotation state seeded with every key available (no cooldowns).
 */
export function createKeyRotationState(
  refs: readonly CredentialRef[],
  options: KeyRotationOptions = {},
): KeyRotationState {
  return {
    refs,
    index: 0,
    bannedUntil: Array.from({ length: refs.length }, () => 0),
    calls: Array.from({ length: refs.length }, () => 0),
    windowStart: 0,
    stickyUntil: 0,
    windowMs: options.windowMs ?? DEFAULT_KEY_BALANCE_WINDOW_MS,
    stickyMs: options.stickyMs ?? DEFAULT_KEY_STICKY_MS,
    pinBySession: options.pinBySession ?? DEFAULT_KEY_PIN_BY_SESSION,
    sessionPinMs: options.sessionPinMs ?? DEFAULT_KEY_SESSION_PIN_MS,
    sessionPins: new Map(),
  }
}

/**
 * Reset per-key call counts when the rolling window has elapsed. The window is
 * approximate by design: counts reset wholesale at the boundary rather than
 * decay per key, which is enough to keep the balancer from over-weighting a key
 * that was busy hours ago.
 * @param state - the per-route rotation state to age.
 * @param now - current epoch milliseconds (`Date.now()`).
 */
function rollWindow(state: KeyRotationState, now: number): void {
  if (state.windowMs > 0 && now - state.windowStart >= state.windowMs) {
    for (let i = 0; i < state.calls.length; i++) state.calls[i] = 0
    state.windowStart = now
  }
}

/**
 * Return the next available credential ref, advancing `index` to it.
 *
 * The balancer prefers the least-used available key within the trailing window
 * (tie broken by pool order) so load spreads across the pool instead of
 * concentrating on one key ("shearing a single sheep"). To keep the provider's
 * per-key prompt cache warm, a chosen key stays pinned for `stickyMs`: while
 * the pin holds and the key is still usable, the same `index` is returned
 * rather than rebalancing every request. A cooled-down key (failure) clears
 * the pin, so the next call rebalances away from it.
 *
 * When `sessionId` is supplied and session affinity is on, the session is
 * pinned to one key: the first request of a session picks the least-loaded
 * available key and records the pin, and every later request of that session
 * reuses it (so concurrent sessions spread across the pool and one session does
 * not pile all its load onto a single key, which is what trips a 429). A pin
 * whose key is cooled, or that has aged past `sessionPinMs`, is dropped and the
 * session rebalances. A request with no `sessionId` uses the global
 * least-loaded + sticky selection above.
 *
 * When every key is still cooling down (total outage), falls back to the
 * current `index` rather than returning `undefined` from a non-empty pool, so
 * the caller retries the least-recently-banned key.
 *
 * @param state - the per-route rotation state to read and advance.
 * @param now - current epoch milliseconds (`Date.now()`).
 * @param sessionId - optional session id for session-affinity pinning.
 * @returns the next available credential ref, or `undefined` for an empty pool.
 */
export function selectActiveKey(
  state: KeyRotationState,
  now: number,
  sessionId?: string,
): CredentialRef | undefined {
  if (state.refs.length === 0) return undefined
  rollWindow(state, now)
  const available: number[] = []
  for (let i = 0; i < state.refs.length; i++) {
    if ((state.bannedUntil[i] ?? 0) <= now) available.push(i)
  }
  // Total outage: every key still cooling. Keep the current index as the last
  // resort and still count the attempt, so the caller retries it.
  if (available.length === 0) {
    state.calls[state.index] = (state.calls[state.index] ?? 0) + 1
    return state.refs[state.index]
  }
  // Session affinity: reuse this session's pinned key while it is live and
  // still usable. The pinned key is also counted, so other sessions' least-loaded
  // choice accounts for this session's load and tends to land on a different key.
  if (sessionId !== undefined && state.pinBySession) {
    const pin = state.sessionPins.get(sessionId)
    if (pin !== undefined) {
      if (pin.until <= now) {
        state.sessionPins.delete(sessionId)
      } else if ((state.bannedUntil[pin.index] ?? 0) <= now) {
        state.calls[pin.index] = (state.calls[pin.index] ?? 0) + 1
        return state.refs[pin.index]
      }
    }
  }
  // Stickiness: if the pinned key is usable and the pin still holds, keep it.
  if (now < state.stickyUntil && (state.bannedUntil[state.index] ?? 0) <= now) {
    state.calls[state.index] = (state.calls[state.index] ?? 0) + 1
    return state.refs[state.index]
  }
  // Rebalance: least-loaded available key, tie broken by pool order. `available`
  // is non-empty here, so its first entry is a valid index.
  let chosen = available[0] ?? 0
  for (const i of available) {
    if ((state.calls[i] ?? 0) < (state.calls[chosen] ?? 0)
      || ((state.calls[i] ?? 0) === (state.calls[chosen] ?? 0) && i < chosen)) {
      chosen = i
    }
  }
  // Pin the session to the chosen key so the session keeps it (and its cache).
  if (sessionId !== undefined && state.pinBySession) {
    state.sessionPins.set(sessionId, { index: chosen, until: now + state.sessionPinMs })
  }
  state.index = chosen
  state.stickyUntil = now + state.stickyMs
  state.calls[chosen] = (state.calls[chosen] ?? 0) + 1
  return state.refs[chosen]
}

/**
 * Drop a session's pin (used when its pinned key is cooled, so the next request
 * rebalances to a fresh key). No-op when the session has no pin.
 * @param state - the per-route rotation state to mutate.
 * @param sessionId - the session whose pin to clear.
 */
export function clearSessionPin(state: KeyRotationState, sessionId: string): void {
  state.sessionPins.delete(sessionId)
}

/**
 * Cool a key down for `cooldownMs` and move `index` past it, so the next
 * `selectActiveKey` chooses a different ref. The pin is cleared too (call
 * {@link clearSessionPin} for the failing session), so the rejection forces a
 * rebalance on the next call rather than re-selecting the banned key until the
 * pin lapses. By default the currently selected key (`state.index`) is banned;
 * pass `banIndex` to ban the exact key a specific session used. No-op on an
 * empty pool.
 *
 * @param state - the per-route rotation state to mutate.
 * @param cooldownMs - milliseconds the rejected key stays cooled.
 * @param now - current epoch milliseconds (`Date.now()`).
 * @param banIndex - index of the key to cool; defaults to `state.index`.
 */
export function coolDownKey(
  state: KeyRotationState,
  cooldownMs: number,
  now: number,
  banIndex: number = state.index,
): void {
  if (state.refs.length === 0) return
  state.bannedUntil[banIndex] = now + cooldownMs
  state.index = (banIndex + 1) % state.refs.length
  state.stickyUntil = now
}
