/**
 * Client-connection watchdog: clears Discord presence when no OpenCode client
 * (TUI / web / desktop) is attached to the service.
 *
 * OpenCode V2 runs plugins inside the long-lived background service, which
 * outlives every TUI: quitting the TUI (Ctrl+C / Q) closes its event-stream
 * (SSE) connection but leaves the service — and this plugin's Discord RPC
 * connection — running, so presence used to stay visible forever. The plugin
 * API exposes no client connect/disconnect events (`server.connected` is
 * synthesized per SSE stream by the HTTP layer and never published on the
 * event bus), so the only observable signal is the set of TCP connections
 * accepted by the service itself.
 *
 * On Linux we derive it from procfs with no subprocesses:
 *   1. `/proc/self/fd/*` → socket inodes owned by THIS process (the plugin
 *      runs in-process with the server).
 *   2. `/proc/net/tcp{,6}` LISTEN rows whose inode is ours → the service's
 *      listen ports.
 *   3. ESTABLISHED rows whose *local* port is one of those → one row per
 *      attached client (accepted server-side sockets; outbound sockets use
 *      ephemeral local ports and never match).
 *
 * `countAttachedClients()` returns `null` ("unsupported / inconclusive") when:
 *   - the platform is not Linux (no procfs), or
 *   - procfs is unreadable, or
 *   - no LISTEN socket belongs to this process — e.g. the V1 CLI, where the
 *     plugin runs in a process that does not host the server. "Zero listen
 *     ports" must NOT read as "zero clients", otherwise presence would be
 *     suppressed forever on such setups.
 */

import { readdir, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"

/** How often the watchdog samples attached clients. */
export const WATCHDOG_POLL_INTERVAL_MS = 2000

const STATE_ESTABLISHED = "01"
const STATE_LISTEN = "0A"
const SOCKET_INODE_RE = /^socket:\[(\d+)\]$/

export interface ProcNetRow {
  localPort: number
  state: string
  inode: string
}

/**
 * Parses `/proc/net/tcp` and `/proc/net/tcp6` content into rows. Both files
 * share the same column layout: field 1 is `ip:port` in hex (the port is
 * always the last 4 hex digits), field 3 the socket state, field 9 the inode.
 * The header line and malformed lines are skipped.
 */
export function parseProcNet(content: string): ProcNetRow[] {
  const rows: ProcNetRow[] = []
  for (const line of content.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 10) continue
    const local = parts[1]
    const colon = local.lastIndexOf(":")
    if (colon === -1) continue
    const inode = parts[9]
    if (!/^\d+$/.test(inode)) continue // header line has "inode" here
    const port = Number.parseInt(local.slice(colon + 1), 16)
    if (!Number.isFinite(port)) continue
    rows.push({ localPort: port, state: parts[3], inode })
  }
  return rows
}

/** Collects the local ports of LISTEN sockets owned by this process. */
export function findListenPorts(rows: ProcNetRow[], ownInodes: Set<string>): Set<number> {
  const ports = new Set<number>()
  for (const row of rows) {
    if (row.state === STATE_LISTEN && ownInodes.has(row.inode)) ports.add(row.localPort)
  }
  return ports
}

/** Counts ESTABLISHED sockets whose local port is a service listen port — one per attached client. */
export function countEstablishedClients(rows: ProcNetRow[], listenPorts: Set<number>): number {
  let count = 0
  for (const row of rows) {
    if (row.state === STATE_ESTABLISHED && listenPorts.has(row.localPort)) count++
  }
  return count
}

/** Reads the socket inodes held by this process via `/proc/self/fd`. */
export async function readSelfSocketInodes(dir = "/proc/self/fd"): Promise<Set<string>> {
  const inodes = new Set<string>()
  const entries = await readdir(dir)
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const target = await readlink(join(dir, entry))
        const match = SOCKET_INODE_RE.exec(target)
        if (match) inodes.add(match[1])
      } catch {
        // fd closed between readdir and readlink, or not a socket — ignore.
      }
    }),
  )
  return inodes
}

/**
 * Samples how many OpenCode clients hold an established connection to this
 * service process. Returns `null` when the platform or process shape makes
 * the answer unknowable — callers must treat that as "feature disabled",
 * never as "zero clients".
 */
export async function countAttachedClients(): Promise<number | null> {
  if (process.platform !== "linux") return null
  try {
    const [inodes, tcp4, tcp6] = await Promise.all([
      readSelfSocketInodes(),
      readFile("/proc/net/tcp", "utf8").catch(() => ""),
      readFile("/proc/net/tcp6", "utf8").catch(() => ""),
    ])
    const rows = [...parseProcNet(tcp4), ...parseProcNet(tcp6)]
    const listenPorts = findListenPorts(rows, inodes)
    if (listenPorts.size === 0) return null
    return countEstablishedClients(rows, listenPorts)
  } catch {
    return null
  }
}

export interface ClientWatchdogOptions {
  /** Samples the number of attached clients; `null` disables the watchdog. */
  countClients: () => Promise<number | null>
  /** Uninterrupted zero-client time (ms) before `onDetach` fires. */
  graceMs: number
  /** Called once when the grace elapses with zero attached clients. */
  onDetach: () => void
  /** Called once when a client attaches again after a detach. */
  onAttach: () => void
  onError?: (error: unknown) => void
  now?: () => number
  pollIntervalMs?: number
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
}

/**
 * Polls the attached-client count and fires onDetach/onAttach on transitions.
 *
 * Safety latch: onDetach only ever fires after at least one client was seen
 * attached at some point. A process that never observes a client (V1 CLI,
 * unsupported platform races) can therefore never suppress presence.
 *
 * `tick()` is public so tests can drive sampling deterministically; the
 * interval simply calls it.
 */
export class ClientWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly options: ClientWatchdogOptions
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly setIntervalImpl: typeof setInterval
  private readonly clearIntervalImpl: typeof clearInterval
  private detached = false
  private everAttached = false
  private zeroSince: number | null = null
  private ticking = false

  constructor(options: ClientWatchdogOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.pollIntervalMs = options.pollIntervalMs ?? WATCHDOG_POLL_INTERVAL_MS
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval
  }

  isDetached(): boolean {
    return this.detached
  }

  start(): void {
    if (this.timer) return
    this.timer = this.setIntervalImpl(() => {
      void this.tick()
    }, this.pollIntervalMs)
    // Never keep the process alive for presence bookkeeping alone.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    this.clearIntervalImpl(this.timer)
    this.timer = null
  }

  /** One sample + state transition. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const count = await this.options.countClients()
      if (count === null) return // unsupported — stay passive forever
      const now = this.now()
      if (count > 0) {
        this.everAttached = true
        this.zeroSince = null
        if (this.detached) {
          this.detached = false
          this.options.onAttach()
        }
        return
      }
      if (!this.everAttached) return // never saw a client: nothing to clear
      if (this.zeroSince === null) {
        this.zeroSince = now
        return
      }
      if (!this.detached && now - this.zeroSince >= this.options.graceMs) {
        this.detached = true
        this.options.onDetach()
      }
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.ticking = false
    }
  }
}
