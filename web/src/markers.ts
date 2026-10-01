// Event markers: labelled moments in a run ("heater on", "added ice").
import type { LogData } from './log'

export interface Marker {
  id: string
  /** Time of the reading it's attached to, seconds since epoch. */
  t: number
  label: string
}

export const newMarker = (t: number, label = ''): Marker => ({
  id: Math.random().toString(36).slice(2, 10),
  t,
  label,
})

/** Identifies a run across reloads and re-downloads: its first reading and probe count. */
export const runKey = (log: LogData | null) => (log?.times.length ? `${log.times[0]}:${log.probes.length}` : null)

export function loadMarkers(key: string): Marker[] {
  try {
    const v = JSON.parse(localStorage.getItem(`markers:${key}`) ?? '[]')
    return Array.isArray(v) ? v.filter((m) => typeof m?.t === 'number' && typeof m?.label === 'string' && typeof m?.id === 'string') : []
  } catch {
    return []
  }
}

export function saveMarkers(key: string, markers: Marker[]) {
  try {
    if (markers.length) localStorage.setItem(`markers:${key}`, JSON.stringify(markers))
    else localStorage.removeItem(`markers:${key}`)
  } catch { /* private mode etc. */ }
}

/** Index of the reading nearest to `t` (times ascending). */
export function nearestIndex(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1
  if (hi < 0) return -1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid
    else hi = mid
  }
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi
}

export const sortMarkers = (m: Marker[]) => [...m].sort((a, b) => a.t - b.t)
