// Byte-level protocol for the logger. See PROTOCOL.md in the repo root.
// Blocks are indexed with the report ID at [0], matching PROTOCOL.md offsets.

export const VENDOR_ID = 0x0483
export const PRODUCT_ID = 0xa07b
/** Each probe's log lives in its own 8000-reading region; chunk addresses count readings. */
export const CHANNEL_REGION = 0x1f40
export const CAPACITY = 8000
/** Raw value the logger stores when it has no valid reading (e.g. probe unplugged). */
export const INVALID_RAW = 0xffff

export const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const put16 = (b: Uint8Array, i: number, v: number) => { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff }

/** Raw reading → °F: 0.05 °F per count. Matches the vendor software's stored values exactly. */
export const fahrenheit = (raw: number) => (raw - 10000) / 20
export const rawFor = (f: number) => Math.round((f + 500) * 20)
export const celsius = (f: number) => ((f - 32) * 5) / 9
export const fromCelsius = (c: number) => (c * 9) / 5 + 32

const bcd = (b: number) => (b >> 4) * 10 + (b & 0x0f)
const toBcd = (v: number) => (Math.floor(v / 10) << 4) | v % 10

/** 6-byte BCD `MM DD YY hh mm ss` in local time; all 0xff means "not set". */
export function bcdDate(b: Uint8Array, o: number): Date | null {
  const v = b.subarray(o, o + 6)
  if (v.length < 6 || v.every((x) => x === 0xff)) return null
  return new Date(2000 + bcd(v[2]), bcd(v[0]) - 1, bcd(v[1]), bcd(v[3]), bcd(v[4]), bcd(v[5]))
}

function putBcdDate(b: Uint8Array, o: number, d: Date) {
  const parts = [d.getMonth() + 1, d.getDate(), d.getFullYear() % 100, d.getHours(), d.getMinutes(), d.getSeconds()]
  parts.forEach((v, i) => (b[o + i] = toBcd(v)))
}

function ascii(b: Uint8Array, from: number, to: number) {
  const s = b.subarray(from, to)
  const end = s.indexOf(0)
  return new TextDecoder().decode(end < 0 ? s : s.subarray(0, end))
}

export type RunState = 'idle' | 'stopped' | 'armed' | 'waiting for button' | 'logging' | 'full'

export interface Status {
  name: string
  serial: string
  clock: Date | null
  actualStart: Date | null
  intervalSeconds: number
  channelCount: number
  readingCount: number
  state: RunState
  /** Most recent logged raw reading per channel (null when none). */
  latestRaw: (number | null)[]
  raw: Uint8Array
}

export function parseStatus(r: Uint8Array): Status {
  const readingCount = le16(r, 0xa6)
  const actualStart = bcdDate(r, 0x33)
  const channelCount = Math.max(1, r[0x66])
  // 0x23 bit 0x08 = armed/active, low bits echo the start mode; it stays set after
  // logging ends. 0xb6 records the last start/stop event: 0x20 = stopped.
  let state: RunState
  if (readingCount >= CAPACITY) state = 'full'
  else if (r[0xb6] === 0x20) state = 'stopped'
  else if ((r[0x23] & 0x08) === 0) state = readingCount > 0 ? 'stopped' : 'idle'
  else if (actualStart) state = 'logging'
  else state = r[0x23] & 0x02 ? 'waiting for button' : 'armed'
  return {
    name: ascii(r, 0x01, 0x21),
    serial: ascii(r, 0x58, 0x61),
    clock: bcdDate(r, 0x95),
    actualStart,
    intervalSeconds: le16(r, 0x44),
    channelCount,
    readingCount,
    state,
    latestRaw: Array.from({ length: channelCount }, (_, ch) => {
      const v = le16(r, 0xa0 + 2 * ch)
      return v === INVALID_RAW ? null : v
    }),
    raw: r,
  }
}

export interface Reading { channel: number; time: Date; raw: number }

/** Parses report-3 chunks: [1] = record count, [2..3] = address (selects channel), 8-byte records from [5]. */
export function parseReadings(chunks: Uint8Array[]): Reading[] {
  const out: Reading[] = []
  for (const c of chunks) {
    if (c.length <= 5) continue
    const channel = Math.floor(le16(c, 2) / CHANNEL_REGION)
    for (let i = 0; i < c[1]; i++) {
      const o = 5 + 8 * i
      if (o + 8 > c.length) break
      const time = bcdDate(c, o)
      if (!time) break
      out.push({ channel, time, raw: le16(c, o + 6) })
    }
  }
  return out
}

// ---- Settings (report-2 write) ----

/**
 * `manual` arms the logger to be started by software or its button (the vendor software's
 * "Manually"); `software` is the same mode, started right away by this app.
 */
export type Start =
  | { kind: 'software' } | { kind: 'manual' } | { kind: 'button'; delaySeconds: number } | { kind: 'at'; date: Date }
export type Stop =
  | { kind: 'software' } | { kind: 'whenFull' } | { kind: 'afterReadings'; count: number } | { kind: 'at'; date: Date }
