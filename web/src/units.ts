import { useEffect, useState } from 'preact/hooks'
import { celsius, fromCelsius } from './protocol'

export type Unit = 'F' | 'C'

export const toUnit = (f: number, u: Unit) => (u === 'F' ? f : celsius(f))
export const fromUnit = (v: number, u: Unit) => (u === 'F' ? v : fromCelsius(v))
export const fmtTemp = (f: number | null | undefined, u: Unit, digits = 1) =>
  f == null ? '—' : `${toUnit(f, u).toFixed(digits)} °${u}`

/** °F/°C preference, remembered per browser. */
export function useUnit(): [Unit, (u: Unit) => void] {
  const [unit, setUnit] = useState<Unit>(() => {
    try { return localStorage.getItem('unit') === 'C' ? 'C' : 'F' } catch { return 'F' }
  })
  useEffect(() => {
    try { localStorage.setItem('unit', unit) } catch { /* private mode etc. */ }
  }, [unit])
  return [unit, setUnit]
}

export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.round((seconds % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  return `${m} min`
}

/** Sample interval: seconds below a minute, otherwise a duration. */
export const fmtInterval = (seconds: number) =>
  seconds < 60 || seconds % 60 ? `${seconds} s` : fmtDuration(seconds)

/** Instrument-style duration: `00:34:15`, or `2d 03:04:05` past a day. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86400)
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
  return d ? `${d}d ${hms}` : hms
}
