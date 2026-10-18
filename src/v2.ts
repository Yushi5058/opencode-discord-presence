/**
 * OpenCode V2 adapter for opencode-discord-presence.
 *
 * OpenCode V2 (>= 2.0.x) loads plugins through `@opencode/plugin` and expects a
 * default export shaped as `{ id, setup }` (see `Plugin.define`). The V2 plugin
 * `Context` is very different from the legacy V1 `PluginInput`:
 *
 *   - There is NO raw `client` object. We provide a thin shim that maps
 *     `client.session.get` to `ctx.session.get` and turns `client.app.log`
 *     into a best-effort debug log.
 *   - V1 hooks are returned by string key; V2 registers each hook on the domain
 *     that owns the operation (`ctx.session.hook`, `ctx.tool.hook`).
 *   - Events arrive from `ctx.event.subscribe()` as `{ type, data, ... }`
 *     whereas the V1 handler consumes `{ type, properties }`. We translate V2
 *     events into the V1 shape so the battle-tested presence engine in
 *     `plugin.ts` can be reused verbatim.
 *
 * The V1 implementation is preserved untouched and re-exported as `server` on
 * the package entry point so OpenCode V1 (1.18.29+) keeps working too.
 *
 * Types are modelled locally instead of importing `@opencode/plugin`: V2's
 * `Plugin.define` is an identity function, so a plain `{ id, setup }` object is
 * a valid definition and the published package needs no extra runtime
 * dependency.
 *
 * Known V2 gaps that the V1 engine cannot be fed:
 *
 *   - V2 removed the `todowrite` tool, so the mission board / todo summary is
 *     never populated. Presence still tracks agent, model, file and idle state.
 *
 * Adapted from the V2 adapter contributed by Muhammad Rheza Alfin (vheins) in
 * Puri12/opencode-discord-presence#14, which this project is free to reuse
 * under the MIT license.
 */
import { OpenCodeDiscordPresence } from "./plugin.js"

/** Stable plugin identifier reported to OpenCode V2. */
export const PLUGIN_ID = "opencode-discord-presence"

// ── V2 structural types (only the members this adapter consumes) ─────────────

interface V2Registration {
  dispose: () => Promise<void>
}

interface V2EventEnvelope {
  id?: string
  created?: number
  type: string
  data?: Record<string, unknown>
  location?: { directory?: string }
}

interface V2SessionInfo {
  id?: string
  parentID?: string | null
  agent?: string
  model?: { id?: string; providerID?: string }
}

interface V2PromptEvent {
  sessionID: string
  messageID?: string
}

interface V2ToolEvent {
  tool: string
  sessionID: string
  id: string
  input?: unknown
}

export interface V2Context {
  location: {
    directory: string
    project?: { id?: string; directory?: string; canonical?: string }
  }
  session: {
    get(input: { sessionID: string }): Promise<V2SessionInfo>
    hook(
      name: "prompt",
      callback: (event: V2PromptEvent) => Promise<void> | void,
    ): Promise<V2Registration>
  }
  tool: {
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: V2ToolEvent) => Promise<void> | void,
    ): Promise<V2Registration>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2EventEnvelope>
  }
}

type V1Handlers = Awaited<ReturnType<typeof OpenCodeDiscordPresence>>

interface SessionIdentity {
  agent?: string
  model?: string
  providerID?: string
}

/** V1 event shape the legacy `event` handler consumes. */
interface V1TranslatedEvent {
  type: string
  properties: Record<string, unknown>
}

// ── Coercion helpers ────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

// ── Client shim ─────────────────────────────────────────────────────────────

