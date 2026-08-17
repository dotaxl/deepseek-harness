/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Credentials stay outside that collection. The harness resolves a route's key
 * through its own seam and passes it as the request's `apiKey` option, which
 * pi-ai treats as the highest-priority auth override — so `Models` never holds
 * a credential store and the harness keeps its fail-loud reference semantics.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  FinishReason,
  KEY_POOL_EXHAUSTED_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back. `sessionId` is the session
   * the request belongs to, used for session-affinity key pinning when present.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile, sessionId?: string) => Promise<string | undefined>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Called when a stream ends on a key-specific rejection (rate limit or a
   * cooled-down quota/ban). The plugin stamps the just-used key as cooled down
   * here so the next request rotates to a different one; the adapter never
   * mutates rotation state itself. `sessionId` is the session that just failed,
   * so its pinned key can be released for rebalancing.
   * @param provider - the route whose key was rejected.
   * @param code - the harness failure code (`RATE_LIMIT` or `QUOTA`).
   * @param sessionId - the session whose request was rejected, if any.
   */
  onKeyFailure?: (provider: string, code: string, sessionId?: string) => void
}

/**
 * Failure codes that name a single bad key rather than a request or model
 * problem. On either, the adapter swallows the terminal finish and retries the
 * request with the next key in the route's pool instead of ending the turn.
 * The same set also drives cross-provider failover: a captured failure in this
 * set, once a route's key pool is exhausted, moves the request to the next
 * backup route (see {@link PiAiAdapter.stream}). `AUTH` is included because a
 * 403 account denial (e.g. an unpurchased model) is key-specific when a route
 * pools credentials from separate accounts — rotating past it, or failing over
 * to a different vendor, is the correct recovery rather than ending the turn.
 */