export interface Alarm { enabled: boolean; raw: number }
export interface Probe { high: Alarm; low: Alarm }
export interface Settings {
  name: string
  intervalSeconds: number
  probeCount: number
  start: Start
  stop: Stop
  probes: [Probe, Probe]
}

export const defaultProbe = (): Probe => ({
  high: { enabled: false, raw: rawFor(1372) },
  low: { enabled: false, raw: rawFor(-100) },
})

const O = {
  flags: 0x21, mode: 0x23, startDate: 0x27, stopDate: 0x2d, buttonDelay: 0x39,
  interval: 0x44, probeCount: 0x66, stopAfter: 0x6f, clock: 0x95,
} as const
const LIMIT_BASE = [0x46, 0x4f]
/** Alarm-enable bits in the flags byte: [probe][high, low]. */
const ALARM_BITS = [[0x10, 0x40], [0x20, 0x80]]
export const WRITE_LENGTH = 192
export const OFFSETS = O

/**
 * Encodes the settings write the way the vendor software does. `base` is the status
 * block read right after the erase command; unknown bytes pass through untouched.
 */
export function encodeSettings(s: Settings, base: Uint8Array, now: Date): Uint8Array {
  if (base.length < WRITE_LENGTH) throw new Error('status block too short')
  const b = base.slice(0, WRITE_LENGTH)

  const name = new TextEncoder().encode(s.name).subarray(0, 32)
  for (let i = 0; i < 32; i++) b[1 + i] = i < name.length ? name[i] : 0

  let flags = b[O.flags] & 0x0f
  s.probes.forEach((p, i) => {
    if (p.high.enabled) flags |= ALARM_BITS[i][0]
    if (p.low.enabled) flags |= ALARM_BITS[i][1]
  })
  b[O.flags] = flags
  b[0x22] = 0x28
  b[0x26] = 0x14

  let startNibble = 1
  let delay = le16(b, O.buttonDelay) || 59
  if (s.start.kind === 'button') { startNibble = 2; delay = s.start.delaySeconds }
  if (s.start.kind === 'at') startNibble = 4
  let stopNibble = 0
  let stopAfter = 1
  if (s.stop.kind === 'whenFull') stopNibble = 2
  if (s.stop.kind === 'at') stopNibble = 4
  if (s.stop.kind === 'afterReadings') { stopNibble = 8; stopAfter = s.stop.count }
  b[O.mode] = (stopNibble << 4) | startNibble
  // Unused date fields: the vendor software fills them with whichever date is set, else now.
  const stopDate = s.stop.kind === 'at' ? s.stop.date : null
  const startDate = s.start.kind === 'at' ? s.start.date : stopDate ?? now
  putBcdDate(b, O.startDate, startDate)
  putBcdDate(b, O.stopDate, stopDate ?? startDate)
  put16(b, O.buttonDelay, Math.max(0, Math.min(0xffff, delay)))

  put16(b, O.interval, s.intervalSeconds)
  s.probes.forEach((p, i) => {
    put16(b, LIMIT_BASE[i], p.high.raw)
    put16(b, LIMIT_BASE[i] + 2, p.low.raw)
  })
  b[O.probeCount] = s.probeCount
  for (let i = 0; i < 4; i++) b[O.stopAfter + i] = (stopAfter >>> (8 * i)) & 0xff
  b.fill(0, 0x73, 0x95) // calibration: sent as zeros, the logger keeps its own
  putBcdDate(b, O.clock, now)
  return b
}

/**
 * Decodes settings from a report-2 block. In a status block the mode byte holds the
 * run state, not the configured start mode, so `start` is only meaningful for writes.
 */
export function decodeSettings(b: Uint8Array): Settings {
  const stopAfter = (b[O.stopAfter] | (b[O.stopAfter + 1] << 8) | (b[O.stopAfter + 2] << 16) | (b[O.stopAfter + 3] << 24)) >>> 0
  const startNibble = b[O.mode] & 0x0f
  const stopNibble = b[O.mode] >> 4
  const probe = (i: number): Probe => ({
    high: { enabled: (b[O.flags] & ALARM_BITS[i][0]) !== 0, raw: le16(b, LIMIT_BASE[i]) },
    low: { enabled: (b[O.flags] & ALARM_BITS[i][1]) !== 0, raw: le16(b, LIMIT_BASE[i] + 2) },
  })
  return {
    name: ascii(b, 0x01, 0x21),
    intervalSeconds: le16(b, O.interval),
    probeCount: b[O.probeCount],
    start:
      startNibble === 2 ? { kind: 'button', delaySeconds: le16(b, O.buttonDelay) }
      : startNibble === 4 ? { kind: 'at', date: bcdDate(b, O.startDate) ?? new Date(0) }
      : { kind: 'manual' },
    stop:
      stopNibble === 2 ? { kind: 'whenFull' }
      : stopNibble === 4 ? { kind: 'at', date: bcdDate(b, O.stopDate) ?? new Date(0) }
      : stopNibble === 8 ? { kind: 'afterReadings', count: stopAfter }
      : { kind: 'software' },
    probes: [probe(0), probe(1)],
  }
}