/** Build a V1-compatible `client` shim backed by the V2 context. */
export function createClientShim(ctx: V2Context, debug = false) {
  return {
    session: {
      get: async (input: { path?: { id?: string }; sessionID?: string }) => {
        const sessionID = input?.path?.id ?? input?.sessionID
        if (!sessionID) {
          throw new Error("session.get: sessionID is required")
        }
        const info = await ctx.session.get({ sessionID })
        // The V1 SessionTracker reads `response.data ?? response`, so wrapping
        // the session record mirrors the SDK response shape it expects.
        return { data: info }
      },
    },
    app: {
      // OpenCode V2 exposes no plugin-facing log API. Keep the method present so
      // the shared engine's diagnostics path does not throw; surface the message
      // only when the user explicitly opted into debug logging.
      log: async (input: { body?: { message?: string } }) => {
        const message = input?.body?.message
        if (debug && message) {
          console.log(`[discord-presence] ${message}`)
        }
      },
    },
  }
}

// ── Event translation (V2 -> V1) ────────────────────────────────────────────

/**
 * Translate a V2 event envelope into the V1 `{ type, properties }` shape the
 * existing handler understands. Returns `null` for events we do not consume.
 *
 * Note: V2's `session.execution.*` events are the reliable busy/idle signal
 * (the schema-defined `session.idle` is not always emitted), so they map onto
 * the V1 `session.status` / `session.idle` handlers. Re-marking an already
 * busy/idle session is idempotent in the orchestrator, so overlapping signals
 * are safe.
 */
export function translateV2Event(event: V2EventEnvelope): V1TranslatedEvent | null {
  const data = asRecord(event.data)

  switch (event.type) {
    case "session.created":
      return {
        type: "session.created",
        properties: {
          info: { id: asString(data.sessionID), parentID: asString(data.parentID) },
        },
      }
    case "session.deleted":
      return {
        type: "session.deleted",
        properties: { info: { id: asString(data.sessionID) } },
      }
    case "session.status":
      return {
        type: "session.status",
        properties: { sessionID: asString(data.sessionID), status: data.status },
      }
    case "session.idle":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return {
        type: "session.idle",
        properties: { sessionID: asString(data.sessionID) },
      }
    case "session.execution.started":
      return {
        type: "session.status",
        properties: { sessionID: asString(data.sessionID), status: { type: "busy" } },
      }
    case "file.edited":
      return {
        type: "file.edited",
        properties: { file: asString(data.file) },
      }
    case "lsp.updated":
      return { type: "lsp.client.diagnostics", properties: {} }
    default:
      return null
  }
}

/**
 * Resolve the session identity (agent/model) for the prompt hook, preferring
 * the cache seeded by session lifecycle events and falling back to a single
 * `session.get` round trip per session.
 */
export async function resolveIdentity(
  ctx: V2Context,
  cache: Map<string, SessionIdentity>,
  resolved: Set<string>,
  sessionID: string,
): Promise<SessionIdentity> {
  const cached = cache.get(sessionID) ?? {}
  if ((cached.agent && cached.model) || resolved.has(sessionID)) {
    return cached
  }

  resolved.add(sessionID)
  try {
    const info = await ctx.session.get({ sessionID })
    const model = asRecord(info.model)
    const identity: SessionIdentity = {
      agent: asString(info.agent) ?? cached.agent,
      model: asString(model.id) ?? cached.model,
      providerID: asString(model.providerID) ?? cached.providerID,
    }
    cache.set(sessionID, identity)
    return identity
  } catch {
    return cached
  }
}

/** Update the per-session agent/model cache used by the prompt hook. */
function updateIdentityCache(cache: Map<string, SessionIdentity>, envelope: V2EventEnvelope): void {
  const data = asRecord(envelope.data)
  const sessionID = asString(data.sessionID)
  if (!sessionID) return

  if (envelope.type === "session.created") {
    const model = asRecord(data.model)
    cache.set(sessionID, {
      agent: asString(data.agent),
      model: asString(model.id),
      providerID: asString(model.providerID),
    })
    return
  }

  if (envelope.type === "session.agent.selected") {
    cache.set(sessionID, { ...(cache.get(sessionID) ?? {}), agent: asString(data.agent) })
    return
  }

  if (envelope.type === "session.model.selected") {
    const model = asRecord(data.model)
    cache.set(sessionID, {
      ...(cache.get(sessionID) ?? {}),
      model: asString(model.id),
      providerID: asString(model.providerID),
    })
  }
}

