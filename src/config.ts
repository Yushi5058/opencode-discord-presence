import type {
  DiscordPresenceOptions,
  Language,
  PresenceConfig,
  RichPresenceOptions,
} from "./types/index.js"

type CompatibleDiscordPresenceOptions = DiscordPresenceOptions & {
  discordPresence?: {
    applicationId?: string
  }
}

export const DEFAULT_CLIENT_ID = "1466770544748662819"

/** Default rotation interval in seconds. Must be within 10-60 range. */
export const DEFAULT_ROTATION_INTERVAL_SECONDS = 20

/** Minimum allowed rotation interval in seconds. */
export const MIN_ROTATION_INTERVAL_SECONDS = 10

/** Maximum allowed rotation interval in seconds. */
export const MAX_ROTATION_INTERVAL_SECONDS = 60

/**
 * Default seconds with zero attached OpenCode clients before the Discord
 * activity is cleared (TUI exited). Includes the 2s poll interval, so the
 * clear lands within ~10s of exit by default.
 */
export const DEFAULT_AUTO_CLEAR_SECONDS = 8

/** Upper bound for autoClearSeconds (one hour). */
export const MAX_AUTO_CLEAR_SECONDS = 3600

/**
 * Clamps and parses the auto-clear delay safely.
 * `0` is valid and disables the watchdog; negatives fall back to 0
 * (disabled is the safer misparse — never clears wrong data by accident),
 * non-numeric input falls back to the default.
 */
function parseAutoClearSeconds(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_AUTO_CLEAR_SECONDS
  }
  const rounded = Math.round(raw)
  if (rounded < 0) return 0
  if (rounded > MAX_AUTO_CLEAR_SECONDS) return MAX_AUTO_CLEAR_SECONDS
  return rounded
}

function parseLanguage(lang?: string): Language {
  const normalized = lang?.toLowerCase()
  if (normalized === "ko" || normalized === "kr" || normalized === "korean") return "ko"
  return "en"
}

/**
 * Clamps and parses rotation interval safely.
 * Invalid values fall back to DEFAULT_ROTATION_INTERVAL_SECONDS.
 */
function parseRotationInterval(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_ROTATION_INTERVAL_SECONDS
  }
  const rounded = Math.round(raw)
  if (rounded < MIN_ROTATION_INTERVAL_SECONDS) {
    return MIN_ROTATION_INTERVAL_SECONDS
  }
  if (rounded > MAX_ROTATION_INTERVAL_SECONDS) {
    return MAX_ROTATION_INTERVAL_SECONDS
  }
  return rounded
}

/**
 * Parses rich presence options with safe defaults.
 * Omitted keys receive safe defaults so partial configs are always safe.
 */
function parseRichPresenceOptions(raw?: Partial<RichPresenceOptions>): RichPresenceOptions {
  if (raw == null) {
    return {
      enableFileSpotlight: false,
      enableMissionBoard: true,
      rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
      diagnostics: { errorsOnly: true },
      mainAgentOnly: false,
      autoClearSeconds: DEFAULT_AUTO_CLEAR_SECONDS,
    }
  }
  return {
    enableFileSpotlight: asBoolean(raw.enableFileSpotlight) ?? false,
    enableMissionBoard: asBoolean(raw.enableMissionBoard) ?? true,
    rotationIntervalSeconds: parseRotationInterval(raw.rotationIntervalSeconds),
    diagnostics: {
      errorsOnly: asBoolean(raw.diagnostics?.errorsOnly) ?? true,
    },
    mainAgentOnly: asBoolean(raw.mainAgentOnly) ?? false,
    autoClearSeconds: parseAutoClearSeconds(raw.autoClearSeconds),
  }
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.toLowerCase()
  if (v === "true" || v === "1" || v === "yes") return true
  if (v === "false" || v === "0" || v === "no") return false
  return undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function getConfig(options?: DiscordPresenceOptions): PresenceConfig {
  const compatibleOptions = options as CompatibleDiscordPresenceOptions | undefined
  const envEnabled = process.env.OPENCODE_DISCORD_ENABLED
  const envClientId = process.env.OPENCODE_DISCORD_CLIENT_ID
  const envLanguage = process.env.OPENCODE_DISCORD_LANGUAGE
  const envDebug = process.env.OPENCODE_DISCORD_DEBUG

  return {
    enabled: asBoolean(options?.enabled) ?? envEnabled !== "false",
    clientId:
      asString(compatibleOptions?.applicationId) ??
      asString(compatibleOptions?.discordPresence?.applicationId) ??
      envClientId ??
      DEFAULT_CLIENT_ID,
    language: parseLanguage(asString(options?.language) ?? envLanguage),
    richPresence: parseRichPresenceOptions(options?.richPresence),
    debug: asBoolean(options?.debug) ?? parseBool(envDebug) ?? false,
  }
}
