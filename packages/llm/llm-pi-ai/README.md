# @deepseek-ai/dsh-llm-pi-ai

English | [中文](README.zh.md)

Generic multi-provider adapter for the harness LLM seam backed by [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai). One plugin instance owns a dict of provider profiles keyed by route; every request selects a profile with `GenerateOptions.provider` and resolves `GenerateOptions.model` against that route's configured catalog. A route naming an installed pi-ai provider inherits its endpoint, wire protocol, and model catalog as defaults and overrides them field by field; a route pi-ai does not ship is declared outright, so an OpenAI-compatible gateway, a self-hosted server, or a provider newer than the installed catalog is configuration rather than a code change.

The package root exposes the Cordis plugin contract, `PiAiAdapter`, and `supportedProtocols()`; profile resolution, catalog materialization, provider construction, replay conversion, and stream conversion remain package-internal.

## Config

Configure credentials, the model catalog, and deployment-specific transport settings per provider, keyed by the provider route itself. `apiKeyEnv` is a credential *reference* resolved per request, so no secret enters this file. Omitting it leaves the route unauthenticated, which for an installed catalog route means pi-ai's provider-native ambient discovery; a configured reference that resolves to nothing fails the request with `MISSING_CREDENTIAL` instead, because falling through would authenticate with whatever unrelated key the environment happens to hold. One credential serves every model on its route.

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      # Catalog route: endpoint, protocol, and models all come from pi-ai.
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      # Catalog route with its catalog narrowed to one model and that model's
      # capacity corrected; every unset field still comes from the catalog.
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      # Catalog route with one model reshaped in place; the rest of the
      # catalog keeps serving (a models list would replace it instead).
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        modelOverrides:
          deepseek-v4-pro:
            reasoningEfforts:
              off:
              high: high
      # Hand-declared route: pi-ai ships nothing under this key, so the profile
      # supplies the whole provider.
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        # Reasoning dialect for an endpoint whose URL pi-ai cannot recognize.
        compat:
          thinkingFormat: deepseek
        models:
          - id: acme-large
            name: Acme Large
            contextWindow: 65536
            maxTokens: 4096
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            maxTokens: 32768
            # key = selectable level, value = its wire spelling; only off may
            # leave the value empty (supported, send nothing).
            reasoningEfforts:
              off:
              high: high
              max: ultra
```

The dict shape makes duplicate routes unrepresentable, and the pre-release array shape (with per-profile `provider` fields) fails load with migration directions. `providers` may also be empty or omitted entirely: the adapter then mounts **dormant** — zero routes, no extra catalog entries — and registers routes the moment the `llm-pi-ai:` settings section supplies profiles, dropping them again when it empties. Dormant or not, the plugin declares every installed catalog provider in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`, settings path `providers.<provider>`), joined with every route the current profiles declare, so configuration surfaces can offer the full catalog before any route exists and can still address a hand-declared one. Each entry carries `declared`: whether pi-ai ships nothing under that key. It follows the installed catalog, never the settings document, because narrowing a shipped provider's models stores a profile too and that route is still one pi-ai knows — only the adapter can tell the two apart, which is why the directory answers rather than leaving a surface to infer it. Which adapters exist is composition; which providers run can be entirely the user's settings document. Registration with `ctx.llm` is atomic: a collision with any provider route already owned by another adapter fails plugin loading without registering the remaining routes. Model ids are not lifecycle config; a model the route does not configure fails before any provider request with `LlmError('UNKNOWN_MODEL')`.

## Catalog resolution

A profile's `models` list *replaces* the route's installed catalog rather than extending it; omitting it (or leaving it empty) serves that catalog unchanged. Each entry defaults its unset fields from the installed model of the same `id`, so narrowing a catalog route to two models, correcting one capacity, or adding a model newer than the installed catalog are all one-line edits — but declaring any `models` list means every model the route should keep serving must appear in it, an entry of nothing but `id` being enough. The configurable entry fields are `id`, `name`, `contextWindow`, `maxTokens`, `reasoningEfforts`, `compat`, `input`, and `failover`. Pricing has no harness consumer and rides the installed entry or is absent.