// ── process-wide engine sharing ─────────────────────────────────────────────

/**
 * V2 instantiates a plugin once per project directory inside a single server
 * process, and each load is a separate module graph, so module-level state does
 * not protect against duplication the way the V1 `isPrimaryPluginInstance`
 * flag used to. Without sharing, every project would build its own presence
 * engine and open its own Discord IPC connection, so the activity shown in
 * Discord would flip between instances.
 *
 * The engine is therefore kept once per process and ref-counted. Two further
 * consequences of per-directory loading are handled here as well:
 *
 *   - the event stream is process-wide, so every load receives every event;
 *     `markEventSeen` makes sure the engine only acts on each event once.
 *   - hooks and events from different loads can otherwise interleave, so engine
 *     calls run through a shared serial queue, matching V1's single-context
 *     behaviour.
 */
const ENGINE_KEY = Symbol.for("opencode-discord-presence.v2.engine")

/** Number of event ids remembered to keep duplicate deliveries out. */
export const SEEN_EVENT_LIMIT = 4096

export interface EngineEntry {
  handlers: Promise<V1Handlers>
  refs: number
  seenEvents: Set<string>
  seenOrder: string[]
  queue: Promise<unknown>
}

type EngineStore = { [ENGINE_KEY]?: EngineEntry }

/**
 * Remember an event id process-wide. Returns `false` when the event was already
 * handled by another loaded instance of this plugin.
 */
export function markEventSeen(entry: EngineEntry, envelope: unknown): boolean {
  const id = asString(asRecord(envelope).id)
  // Events without an id cannot be deduplicated; pass them through.
  if (!id) return true

  if (entry.seenEvents.has(id)) return false

  entry.seenEvents.add(id)
  entry.seenOrder.push(id)
  if (entry.seenOrder.length > SEEN_EVENT_LIMIT) {
    const oldest = entry.seenOrder.shift()
    if (oldest !== undefined) entry.seenEvents.delete(oldest)
  }
  return true
}

/** Run an engine call after every earlier one, across all loaded instances. */
export function runSerialized<T>(entry: EngineEntry, task: () => Promise<T>): Promise<T> {
  const result = entry.queue.then(task, task)
  // Keep the chain alive even when a call rejects.
  entry.queue = result.catch(() => undefined)
  return result
}

function createEngine(ctx: V2Context): Promise<V1Handlers> {
  const directory = ctx.location.directory
  const debug = process.env.OPENCODE_DISCORD_DEBUG === "true"
  const pluginInput = {
    directory,
    worktree: directory,
    project: ctx.location.project ?? { id: "", directory, worktree: directory },
    client: createClientShim(ctx, debug),
    serverUrl: new URL("http://127.0.0.1"),
    experimental_workspace: { register() {} },
    $: undefined,
  } as unknown as Parameters<typeof OpenCodeDiscordPresence>[0]

  return OpenCodeDiscordPresence(pluginInput).then((handlers) => handlers as V1Handlers)
}

/** Borrow the process-wide engine, creating it on first use. */
export function acquireEngine(ctx: V2Context): EngineEntry {
  const store = globalThis as unknown as EngineStore
  const existing = store[ENGINE_KEY]
  if (existing) {
    existing.refs += 1
    return existing
  }

  const entry: EngineEntry = {
    handlers: createEngine(ctx),
    refs: 1,
    seenEvents: new Set(),
    seenOrder: [],
    queue: Promise.resolve(),
  }
  store[ENGINE_KEY] = entry
  return entry
}

/** Drop one reference; the last user disposes the engine and its connection. */
export async function releaseEngine(entry: EngineEntry): Promise<void> {
  const store = globalThis as unknown as EngineStore
  if (store[ENGINE_KEY] !== entry) return

  entry.refs -= 1
  if (entry.refs > 0) return

  delete store[ENGINE_KEY]
  try {
    const handlers = await entry.handlers
    await (handlers as { dispose?: () => Promise<void> }).dispose?.()
  } catch {
    // ignore
  }
}

// ── V2 plugin definition ────────────────────────────────────────────────────

