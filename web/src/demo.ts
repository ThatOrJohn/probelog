// A simulated logger for the demo. It answers the same HID reports as the real device
// (see PROTOCOL.md), so the app drives it through the normal LoggerDevice code path.
import {
  CAPACITY, CHANNEL_REGION, OFFSETS as O, PRODUCT_ID, VENDOR_ID, bcdDate, le16, put16, putBcdDate, rawFor,
} from './protocol'

const STATUS_LENGTH = 193 // report ID + 192 bytes, as the real logger sends
const CHUNK_RECORDS = 127
const EXPERIMENT_MINUTES = 45

/** Deterministic noise in [-1, 1] for a given timestamp, so re-downloads match. */
const noise = (t: number, salt: number) => {
  const x = Math.sin((t + salt) * 12.9898) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

/**
 * A lab heating run: probe 1 is a sample warming from room temperature toward ~86 °F
 * (crossing its 80 °F alarm about 25 minutes in); probe 2 is ambient air.
 */
function model(probe: number, secondsIntoRun: number): number {
  const t = Math.max(0, secondsIntoRun)
  if (probe === 0) return 72 + 14 * (1 - Math.exp(-t / 1800)) + 0.15 * noise(t, 1)
  return 72.5 + 0.4 * Math.sin(t / 600) + 0.1 * noise(t, 2)
}

/** Raw value as the logger would store it (0.05 °F steps). */
const rawAt = (probe: number, seconds: number) => rawFor(Math.round(model(probe, seconds) * 20) / 20)

export class DemoLogger extends EventTarget {
  readonly vendorId = VENDOR_ID
  readonly productId = PRODUCT_ID
  readonly productName = 'ProbeLog demo logger'
  readonly collections: HIDCollectionInfo[] = []
  opened = false
  oninputreport: ((e: HIDInputReportEvent) => unknown) | null = null

  /** Status block, report ID at [0], offsets as in PROTOCOL.md. */
  private block = new Uint8Array(STATUS_LENGTH)
  /** Logger clock minus real time, ms (set when settings are written). */
  private clockOffset = 0
  /** When the experiment "began", real ms — temperatures follow it across restarts. */
  private readonly runEpoch = Date.now() - EXPERIMENT_MINUTES * 60_000
  private logStart: number | null = null
  private stoppedAt: number | null = null
  /** Start/stop mode as last written (the status byte reports run state instead). */
  private mode = 0x01

  constructor() {
    super()
    const b = this.block
    b[0] = 2
    this.setName('demo-heating-run')
    b[0x21] = 0x0d | 0x10 | 0x80 // probe 1 over alarm, probe 2 under alarm
    b[0x22] = 0x28
    b[0x26] = 0x0e
    b.fill(0xff, 0x27, 0x39)
    put16(b, O.buttonDelay, 59)
    put16(b, O.interval, 5)
    put16(b, 0x46, rawFor(80)); put16(b, 0x48, rawFor(-100)) // probe 1: over 80 °F
    put16(b, 0x4f, rawFor(1372)); put16(b, 0x51, rawFor(65)) // probe 2: under 65 °F
    b.set([0xff, 0x98, 0xf4, 0xe4, 0x28], 0x4a)
    b.set([0xff, 0x98, 0xf4, 0xe4, 0x28], 0x53)
    b.set(new TextEncoder().encode('DEMO00001'), 0x58)
    b[0x66] = 2
    b.fill(0xff, O.stopAfter, O.stopAfter + 4)
    // Already logging, started with the software start at the beginning of the run.
    b[0x23] = 0x08 | 0x01
    b[0xb7] = 0x01
    this.beginAt(this.runEpoch)
  }

  async open() { this.opened = true }
  async close() { this.opened = false }
  async forget() {}
  async sendFeatureReport() {}
  async receiveFeatureReport(): Promise<DataView> { return new DataView(new ArrayBuffer(0)) }

  async sendReport(reportId: number, data: BufferSource) {
    const d = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data instanceof ArrayBuffer ? 0 : data.byteOffset, data.byteLength)
    const eti = d[0] === 0x45 && d[1] === 0x54 && d[2] === 0x49
    if (reportId === 1 && d[0] === 0x02) this.later(() => this.emitStatus())
    else if (reportId === 1 && d[0] === 0xff) this.later(() => this.emitDownload())
    else if (reportId === 5 && eti) this.erase()
    else if (reportId === 2) this.write(d)
    else if (reportId === 8 && eti && d[3] === 0x10) this.start()
    else if (reportId === 8 && eti && d[3] === 0x20) this.stop()
  }

  private later(fn: () => void) { setTimeout(fn, 5) }
  private now() { return Date.now() + this.clockOffset }

  private setName(name: string) {
    const bytes = new TextEncoder().encode(name).subarray(0, 32)
    this.block.fill(0, 1, 0x21)
    this.block.set(bytes, 1)
  }

  private interval() { return le16(this.block, O.interval) || 1 }

  /** Readings logged so far, applying start/stop conditions as the logger would. */
  private tick(): number {
    const b = this.block
    const now = this.now()
    // A date/time start begins on its own.
    if (this.logStart == null && (this.mode & 0x0f) === 0x4 && b[0x23] & 0x08) {
      const at = bcdDate(b, O.startDate)
      if (at && now >= at.getTime()) this.beginAt(at.getTime())
    }
    if (this.logStart == null) return 0
    const stopKind = this.mode >> 4
    const stopAt = stopKind === 0x4 ? bcdDate(b, O.stopDate)?.getTime() : undefined
    if (this.stoppedAt == null && stopAt != null && now >= stopAt) this.stopAtTime(stopAt)
    const end = this.stoppedAt ?? now
    let n = Math.max(0, Math.floor((end - this.logStart) / (this.interval() * 1000)) + 1)
    const limit = stopKind === 0x8 ? Math.min(CAPACITY, (b[O.stopAfter] | (b[O.stopAfter + 1] << 8)) || CAPACITY) : CAPACITY
    if (n >= limit) {
      n = limit
      if (this.stoppedAt == null && stopKind === 0x8) this.stopAtTime(this.logStart + (limit - 1) * this.interval() * 1000)
    }
    return n
  }

  private readingTime(i: number) { return this.logStart! + i * this.interval() * 1000 }
  private secondsIntoRun(loggerMs: number) { return (loggerMs - this.clockOffset - this.runEpoch) / 1000 }

  private emitStatus() {
    const b = this.block
    const n = this.tick()
    put16(b, 0xa6, n)
    putBcdDate(b, O.clock, new Date(this.now()))
    for (let ch = 0; ch < 2; ch++) {
      const raw = n > 0 && ch < b[0x66] ? rawAt(ch, this.secondsIntoRun(this.readingTime(n - 1))) : 0xffff
      put16(b, 0xa0 + 2 * ch, raw)
    }
    this.emit(2, b.subarray(1))
  }

  private emitDownload() {
    this.emitStatus()
    const n = le16(this.block, 0xa6)
    for (let ch = 0; ch < this.block[0x66]; ch++) {
      for (let first = 0; first < n; first += CHUNK_RECORDS) {
        const count = Math.min(CHUNK_RECORDS, n - first)
        const c = new Uint8Array(1023)
        c[0] = count
        put16(c, 1, ch * CHANNEL_REGION + first)
        c[3] = 0x01
        for (let i = 0; i < count; i++) {
          const t = this.readingTime(first + i)
          const o = 4 + 8 * i // offsets here exclude the report ID
          putBcdDate(c, o, new Date(t))
          put16(c, o + 6, rawAt(ch, this.secondsIntoRun(t)))
        }
        this.emit(3, c)
      }
    }
  }

  private erase() {
    const b = this.block
    b[0x23] = 0x00
    b.fill(0xff, 0x27, 0x39)
    b.fill(0xff, O.stopAfter, O.stopAfter + 4)
    b.fill(0xff, 0xa0, 0xa4)
    put16(b, 0xa6, 0)
    b[0xb6] = 0x00
    this.logStart = null
    this.stoppedAt = null
  }

  private write(d: Uint8Array) {
    const b = this.block
    const keep = b.slice(0x73, 0x95) // the logger keeps its own calibration
    b.set(d.subarray(0, STATUS_LENGTH - 1), 1)
    b.set(keep, 0x73)
    this.mode = b[0x23]
    b[0x23] = 0x08 | (this.mode & 0x0f) // armed
    b[0x26] = 0x0e
    b.fill(0xff, 0x33, 0x39)
    const clock = bcdDate(b, O.clock)
    if (clock) this.clockOffset = clock.getTime() - Date.now()
  }

  private beginAt(ms: number) {
    this.logStart = ms
    this.stoppedAt = null
    putBcdDate(this.block, 0x33, new Date(ms))
    this.block[0xb6] = 0x10
  }

  private start() {
    if (this.logStart == null) this.beginAt(this.now())
  }

  private stopAtTime(ms: number) {
    this.stoppedAt = ms
    this.block[0xb6] = 0x20
  }

  private stop() {
    if (this.logStart != null && this.stoppedAt == null) this.stopAtTime(this.now())
  }

  private emit(reportId: number, data: Uint8Array) {
    const e = Object.assign(new Event('inputreport'), {
      device: this, reportId, data: new DataView(data.slice().buffer),
    }) as unknown as HIDInputReportEvent
    this.dispatchEvent(e)
  }
}

export const createDemoLogger = () => new DemoLogger() as unknown as HIDDevice
export const isDemo = (hid: HIDDevice | undefined | null) => hid instanceof DemoLogger