`modelOverrides` reshapes individual installed-catalog models without that cost: each key is a catalog model id, each value the same fields a `models` entry takes with the id living in the key, and the rest of the catalog keeps serving untouched — "correct one model, keep the other thirty-seven" as a three-line edit. An override becomes that catalog entry's configuration, so capacities, efforts, and compat resolve through the same path with the same diagnostics and the same request-default semantics as a `models` entry. Overrides are only meaningful on a catalog route serving its catalog: one set beside a `models` list (which already replaces the catalog), on a hand-declared route (whose models are fully spelled in `models`), or naming a model the catalog does not describe is refused rather than skipped, because a silently unchanged model is a typo someone would otherwise hunt for.

### Per-model reasoning efforts

`reasoningEfforts` declares a model's selectable thinking levels: each key is a level selectors offer, its value the spelling dispatch sends on the wire, so `high: high` passes the canonical name through while `max: ultra` renames it for a gateway with its own vocabulary. Keys come from pi-ai's level set (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); a level not declared is not offered. Omitting the field keeps the installed catalog entry's capability (a hand-declared model has none and does not reason); `false` declares a non-reasoning model, which is how a profile strips reasoning from a catalog model its gateway cannot serve; an empty declaration is refused rather than guessing between those two meanings.

The declaration translates to pi-ai's `Model.reasoning` + `thinkingLevelMap` with every level decided explicitly — undeclared levels are pinned unsupported rather than left to pi-ai's own defaulting, which is asymmetric (an absent key means "supported" for the five base levels but "unsupported" for `xhigh`/`max`) and which a profile author should not need to know. `off` is the one three-state key: left out, selectors offer no Off and an explicit Off request is refused — a request naming no effort still goes out without the parameter, so what the provider then does is its own default; declared with no value (`off:`), Off is offered and selecting it sends nothing — for the `deepseek` dialect an explicit `thinking: {type: "disabled"}` — which also covers a request naming no effort at all; declared with a value (`off: none`), that value goes on the wire as the effort parameter. There is no spelling for restoring a catalog map key to "unset": the declaration is the whole offer, so restate the catalog levels you keep.

### Reasoning-dispatch compat switches