/**
 * V2 plugin definition. Exported as a plain object (equivalent to
 * `Plugin.define`, which is an identity function) so the package needs no
 * runtime dependency on `@opencode/plugin`.
 */
export const openCodeDiscordPresenceV2 = {
  id: PLUGIN_ID,
  async setup(ctx: V2Context): Promise<(() => Promise<void>) | void> {
    // Reuse the entire V1 presence engine, sharing one engine across every
    // project directory loaded in this process.
    const entry = acquireEngine(ctx)
    const handlers: V1Handlers = await entry.handlers

    // Disabled, or this is not the process-wide primary instance: register
    // nothing so we do not duplicate the instance that already owns Discord.
    if (typeof handlers.event !== "function" && typeof handlers["chat.message"] !== "function") {
      return
    }

    const identityCache = new Map<string, SessionIdentity>()
    const identityResolved = new Set<string>()
    const registrations: V2Registration[] = []

    // V1 `chat.message` -> V2 `prompt` hook. The prompt hook carries no
    // agent/model, so identity is resolved from the per-session cache seeded by
    // session lifecycle and agent/model selection events, with a `session.get`
    // fallback when those events were missed.
    if (typeof handlers["chat.message"] === "function") {
      const chatMessage = handlers["chat.message"]
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          const identity = await resolveIdentity(
            ctx,
            identityCache,
            identityResolved,
            event.sessionID,
          )
          await runSerialized(entry, () =>
            chatMessage(
              {
                sessionID: event.sessionID,
                agent: identity.agent,
                model: identity.model
                  ? { providerID: identity.providerID ?? "", modelID: identity.model }
                  : undefined,
              } as never,
              { message: undefined, parts: [] } as never,
            ),
          )
        }),
      )
    }

    // V1 `tool.execute.before` -> V2 `execute.before` hook. V2 passes the call
    // id on `event.id` and the tool arguments on `event.input`.
    if (typeof handlers["tool.execute.before"] === "function") {
      const before = handlers["tool.execute.before"]
      registrations.push(
        await ctx.tool.hook("execute.before", async (event) => {
          await runSerialized(entry, () =>
            before(
              { tool: event.tool, sessionID: event.sessionID, callID: event.id } as never,
              { args: event.input } as never,
            ),
          )
        }),
      )
    }

    // V1 `tool.execute.after` -> V2 `execute.after` hook. The V1 handler reads
    // only the call id, which is stable across before/after in V2.
    if (typeof handlers["tool.execute.after"] === "function") {
      const after = handlers["tool.execute.after"]
      registrations.push(
        await ctx.tool.hook("execute.after", async (event) => {
          await runSerialized(entry, () =>
            after(
              { tool: event.tool, sessionID: event.sessionID, callID: event.id } as never,
              {} as never,
            ),
          )
        }),
      )
    }

    // V1 `event` hook -> V2 event subscription.
    const abort = new AbortController()
    const eventTask = (async () => {
      try {
        for await (const envelope of ctx.event.subscribe({ signal: abort.signal })) {
          // Cache updates are idempotent, so every load may run them even when
          // the event itself is deduplicated below.
          updateIdentityCache(identityCache, envelope)
          // Every loaded instance receives every event; act on each one once.
          if (!markEventSeen(entry, envelope)) continue
          const translated = translateV2Event(envelope)
          const eventHandler = handlers.event
          if (!translated || typeof eventHandler !== "function") continue
          try {
            await runSerialized(entry, () => eventHandler({ event: translated as never }))
          } catch {
            // The V1 handler logs internally; never tear down the subscription.
          }
        }
      } catch {
        // Subscription ended (server shutdown / abort). Nothing to do.
      }
    })()

    // V2 cleanup: stop consuming events, drop hooks, and run the V1 dispose.
    return async () => {
      abort.abort()
      try {
        await eventTask
      } catch {
        // ignore
      }
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch {
          // ignore
        }
      }
      // The shared engine lives as long as any loaded project still uses it.
      await releaseEngine(entry)
    }
  },
}
