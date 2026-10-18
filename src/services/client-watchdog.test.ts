import { beforeEach, describe, expect, test } from "bun:test"
import {
  ClientWatchdog,
  countEstablishedClients,
  findListenPorts,
  type ProcNetRow,
  parseProcNet,
} from "./client-watchdog.js"

// ─── parseProcNet ────────────────────────────────────────────────────────────

describe("parseProcNet", () => {
  test("parses listen and established rows from /proc/net/tcp", () => {
    const content = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:9F12 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 341125 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:9F12 0100007F:C1A4 01 00000000:00000000 00:00000000 00000000     0        0 341126 1 0000000000000000 20 4 30 10 -1",
      "   2: 0100007F:C1A5 0100007F:9F12 01 00000000:00000000 00:00000000 00000000     0        0 341127 1 0000000000000000 20 4 30 10 -1",
    ].join("\n")

    const rows = parseProcNet(content)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ localPort: 40722, state: "0A", inode: "341125" })
    expect(rows[1]).toEqual({ localPort: 40722, state: "01", inode: "341126" })
    expect(rows[2]).toEqual({ localPort: 49573, state: "01", inode: "341127" })
  })

  test("skips the header line and malformed lines", () => {
    const content = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "not a valid line at all",
      "   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 500 1 0000000000000000 100 0 0 10 0",
    ].join("\n")

    const rows = parseProcNet(content)
    expect(rows).toHaveLength(1)
    expect(rows[0].localPort).toBe(8080)
  })

  test("handles empty and header-only content", () => {
    expect(parseProcNet("")).toHaveLength(0)
    expect(
      parseProcNet(
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
      ),
    ).toHaveLength(0)
  })

  test("parses IPv6 hex ports", () => {
    // tcp6 uses the same layout; the port is still the last 4 hex digits.
    const content =
      "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 600 1 0000000000000000 100 0 0 10 0"
    const rows = parseProcNet(content)
    expect(rows[0].localPort).toBe(8080)
    expect(rows[0].state).toBe("0A")
  })
})

// ─── findListenPorts ─────────────────────────────────────────────────────────

describe("findListenPorts", () => {
  const rows = (ports: Array<[number, string, string]>): ProcNetRow[] =>
    ports.map(([localPort, state, inode]) => ({ localPort, state, inode }))

  test("returns only LISTEN ports owned by this process", () => {
    const all = rows([
      [49374, "0A", "111"],
      [49374, "01", "222"],
      [53, "0A", "333"], // another process's listener
    ])
    expect(findListenPorts(all, new Set(["111"]))).toEqual(new Set([49374]))
  })

  test("returns empty set when no socket is owned", () => {
    const all = rows([[49374, "0A", "111"]])
    expect(findListenPorts(all, new Set())).toEqual(new Set())
  })

  test("deduplicates ports across IPv4/IPv6 listeners", () => {
    const all = rows([
      [8080, "0A", "111"],
      [8080, "0A", "112"],
    ])
    expect(findListenPorts(all, new Set(["111", "112"]))).toEqual(new Set([8080]))
  })
})

// ─── countEstablishedClients ─────────────────────────────────────────────────

describe("countEstablishedClients", () => {
  test("counts ESTABLISHED sockets on service ports only", () => {
    const rows: ProcNetRow[] = [
      { localPort: 49374, state: "0A", inode: "1" }, // LISTEN — not a client
      { localPort: 49374, state: "01", inode: "2" }, // attached client #1
      { localPort: 49374, state: "01", inode: "3" }, // attached client #2
      { localPort: 49374, state: "08", inode: "4" }, // CLOSE_WAIT — gone
      { localPort: 54321, state: "01", inode: "5" }, // outbound — not a client
    ]
    expect(countEstablishedClients(rows, new Set([49374]))).toBe(2)
  })

  test("returns 0 when no listen ports are known", () => {
    const rows: ProcNetRow[] = [{ localPort: 49374, state: "01", inode: "2" }]
    expect(countEstablishedClients(rows, new Set())).toBe(0)
  })
})

// ─── ClientWatchdog state machine ────────────────────────────────────────────