How a thinking level travels — `reasoning_effort` alone, DeepSeek's `thinking: {type}` plus effort, z.ai's `thinking` object, and so on — is pi-ai's `compat.thinkingFormat`, which pi-ai guesses from the endpoint URL; a private gateway's URL says nothing, so a DeepSeek-dialect gateway would be spoken to in the OpenAI dialect with no way to correct it. `compat.thinkingFormat` and `compat.supportsReasoningEffort` are therefore configurable on the route (its models' default) and per model (winning per field), resolving model → route → installed catalog entry → pi-ai's URL-derived guess; setting a route-level switch shadows the catalog entry's value for every model on the route, and there is no spelling for handing a field back to the catalog short of restating its value. `thinkingFormat` accepts pi-ai's dispatchable formats except the two `chat-template` variants, which need `chatTemplateKwargs` this configuration does not expose. Both switches exist only on `openai-completions` — the other protocols carry their reasoning shape in the protocol itself — so a model-level switch elsewhere fails resolution, a route-level one skips models of other protocols, and a route with no `openai-completions` model at all is refused. The rest of pi-ai's compat surface (`supportsStore`, `maxTokensField`, …) stays auto-detected and is deliberately not configurable here.

A model neither the entry nor the installed catalog sizes takes the route's `defaultContextWindow` (262,144) and `defaultMaxTokens` (32,768), so a listing that discloses nothing but ids still yields a serviceable route. Both fallbacks are guesses by construction, which is why they are route fields a deployment whose gateway serves smaller models corrects once rather than constants buried in the adapter; the fallback sizes the model and never becomes a per-request cap.

Request modalities resolve entry `input` → installed catalog entry → route `defaultInput` (default `[text]`), the same order and the same fallback role the capacities above use. So a catalog model keeps the modalities the catalog records for it, and a narrower route default never strips them; a gateway whose *undescribed* models all take images declares `[text, image]` once at the route instead of on every entry. An entry's empty list means the same as an absent one — it describes a model accepting nothing, so it states no answer and resolution continues past it, which is what keeps a catalog model's own modalities when a `models` entry names it without declaring any. The route's may not be empty, since nothing sits below it to answer instead.

`[text]` is the absence of a declaration rather than a guess at the endpoint, which is why the fallback here is conservative where the capacity fallbacks are merely plausible. Nothing interrogates a gateway for what it accepts, and the two wrong answers do not cost the same: the harness refuses an image before it is attached when a model's modalities omit one, so under-claiming costs a refusal naming the model, while over-claiming admits an image the provider then rejects mid-turn — after the message is durable, which leaves the session repeating a request that cannot succeed.

Resolution still fails loud, naming the offending route and model, when a route cannot be served at all: a route the catalog does not ship needs `api`, `baseURL`, and a non-empty `models` list of uniquely-identified models. That resolution runs inside the section schema, so an unserviceable profile is refused **where it is written** — `settings.mutate` answers `settings-rejected` naming the route and model — rather than being stored and then quietly disabling every route in the namespace. The settings seam keeps a namespace's last good value for an already-stored section that fails, so this cannot strand a deployment. `api` accepts the protocols in `supportedProtocols()` and is only needed when the catalog cannot supply one: a model absent from the catalog inherits the protocol its shipped siblings agree on, so adding a model to a single-protocol catalog route restates nothing.

`baseURL` sets the endpoint of every model on the route, so private proxies such as `https://proxy.example.com:8443` remain supported; a catalog route that omits it keeps each catalog model's own endpoint. Naming `api` on a catalog route repoints the whole route at that protocol, which is how a deployment moves a provider between, say, Responses and Chat Completions.

`supportedProtocols()` is deliberately narrower than pi-ai's full streaming API set: it holds only the protocols a profile can *completely* describe with a key, an endpoint, and headers. Bedrock signs with SigV4 over AWS credentials and a region, Vertex needs a project, a location, and application-default credentials, Azure needs provider environment plus an api-version, and Codex authenticates through OAuth — offering those would hand back a route that cannot authenticate. Catalog routes still reach them through their own provider; only an explicit override is refused.

## Dynamic configuration (settings + credentials)

The adapter reads its profiles through a thunk **once per operation** instead of freezing them at construction. The plugin registers the `llm-pi-ai` namespace on the optional `ctx.settings` seam with this same `Config` schema and its `cordis.yml` entry as the composition `base`, and because `providers` is a dict, the base and the user's `llm-pi-ai:` settings section merge **per provider**: a user can add a route, override one field of a composition route, or point a route at another proxy, all effective on the next request with no restart. Without a mounted settings service the entry config alone drives the adapter, unchanged.

Credentials resolve per stream call through `apiKeyEnv` and the optional `ctx.credentials` seam; without that seam, the adapter reads exactly the referenced environment variable. A profile naming no credential at all — and only that case — defers to pi-ai's ambient discovery. Every resolved key is trimmed and format-checked before use, so a value no HTTP header can carry is refused instead of surfacing as an opaque `fetch` `TypeError`; the refusal throws `LlmError('INVALID_CREDENTIAL')` naming the failing route and credential reference but never any part of the key. The route set and each route's captured retry policy are the registration-level facts: when either changes, the plugin replaces its registration atomically (same adapter instance, candidate set validated first), so a route another adapter already owns leaves the previous routes serving and reverting to a working configuration re-applies. Provider key order never counts as a change. A section this adapter could not serve is refused where it is written — the registered `validate` resolves the whole profile set, so `ctx.settings.mutate` rejects with the resolver's own error (the wire surface reports it as `settings-rejected`) and nothing is stored. A stored section that becomes unserviceable some other way — an external edit of `settings.yaml` — keeps the namespace's last good value at the settings seam and warns. The entry config itself still fails plugin load, and a route the llm registry refuses (one another adapter family already owns) is logged while the previously registered routes keep serving.

The adapter exposes each configured route's models through `ctx.llm.listModels(provider)`. This is provider-neutral selector metadata read from the same pi-ai `Models` collection the request path uses, so discovery does not create a second model registry. `ctx.llm.resolveModelInfo(provider, model)` performs that exact descriptor lookup once and returns its identity, context window, configured output cap, and selectable thinking levels, keeping authoritative metadata on the route-owning adapter rather than its consumers. A model's **configured** `maxTokens` becomes the seam's `defaultMaxTokens`, so a request that names no output cap carries the one the deployment chose; a value inherited from the installed catalog is the model's output *capability* and never becomes a request default on its own.

A model that carries reasoning metadata — from the installed catalog or from its entry's `reasoningEfforts` — exposes pi-ai's ordered `getSupportedThinkingLevels(model)` result without filtering or normalization, including `off` and the model-specific availability of `xhigh` or `max`. The Harness exposes each canonical pi-ai level as an opaque ID; provider/model wire spellings remain inside pi-ai's `thinkingLevelMap`.

A model **without** that metadata — a hand-declared one whose entry declares no `reasoningEfforts`, and a catalog model pi-ai marks as non-reasoning — exposes no `reasoning` at all. pi-ai reports such a model as supporting the single level `off`, but `off` is translated to *omitting* the reasoning option, which is byte-for-byte the request that naming no effort already produces: selecting it could not disable anything, so a provider whose own default is to think would keep thinking with `off` shown as selected. Reporting the capability as unavailable leaves a surface offering the provider's default and nothing that misrepresents it. The profile `reasoning` value, including `off`, is the deployment default when configured; omitting it preserves the provider default. Per-request `GenerateOptions.reasoningEffort` takes precedence, and a level absent from the exact model capability fails the REQUEST with `UNSUPPORTED_REASONING_EFFORT` before network I/O instead of being clamped. Describing a model never fails that way: the models under one provider disagree about which levels they accept, so `resolveModel` reports a profile level the exact model cannot take as no default at all rather than throwing. A throw there would take the whole provider out of every model catalog built over it — one mis-set profile field hiding even the models that do support the level — so a bad configuration surfaces where it is acted on, not where it is described. pi-ai's common stream options represent `off` by omitting `reasoning`.

Supported profile fields are `apiKeyEnv`, `apiKeyEnvs`, `keyCooldownMs`, `rateLimitCooldownMs`, `keyBalanceWindowMs`, `keyStickyMs`, `keyPinBySession`, `keySessionPinMs`, `displayName`, `api`, `baseURL`, `models`, `modelOverrides`, `compat`, `defaultContextWindow`, `defaultMaxTokens`, `defaultInput`, `headers`, `reasoning`, `thinkingBudgets`, `cacheRetention`, `transport`, `timeoutMs`, `websocketConnectTimeoutMs`, `streamIdleTimeoutMs`, and `retryPolicy`. Each profile's optional retry policy is captured with that provider route; omission uses bounded normal defaults. The stream-idle interval is a positive finite Node timer delay, defaults to five minutes, and covers only an outstanding provider read, not consumer think time. Harness app attribution wins a conflicting configured header name.

The adapter forces pi-ai's SDK `maxRetries` to zero so one `stream()` call makes one provider request. The removed profile fields `maxRetries` and `maxRetryDelayMs` fail load instead of silently multiplying or hiding the separately composed agent-level retry budget. Idle expiry aborts the SDK's stable request signal and surfaces `TIMEOUT`; an earlier caller abort remains `ABORTED`.

## Key pool and circuit breaking

A route can serve more than one credential. `apiKeyEnv` stays the primary reference; `apiKeyEnvs` adds further references into one ordered pool. On a **key-specific rejection** — a rate limit (`RATE_LIMIT`) or a quota/ban (the harness `QUOTA` code, e.g. `insufficient_quota`) — the adapter swallows the terminal finish and retries the same request with the next key in the pool, rather than ending the turn. The rejected key is cooled down so the rotation skips it for a while: `keyCooldownMs` (default five hours) after a hard quota ban, `rateLimitCooldownMs` (default sixty seconds) after a 429. A single-key or keyless route makes exactly one attempt, so existing behavior is unchanged.

### Load balancing across the pool

Rotation is also **proactive**, not only reactive to failures. Each key carries an approximate request count over a trailing `keyBalanceWindowMs` window (default five hours), and the adapter prefers the **least-used available key** so traffic spreads across the pool instead of concentrating on one key ("shearing a single sheep" while the rest sit idle). A selected key stays **pinned** for `keyStickyMs` (default five minutes) before the balancer re-evaluates — pinning keeps one key in use for a stretch so the provider's per-key prompt cache stays warm, because switching keys on every request would scatter that cache and drop its hit rate. The window still lets the balancer rebalance periodically rather than never: after the pin lapses it may move to a quieter key, and a rejection immediately clears the pin and rebalances away from the cooled key. Counts reset wholesale when the window elapses (approximate by design), so a key busy hours ago does not keep weighting traffic away from it. Both knobs are per-route config fields with the defaults above; a single-key route is unaffected.

### Per-session affinity

When a request names a session, the route **pins that session to one key** (`keyPinBySession`, default on). The first request of a session picks the least-loaded available key and records the pin; every later request of that session reuses it. Because each session's load counts against its pinned key, concurrent sessions spread across the pool instead of all hammering one key — which is what trips a single key's 429 — while a single session keeps one key so its per-key prompt cache stays warm. The pin lasts `keySessionPinMs` (default thirty minutes) and is released if its key is cooled or the pin ages out, after which the session rebalances to a quieter key; a request with no session id (or with pinning disabled) uses the global least-loaded + sticky selection above. A key rejection still cools the exact key the session used and forces the next request onto a different one.

The rotation state lives in the plugin's `apply()` closure, keyed by route, and is shared between the per-request `resolveApiKey` (which picks the next usable key) and `onKeyFailure` (which cools the just-used key). Because `stream()` makes one provider request per attempt, a route with N keys retries up to N−1 times before surfacing the failure — there is no hidden multiplier. The state rebuilds when a route's reference pool changes identity, dropping stale cooldowns, so a settings edit takes effect on the next request.

Compose this with the agent-level `llm-retry` policy deliberately: the adapter already handles rate-limit/quota failover, so the route's `retryPolicy` need not retry those codes (doing so would re-run the whole rotation loop). Leave `retryableCodes` for transient transport/server errors, or set `maxRetries: 0` to delegate all failover to the key pool.

## Cross-provider failover

Key-pool rotation saves a run when *one* key is rejected, but it cannot help when the rejection is **account-level**: a rate limit, a quota/ban, or a 403 `AUTH` denial that names the whole account rather than one credential. When a route's keys share one account — the common case for a vendor-supplied multi-key plan — an account cap (e.g. a "5-hour usage limit") rejects every key at once, so rotating within the route just replays the same denial until the pool is exhausted and the turn ends. The only recovery is a *different* account, which in practice means a different provider route.

`failover` is a **per-model** list of backup routes that the adapter walks once the model's own key pool is exhausted on an account-level failure. Each entry names another route that also serves the model, with an optional `model` remap for the wire id when the backup spells the same model differently:

```yaml
providers:
  sensenova-deepseek:
    apiKeyEnv: SENSENOVA_API_KEY
    apiKeyEnvs: [SENSENOVA_API_KEY_2, …, SENSENOVA_API_KEY_10]
    api: openai-completions
    baseURL: https://token.sensenova.cn/v1
    models:
      - id: deepseek-v4-flash
        reasoningEfforts:
          off:
          high: high
        failover:
          - provider: qwen-token-plan
            model: deepseek-v4-flash-0731
  qwen-token-plan:
    apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY
    baseURL: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
    models:
      - id: deepseek-v4-flash-0731
        reasoningEfforts:
          off:
          high: high
```

The failover chain is the selected route, then its declared backups in order. Inside one route the key pool rotates to exhaustion as above; only once *every* key on a route is spent does the adapter hand the captured failure to the next route, which starts its own pool fresh. A captured failure on the **last** route in the chain surfaces as the turn's terminal `finish {kind:'error'}`, so a fully exhausted chain still ends the turn exactly as before — failover only ever *adds* routes, it never loops or softens a genuine dead end. The chain is built from the *selected* model's `failover` only, so a backup route's own `failover` is ignored unless that backup is itself the selected route: there is no recursion and no ping-pong between two routes that list each other.

`AUTH` (a 403) is one of the switchable codes, so a 403 account denial rotates the key pool exactly like a 429, and once the pool is spent hands off to the backup route — a model a route is not entitled to on its own account is retried on the backup's account rather than ending the turn. The same cross-route existence check refuses a `failover` entry that names its own route, an unknown route, or a route that does not serve the (remapped) model, so a typo fails load (`settings-rejected` naming the route and model) instead of silently abandoning a request to an unserviceable backup mid-turn.

Compose the two mechanisms deliberately: the key pool is **intra-account** rotation (one key for another on the same vendor), `failover` is **cross-account / cross-vendor** rotation (one vendor for another). A single-key route with a `failover` skips straight to the backup on the first account-level rejection; a multi-key route exhausts its own pool first, then fails over. Both are inside one `stream()` call, so `retryPolicy` should still avoid retrying the same switchable codes, or set `maxRetries: 0`, lest the agent-level retry re-run the whole chain.

## Endpoint interrogation

The plugin offers `ctx.llm.registerModelDiscovery('llm-pi-ai', …)`, which answers "which models can this provider serve?" for a route a configuration surface is editing or drafting. It is deliberately *not* a catalog refresh: nothing is stored, and the reply is candidates the surface offers for adoption. `settings.yaml` remains the only thing that decides what a route serves.

A request naming a route the **installed catalog ships is answered from that catalog**, with no network call: pi-ai's registry is the authoritative list for its own providers, and it carries the context windows and output caps a listing endpoint would not disclose. Such a route needs no `baseURL` at all. Only a route the catalog does not describe — a gateway, a self-hosted server — is interrogated over the wire, and one that names no endpoint is told to set one or enter its models by hand.

A draft carries the credential the user typed, if any; a route that already stored one shows a configuration surface only a redacted descriptor, so the interrogation resolves that route's `apiKeyEnv` rather than going out unauthenticated and reporting the endpoint's 401 as a wrong key. A typed key wins, being the one under test. Resolution happens only on the path that reaches the network, so a catalog route answers without touching credentials at all. A supplied or stored probe key is trimmed and format-checked the same way, so a value no HTTP header can carry is refused immediately as `LlmError('INVALID_CREDENTIAL')` instead of reaching `fetch`, where it would surface as an opaque `ByteString` failure indistinguishable from an unreachable endpoint.

Interrogation reads `openai-completions` and `openai-responses`, whose `GET /models` shape with bearer auth is the one a gateway, a self-hosted server, and the official endpoints all agree on. Azure is excluded despite its OpenAI lineage — it authenticates with an `api-key` header and requires an `api-version` query — and Codex uses OAuth; every other protocol answers `DISCOVERY_UNSUPPORTED` so the surface falls back to hand-entry instead of an authentication failure being reported as a provider with no models. The `baseURL` is treated as a prefix rather than a URL to resolve against, so a deployment path such as `https://gateway.example/openai/v1` keeps its segments.

Most listings disclose an id and nothing else; `context_window`/`context_length` and `max_output_tokens`/`max_tokens` are read when a gateway supplies them, entries without a usable id are skipped rather than failing the whole listing, and everything else the adopting surface still owes. The reply is read under a four-megabyte ceiling enforced on the bytes actually received — the endpoint is a URL the user typed, so a declared length is checked first but never trusted as the bound. An unreachable endpoint, a refused credential, a non-JSON body, and a body with no `data` array all fail with `DISCOVERY_FAILED` and a message naming the endpoint and, for a 401 or 403 alone, the credential. Cancellation during the body read surfaces as `ABORTED`, like a cancellation before the request went out.

## Provider/model routing and replay

Each resolution produces one **immutable** snapshot — the profiles plus a `createModels()` collection holding the `Provider` each route built — and every operation captures a whole snapshot before its first `await`. A configuration change builds a *new* collection rather than mutating the one in use: `Models.streamSimple()` resolves its provider lazily, when the stream is first consumed, which is after the credential await, so a mutated collection would let a request that started under one configuration finish under another or fail on a provider that no longer exists. This is what makes the seam's per-step call freeze (`llm.prepareCall()`) hold end to end — switching models mid-reply takes effect on the next step, never inside the one in flight. Requests reach their provider through `Models.streamSimple()`. A catalog route that keeps its catalog protocol **reuses** the installed provider with its model list replaced, because that provider owns API implementations this package cannot reconstruct — Bedrock loads its Smithy module through a separate entry point — so rebuilding it from parts would silently narrow which providers work. Every other route is built by `createProvider()` over the protocol table behind `supportedProtocols()`, whose entries are the same factories pi-ai's own provider factories use.

Credentials never enter that collection. The harness resolves a route's key through its own seam before the request reaches pi-ai and passes it as the request's `apiKey` option, which pi-ai treats as the highest-priority auth override; `Models` therefore holds no credential store, and the harness keeps its fail-loud reference semantics. A route naming no credential resolves as configured-but-keyless and leaves the requirement to the protocol, which is where it actually lives.

The selected model descriptor supplies the protocol implementation. This includes native API differences such as OpenAI models whose descriptor uses the Responses API rather than Chat Completions; the harness adapter does not hardcode endpoint selection by model name.

Successful assistant responses store a versioned, lossless-JSON replay state beside the provider and model that produced them. At request time, `LlmRuntime` passes replay state only when the historical provider route and target provider route are currently owned by this same `PiAiAdapter` instance. The adapter validates the state and restores pi-ai response ids and provider signatures even when the target provider or model changes; pi-ai then decides which metadata its target API can reuse. History without replay state is translated as foreign provider-neutral content and never impersonates a native pi-ai response.

The finish chunk of a successful response carries `answeredBy` — the route and model that actually answered. A key-pool or cross-provider failover may answer on a different route than the request named, and the loop stamps the logged assistant source from `answeredBy`, so the source beside a replay state names the route that state was captured on. Absent `answeredBy` means the requested route answered.

If a listener rewrites assembled assistant content, the loop drops replay state before logging the message because its provider metadata no longer describes the content. A replay state whose recorded provider or model disagrees with the message source degrades to a foreign projection — content is kept, pi-ai signature continuity is not — because logs written before finish chunks carried `answeredBy` record the requested route as source while a failover answered elsewhere; failing the turn would strand the session permanently on one stale pairing. Invalid versions, malformed metadata, and content/block mismatches still fail explicitly with `LlmError('INVALID_REPLAY_STATE')`.

## Vocabulary differences

- pi-ai tool-call arguments are parsed objects; the harness stores raw JSON strings. The adapter parses input and re-stringifies output.
- pi-ai reports failures as in-stream error events; these map to `finish {kind:'error'|'aborted', failure}` chunks. Provider-specific error text distinguishes terminal `QUOTA` from transient `RATE_LIMIT`, while text and usage signals evaluated against the resolved model's context window normalize overflow to `CONTEXT_WINDOW_EXCEEDED`. A terminal `stop` whose message carries no content blocks maps to a `finish {kind:'error'}` with code `EMPTY_RESPONSE` (retried by default policy) instead of a successful empty message.
- pi-ai folds reasoning tokens into output usage; there is no separate reasoning count to map.
- pi-ai's `off` thinking level crosses the Harness capability seam unchanged and becomes an omitted pi-ai common `reasoning` option at dispatch.
- `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION` because pi-ai's common streaming UI cannot guarantee it across providers.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()`, merged through pi-ai's `headers` stream option. Provider-specific app-attribution headers are not synthesized. See [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts).

## Dependency weight

pi-ai installs several provider SDKs and lazy-loads the one selected by the catalog model. The dependency weight is isolated to this opt-in adapter package.

## Model Experience

### Provider request through pi-ai

#### What the model sees

The selected catalog model receives `GenerateOptions.system`, history, tools, and sampling fields supported by pi-ai's common streaming API. This package adds no prompt prose. Provider-native replay metadata is restored only when the adapter validates it for the historical content.

#### Token effect

Provider tokenization governs exact input. Conversion adds no model-visible text; replay metadata may let a native API reuse provider-side state.

#### KV Cache effect

Conversion preserves logical request order without adding text, while the selected provider's serialization and replay state determine reuse. Changing adapter instance, provider, model, or any upstream request token may prevent reuse from the first difference.

### Provider response

#### What the model sees

pi-ai events become harness reasoning, text, tool-call, usage, and finish chunks. The adapter passes parsed tool arguments to the harness as raw JSON strings.

#### Token effect

Generated content affects later inputs only after the loop records it. pi-ai folds reasoning tokens into output usage when the provider does not report them separately.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Unrecorded transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

- **A provider that authenticates through OAuth alone is not offered** — pi-ai resolves OAuth from a *stored* OAuth credential, and this adapter builds its `Models` collection with no credential store and runs no login flow, so every request on such a route fails `Provider is not configured` before it goes out. The configurable-provider directory withholds them; `openai-codex` is the only one the installed catalog ships. A route a settings document already names keeps its entry so a configuration surface can edit or delete it, and `apiKeyEnv` still authenticates it with that key — which for Codex is a token that expires with nothing here to refresh it.
- **Provider-native discovery reads the process environment only** — a route naming no credential defers to the catalog provider's own resolution, which interrogates environment variables (`AZURE_OPENAI_API_KEY`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, and each provider's own set). It reads no local credential directory, so `~/.aws/credentials` without an exported `AWS_PROFILE` resolves as unconfigured, and a value held by the harness credential seam is invisible to it unless the process environment carries it too.
- **Settings can add or override routes, not remove composition routes** — the user layer merges over the composition `base`, so deleting a `cordis.yml`-provided provider is a composition change; `replace` on the namespace only resets the user layer.
- **The layered merge has no delete for dict keys** — the settings seam merges the composition `base` and the user layer per key, recursively, so a `reasoningEfforts` level, `modelOverrides` entry, or `compat` field the base declares cannot be removed by the user layer, only overridden — and for `reasoningEfforts` absence *is* the meaning ("not offered"), so a base-declared level stays offered. This only triggers when a `cordis.yml` entry config declares per-model reasoning fields for the same model the user layer edits; the supported posture is to leave those to the settings document (the shipped composition mounts the adapter dormant), and a `models` list is an array replacing wholesale, which is the in-band escape.
- **`headers` can carry a credential the redactor never sees** — the profile's `headers` dict is plain strings, so `Authorization` or `api-key` set there is returned verbatim by a redacted `describe()` and rendered by any configuration UI. Store credentials as `apiKeyEnv` references; making the dict write-only is deferred with the rest of the [wire-boundary work](../llm/README.md#known-limitations-and-deferred-work).
- **A route's catalog never refreshes itself** — the catalog is whatever `settings.yaml` says, so a model list is only as current as its last edit. Nothing here queries a provider for the models it serves; a route gains a model when someone writes one.
- **One wire protocol per route** — `api` applies to the whole route, so a mixed-protocol catalog route (an OpenAI-style catalog spanning Responses and Chat Completions) cannot host a model of the other protocol, and adding a model such a route does not describe requires naming `api` and moving every model onto it. Splitting the provider across two route keys is the workaround.
- **A modality declaration is not verified, and over-claiming outlives the turn** — nothing interrogates an endpoint for what it accepts, so a model declaring `image` its gateway does not serve is refused by the provider mid-turn rather than here. Prompt admission commits the user message durably before the request is built, so the rejected image stays in the session log. A later request on a text-only route degrades that historical image block to placeholder text — the log keeps the image and any prior analysis of it — so switching to a text-only model is the recovery, not a dead end. Only queued-but-unsent images still refuse: a text-only selection is rejected while inbox images wait, because they would ship as fresh input the route rejects.
- **An unauthenticated route depends on its protocol** — naming no credential resolves the route as configured-but-keyless, but pi-ai's OpenAI-compatible implementation still requires an API key or an `Authorization` header, so a keyless local server needs a placeholder credential referenced by `apiKeyEnv` or an `Authorization` entry in `headers`.
- **`GenerateOptions.stop` is unsupported** — pi-ai's common stream options cannot guarantee stop-sequence behavior across providers, so the adapter rejects the field.
- **In-history `system` messages use pi-ai's common context conversion** — provider-specific placement follows pi-ai rather than a harness-owned wire override.
- **Provider HTTP status is unavailable** — pi-ai error events do not expose a stable HTTP status across providers; failures expose only stable harness error codes.
- **Retry policy is provider-owned, not an SDK retry** — each provider profile may configure nested `retryPolicy`, which `dsh-llm-retry` executes at the agent failed-step extension point; pi-ai SDK retries stay disabled so durable agent steps and `llm/retry` events own every visible attempt, and direct `ctx.llm.stream()` calls remain single-attempt.
