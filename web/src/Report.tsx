import { createPortal } from 'preact/compat'
import type { AlarmLine, Region } from './Chart'
import { regionStats, stamp, stats, timeInAlarm, type LogData } from './log'
import { nearestIndex, sortMarkers, type Marker } from './markers'
import { fmtClock, fmtDuration, toUnit, type Unit } from './units'

const delta = (f: number, unit: Unit) => (unit === 'F' ? f : (f * 5) / 9)
const signed = (v: number, digits = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`

/**
 * A one-page lab record, shown only when printing (Save as PDF from the print dialog):
 * details, the chart, per-probe summary, the measured region and event markers.
 */
export function Report({ log, unit, alarms, markers, region, chartUrl, details, intervalSeconds, generatedAt }: {
  log: LogData
  unit: Unit
  alarms: AlarmLine[]
  markers: Marker[]
  region: Region | null
  /** The chart, rendered in the light style. */
  chartUrl: string
  details: string
  intervalSeconds: number | null
  generatedAt: Date
}) {
  const first = log.times[0], last = log.times[log.times.length - 1]
  const origin = first
  const t = (s: number) => stamp(new Date(s * 1000))
  const temp = (f: number | null | undefined) => (f == null ? '—' : `${toUnit(f, unit).toFixed(2)}`)
  const interval = intervalSeconds ?? (log.times.length > 1 ? Math.round((last - first) / (log.times.length - 1)) : null)
  const probes = log.probes.map((_, i) => i)
  const sorted = sortMarkers(markers)

  return createPortal(
    <article class="report">
      <header class="report-head">
        <p class="report-kicker">ProbeLog temperature report</p>
        <h1>{log.title}</h1>
        <p class="report-meta">{details}</p>
      </header>

      <dl class="report-facts">
        <div><dt>Start</dt><dd>{t(first)}</dd></div>
        <div><dt>End</dt><dd>{t(last)}</dd></div>
        <div><dt>Duration</dt><dd>{fmtClock(last - first)}</dd></div>
        <div><dt>Readings</dt><dd>{log.times.length.toLocaleString()} per probe{interval ? `, every ${fmtClock(interval)}` : ''}</dd></div>
        <div><dt>Unit</dt><dd>°{unit}</dd></div>
        <div>
          <dt>Alarms</dt>
          <dd>{alarms.length
            ? alarms.map((a) => `CH${a.probe + 1} ${a.kind} ${toUnit(a.f, unit).toFixed(1)}°`).join(' · ')
            : 'None'}</dd>
        </div>
      </dl>

      <img class="report-chart" src={chartUrl} alt="Temperature chart" />

      <h2>Summary</h2>
      <table class="report-table">
        <thead><tr><th>Probe</th><th>Min</th><th>Max</th><th>Mean</th><th>Valid readings</th><th>In alarm</th></tr></thead>
        <tbody>
          {probes.map((p) => {
            const s = stats(log.probes[p])
            const a = timeInAlarm(log, p, alarms.filter((x) => x.probe === p))
            return (
              <tr key={p}>
                <th>CH {p + 1}</th>
                <td>{temp(s?.min)}</td><td>{temp(s?.max)}</td><td>{temp(s?.mean)}</td>
                <td>{(s?.count ?? 0).toLocaleString()}</td>
                <td>{alarms.some((x) => x.probe === p) ? `${a.count.toLocaleString()}${a.count ? ` (~${fmtDuration(Math.max(60, a.seconds))})` : ''}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {region && (
        <>
          <h2>Measured region</h2>
          <p class="report-note">{t(region[0])} → {t(region[1])} · {fmtClock(region[1] - region[0])}</p>
          <table class="report-table">
            <thead><tr><th>Probe</th><th>Min</th><th>Max</th><th>Mean</th><th>Change</th><th>Rate (°/min)</th></tr></thead>
            <tbody>
              {probes.map((p) => {
                const s = regionStats(log, p, region[0], region[1])
                return (
                  <tr key={p}>
                    <th>CH {p + 1}</th>
                    {s ? (
                      <>
                        <td>{temp(s.min)}</td><td>{temp(s.max)}</td><td>{temp(s.mean)}</td>
                        <td>{signed(delta(s.change, unit))}</td>
                        <td>{s.ratePerMin == null ? '—' : signed(delta(s.ratePerMin, unit), 3)}</td>
                      </>
                    ) : <td colSpan={5}>No readings</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {sorted.length > 0 && (
        <>
          <h2>Event markers</h2>
          <table class="report-table">
            <thead>
              <tr><th>#</th><th>Time</th><th>Elapsed</th><th class="left">Label</th>{probes.map((p) => <th key={p}>CH {p + 1}</th>)}</tr>
            </thead>
            <tbody>
              {sorted.map((m, n) => {
                const i = nearestIndex(log.times, m.t)
                return (
                  <tr key={m.id}>
                    <th>{n + 1}</th>
                    <td>{t(m.t)}</td>
                    <td>T+{fmtClock(m.t - origin)}</td>
                    <td class="left">{m.label || '—'}</td>
                    {probes.map((p) => <td key={p}>{temp(log.probes[p][i])}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      <footer class="report-foot">
        Generated by ProbeLog (thatorjohn.github.io/probelog) on {stamp(generatedAt)}. Not affiliated with or endorsed by
        ThermoWorks or Electronic Temperature Instruments. No warranty — verify readings against a reference.
      </footer>
    </article>,
    document.body,
  )
}