const SWITCHABLE_FAILURE_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', QUOTA_EXCEEDED_CODE, 'AUTH'])

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels()
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  /**
   * Outcome of streaming one provider route: the request completed, or it ended
   * on a captured account-level failure whose code the caller uses to decide
   * whether to fail over to the next route.
   */
  private readonly failoverOutcomeOk: FailoverOutcome = { ok: true }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = this.current()
    // The selected route first, then its declared backup routes in order. Each
    // entry is tried whole (its own key pool rotated to exhaustion) before the
    // next; only after every route is exhausted does the turn end. The chain is
    // never empty — the selected route is always first — so the loop below runs
    // at least once and `lastFailure` is always set by the time it ends.
    const chain = this.failoverChain(snapshot, options.provider, options.model)
    let lastFailure!: FinishReason
    for (const [ci, target] of chain.entries()) {
      const isLast = ci === chain.length - 1
      const result = yield * this.streamOnProvider(snapshot, target.provider, target.model, options, isLast)
      if (result.ok) return
      // The route that just failed is cooled where the failure was captured
      // (see streamOnProvider): a non-last route cools and returns, the last
      // route cools on each rotation and on its terminal surface.
      lastFailure = result.failure
    }
    yield { type: 'finish', reason: lastFailure }
  }

  /**
   * The ordered failover chain for one request: the selected route, then its
   * declared backup routes (with each target's wire-model remap applied).
   * Resolution has already refused any target that names an unknown route or a
   * route that does not serve the (remapped) model, so a stale reference left
   * by a later settings edit is the only way a listed route could vanish; the
   * guard drops such an entry instead of looping or failing a request on it.
   * @param snapshot - the frozen profile/collection snapshot for this operation.
   * @param provider - the originally selected provider route.
   * @param model - the originally selected model id.
   * @returns the route/model pairs to try, in order.
   */
  private failoverChain(
    snapshot: PiAiSnapshot,
    provider: string,
    model: string,
  ): readonly { provider: string; model: string }[] {
    const profile = this.profileOf(snapshot, provider)
    // `resolveProfiles` has already refused any target that names an unknown
    // route or a route that does not serve the (remapped) model, so every
    // declared target references a route present in this same snapshot.
    const declared = profile.failover.get(model) ?? []
    const chain = [{ provider, model }]
    for (const target of declared) {
      chain.push({ provider: target.provider, model: target.model ?? model })
    }
    return chain
  }

  /**
   * Stream one request against a single provider route — one key pool. Yields
   * the request's chunks and returns whether it completed (`ok: true`) or ended
   * on a captured account-level failure (`ok: false`). The caller's outer loop
   * drives failover across routes; this method owns only this route's key-pool
   * rotation, except that when `isLast` is false (a backup route remains) a
   * captured switchable failure returns immediately so the caller can abandon
   * this route for the backup rather than burning the remaining keys here.
   *
   * Inside the attempt loop the active key rotates between attempts via
   * `resolveApiKey` + `onKeyFailure`, so a rate-limited or banned key yields to
   * the next without ending the turn. A single-key or keyless route makes
   * exactly one attempt — behavior unchanged. The image and context preparation
   * stays inside the attempt's try so a caller abort still classifies as
   * `ABORTED` rather than surfacing a raw conversion error.
   * @param snapshot - the frozen profile/collection snapshot for this operation.
   * @param provider - the provider route to stream against.
   * @param modelId - the model id to stream against on this route.
   * @param options - the original generate options (provider/model overridden per route).
   * @param isLast - whether this is the last route in the failover chain.
   */
  private async * streamOnProvider(
    snapshot: PiAiSnapshot,
    provider: string,
    modelId: string,
    options: GenerateOptions,
    isLast: boolean,
  ): AsyncGenerator<StreamChunk, FailoverOutcome> {
    const profile = this.profileOf(snapshot, provider)
    const model = this.modelOf(snapshot, provider, modelId)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )

    const total = profile.apiKeyRefs.length
    for (let attempt = 0; ; attempt++) {
      const consumer = new AbortController()
      const upstream = options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])
      using watchdog = idleWatchdog(upstream, profile.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
      const apiKey = await this.config.resolveApiKey(provider, profile, options.sessionId)
      try {
        const containsImage = options.messages.some(message => contentHasImage(message.content))
        if (containsImage && !model.input.includes('image')) {
          throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
        }
        const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
        if (containsImage && attachments === undefined) {
          throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
        }
        const context = attachments === undefined
          ? toPiContext(options)
          : await toPiContext(options, attachments)
        const events = snapshot.models.streamSimple(model, context, {
          ...profileOptions(profile, reasoning, apiKey),
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
          signal: watchdog.signal,
          // Profile headers are deployment-owned; attribution names are
          // Harness-owned and therefore win collisions.
          headers: requestHeaders(profile.headers),
        })
        const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
        let exhausted = false
        let captured!: Extract<FinishReason, { kind: 'error' }>
        try {
          while (true) {
            const result = await watchdog.next(iterator)
            const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
            if (timeout !== undefined) throw timeout
            if (result.done) {
              exhausted = true
              return this.failoverOutcomeOk
            }
            const chunk = result.value
            // A key-specific rejection ends the stream; swallow it. When a
            // backup route remains, abandon this route for it (the caller hands
            // the failure off) instead of rotating the remaining keys here.
            // Otherwise rotate to the next key while one remains; once the pool
            // is exhausted, surface the failure as the terminal chunk.
            if (chunk.type === 'finish' && chunk.reason.kind === 'error'
              && SWITCHABLE_FAILURE_CODES.has(chunk.reason.failure.code)) {
              captured = chunk.reason
              break
            }
            yield chunk
          }
        } finally {
          if (!exhausted) {
            consumer.abort('pi-ai stream consumer stopped')
            try {
              await iterator.return(undefined)
            } catch (_abortedSdkTeardown) {
              // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
            }
          }
        }
        // The attempt loop only leaves via `return` on exhaustion (above) or a
        // `break` after capturing a switchable failure, so `captured` is set.
        // Cool the rejected key, then either hand the failure to the caller for
        // failover (a backup route remains) or, on the last route, rotate to the
        // next key while one remains, else surface the failure as the terminal chunk.
        this.config.onKeyFailure?.(provider, captured.failure.code, options.sessionId)
        if (!isLast) return { ok: false, failure: captured }
        if (total > 1 && attempt < total - 1) continue
        // The whole key pool was tried and every key rejected with a key-specific
        // failure (rate limit, quota, or account auth): retrying would only
        // re-exercise the now-cooled keys, so name the terminal failure distinctly
        // so the agent loop can stop the run instead of churning the pool. A
        // single-key route keeps the original per-key code — pool exhaustion is
        // meaningless for one key.
        const terminal: Extract<FinishReason, { kind: 'error' }> = total > 1
          ? { kind: 'error', failure: { ...captured.failure, code: KEY_POOL_EXHAUSTED_CODE } }
          : captured
        yield { type: 'finish', reason: terminal }
        return { ok: false, failure: terminal }
      } catch (error: unknown) {
        if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
          throw new LlmError(`pi-ai stream idle timeout after ${profile.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
        }
        if (options.signal?.aborted) {
          throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
        }
        throw error
      } finally {
        consumer.abort('pi-ai stream consumer stopped')
      }
    }
  }
}

/** Outcome of streaming one provider route: success, or a captured account-level failure. */
type FailoverOutcome = { ok: true } | { ok: false; failure: FinishReason }
