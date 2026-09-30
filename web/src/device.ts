// WebHID transport. Only sends the requests observed from the vendor software.
import { PRODUCT_ID, VENDOR_ID, encodeSettings, parseReadings, parseStatus, type Settings, type Status } from './protocol'

export const webHidSupported = () => typeof navigator !== 'undefined' && 'hid' in navigator

const FILTERS: HIDDeviceFilter[] = [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]
const ETI = [0x45, 0x54, 0x49] // "ETI"

/** Asks the user to pick the logger (must be called from a click). */
export async function requestLogger(): Promise<HIDDevice | null> {
  const [d] = await navigator.hid.requestDevice({ filters: FILTERS })
  return d ?? null
}

/** Loggers this site was already given access to. */
export async function grantedLoggers(): Promise<HIDDevice[]> {
  return (await navigator.hid.getDevices()).filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID)
}

export class LoggerDevice {
  private reports: Uint8Array[] = []
  private wake: (() => void) | null = null
  private busy: Promise<unknown> = Promise.resolve()

  constructor(readonly hid: HIDDevice) {
    hid.addEventListener('inputreport', (e) => {
      // WebHID strips the report ID; put it back so offsets match PROTOCOL.md.
      const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)
      const r = new Uint8Array(data.length + 1)
      r[0] = e.reportId
      r.set(data, 1)
      this.reports.push(r)
      this.wake?.()
    })
  }

  async open() {
    if (!this.hid.opened) await this.hid.open()
  }

  /** Runs one operation at a time so request/response pairs never interleave. */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.busy.then(op, op)
    this.busy = next.catch(() => undefined)
    return next
  }

  private send(reportId: number, payload: number[] | Uint8Array) {
    return this.hid.sendReport(reportId, Uint8Array.from(payload))
  }

  /** Waits until `done` is satisfied or `idleMs` pass without a new report. */
  private async collect(idleMs: number, done: (r: Uint8Array[]) => boolean) {
    while (!done(this.reports)) {
      const got = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), idleMs)
        this.wake = () => { clearTimeout(t); resolve(true) }
      })
      this.wake = null
      if (!got) return
    }
  }

  private async statusRaw(): Promise<Uint8Array> {
    this.reports = []
    await this.send(1, [0x02, 0, 0, 0, 0])
    await this.collect(2000, (r) => r.some((x) => x[0] === 2))
    const r = this.reports.find((x) => x[0] === 2)
    if (!r) throw new Error('The logger did not answer the status request.')
    return r
  }

  readStatus(): Promise<Status> {
    return this.exclusive(async () => parseStatus(await this.statusRaw()))
  }

  /** Downloads every probe's log. `onProgress` gets 0…1. */
  download(onProgress?: (fraction: number) => void) {
    return this.exclusive(async () => {
      const status = parseStatus(await this.statusRaw())
      const expected = status.channelCount * status.readingCount
      this.reports = []
      await this.send(1, [0xff, 0xff, 0xff, 0xff, 0xff])
      let received = 0
      await this.collect(2000, (r) => {
        received = parseReadings(r.filter((x) => x[0] === 3)).length
        onProgress?.(expected ? Math.min(1, received / expected) : 1)
        return received >= expected
      })
      const chunks = this.reports.filter((x) => x[0] === 3)
      if (expected > 0 && chunks.length === 0) throw new Error('The logger did not send any data.')
      return { status, chunks, readings: parseReadings(chunks) }
    })
  }

  /** ERASES the logger, writes `settings` (clock = now), and returns the status read back. */
  applySettings(settings: Settings) {
    return this.exclusive(async () => {
      await this.send(5, ETI)
      const base = await this.statusRaw()
      const block = encodeSettings(settings, base, new Date())
      await this.send(2, block.subarray(1))
      const after = parseStatus(await this.statusRaw())
      if (settings.start.kind === 'software') await this.send(8, [...ETI, 0x10])
      return after
    })
  }

  startNow() { return this.exclusive(() => this.send(8, [...ETI, 0x10])) }
  stopNow() { return this.exclusive(() => this.send(8, [...ETI, 0x20])) }
}