describe("ClientWatchdog", () => {
  let clock = 0
  let count = 0
  let countImpl: () => Promise<number | null>
  let detachCalls: number
  let attachCalls: number
  let errors: unknown[]

  const makeWatchdog = (graceMs = 5000) =>
    new ClientWatchdog({
      countClients: () => countImpl(),
      graceMs,
      onDetach: () => {
        detachCalls++
      },
      onAttach: () => {
        attachCalls++
      },
      onError: (error) => {
        errors.push(error)
      },
      now: () => clock,
    })

  /** Advances the clock and samples once. */
  const advance = async (watchdog: ClientWatchdog, ms: number) => {
    clock += ms
    await watchdog.tick()
  }

  beforeEach(() => {
    clock = 0
    count = 1
    countImpl = async () => count
    detachCalls = 0
    attachCalls = 0
    errors = []
  })

  test("stays attached while a client is present", async () => {
    const watchdog = makeWatchdog()
    for (let i = 0; i < 10; i++) await advance(watchdog, 2000)
    expect(watchdog.isDetached()).toBe(false)
    expect(detachCalls).toBe(0)
    expect(attachCalls).toBe(0)
  })

  test("detaches once the grace elapses with zero clients", async () => {
    const watchdog = makeWatchdog(5000)
    await watchdog.tick() // observed attached

    count = 0
    await advance(watchdog, 2000) // zero starts here (clock 2000)
    expect(detachCalls).toBe(0)
    await advance(watchdog, 2000) // 2s of zero
    expect(detachCalls).toBe(0)
    await advance(watchdog, 2000) // 4s of zero
    expect(detachCalls).toBe(0)
    await advance(watchdog, 2000) // 6s of zero ≥ 5s grace
    expect(detachCalls).toBe(1)
    expect(watchdog.isDetached()).toBe(true)

    // Further zero samples must not re-fire.
    await advance(watchdog, 2000)
    expect(detachCalls).toBe(1)
  })

  test("client returning during grace cancels the pending detach", async () => {
    const watchdog = makeWatchdog(5000)
    await watchdog.tick()

    count = 0
    await advance(watchdog, 2000)
    await advance(watchdog, 2000) // 4s of zero, below grace

    count = 1
    await advance(watchdog, 2000) // client back — zero timer resets
    expect(watchdog.isDetached()).toBe(false)

    count = 0
    await advance(watchdog, 2000) // fresh zero period starts
    await advance(watchdog, 2000)
    await advance(watchdog, 2000)
    await advance(watchdog, 2000) // ≥ grace since fresh start
    expect(detachCalls).toBe(1)
  })

  test("reattach after detach fires onAttach exactly once", async () => {
    const watchdog = makeWatchdog(1000)
    await watchdog.tick()
    count = 0
    await advance(watchdog, 1000)
    await advance(watchdog, 1000)
    expect(watchdog.isDetached()).toBe(true)

    count = 2 // e.g. TUI + web UI
    await advance(watchdog, 2000)
    expect(watchdog.isDetached()).toBe(false)
    expect(attachCalls).toBe(1)

    await advance(watchdog, 2000) // still attached — no repeat
    expect(attachCalls).toBe(1)
    expect(detachCalls).toBe(1)
  })

  test("never detaches before the first client is observed", async () => {
    count = 0
    const watchdog = makeWatchdog(1000)
    for (let i = 0; i < 100; i++) await advance(watchdog, 2000)
    expect(watchdog.isDetached()).toBe(false)
    expect(detachCalls).toBe(0)
  })

  test("stays passive when the probe reports unsupported", async () => {
    countImpl = async () => null
    const watchdog = makeWatchdog(1000)
    for (let i = 0; i < 10; i++) await advance(watchdog, 2000)
    expect(watchdog.isDetached()).toBe(false)
    expect(detachCalls).toBe(0)
  })

  test("probe errors are routed to onError and sampling continues", async () => {
    let shouldThrow = false
    countImpl = async () => {
      if (shouldThrow) throw new Error("boom")
      return 1
    }
    const watchdog = makeWatchdog(1000)
    await watchdog.tick()
    expect(errors).toHaveLength(0)

    shouldThrow = true
    await watchdog.tick()
    expect(errors).toHaveLength(1)
    expect(watchdog.isDetached()).toBe(false)

    shouldThrow = false
    await watchdog.tick() // recovered — still attached
    expect(watchdog.isDetached()).toBe(false)
    expect(detachCalls).toBe(0)
  })

  test("tick is re-entrancy safe", async () => {
    const watchdog = makeWatchdog(1000)
    // Establish the attach latch first — a detached transition requires a
    // client to have been seen. Then two concurrent ticks during an expired
    // zero period must not double-fire onDetach.
    count = 1
    clock = 0
    await watchdog.tick()
    count = 0
    clock = 5000
    await watchdog.tick() // zero period starts
    clock = 7000
    await Promise.all([watchdog.tick(), watchdog.tick()])
    expect(detachCalls).toBe(1)
  })

  test("start/stop manage the interval without duplicate timers", async () => {
    let ticks = 0
    const watchdog = new ClientWatchdog({
      countClients: async () => {
        ticks++
        return 1
      },
      graceMs: 1000,
      onDetach: () => {},
      onAttach: () => {},
      pollIntervalMs: 1,
      setIntervalImpl: ((fn: () => void) => {
        const id = setInterval(fn, 1)
        return id
      }) as unknown as typeof setInterval,
      clearIntervalImpl: clearInterval,
    })
    watchdog.start()
    watchdog.start() // idempotent
    await new Promise((resolve) => setTimeout(resolve, 20))
    watchdog.stop()
    watchdog.stop() // idempotent
    const stopped = ticks
    expect(stopped).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ticks).toBe(stopped) // no ticks after stop
  })
})
