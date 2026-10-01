import { useEffect, useRef, useState } from 'preact/hooks'
import { Chart, LIGHT_THEME, darkTheme, fmtElapsed, type AlarmLine, type Region, type TimeMode } from './Chart'
import { copyPng, renderChartImage, savePng } from './exportChart'
import { regionStats, stamp, type LogData } from './log'
import { fmtClock, toUnit, type Unit } from './units'

const RANGES = [{ label: '5 MIN', seconds: 300 }, { label: '30 MIN', seconds: 1800 }, { label: 'ALL', seconds: null }] as const

function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key) as T | null; return s && allowed.includes(s) ? s : fallback } catch { return fallback }
  })
  return [v, (next: T) => { setV(next); try { localStorage.setItem(key, next) } catch { /* private mode etc. */ } }]
}

/** Temperature differences (change, rate) convert by scale only, without the 32° offset. */
const delta = (f: number, unit: Unit) => (unit === 'F' ? f : (f * 5) / 9)
const signed = (v: number, digits = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`

export function Trend({ log, unit, live, intervalSeconds, details, fileBase }: {
  log: (LogData & { alarms: AlarmLine[] }) | null
  unit: Unit
  live: boolean
  intervalSeconds: number | null
  /** Logger details for exported images, e.g. "SN D14380098 · 2 probes". */
  details: string
  fileBase: string
}) {
  const [range, setRange] = useState<number | null>(null)
  const [timeMode, setTimeMode] = useStored<TimeMode>('timeMode', 'clock', ['clock', 'elapsed'])
  const [tool, setTool] = useStored<'zoom' | 'measure'>('chartTool', 'zoom', ['zoom', 'measure'])
  const [imageStyle, setImageStyle] = useStored<'light' | 'dark'>('imageStyle', 'light', ['light', 'dark'])
  const [region, setRegion] = useState<Region | null>(null)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const view = useRef<(() => Region | null) | null>(null)
  const menu = useRef<HTMLDetailsElement>(null)

  // A new log (download, file, demo) starts without a measurement.
  useEffect(() => { setRegion(null) }, [log?.title])

  // Close the image menu on a click outside it or Escape.
  useEffect(() => {
    const close = (e: Event) => {
      const m = menu.current
      if (m?.open && (e instanceof KeyboardEvent ? e.key === 'Escape' : !m.contains(e.target as Node))) m.open = false
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [])

  const origin = log?.times[0] ?? 0
  const fmtT = (t: number) => (timeMode === 'elapsed' ? fmtElapsed(t - origin) : new Date(t * 1000).toLocaleTimeString([], { hour12: false }))
  const lastTime = log?.times.length ? log.times[log.times.length - 1] : null

  async function exportImage(action: 'save' | 'copy') {
    if (!log) return
    setExportNote(null)
    try {
      const canvas = await renderChartImage({
        log, unit, alarms: log.alarms, timeMode, region,
        theme: imageStyle === 'light' ? LIGHT_THEME : darkTheme(),
        range: view.current?.() ?? null,
        title: log.title, details,
      })
      if (action === 'save') {
        const day = log.times[0] ? stamp(new Date(log.times[0] * 1000)).slice(0, 10) : 'chart'
        await savePng(canvas, `${fileBase}-${day}.png`)
      } else {
        await copyPng(canvas)
        setExportNote('Copied')
        setTimeout(() => setExportNote(null), 2000)
      }
      if (menu.current) menu.current.open = false
    } catch (e) {
      setExportNote(e instanceof Error ? e.message : String(e))
    }
  }

  const probes = log?.probes.map((_, i) => i) ?? []
  const stats = log && region ? probes.map((p) => regionStats(log, p, region[0], region[1], log.alarms.filter((a) => a.probe === p))) : []
  const meanDiff = stats.length === 2 && stats[0] && stats[1] ? stats[0].mean - stats[1].mean : null

  return (
    <section class="panel trend" aria-label="Trend">
      <div class="trend-head">
        <div class="trend-meta">
          <span class="label" style={{ color: 'var(--bright)' }}>Trend</span>
          {live && <span class="led live">Live</span>}
          {lastTime != null && <span class="label muted">Last {fmtT(lastTime)}{intervalSeconds && live ? ` · every ${fmtClock(intervalSeconds)}` : ''}</span>}
        </div>
        <div class="trend-tools">
          <div class="ranges" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.label} aria-pressed={range === r.seconds} disabled={!log} onClick={() => setRange(r.seconds)}>{r.label}</button>
            ))}
          </div>
          <div class="ranges" role="group" aria-label="Time axis">
            <button aria-pressed={timeMode === 'clock'} disabled={!log} onClick={() => setTimeMode('clock')}>Clock</button>
            <button aria-pressed={timeMode === 'elapsed'} disabled={!log} onClick={() => setTimeMode('elapsed')}>Elapsed</button>
          </div>
          <div class="ranges" role="group" aria-label="Drag on the chart to">
            <button aria-pressed={tool === 'zoom'} disabled={!log} onClick={() => setTool('zoom')}>Zoom</button>
            <button aria-pressed={tool === 'measure'} disabled={!log} onClick={() => setTool('measure')}>Measure</button>
          </div>
          <details class="menu" ref={menu}>
            <summary class={log ? '' : 'disabled'} aria-disabled={!log}>Image ▾</summary>
            <div class="menu-body">
              <div class="ranges" role="group" aria-label="Image style">
                <button aria-pressed={imageStyle === 'light'} onClick={() => setImageStyle('light')}>Light</button>
                <button aria-pressed={imageStyle === 'dark'} onClick={() => setImageStyle('dark')}>Dark</button>
              </div>
              <button class="small" disabled={!log} onClick={() => exportImage('save')}>Save PNG</button>
              <button class="small" disabled={!log} onClick={() => exportImage('copy')}>Copy image</button>
              <p class="hint">Exports what's on screen{region ? ', with the measured region' : ''}.</p>
            </div>
          </details>
          {exportNote && <span class="label muted" role="status">{exportNote}</span>}
        </div>
      </div>

      {log && log.times.length ? (
        <>
          <Chart log={log} unit={unit} alarms={log.alarms} follow={live} rangeSeconds={range} timeMode={timeMode}
            measuring={tool === 'measure'} region={region} onRegion={setRegion} onUnzoom={() => setRange(null)} viewRef={view} />
          {region && (
            <div class="region" aria-label="Measured region">
              <div class="region-head">
                <span class="label" style={{ color: 'var(--bright)' }}>Measured</span>
                <span class="label muted">{fmtT(region[0])} → {fmtT(region[1])} · {fmtClock(region[1] - region[0])}</span>
                <button class="link" onClick={() => setRegion(null)}>Clear</button>
              </div>
              <table class="region-table">
                <thead>
                  <tr><th></th><th>Min</th><th>Max</th><th>Mean</th><th>Change</th><th>Rate</th><th>In alarm</th></tr>
                </thead>
                <tbody>
                  {stats.map((s, p) => (
                    <tr key={p}>
                      <th><span class={`probe-dot p${p + 1}`}>CH {p + 1}</span></th>
                      {s ? (
                        <>
                          <td>{toUnit(s.min, unit).toFixed(2)}</td>
                          <td>{toUnit(s.max, unit).toFixed(2)}</td>
                          <td>{toUnit(s.mean, unit).toFixed(2)}</td>
                          <td>{signed(delta(s.change, unit))}</td>
                          <td>{s.ratePerMin == null ? '—' : `${signed(delta(s.ratePerMin, unit), 3)} °/min`}</td>
                          <td>{s.inAlarm} of {s.count}</td>
                        </>
                      ) : <td colSpan={6} class="muted">No readings</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {meanDiff != null && <p class="hint">Mean CH1 − CH2: {signed(delta(meanDiff, unit))} °{unit}</p>}
            </div>
          )}
          <p class="hint">
            {tool === 'measure' ? 'Drag to measure · Shift-drag to zoom' : 'Drag to zoom · Shift-drag to measure'} · double-click to reset · {log.times.length.toLocaleString()} samples · {log.title}
          </p>
        </>
      ) : (
        <div class="empty">
          <strong>No data</strong>
          Download from the logger, start live view, or open a CSV you saved earlier.
        </div>
      )}
    </section>
  )
}
