/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/** Default run-wide turn cap; a runaway loop ends instead of spinning forever. */
export const DEFAULT_MAX_TURNS = 200

/** Default cap on consecutive failed LLM requests before the run stops. */
export const DEFAULT_MAX_CONSECUTIVE_REQUEST_FAILURES = 8

/**
 * Default run-wide step cap. One step is one model round-trip; an unbounded
 * chatty run would otherwise balloon the session log (and, co-located on one
 * Node loop, the web UI) without limit. The run ends gracefully on the
 * budget, not as a failure.
 */
export const DEFAULT_MAX_STEPS = 500
