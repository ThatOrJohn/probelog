// A downloaded (or re-opened) log, in a column layout that suits the chart.
import { INVALID_RAW, celsius, fahrenheit, type Reading, type Status } from './protocol'

export interface LogData {
  title: string
  /** Seconds since epoch, ascending. */
  times: number[]
  /** °F per probe, aligned with `times`; null = no valid reading. */
  probes: (number | null)[][]
}

export function logFromReadings(readings: Reading[], title: string): LogData {
  const channels = [...new Set(readings.map((r) => r.channel))].sort()
  const byTime = new Map<number, (number | null)[]>()
  for (const r of readings) {
    const t = r.time.getTime() / 1000
    const row = byTime.get(t) ?? channels.map(() => null)
    row[channels.indexOf(r.channel)] = r.raw === INVALID_RAW ? null : fahrenheit(r.raw)
    byTime.set(t, row)
  }
  const times = [...byTime.keys()].sort((a, b) => a - b)
  return { title, times, probes: channels.map((_, i) => times.map((t) => byTime.get(t)![i])) }
}

const pad = (n: number) => String(n).padStart(2, '0')
export const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/** Same format as the `tdlog` command-line tool: one row per time, °F and °C per probe. */
export function toCsv(log: LogData): string {
  const head = ['time', ...log.probes.flatMap((_, i) => [`probe${i + 1}_f`, `probe${i + 1}_c`])]
  const rows = log.times.map((t, r) =>
    [stamp(new Date(t * 1000)), ...log.probes.flatMap((p) => {
      const f = p[r]
      return f == null ? ['', ''] : [f.toFixed(2), celsius(f).toFixed(2)]
    })].join(','),
  )
  return [head.join(','), ...rows].join('\n') + '\n'
}

/** Reads a CSV written by `toCsv` (or `tdlog`). */
export function fromCsv(text: string, title: string): LogData {
  const [head, ...lines] = text.trim().split(/\r?\n/)
  const cols = head.split(',')
  const fCols = cols.flatMap((c, i) => (/^probe\d+_f$/.test(c) ? [i] : []))
  if (cols[0] !== 'time' || fCols.length === 0) throw new Error('Not a ProbeLog CSV file.')
  const times: number[] = []
  const probes: (number | null)[][] = fCols.map(() => [])
  for (const line of lines) {
    const v = line.split(',')
    const t = new Date(v[0].replace(' ', 'T')).getTime()
    if (Number.isNaN(t)) continue
    times.push(t / 1000)
    fCols.forEach((c, i) => probes[i].push(v[c] === '' || v[c] == null ? null : Number(v[c])))
  }
  return { title, times, probes }
}

export interface ProbeStats { min: number; max: number; mean: number; count: number }

export function stats(values: (number | null)[]): ProbeStats | null {
  let min = Infinity, max = -Infinity, sum = 0, count = 0
  for (const v of values) {
    if (v == null) continue
    min = Math.min(min, v); max = Math.max(max, v); sum += v; count++
  }
  return count ? { min, max, mean: sum / count, count } : null
}

/**
 * Adds the reading the logger just took, using the latest values from its status block.
 * Returns null when that isn't safe (readings were missed, a new log started, probe
 * count changed) and a full download is needed instead.
 */
export function appendLatest<T extends LogData>(
  log: T,
  prevCount: number,
  s: Pick<Status, 'readingCount' | 'actualStart' | 'intervalSeconds' | 'latestRaw'>,
): T | null {
  if (s.readingCount !== prevCount + 1 || !s.actualStart || s.latestRaw.length !== log.probes.length) return null
  // Step from the last real timestamp; the logger's own spacing drifts by a second now and then.
  const last = log.times[log.times.length - 1]
  const t = last != null ? last + s.intervalSeconds : s.actualStart.getTime() / 1000 + (s.readingCount - 1) * s.intervalSeconds
  return {
    ...log,
    times: [...log.times, t],
    probes: log.probes.map((p, i) => {
      const raw = s.latestRaw[i]
      return [...p, raw == null ? null : fahrenheit(raw)]
    }),
  }
}

/** Change in a probe's value over the last `seconds` of the log (null if it can't be computed). */
export function change(log: LogData, probe: number, seconds: number): number | null {
  const v = log.probes[probe]
  if (!v) return null
  let end = v.length - 1
  while (end >= 0 && v[end] == null) end--
  if (end < 0) return null
  const from = log.times[end] - seconds
  let start = end
  for (let i = end - 1; i >= 0 && log.times[i] >= from; i--) if (v[i] != null) start = i
  return start === end ? null : v[end]! - v[start]!
}

/** The last `n` valid values of a probe, for a sparkline. */
export function recent(log: LogData, probe: number, n: number): number[] {
  const out: number[] = []
  const v = log.probes[probe] ?? []
  for (let i = v.length - 1; i >= 0 && out.length < n; i--) if (v[i] != null) out.unshift(v[i]!)
  return out
}

/** A limit is tripped when a reading goes strictly past it. */
export const beyond = (f: number, limit: { kind: 'over' | 'under'; f: number }) =>
  limit.kind === 'over' ? f > limit.f : f < limit.f

/** How many of a probe's readings were past any of its alarm limits, and roughly for how long. */
export function timeInAlarm(log: LogData, probe: number, limits: { kind: 'over' | 'under'; f: number }[]) {
  const v = log.probes[probe] ?? []
  let count = 0
  for (const f of v) if (f != null && limits.some((l) => beyond(f, l))) count++
  const n = log.times.length
  const interval = n > 1 ? (log.times[n - 1] - log.times[0]) / (n - 1) : 0
  return { count, seconds: count * interval }
}

export interface RegionStats {
  count: number
  min: number
  max: number
  mean: number
  /** Last minus first valid reading in the region, °F. */
  change: number
  /** Least-squares slope, °F per minute (robust to noise, unlike last − first). */
  ratePerMin: number | null
  inAlarm: number
}

/** Statistics for one probe between two times (seconds, inclusive). */
export function regionStats(
  log: LogData, probe: number, t0: number, t1: number, limits: { kind: 'over' | 'under'; f: number }[] = [],
): RegionStats | null {
  const v = log.probes[probe] ?? []
  const ts: number[] = [], fs: number[] = []
  for (let i = 0; i < log.times.length; i++) {
    const t = log.times[i], f = v[i]
    if (t >= t0 && t <= t1 && f != null) { ts.push(t); fs.push(f) }
  }
  if (!fs.length) return null
  const n = fs.length
  const mean = fs.reduce((a, b) => a + b, 0) / n
  const tMean = ts.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (ts[i] - tMean) * (fs[i] - mean); den += (ts[i] - tMean) ** 2 }
  return {
    count: n,
    min: Math.min(...fs),
    max: Math.max(...fs),
    mean,
    change: fs[n - 1] - fs[0],
    ratePerMin: den > 0 ? (num / den) * 60 : null,
    inAlarm: fs.filter((f) => limits.some((l) => beyond(f, l))).length,
  }
}
